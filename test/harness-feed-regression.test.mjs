import test from 'node:test';
import assert from 'node:assert/strict';

/**
 * HF-4 regression net: the openclaw.test.mjs locks that survived the
 * harness-feed rewrite, re-locked against the CURRENT (post-HF-1/2/3)
 * implementation. Sibling coverage was inventoried first — this file adds
 * only what the other harness-feed*.test.mjs files do NOT already lock:
 *
 * - already locked elsewhere, NOT duplicated here:
 *   #37 success-receipt suppression across every failure reason shape
 *     (harness-feed-hf3.test.mjs, HF-3 B block), #23 restart-after-landing
 *     placeholder reuse (harness-feed.test.mjs), single zero-output #33
 *     notice (harness-feed.test.mjs), hot-teardown timer kill + #48
 *     stopLiveFeed dormancy on an EMPTY turn (harness-feed-liveness.test.mjs),
 *     HF-2 A split delivery / HF-2 B orphan bubbles / HF-2 C remount
 *     deduplication (harness-feed-delivery.test.mjs).
 * - added HERE: #13 degraded final delivery (both failure modes), #15 edit
 *     retry/backoff + identical-render skip + retry-budget fallback,
 *     #26 GFM-table Think line (mechanics preserved via
 *     markdownTablePreBlock — no supersession), RE-1 goal-objective escaping
 *     (draft title + both goal receipt shapes), usage-token folding into the
 *     receipt cache-hit metric, the five-metric renderTurnReceipt line,
 *     consecutive-empty #33 variants, #48 late-real-turn settlement after the
 *     Abort seam, concurrent-chat interleaving, throttle-frame bounding, and
 *     the #23 in-flight-send race.
 */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Drain the safeWrap/edit/claim promise chains (several microtask hops). */
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

function makeHost(options = {}) {
  const pending = { 7: false, ...(options.inbound ?? {}) };
  const inboundIds = { 7: 99, ...(options.inboundIds ?? {}) };
  const marks = {};
  for (const chatId of Object.keys(pending)) marks[chatId] = 0;
  const host = {
    sends: [],
    edits: [],
    /** EVERY editMessage invocation (successful or not) — the retry/backoff
     * tests must count ATTEMPTS against failing transports. */
    editAttemptsLog: [],
    deletes: [],
    feedback: [],
    nextId: 100,
    /** Message ids whose editMessage must fail (transport outage simulation). */
    failEdits: new Set(),
    /** Texts whose send must RESOLVE WITHOUT an id (silent transport loss). */
    sendLosesIdFor: new Set(),
    /** Optional async gate (text) -> promise, holds ONE send in flight. */
    sendGate: undefined,
    liveFeed: true,
    consumer: undefined,
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    currentAgent: () => ({ id: 'agent-1' }),
    agentIdForChat: options.agentIdForChat ?? ((chatId) => (chatId === 7 ? 'agent-1' : undefined)),
    chatIdForAgent: options.chatIdForAgent ?? ((agentId) => (agentId === 'agent-1' ? 7 : undefined)),
    liveFeedEnabled: () => host.liveFeed !== false,
    bindAgent: () => {},
    unbindChat: () => {},
    goalForChat: () => options.goal,
    send: async (chatId, text, sendOptions) => {
      if (host.sendGate) await host.sendGate(text);
      if (host.sendLosesIdFor.has(text)) return undefined;
      const id = host.nextId++;
      host.sends.push({ chatId, text, options: sendOptions, id });
      return id;
    },
    editMessage: async (chatId, messageId, text, editOptions) => {
      host.editAttemptsLog.push({ chatId, messageId, text, options: editOptions });
      if (host.failEdits.has(messageId)) return false;
      host.edits.push({ chatId, messageId, text, options: editOptions });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      host.deletes.push({ chatId, messageId });
    },
    attachFeedback: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      host.feedback.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    statusStats: options.statusStats ?? (() => undefined),
    setAssistantConsumer: (consumer) => {
      host.consumer = consumer;
    },
    pendingInbound: (chatId) => pending[chatId] ?? false,
    inboundMessageId: (chatId) => (pending[chatId] ? inboundIds[chatId] : undefined),
    markInboundReplied: (chatId) => {
      marks[chatId] = (marks[chatId] ?? 0) + 1;
      pending[chatId] = false;
    },
    inboundMarks: marks,
    setPending(chatId, value) {
      pending[chatId] = value;
    },
    /** notify.onLongTask defaults ON (production shape); fake-timer tests that
     * count edits precisely flip this to false to silence the 30s heartbeat. */
    longTask: true,
    stopLiveFeed: undefined,
    getConfigPath: (path) => (path === 'notify.onLongTask' ? host.longTask : true),
  };
  return host;
}

