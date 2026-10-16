import test from 'node:test';
import assert from 'node:assert/strict';
import { splitText } from '../dist/telegram/html.js';
import { markdownToHtml } from '../dist/telegram/markdown.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain safeWrap/edit/claim promise chains (several microtask hops). */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/**
 * Host stub whose send lane mirrors TelegramTransport.sendTextLane: payloads
 * over the per-message cap are SPLIT into ordered parts (splitText, first
 * part keeps reply quoting), every part gets its own message id and the
 * promise resolves with the FIRST id — only then is a multi-part send
 * "landed". Without this, sharded delivery is unobservable at host level.
 */
function makeHost() {
  const host = {
    sends: [],
    edits: [],
    deletes: [],
    feedback: [],
    nextId: 100,
    inboundPending: false,
    liveFeed: true,
    inboundRepliedMarks: 0,
    consumer: undefined,
    /** Optional async gate (text) -> promise, holds ONE send in flight. */
    sendGate: undefined,
    /** When true, deleteMessage rejects (retract hardening regression). */
    deleteFails: false,
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    currentAgent: () => ({ id: 'agent-1' }),
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    liveFeedEnabled: () => host.liveFeed !== false,
    bindAgent: () => {},
    unbindChat: () => {},
    send: async (chatId, text, options) => {
      if (host.sendGate) await host.sendGate(text);
      const max = 4096;
      const parts = splitText(text, max);
      let first;
      for (let index = 0; index < parts.length; index += 1) {
        // Reply quoting / keyboards are per-message Telegram state: only the
        // FIRST part carries them (transport.sendTextLane semantics).
        const partOptions = index === 0 ? options : { ...options, reply_parameters: undefined, reply_markup: undefined };
        const id = host.nextId++;
        host.sends.push({ chatId, text: parts[index], options: partOptions, id });
        first ??= id;
      }
      return first;
    },
    editMessage: async (chatId, messageId, text, options) => {
      host.edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      if (host.deleteFails) throw new Error('message to delete not found');
      host.deletes.push({ chatId, messageId });
    },
    attachFeedback: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      host.feedback.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    statusStats: () => ({}),
    setAssistantConsumer: (consumer) => {
      host.consumer = consumer;
    },
    pendingInbound: () => host.inboundPending,
    inboundMessageId: () => (host.inboundPending ? 99 : undefined),
    markInboundReplied: () => {
      host.inboundRepliedMarks += 1;
      host.inboundPending = false;
    },
    stopLiveFeed: undefined,
    goalForChat: () => undefined,
    getConfigPath: () => true,
  };
  return host;
}

function makeCtx(host, { tools, listeners: sharedBus } = {}) {
  const listeners = sharedBus ?? new Map();
  const disposers = [];
  const registry = tools ?? undefined;
  return {
    host,
    telegram: host,
    logger: { info: () => {} },
    get: (key) => (key === 'tools' ? registry : undefined),
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      // Real cordis-shaped unsubscribe: removing the listener must actually
      // detach it, or a remount stacks copies (HF-2 C).
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
    listenerCount: (name) => (listeners.get(name) ?? []).length,
  };
}

