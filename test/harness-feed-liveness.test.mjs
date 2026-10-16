import test from 'node:test';
import assert from 'node:assert/strict';

function makeHost({ goal } = {}) {
  const host = {
    sends: [],
    edits: [],
    deletes: [],
    nextId: 100,
    inboundPending: false,
    liveFeed: true,
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    goalForChat: (chatId) => (chatId === 7 ? goal : undefined),
    // Dynamic read (HF-3 A): tests flip host.liveFeed to simulate
    // /config set outbound.liveFeed false mid-run.
    liveFeedEnabled: () => host.liveFeed !== false,
    bindAgent: () => {},
    unbindChat: () => {},
    send: async (chatId, text, options) => {
      const id = host.nextId++;
      host.sends.push({ chatId, text, options, id });
      return id;
    },
    editMessage: async (chatId, messageId, text, options) => {
      host.edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      host.deletes.push({ chatId, messageId });
    },
    attachFeedback: () => {},
    statusStats: () => undefined,
    setAssistantConsumer: (consumer) => {
      host.consumer = consumer;
    },
    pendingInbound: () => false,
    inboundMessageId: () => undefined,
    markInboundReplied: () => {},
    stopLiveFeed: undefined,
    getConfigPath: () => true,
  };
  return host;
}

function makeCtx(host) {
  const listeners = new Map();
  const disposers = [];
  return {
    host,
    telegram: host,
    logger: { info: () => {} },
    get: () => undefined,
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      // Real unsubscribe (HF-2 C): teardownFeed must detach the session/event
      // listener so post-teardown traffic causes zero sends.
      return () => {
        const list = listeners.get(name);
        const at = list !== undefined ? list.indexOf(cb) : -1;
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    disposeAll: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
    emit: (sessionId, event) => {
      for (const cb of [...(listeners.get('session/event') ?? [])]) cb({ id: sessionId }, event);
    },
  };
}

async function setup(goal) {
  const host = makeHost({ goal });
  const ctx = makeCtx(host);
  host.requireCtx = () => ctx;
  const { apply } = await import('../dist/extensions/harness-feed.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};
const ev = (type, data = {}) => ({ type, data });

test('heartbeat edits the elapsed title every 30s for a silent tool (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(host.sends.length, 1);
  assert.equal(host.sends[0].text, '\u2699\uFE0F Working\u2026');
  assert.equal(host.edits.length, 0);

  t.mock.timers.tick(30_000);
  await settle();
  assert.equal(host.edits.length, 1, 'heartbeat is an immediate liveness edit');
  assert.match(host.edits[0].text, /\u2699\uFE0F Working \u00B7 \u23F1\uFE0F 30s/);

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(host.sends.length, 1, 'ordinary turns do not spam a second completion message');
});

test('goal turn completion pushes a fresh receipt message (#18)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { host, ctx } = await setup({ objective: 'process the dataset' });
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_1', name: 'python', arguments: 'work' }));
  await settle();
  t.mock.timers.tick(1000);
  await settle();
  assert.equal(host.sends.length, 1, 'goal placeholder only');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(host.sends.length, 2, 'completion receipt is a fresh push');
  // (markup-tolerant: the objective renders bold in the receipt header)
  assert.match(host.sends[1].text, /\u2705 (?:<b>)?process the dataset(?:<\/b>)?/);
  assert.equal(host.sends[1].options.disable_notification, false);
});

test('stopLiveFeed (Abort seam) latches the card dormant (#48)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(2_000_000);

  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(typeof host.stopLiveFeed, 'function');

  host.stopLiveFeed?.(7);
  t.mock.timers.tick(120_000);
  await settle();
  const editsAtAbort = host.edits.length;
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(host.edits.length, editsAtAbort, 'no heartbeat survives the Abort seam');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  // The aborted turn had zero output: its outcome still lands (#33 path).
  assert.ok(host.edits.some((e) => e.text.includes('Empty response')));
});

/* ---- HF-3 A: liveFeed toggled OFF mid-turn must not strand a zombie card ---- */

test('liveFeed off mid-turn stops the heartbeat, stays quiet, and settles bookkeeping at turn end (HF-3 A)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(host.sends.length, 1, 'placeholder sent while live');
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'streamed half' } }));
  await settle();
  assert.equal(host.sends.length, 2, 'answer bubble opened before the toggle');
  const answerId = host.sends[1].id;

  host.liveFeed = false; // toggled OFF mid-turn
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' more' } }));
  await settle();
  const editsAtToggle = host.edits.length;
  t.mock.timers.tick(10 * 60_000); // several heartbeat periods + throttle frames
  await settle();
  assert.equal(host.edits.length, editsAtToggle, 'no zombie heartbeat / throttled edit after the toggle');
  assert.equal(host.sends.length, 2, 'no new bubbles while disabled');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(host.edits.length, editsAtToggle, 'settlement adds no receipt/final edits — the core forwarder owns delivery');
  assert.equal(host.sends.length, 2, 'feed sends nothing while disabled');
  assert.deepEqual(
    host.deletes.filter((d) => d.chatId === 7).map((d) => d.messageId).sort((a, b) => a - b),
    [activityId, answerId].sort((a, b) => a - b),
    'partial artifacts withdrawn: activity card + tail-window bubble',
  );

  // Entry cleaned at turn end: late traffic finds no turn to render into.
  ctx.emit('agent-1', ev('tool/call', { callId: 'late', name: 'bash', arguments: 'ls' }));
  t.mock.timers.tick(60_000);
  await settle();
  assert.equal(host.edits.length, editsAtToggle, 'late events find no turn entry');
});

test('session/event listener is unsubscribed on teardown; injected events cause zero sends (HF-2 C)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(3_000_000);

  const { host, ctx } = await setup();
  ctx.disposeAll(); // hot teardown: teardownFeed must detach the listener
  await settle();

  // Traffic that arrives after unmount must be completely inert.
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'ghost prose' } }));
  await settle();

  assert.equal(host.sends.length, 0, 'no placeholder/answer sends after teardown');
  assert.equal(host.edits.length, 0, 'no edits after teardown');
});