function makeCtx(host, { tools } = {}) {
  const listeners = new Map();
  const disposers = [];
  return {
    host,
    telegram: host,
    logger: { info: () => {} },
    get: (key) => (key === 'tools' ? tools : undefined),
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      // Real unsubscribe (HF-2 C): teardown must actually detach.
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

async function setup(options = {}) {
  const host = makeHost(options.host);
  const ctx = makeCtx(host, options);
  host.requireCtx = () => ctx;
  const { apply } = await import('../dist/extensions/harness-feed.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data) => ({ type, data });

/** One reasoning burst (Think line material). */
const emitReasoning = (ctx, text) => {
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text } }));
};

/** One completed tool round on the activity card. */
const emitToolRound = (ctx, callId, name = 'bash', args = 'ls') => {
  ctx.emit('agent-1', ev('tool/call', { callId, name, arguments: args }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId }, content: [{ type: 'tool-result', isError: false }] } }));
};

const DEGRADED_MARK = 'could not be delivered';

/* ---- #13: final-answer delivery failure degrades to the warning notice AND
 * the inbound stays pending (failFinal never reaches markInboundReplied) ---- */

test('#13: a failed in-place final edit degrades to the warning notice and leaves the inbound pending', async () => {
  const { host, ctx } = await setup();
  host.setPending(7, true);
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Deliver me please' } }));
  await sleep(1150);

  assert.equal(host.sends.length, 2, 'activity placeholder + streamed answer bubble');
  const answerId = host.sends[1].id;

  // The transport goes down exactly when settlement tries to finalize the
  // streamed bubble into the committed answer.
  host.failEdits.add(answerId);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  for (let i = 0; i < 3; i += 1) await settle();

  const degraded = host.sends.filter((s) => s.text.includes(DEGRADED_MARK));
  assert.equal(degraded.length, 1, `exactly one degraded notice, got ${host.sends.length} sends: ${JSON.stringify(host.sends.map((s) => s.text))}`);
  assert.ok(!host.sends.some((s) => s.text.includes('Deliver me please')), 'the failed delivery is NOT retried as a duplicate fresh send');
  assert.equal(host.inboundMarks[7], 0, 'a degraded delivery never marks the inbound answered');
  assert.equal(host.feedback.length, 0, 'no feedback anchor without a landed delivery');
  // The activity card still collapses normally — ONLY the final answer lane degraded.
  const activityId = host.sends[0].id;
  assert.ok(
    host.edits.some((e) => e.messageId === activityId && e.text.includes('Completed')),
    `the placeholder receipt still renders: ${JSON.stringify(host.edits.map((e) => e.text))}`,
  );
  assert.ok(!host.deletes.some((d) => d.messageId === answerId), 'the stale bubble is left in place, not silently retracted');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

test('#13: a send resolving WITHOUT a message id is a failed delivery too — degraded notice, inbound untouched', async () => {
  const { host, ctx } = await setup();
  host.setPending(7, true);
  host.sendLosesIdFor.add('Committed answer text'); // silent transport loss on THE final send

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;
  host.consumer?.(7, 'Committed answer text', 'am-9');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  for (let i = 0; i < 3; i += 1) await settle();

  const degraded = host.sends.filter((s) => s.text.includes(DEGRADED_MARK));
  assert.equal(degraded.length, 1, `the id-less resolution counts as failed: ${JSON.stringify(host.sends.map((s) => s.text))}`);
  assert.equal(host.inboundMarks[7], 0, 'settle() threw before the mark — the inbound stays pending for the core reminder');
  assert.equal(host.feedback.length, 0);
  assert.ok(host.deletes.some((d) => d.chatId === 7 && d.messageId === activityId), 'no summary/notice applied to the placeholder: quiet delete path');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- #15: failed card edits retry the SAME message id with exponential
 * backoff; an identical re-render is skipped entirely ---- */

test('#15: a failing card edit retries the SAME message id on exponential backoff, never respawning the placeholder', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(1_000_000);

  const { host, ctx } = await setup();
  host.longTask = false; // silence the 30s heartbeat so edit counts stay exact

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;
  assert.equal(host.sends.length, 1);

  host.failEdits.add(activityId); // every card edit fails from here on
  emitToolCallOnly(ctx, 'c1');

  // Throttle frame at t+1000ms -> attempt #1; then backoff 1500/3000/6000/12000ms.
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(host.editAttemptsLog.length, 1, 'first throttled attempt fired');

  const gaps = [1_500, 3_000, 6_000, 12_000];
  let expected = 1;
  for (const gap of gaps) {
    t.mock.timers.tick(gap - 1);
    await settle();
    assert.equal(host.editAttemptsLog.length, expected, `no early retry before the ${gap}ms backoff elapses`);
    t.mock.timers.tick(1);
    await settle();
    expected += 1;
    assert.equal(host.editAttemptsLog.length, expected, `retry fired after the ${gap}ms backoff`);
  }

  // Fifth failure scheduled the last 24000ms retry; that SIXTH attempt is
  // the one that blows MAX_EDIT_FAILURES: it fires, announces the fallback
  // ONCE, resets the counter and schedules nothing further.
  t.mock.timers.tick(24_000);
  await settle();

  assert.equal(host.editAttemptsLog.length, expected + 1, 'the budget-exhausting attempt fired');
  assert.deepEqual(
    [...new Set(host.editAttemptsLog.map((e) => e.messageId))],
    [activityId],
    'every retry targeted the SAME retained message id (#23/#15)',
  );
  assert.equal(host.sends.length, 2, 'placeholder + exactly ONE fallback announce, no fresh Working… respawn');
  assert.match(host.sends[1].text, /\u26A0\uFE0F Agent is running, but live progress cannot be delivered/);

  // No retry was armed by the exhausted failure; new content may still try
  // the retained message afterwards.
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }));
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(host.editAttemptsLog.length, expected + 2, 'post-fallback content still retries the retained id');
  assert.equal([...new Set(host.editAttemptsLog.map((e) => e.messageId))].length, 1);
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/** tool/call without its result (keeps the row in the running state). */
function emitToolCallOnly(ctx, callId, name = 'bash', args = '{"command":"npm test"}') {
  ctx.emit('agent-1', ev('tool/call', { callId, name, arguments: args }));
}

test('#15: an identical re-render is skipped — no duplicate edit API call until content changes', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(2_000_000);

  const { host, ctx } = await setup();
  host.longTask = false;

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;

  emitToolCallOnly(ctx, 'c1');
  t.mock.timers.tick(1_000);
  await settle();
  assert.equal(host.edits.filter((e) => e.messageId === activityId).length, 1, 'first frame rendered the running row');

  // A re-delivered tool/call event recomputes the SAME row html: the diff
  // check must suppress the API call ("message is not modified" guard).
  emitToolCallOnly(ctx, 'c1');
  t.mock.timers.tick(999);
  await settle();
  assert.equal(host.edits.filter((e) => e.messageId === activityId).length, 1, 'coalesced window not elapsed yet');
  t.mock.timers.tick(1);
  await settle();
  assert.equal(host.edits.filter((e) => e.messageId === activityId).length, 1, 'identical re-render produced NO second edit call');

  // Control: content that truly differs still flows through.
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }));
  t.mock.timers.tick(1_000);
  await settle();
  const frames = host.edits.filter((e) => e.messageId === activityId);
  assert.equal(frames.length, 2, 'changed content gets its own frame');
  assert.ok(frames[1].text.includes('<b>\u2713 bash</b>'), `completed row rendered: ${frames[1].text}`);
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- RE-1: goal objective is HTML-escaped everywhere user text lands ---- */