async function setup(options) {
  const host = makeHost();
  const ctx = makeCtx(host, options);
  host.requireCtx = () => ctx;
  const { apply } = await import('../dist/extensions/harness-feed.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data) => ({ type, data });

/* ---- HF-2 A: over-cap final answers must arrive COMPLETELY ---- */

test('oversized final answer (>4096 HTML chars) lands COMPLETELY across ordered split sends', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Short start.' } }));
  await settle();
  assert.equal(host.sends.length, 2, 'activity placeholder + streamed answer bubble');
  const answerBubbleId = host.sends[1].id;

  // Authoritative final dwarfs one Telegram message (~9000 plain chars).
  const finalText = `${Array.from({ length: 300 }, (_, i) => `Shard line ${i} of the long final answer.`).join('\n')}\nUNIQUE-TAIL-MARKER`;
  assert.ok(markdownToHtml(finalText).length > 4096, 'fixture must exceed the transport cap');
  host.consumer?.(7, finalText, 'am-1');
  const sendsBeforeEnd = host.sends.length;
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const finalHtml = markdownToHtml(finalText);
  const expectedParts = splitText(finalHtml, 4096);

  // The streamed bubble was retracted, then the complete text followed as
  // exactly the transport-shaped shard sequence.
  assert.ok(host.deletes.some((d) => d.messageId === answerBubbleId), 'partial streamed bubble retracted so no stale duplicate remains');
  const delivered = host.sends.slice(sendsBeforeEnd);
  assert.equal(delivered.length, expectedParts.length, `one send per shard, got ${delivered.length}`);
  assert.equal(delivered.map((s) => s.text).join(''), finalHtml, 'shards concatenate back to the EXACT final HTML — nothing lost, nothing duplicated');
  assert.ok(delivered.every((s) => s.text.length <= 4096), 'every shard fits one Telegram message');
  const joined = delivered.map((s) => s.text).join('');
  assert.ok(joined.startsWith(finalHtml.slice(0, 60)) && joined.endsWith('UNIQUE-TAIL-MARKER'), 'shard order preserved head -> tail');
  assert.equal(delivered.filter((s) => s.text.includes('UNIQUE-TAIL-MARKER')).length, 1, 'tail arrives exactly once');
  assert.ok(!delivered.some((s) => s.text.includes('could not be delivered')), 'degraded notice must NOT fire — the answer WAS delivered');
  // Settlement rides the LAST shard landing: feedback anchors to the first
  // part and the inbound is marked answered exactly once.
  assert.equal(host.feedback.length, 1);
  assert.equal(host.feedback[0].telegramMessageId, delivered[0].id);
  assert.equal(host.feedback[0].assistantMessageId, 'am-1');
  assert.equal(host.inboundRepliedMarks, 1);
});

test('a failed retract must not take the oversized delivery down with it', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  host.deleteFails = true; // user already removed the bubble / delete hiccups
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Begin.' } }));
  await settle();
  const finalText = Array.from({ length: 300 }, (_, i) => `Line ${i} still long enough overall.`).join('\n');
  host.consumer?.(7, finalText, 'am-1');
  const sendsBeforeEnd = host.sends.length;
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const delivered = host.sends.slice(sendsBeforeEnd);
  assert.equal(delivered.map((s) => s.text).join(''), markdownToHtml(finalText), 'complete answer still delivered despite the retract failure');
  assert.ok(!host.sends.some((s) => s.text.includes('could not be delivered')), 'no degraded notice when delivery succeeded');
  assert.equal(host.inboundRepliedMarks, 1);
});

/* ---- HF-2 B: answer-slot orphan bubbles ---- */

test('in-flight "…" answer send is CLAIMED by turn/end and settles in place — never deleted nor duplicated', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  let releaseAnswer;
  const heldAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
  host.sendGate = (text) => (text === '\u2026' ? heldAnswer : undefined);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'streamed reply' } }));
  await settle();
  // Committed prose wins at settlement — and gives settle() a feedback anchor.
  host.consumer?.(7, 'Committed **final**.', 'am-1');
  // The "…" send is STILL in flight when the turn settles.
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  releaseAnswer();
  await sleep(5);
  await settle();

  const answerSends = host.sends.filter((s) => s.text === '\u2026');
  assert.equal(answerSends.length, 1, 'exactly one answer bubble was spawned');
  const bubbleId = answerSends[0].id;
  assert.ok(!host.deletes.some((d) => d.messageId === bubbleId), 'the claimed bubble is settled, NOT deleted as an orphan');
  assert.equal(host.sends.length, 2, 'no fresh duplicate final send races the late landing');
  const settledEdit = host.edits.filter((e) => e.messageId === bubbleId).at(-1);
  assert.ok(settledEdit?.text.includes('<b>final</b>'), `late bubble adopted and settled in place: ${settledEdit?.text}`);
  assert.equal(host.feedback.length, 1);
  assert.equal(host.feedback[0].telegramMessageId, bubbleId, 'feedback anchors to the adopted bubble carrying the final text');
  assert.equal(host.feedback[0].assistantMessageId, 'am-1');
  assert.equal(host.inboundRepliedMarks, 1);
});

