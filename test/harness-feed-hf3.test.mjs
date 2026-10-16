import test from 'node:test';
import assert from 'node:assert/strict';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain the safeWrap/edit promise chains (several microtask hops). */
const settle = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve();
};

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
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    currentAgent: () => ({ id: 'agent-1' }),
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
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

async function setup() {
  const host = makeHost();
  const ctx = makeCtx(host);
  host.requireCtx = () => ctx;
  const { apply } = await import('../dist/extensions/harness-feed.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data) => ({ type, data });

/** A turn with visible activity (tool row + streamed prose) so hasContent is
 * true — the shape that used to collapse into the SUCCESS receipt. */
function emitActiveTurn(ctx) {
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'c1', name: 'bash', arguments: 'ls' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'partial prose then death' } }));
}

/* ---- HF-3 B: failure/abort detection across the TurnEndReasonMap ---- */

// The documented union (@deepseek-ai/dsh-session types.d.ts): completed,
// aborted{reason}, blocked, error{error:LlmFailure}, max-tokens, interrupted.
// Every non-completed shape must suppress the success receipt; before the fix
// only kind==="error" WITH a non-empty message string did.
const failureShapes = [
  ['aborted (with cancel cause)', { kind: 'aborted', reason: { kind: 'legacy' } }],
  ['blocked', { kind: 'blocked' }],
  ['interrupted (crash orphan)', { kind: 'interrupted' }],
  ['max-tokens', { kind: 'max-tokens' }],
  ['error with blank message', { kind: 'error', error: { message: '   ' } }],
  ['error without message field', { kind: 'error', error: {} }],
  ['error with non-string message', { kind: 'error', error: { message: 42 } }],
  ['plugin-merged unknown variant', { kind: 'mystery-variant' }],
];

for (const [label, reason] of failureShapes) {
  test(`no success receipt when turn/end is ${label} (HF-3 B)`, async () => {
    const { host, ctx } = await setup();
    host.inboundPending = true;
    emitActiveTurn(ctx);
    await sleep(1150);
    const activityId = host.sends[0].id;

    ctx.emit('agent-1', ev('turn/end', { turn: 1, reason }));
    await settle();

    assert.ok(
      !host.edits.some((e) => e.text.includes('Completed')),
      `${label} must not render the \u2699\uFE0F Completed success receipt: ${JSON.stringify(host.edits.map((e) => e.text))}`,
    );
    assert.ok(!host.sends.some((s) => s.text.includes('\u2705')), 'no success goal receipt either');
  });
}

test('genuine completed turns keep the success receipt (HF-3 B control)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  emitActiveTurn(ctx);
  await sleep(1150);
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  assert.ok(
    host.edits.some((e) => e.messageId === activityId && e.text.includes('Completed')),
    `completed still collapses into the receipt: ${JSON.stringify(host.edits.map((e) => e.text))}`,
  );
});

test('malformed turn/end without any reason keeps the legacy success shape (HF-3 B)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  emitActiveTurn(ctx);
  await sleep(1150);
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1 }));
  await settle();
  assert.ok(
    host.edits.some((e) => e.messageId === activityId && e.text.includes('Completed')),
    'missing reason is not evidence of failure',
  );
});

test('aborted turn with no prose: no receipt, no empty notice, inbound left unanswered (HF-3 B / #37)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  // Activity content but ZERO prose: reasoningSteps > 0 makes hasContent true.
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } }));
  await sleep(1150);
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'aborted', reason: { kind: 'legacy' } } }));
  await settle();

  assert.ok(!host.edits.some((e) => e.text.includes('Completed')), 'no success receipt on abort');
  assert.ok(!host.edits.some((e) => e.text.includes('Empty response')), 'failed turns take no #33 empty notice');
  assert.ok(!host.sends.some((s) => s.text.includes('Empty response') || s.text.includes('telegram_reply')), 'the feed fabricates no outcome voice');
  assert.ok(host.deletes.some((d) => d.chatId === 7 && d.messageId === activityId), 'placeholder takes the quiet delete path');
  assert.equal(host.inboundRepliedMarks, 0, 'a failed-with-no-prose turn never marks the inbound replied');
});

test('errored turn with prose still delivers the partial stream exactly once (HF-3 B preserves delivery)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  emitActiveTurn(ctx);
  await sleep(1150);
  const answerId = host.sends[1].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }));
  await settle();

  const finalEdit = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(finalEdit.text.includes('partial prose then death'), 'partial stream still settles in place');
  assert.equal(host.sends.length, 2, 'no duplicate fresh-send delivery');
});

/* ---- HF-3 A: mid-turn liveFeed toggle lifecycle ---- */

test('liveFeed flipped off MID-turn: card settles, feed adds no second answer, next turn renders normally (HF-3 A)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'streamed half' } }));
  await sleep(1150);
  const activityId = host.sends[0].id;
  const sendsBeforeFlip = host.sends.length;

  // Mid-turn disable: from here the CORE forwarder owns delivery (bridge
  // sends the committed message itself and marks the inbound answered).
  host.liveFeed = false;
  host.inboundPending = false;
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  // No zombie: the card collapsed to its receipt instead of staying "Working…".
  const cardEdit = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.ok(cardEdit.text.includes('Completed'), `card settled to a receipt: ${cardEdit.text}`);
  assert.ok(!cardEdit.text.includes('Working'), 'no live header left behind');
  // Exactly one answer delivery: the core's — the feed adds nothing.
  assert.equal(host.sends.length, sendsBeforeFlip, 'no duplicate answer send while disabled');

  // Flip back on: the NEXT turn renders normally again.
  host.liveFeed = true;
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 2 }));
  await settle();
  assert.equal(host.sends.length, sendsBeforeFlip + 1, 'fresh placeholder after re-enable');
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'back in business' } }));
  await sleep(1150);
  assert.ok(
    host.edits.some((e) => e.text.includes('back in business')),
    'streaming resumes normally for the next turn',
  );
});

test('flag re-enabled mid-turn: consumer-captured answer is delivered exactly once, not withdrawn (HF-3 A)', async () => {
  const { host, ctx } = await setup();
  host.liveFeed = false;
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(host.sends.length, 0, 'disabled at start: nothing rendered');

  // The user re-enables BEFORE the model answers: the bridge now routes the
  // committed message through the consumer (no core forward, no reply mark).
  host.liveFeed = true;
  host.consumer?.(7, 'Committed **while enabled**', 'am-1');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const delivered = host.sends.filter((s) => s.text.includes('<b>while enabled</b>'));
  assert.equal(delivered.length, 1, `exactly one delivery of the captured answer, got ${host.sends.length} sends: ${JSON.stringify(host.sends.map((s) => s.text))}`);
  assert.equal(delivered[0].options.reply_parameters?.message_id, 99, 'delivery quotes the inbound');
  assert.equal(host.inboundRepliedMarks, 1, 'the feed marks the inbound it satisfied');
  assert.equal(host.feedback.length, 1);
  assert.equal(host.feedback[0].assistantMessageId, 'am-1');
});