test('RE-1: goal objective is HTML-escaped in the draft card title, the summary receipt and the fallback goal receipt', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(3_000_000);

  const objective = 'Fix <b>bugs</b> & "quotes"';
  const escaped = 'Fix &lt;b&gt;bugs&lt;/b&gt; &amp; &quot;quotes&quot;';
  const { host, ctx } = await setup({ host: { goal: { objective } } });

  // Turn 1 has visible activity: the summary receipt path (renderTurnReceipt).
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const firstCard = host.sends[0];
  assert.ok(firstCard.text.startsWith(`\u{1F4CA} ${escaped} \u00B7 step`), `draft title escapes the objective: ${firstCard.text}`);
  assert.ok(!firstCard.text.includes('<b>bugs'), 'no raw markup leaks into the draft title');

  emitReasoning(ctx, 'plan');
  t.mock.timers.tick(1_000);
  await settle();
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  assert.equal(host.sends.length, 2, 'goal completion pushes a fresh receipt (#18)');
  const summaryReceipt = host.sends[1].text;
  assert.ok(summaryReceipt.includes(`\u2705 <b>${escaped}</b>`), `summary receipt escapes inside the bold lead: ${summaryReceipt}`);
  assert.ok(!summaryReceipt.includes('<b>bugs') && !summaryReceipt.includes('"quotes'), 'no raw objective text in the summary receipt');

  // Turn 2 is zero-output: the FALLBACK goal receipt shape (✅ … · ⏱️ Ns).
  ctx.emit('agent-1', ev('turn/start', { turn: 2 }));
  await settle();
  const secondCard = host.sends[2];
  assert.ok(secondCard.text.includes(escaped), 'second draft title escaped too');
  ctx.emit('agent-1', ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await settle();

  assert.equal(host.sends.length, 4, 'fallback goal receipt pushed for the empty goal turn');
  const fallbackReceipt = host.sends[3].text;
  assert.ok(fallbackReceipt.startsWith(`\u2705 ${escaped} \u00B7 \u23F1\uFE0F `), `fallback receipt escaped: ${fallbackReceipt}`);
  assert.ok(!host.sends.some((s) => s.text.includes('\u{1F937}')), 'a goal turn with a receipt never takes the Empty-response path');
  assert.ok(!host.sends.some((s) => s.text.includes('<b>bugs')), 'raw markup appears in NO outgoing message');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- #26: a GFM table snapshot inside a reasoning block renders through
 * markdownTablePreBlock as an aligned monospace Think line (mechanics kept
 * from the original issue — thinkHtml checks tables BEFORE the italic line) ---- */

test('#26: a reasoning block containing a GFM table renders as an aligned <pre><code> Think line', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;

  const tableText = '| Name | Value |\n| --- | --- |\n| alpha | 1 |\n| beta | 2 |';
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: tableText } }));
  await sleep(1150);

  const tableFrames = host.edits.filter((e) => e.messageId === activityId && e.text.includes('<pre><code>'));
  assert.ok(tableFrames.length >= 1, `table renders as a pre block, got: ${JSON.stringify(host.edits.map((e) => e.text))}`);
  const frame = tableFrames.at(-1).text;
  // Columns aligned to the widest cell (Name->5, Value->5), separator dashed.
  assert.ok(frame.includes('| Name  | Value |'), `aligned header: ${frame}`);
  assert.ok(frame.includes('| ----- | ----- |'), `aligned separator: ${frame}`);
  assert.ok(frame.includes('| alpha | 1     |') && frame.includes('| beta  | 2     |'), `aligned body rows: ${frame}`);
  assert.ok(frame.includes('\u{1F9E0} <pre><code>|'), 'the Think line keeps the 🧠 prefix ahead of the monospace block');

  // Authoritative block-end freezes the same table as a committed Think LINE.
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: tableText } } }));
  await sleep(1150);
  const frozenFrame = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.ok(
    frozenFrame.text.includes('| alpha | 1     |'),
    `frozen Think line keeps the table rendering: ${frozenFrame.text.replace(/\n/g, '\\n')}`,
  );

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  const receipt = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.match(receipt.text, /\u{1F9E0} 1 thoughts/u, 'the table burst still counts as one reasoning step');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- usage folding + the five-metric receipt contract ---- */