test('unclaimed "…" bubble landing after the chat entry is gone is deleted (goal-turn orphan)', async () => {
  const { host, ctx } = await setup();
  // No inbound pending: autonomous goal turn — settlement never claims the
  // answer send, so the late "…" bubble is nobody's orphan.
  let releaseAnswer;
  const heldAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
  host.sendGate = (text) => (text === '\u2026' ? heldAnswer : undefined);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'streamed reply' } }));
  await settle();
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  releaseAnswer();
  await sleep(5);
  await settle();

  const lateBubble = host.sends.find((s) => s.text === '\u2026');
  assert.ok(lateBubble !== undefined, 'the held answer send did land');
  assert.ok(host.deletes.some((d) => d.messageId === lateBubble.id), 'orphan "…" bubble deleted instead of leaking forever');
  assert.ok(!host.sends.some((s) => s.text.includes('streamed reply')), 'no stray duplicate of the streamed text');
});

test('"…" bubble landing after TEARDOWN is deleted (disposed orphan)', async () => {
  const { host, ctx } = await setup();
  let releaseAnswer;
  const heldAnswer = new Promise((resolve) => { releaseAnswer = resolve; });
  host.sendGate = (text) => (text === '\u2026' ? heldAnswer : undefined);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'partial' } }));
  await settle();
  ctx.disposeAll();
  await settle();
  releaseAnswer();
  await sleep(5);
  await settle();

  const lateBubble = host.sends.find((s) => s.text === '\u2026');
  assert.ok(lateBubble !== undefined, 'the held answer send landed after teardown');
  assert.ok(host.deletes.some((d) => d.messageId === lateBubble.id), 'post-teardown answer orphan deleted');
});

/* ---- HF-2 C: session/event subscription lifecycle ---- */

test('teardown unsubscribes session/event; a re-mount renders each turn exactly ONCE', async () => {
  const bus = new Map();
  const { apply } = await import('../dist/extensions/harness-feed.js');

  // Mount 1.
  const host1 = makeHost();
  const ctx1 = makeCtx(host1, { listeners: bus });
  host1.requireCtx = () => ctx1;
  apply(ctx1, undefined);
  assert.equal(ctx1.listenerCount('session/event'), 1, 'first mount subscribes exactly once');
  ctx1.emit('agent-1', ev('turn/start', { turn: 1 }));
  await sleep(20);
  assert.equal(host1.sends.length, 1, 'one placeholder');

  // Hot teardown via the cordis effect cleanup.
  ctx1.disposeAll();
  await settle();
  assert.equal(ctx1.listenerCount('session/event'), 0, 'teardownFeed unsubscribed the listener');

  // Mount 2 on a FRESH context over the SAME event bus (HMR / re-apply shape).
  const host2 = makeHost();
  const ctx2 = makeCtx(host2, { listeners: bus });
  host2.requireCtx = () => ctx2;
  apply(ctx2, undefined);
  assert.equal(ctx2.listenerCount('session/event'), 1, 'remount holds exactly one subscription — no stacked copy');

  host2.inboundPending = true;
  ctx2.emit('agent-1', ev('turn/start', { turn: 2 }));
  await sleep(20);
  assert.equal(host2.sends.length, 1, 'exactly ONE placeholder per chat per turn');
  ctx2.emit('agent-1', ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(host2.edits.filter((e) => e.text.includes('Empty response')).length, 1, 'outcome notice applied once');
  assert.equal(host2.inboundRepliedMarks, 1, 'settlement ran exactly once (double listener would mark twice)');
  assert.equal(host2.sends.length, 1, 'no duplicated notice push from a leaked first-mount listener');
});