test('usage: usage chunks ACCUMULATE input/cache tokens into the receipt cache-hit metric', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  emitReasoning(ctx, 'think');
  emitToolRound(ctx, 'c1');
  // Two usage chunks: totals must SUM (last-write-wins would read Cache hit 50%).
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 200, cacheWriteTokens: 0 } } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 0, outputTokens: 25, cacheReadTokens: 100, cacheWriteTokens: 100 } } }));
  await sleep(1150);
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const receipt = host.edits.filter((e) => e.messageId === activityId).at(-1);
  // billed = 100 uncached + 200 read + 100 write = 500; cached = 300 -> 60%.
  assert.match(
    receipt.text,
    /^\u2699\uFE0F (?:<b>)?Completed(?:<\/b>)? \u00B7 \u23F1\uFE0F \d+s \u00B7 \u{1F9E0} 1 thoughts \u00B7 \u{1F6E0}\uFE0F 1 tools \u00B7 \u{1F4BE} Cache hit 60%$/u,
    `accumulated hit rate on a single-line receipt: ${receipt.text}`,
  );
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

test('receipt: the collapse line carries the five user-facing metrics incl. session stats segment', async () => {
  const { host, ctx } = await setup({
    host: {
      statusStats: () => ({
        turns: 3,
        steps: 7,
        toolCalls: 9,
        llmMs: 1_810_000,
        toolMs: 310_000,
        ttftMs: 3_500,
        ttftSteps: 2,
        decodeMs: 10_000,
        decodeTokens: 680,
        uncachedInputTokens: 60,
        outputTokens: 80,
        cacheReadTokens: 240,
        cacheWriteTokens: 0,
      }),
    },
  });
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  emitReasoning(ctx, 'think');
  emitToolRound(ctx, 'c1');
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'usage', usage: { inputTokens: 60, outputTokens: 80, cacheReadTokens: 240, cacheWriteTokens: 0 } } }));
  await sleep(1150);
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const receipt = host.edits.filter((e) => e.messageId === activityId).at(-1);
  // ONE line: header+duration · thoughts · tools · session stats head · cache hit.
  assert.match(
    receipt.text,
    /^\u2699\uFE0F (?:<b>)?Completed(?:<\/b>)? \u00B7 \u23F1\uFE0F \d+s \u00B7 \u{1F9E0} 1 thoughts \u00B7 \u{1F6E0}\uFE0F 1 tools \u00B7 \u{1F4CA} 3 turns \u00B7 7 steps \u00B7 \u{1F4BE} Cache hit 80%$/u,
    `five-metric single-line receipt: ${receipt.text}`,
  );
  assert.ok(!receipt.text.includes('\n'), 'the receipt stays on one line');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- #33: consecutive zero-output turns each notify exactly once ---- */

test('#33: consecutive empty turns each collapse their own placeholder into exactly one 🤷 notice', async () => {
  const { host, ctx } = await setup();
  host.setPending(7, true);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await sleep(20);
  const firstCard = host.sends[0].id;
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  host.setPending(7, true); // a new user message arrived meanwhile
  ctx.emit('agent-1', ev('turn/start', { turn: 2 }));
  await settle();
  assert.equal(host.sends.length, 2, 'each turn owns its own placeholder (previous entry settled away)');
  const secondCard = host.sends[1].id;
  assert.notEqual(firstCard, secondCard);
  ctx.emit('agent-1', ev('turn/end', { turn: 2, reason: { kind: 'completed' } }));
  await settle();

  for (const cardId of [firstCard, secondCard]) {
    const notices = host.edits.filter((e) => e.messageId === cardId && /^\u{1F937} Empty response/u.test(e.text));
    assert.equal(notices.length, 1, `card ${cardId}: exactly one outcome notice, got ${notices.length}`);
  }
  assert.equal(host.inboundMarks[7], 2, 'each notice satisfied its own inbound');
  assert.equal(host.deletes.length, 0, 'placeholders degrade in place — never deleted into silence');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- #48 (current form): stopLiveFeed dormancy does not eat a late REAL
 * turn — the deferred settlement still lands everything, without throwing ---- */

test('#48/HF-3: after stopLiveFeed the draft goes dormant and a late real turn/end settles in full', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(5_000_000);

  const { host, ctx } = await setup();
  host.setPending(7, true);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;

  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'survives the abort' } }));
  await settle();
  assert.equal(host.sends.length, 2, 'answer bubble opened before the abort');
  const answerId = host.sends[1].id;

  host.stopLiveFeed?.(7); // core Abort seam
  const editsAtStop = host.edits.length;
  const sendsAtStop = host.sends.length;

  // Post-abort traffic races in, plus minutes of wall time: fully dormant.
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' plus late chunks' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'late', name: 'bash', arguments: 'ls' }));
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(host.edits.length, editsAtStop, 'no throttled/heartbeat/retry edit fires after the Abort seam');
  assert.equal(host.sends.length, sendsAtStop, 'no fresh bubbles after the Abort seam');

  // The REAL turn/end arrives late: ordinary settlement runs, nothing throws.
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const settledAnswer = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(settledAnswer.text.includes('survives the abort'), `streamed prose settled in place: ${settledAnswer.text}`);
  assert.ok(
    host.edits.some((e) => e.messageId === activityId && e.text.includes('Completed')),
    'activity card collapsed into the success receipt',
  );
  assert.equal(host.inboundMarks[7], 1, 'the late finalize satisfies the inbound exactly once');
  assert.equal(host.deletes.length, 0, 'nothing withdrawn — the turn completed');

  // Terminal state: minutes of further wall time produce zero edits.
  const editsAfterSettle = host.edits.length;
  t.mock.timers.tick(600_000);
  await settle();
  assert.equal(host.edits.length, editsAfterSettle, 'no post-settlement zombie timers');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- interleave: two chats stream concurrently, routed by session binding ---- */

test('interleave: two concurrent chats stream with zero cross-chat bleed (session->chat routing)', async () => {
  const { host, ctx } = await setup({
    host: {
      agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : chatId === 8 ? 'agent-2' : undefined),
      chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : agentId === 'agent-2' ? 8 : undefined),
      inbound: { 7: true, 8: true },
      inboundIds: { 7: 91, 8: 92 },
    },
  });

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Alpha lane' } }));

  ctx.emit('agent-2', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-2', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-2', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Beta lane' } }));
  await sleep(1150);

  assert.equal(host.sends.filter((s) => s.chatId === 7).length, 2, 'chat 7: placeholder + own bubble');
  assert.equal(host.sends.filter((s) => s.chatId === 8).length, 2, 'chat 8: placeholder + own bubble');
  const bubble7 = host.sends.find((s) => s.chatId === 7 && s.text === '\u2026');
  const bubble8 = host.sends.find((s) => s.chatId === 8 && s.text === '\u2026');
  assert.equal(bubble7.options.reply_parameters?.message_id, 91, 'chat 7 bubble quotes ITS inbound');
  assert.equal(bubble8.options.reply_parameters?.message_id, 92, 'chat 8 bubble quotes ITS inbound');

  const edits7 = host.edits.filter((e) => e.chatId === 7);
  const edits8 = host.edits.filter((e) => e.chatId === 8);
  assert.ok(edits7.some((e) => e.text.includes('Alpha lane')), 'chat 7 streams its own prose');
  assert.ok(edits8.some((e) => e.text.includes('Beta lane')), 'chat 8 streams its own prose');
  assert.ok(edits7.every((e) => !e.text.includes('Beta lane')), 'no Beta content bled into chat 7');
  assert.ok(edits8.every((e) => !e.text.includes('Alpha lane')), 'no Alpha content bled into chat 8');
  assert.ok(edits7.every((e) => e.messageId === host.sends[0].id || e.messageId === bubble7.id), 'chat 7 edits touch only chat 7 messages');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  ctx.emit('agent-2', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  assert.deepEqual(host.inboundMarks, { 7: 1, 8: 1 }, 'each chat settled its own inbound exactly once');
  const receipt7 = host.edits.filter((e) => e.chatId === 7 && e.text.includes('Completed'));
  const receipt8 = host.edits.filter((e) => e.chatId === 8 && e.text.includes('Completed'));
  assert.equal(receipt7.length, 1, 'chat 7 receipt on its own card');
  assert.equal(receipt8.length, 1, 'chat 8 receipt on its own card');
  assert.notEqual(receipt7[0].messageId, receipt8[0].messageId, 'receipts land on distinct per-chat cards');
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- throttle: rapid bursts coalesce into bounded edit frames ---- */

test('throttle: 25 rapid deltas coalesce into exactly two throttled answer edits (1s frames)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  t.mock.timers.setTime(7_000_000);

  const { host, ctx } = await setup();
  host.longTask = false;
  host.setPending(7, true);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  for (let i = 1; i <= 15; i += 1) {
    ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: `w${i} ` } }));
  }
  await settle();
  assert.equal(host.sends.length, 2, 'answer bubble opened immediately on first prose');
  const answerId = host.sends[1].id;
  assert.equal(host.edits.length, 0, 'nothing edits before the first 1s frame');

  t.mock.timers.tick(1_000);
  await settle();
  let frames = host.edits.filter((e) => e.messageId === answerId);
  assert.equal(frames.length, 1, 'the whole 15-delta burst landed as ONE frame');
  assert.ok(frames[0].text.includes('w1') && frames[0].text.includes('w15'), 'the frame carries every coalesced delta');

  for (let i = 16; i <= 25; i += 1) {
    ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: `w${i} ` } }));
  }
  t.mock.timers.tick(999);
  await settle();
  assert.equal(host.edits.filter((e) => e.messageId === answerId).length, 1, 'mid-window deltas stay coalesced');
  t.mock.timers.tick(1);
  await settle();
  frames = host.edits.filter((e) => e.messageId === answerId);
  assert.equal(frames.length, 2, '25 deltas -> exactly 2 API edits, far below the burst size');
  assert.ok(frames[1].text.includes('w25'), `second frame carries the newest tail: ${frames[1].text.slice(-40)}`);
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});

/* ---- #23 (current form): a restart while the placeholder send is STILL IN
 * FLIGHT carries the pending promise instead of spawning a second card ---- */

test('#23/HF-2: turn/start while the previous placeholder send is in flight reuses the pending send', async () => {
  const { host, ctx } = await setup();

  let release;
  const held = new Promise((resolve) => { release = resolve; });
  host.sendGate = (text) => (text === '\u2699\uFE0F Working\u2026' ? held : undefined);

  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(host.sends.length, 0, 'the placeholder send is held in flight');

  ctx.emit('agent-1', ev('turn/start', { turn: 2 })); // restart DURING the send
  await settle();
  release(); // the held "Working…" lands under the NEW turn's ownership
  await settle();
  await settle();

  assert.equal(host.sends.length, 1, 'exactly ONE placeholder despite the mid-flight restart');
  const landedId = host.sends[0].id;
  assert.equal(host.deletes.length, 0, 'the landing was adopted, not orphan-deleted');

  emitReasoning(ctx, 'fresh turn thinking');
  await sleep(1150);
  const streamEdits = host.edits.filter((e) => e.messageId === landedId);
  assert.ok(streamEdits.length >= 1, 'the new turn renders onto the adopted card');
  assert.ok(streamEdits.at(-1).text.includes('<i>fresh turn thinking</i>'), `adopted card streams the new turn: ${streamEdits.at(-1).text}`);
  // Deterministic teardown: kill timers/heartbeats while THIS test's timer
  // regime (real vs node:test mock) is still the installed one.
  ctx.disposeAll();
});
