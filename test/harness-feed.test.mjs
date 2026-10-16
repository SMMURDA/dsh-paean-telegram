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
    /** Presenter scope (web parity: api-proxy passes the live agent). */
    currentAgent: () => ({ id: 'agent-1' }),
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    liveFeedEnabled: () => host.liveFeed !== false,
    bindAgent: () => {},
    unbindChat: () => {},
    /** HF-2 B tests hold the "…" answer send in flight by injecting a gate. */
    sendGate: undefined,
    send: async (chatId, text, options) => {
      if (host.sendGate) await host.sendGate();
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

function makeCtx(host, { tools, listeners: sharedListeners } = {}) {
  /** Shared bus support (HF-2 C): a remount registers on a fresh ctx but the
   * same underlying event bus — pass `listeners` to simulate that. */
  const listeners = sharedListeners ?? new Map();
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
      // Real unsubscribe (HF-2 C): teardownFeed must detach its session/event
      // listener or every hot re-apply stacks another copy.
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
    /** Simulate hot teardown: run every registered effect disposer. */
    disposeAll: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
    emit: (sessionId, event) => {
      for (const cb of [...(listeners.get('session/event') ?? [])]) cb({ id: sessionId }, event);
    },
  };
}

async function setup(options) {
  const host = makeHost();
  const ctx = makeCtx(host, options);
  // The real bridge host exposes requireCtx(); presenters resolve through it.
  host.requireCtx = () => ctx;
  const { apply } = await import('../dist/extensions/harness-feed.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data) => ({ type, data });

test('harness feed streams reasoning + tool rows on the activity card and collapses to the receipt', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: 'Let me' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: ' check\nsecond line' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'call_1', name: 'bash', arguments: 'ls -la' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'call_1' }, content: [{ type: 'tool-result', isError: false }] } }));
  await sleep(1150);

  // Placeholder + NO answer message (reasoning is not prose).
  assert.equal(host.sends.length, 1);
  assert.equal(host.sends[0].text, '\u2699\uFE0F Working\u2026');
  const activityId = host.sends[0].id;

  const streamEdits = host.edits.filter((e) => e.messageId === activityId);
  assert.ok(streamEdits.length >= 1, `expected at least one streaming edit, got ${streamEdits.length}`);
  const lastStream = streamEdits[streamEdits.length - 1];
  // Frozen think line keeps the FIRST line (web ReasoningRow semantics).
  assert.ok(lastStream.text.includes('<i>Let me check</i>'), `think line frozen to first line: ${lastStream.text}`);
  // Tool row completed through ✓ with no trailing status.
  assert.ok(lastStream.text.includes('<b>\u2713 bash</b> <code>ls -la</code>'), `tool row: ${lastStream.text}`);

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  const receipt = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.match(
    receipt.text,
    /^\u2699\uFE0F (?:<b>)?\u5B8C\u6210(?:<\/b>)? \u00B7 \u23F1\uFE0F 1s \u00B7 \u{1F9E0} 1 \u6B21\u601D\u8003 \u00B7 \u{1F6E0}\uFE0F 1 \u6B21\u5DE5\u5177$/u,
  );
});

test('prose streams live into its own answer message and settles in place at turn end (web semantics)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));

  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'Hello' } }));
  await settle();
  // The answer bubble opens as soon as prose arrives.
  assert.equal(host.sends.length, 2, 'activity placeholder + streamed answer bubble');
  const answerSend = host.sends[1];
  assert.equal(answerSend.text, '\u2026');
  assert.equal(answerSend.options.reply_parameters?.message_id, 99, 'answer quotes the inbound from birth');

  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: ' world' } }));
  await sleep(1150);
  const streamedEdits = host.edits.filter((e) => e.messageId === answerSend.id);
  assert.ok(streamedEdits.length >= 1, 'prose streams into the answer bubble');
  assert.ok(streamedEdits.at(-1).text.includes('Hello world'), streamedEdits.at(-1).text);

  // Committed message finalizes the SAME bubble in place — no duplicate send.
  host.consumer?.(7, 'Hello world **final**', 'am-1');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();

  const finalEdits = host.edits.filter((e) => e.messageId === answerSend.id);
  assert.ok(finalEdits.at(-1).text.includes('<b>final</b>'), `committed markdown lands in place: ${finalEdits.at(-1).text}`);
  assert.equal(host.sends.length, 2, 'no duplicate final message after streaming');
  assert.equal(host.feedback.length, 1);
  assert.equal(host.feedback[0].telegramMessageId, answerSend.id);
  assert.equal(host.feedback[0].assistantMessageId, 'am-1');
  assert.equal(host.inboundRepliedMarks, 1);
});

test('without a committed message the streamed blocks are the final answer', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'streamed reply' } }));
  await sleep(1150);
  const answerId = host.sends[1].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  // No consumer capture happened: the folded text blocks settle in place.
  const finalEdit = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(finalEdit.text.includes('streamed reply'));
  assert.equal(host.sends.length, 2, 'still no duplicate delivery');
  assert.equal(host.inboundRepliedMarks, 1);
});

test('tool rows render through harness presenters (terminal card + exit suffix)', async () => {
  const bashPresenter = {
    presentCall: (args) => ({ card: 'terminal', title: args.command, cwd: '/workspace' }),
    presentResult: (_args, result) => ({ card: 'terminal', exitCode: result.isError ? 1 : 0 }),
  };
  const { host, ctx } = await setup({ tools: { get: (name) => (name === 'bash' ? bashPresenter : undefined) } });
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'c1', name: 'bash', arguments: '{"command":"npm test"}' }));
  await sleep(1150);
  const activityId = host.sends[0].id;
  let last = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.ok(last.text.includes('<b>\u25B8 npm test</b> <code>/workspace</code> <i>running</i>'), `presenter call view: ${last.text}`);

  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }));
  await sleep(1150);
  last = host.edits.filter((e) => e.messageId === activityId).at(-1);
  // Completed rows swap in the ✓ status icon and keep the card title + suffix.
  assert.ok(last.text.includes('<b>\u2713 npm test</b> <code>/workspace</code> exit 0'), `result suffix: ${last.text}`);

  // Failed result flips to ✗ with the failing exit code.
  ctx.emit('agent-1', ev('tool/call', { callId: 'c2', name: 'bash', arguments: '{"command":"false"}' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c2' }, content: [{ type: 'tool-result', isError: true }] } }));
  await sleep(1150);
  last = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.ok(last.text.includes('<b>\u2717 false</b>') && last.text.includes('exit 1'), `failed row: ${last.text}`);
});

test('unknown tools keep the generic fallback row (no registry entry)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'c9', name: 'mystery', arguments: '{"q":"x"}' }));
  await sleep(1150);
  const last = host.edits.filter((e) => e.messageId === host.sends[0].id).at(-1);
  assert.ok(last.text.includes('<b>\u{1F527} mystery</b>'), `generic icon+title: ${last.text}`);
  assert.ok(last.text.includes('<code>{&quot;q&quot;:&quot;x&quot;}</code>'), `raw args as detail: ${last.text}`);
});

test('zero-output turn degrades the placeholder into an outcome notice (#33)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await sleep(20);
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  const noticeEdit = host.edits.filter((e) => e.messageId === host.sends[0].id).at(-1);
  assert.match(noticeEdit.text, /^\u{1F937} Empty response/u);
  assert.equal(host.inboundRepliedMarks, 1, 'the notice satisfies the inbound');
});

test('liveFeed=false disables rendering entirely; core forwarding takes over', async () => {
  const { host, ctx } = await setup();
  host.liveFeed = false;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'hi' } }));
  await settle();
  assert.equal(host.sends.length, 0);
  assert.equal(host.edits.length, 0);
});

test('a restarted turn reuses the previous placeholder message id (#23)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await sleep(20);
  const first = host.sends[0].id;
  ctx.emit('agent-1', ev('turn/start', { turn: 2 }));
  await settle();
  const restartSends = host.sends.length;
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: 'thinking' } }));
  await sleep(1150);
  const editedIds = [...new Set(host.edits.map((e) => e.messageId))];
  assert.equal(restartSends, 1, 'no second placeholder');
  assert.ok(editedIds.includes(first), 'the retained placeholder carries the new turn');
});

test('unbound sessions are ignored', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-other', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(host.sends.length, 0);
});

test('hot teardown clears timers so nothing edits after unmount (#48 teardown)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'partial' } }));
  await settle();
  ctx.disposeAll();
  await settle();
  const editCount = host.edits.length;
  await sleep(1200);
  assert.equal(host.edits.length, editCount, 'no throttled edit fires after teardown');
});

/* ---- HF-1: folding is per (step, index), not per bare index ---- */

test('two-step agentic turn streams and settles BOTH steps\' prose in one bubble (HF-1)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));

  // Step 0: prose streams, then the model calls a tool.
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'First half.' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'c1', name: 'bash', arguments: 'ls' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }));
  await sleep(1150);
  assert.equal(host.sends.length, 2, 'activity placeholder + streamed answer bubble');
  const answerId = host.sends[1].id;
  const step0Edit = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(step0Edit.text.includes('First half'), `step 0 prose streams live: ${step0Edit.text}`);

  // Step 1: chunk.index restarts at 0 — must NOT clobber step 0's block.
  ctx.emit('agent-1', ev('step/start', { turn: 1, step: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Second half.' } }));
  await sleep(1150);
  const streamed = host.edits.filter((e) => e.messageId === answerId).at(-1).text;
  assert.ok(streamed.includes('First half'), `step 0 prose survives the second step: ${streamed}`);
  assert.ok(streamed.includes('Second half'), `step 1 prose streams into the same bubble: ${streamed}`);
  assert.ok(streamed.indexOf('First half') < streamed.indexOf('Second half'), 'steps concatenate in order');

  // Settlement keeps the full concatenation; no duplicate final message.
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  const finalEdit = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(finalEdit.text.includes('First half') && finalEdit.text.includes('Second half'), `settled answer keeps both steps: ${finalEdit.text}`);
  assert.equal(host.sends.length, 2, 'still one activity card + one answer bubble');
  assert.equal(host.inboundRepliedMarks, 1);
});

test('authoritative block-end snapshot lands on its OWN step\'s block (HF-1)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'text-delta', index: 0, text: 'Draft one.' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 0, text: 'Draft two.' } }));
  // Late authoritative snapshot for STEP 0 arrives after step 1 already
  // streamed: it must splice into step 0's slot, not wipe step 1's prose.
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Final one.' } } }));
  await settle(); // let the placeholder send adopt its message id before settlement

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  const answerId = host.sends[1].id;
  const finalEdit = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(finalEdit.text.includes('Final one.'), `snapshot applied to step 0: ${finalEdit.text}`);
  assert.ok(finalEdit.text.includes('Draft two.'), `step 1 prose untouched by the late snapshot: ${finalEdit.text}`);
  assert.ok(finalEdit.text.indexOf('Final one.') < finalEdit.text.indexOf('Draft two.'), '(step, index) order preserved');
  assert.equal(host.sends.length, 2, 'settles into the streamed bubble, no duplicate delivery');
});

test('multi-step reasoning freezes one think line per burst and never leaks into the answer (HF-1)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  // Step 0: a reasoning burst, committed by the tool row at the step boundary.
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 0, chunk: { type: 'reasoning-delta', index: 0, text: 'Plan the work' } }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'c1', name: 'bash', arguments: 'ls' }));
  // Step 1: a NEW reasoning burst reusing index 0, closed by an authoritative block-end.
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'reasoning-delta', index: 0, text: 'Check the output' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'Check the output closely' } } }));
  // Step 1 prose on a different index of the same recycled numbering space.
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'block-start', index: 1, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { turn: 1, step: 1, chunk: { type: 'text-delta', index: 1, text: 'All done.' } }));
  await sleep(1150);

  const activityId = host.sends[0].id;
  const lastActivity = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.ok(lastActivity.text.includes('<i>Plan the work</i>'), `first burst frozen at its boundary: ${lastActivity.text}`);
  // Think behavior unchanged: the frozen line keeps the STREAMED delta tail
  // (a non-empty liveThinkRaw wins over the block-end snapshot).
  assert.ok(lastActivity.text.includes('<i>Check the output</i>'), `second burst frozen by its block-end: ${lastActivity.text}`);

  const answerId = host.sends[1].id;
  const streamedAnswer = host.edits.filter((e) => e.messageId === answerId).at(-1).text;
  assert.ok(streamedAnswer.includes('All done.'), `prose streams: ${streamedAnswer}`);
  assert.ok(!streamedAnswer.includes('Plan the work') && !streamedAnswer.includes('Check the output'), 'reasoning stays out of the answer');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  const receipt = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.match(
    receipt.text,
    /^\u2699\uFE0F (?:<b>)?\u5B8C\u6210(?:<\/b>)? \u00B7 \u23F1\uFE0F 1s \u00B7 \u{1F9E0} 2 \u6B21\u601D\u8003 \u00B7 \u{1F6E0}\uFE0F 1 \u6B21\u5DE5\u5177$/u,
    'both bursts count as reasoning steps',
  );
});

test('single-step turns fold byte-identically with or without explicit step tagging (HF-1)', async () => {
  // Runs must be SEQUENTIAL: mounting a second host unmounts the first.
  const run = async (tagged) => {
    const { host, ctx } = await setup();
    host.inboundPending = true;
    ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
    const frame = tagged ? { turn: 1, step: 0 } : { turn: 1 };
    ctx.emit('agent-1', ev('assistant/chunk', { ...frame, chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
    ctx.emit('agent-1', ev('assistant/chunk', { ...frame, chunk: { type: 'text-delta', index: 0, text: 'Hello' } }));
    ctx.emit('agent-1', ev('assistant/chunk', { ...frame, chunk: { type: 'text-delta', index: 0, text: ' world' } }));
    ctx.emit('agent-1', ev('assistant/chunk', { ...frame, chunk: { type: 'block-end', index: 0, block: { type: 'text', text: 'Hello world' } } }));
    await sleep(1150);
    return host.edits.map((e) => ({ messageId: e.messageId, text: e.text }));
  };
  const legacy = await run(false);
  const tagged = await run(true);
  assert.deepEqual(tagged, legacy, 'explicit step:0 produces the identical edit sequence as the legacy no-step shape');
});

/* ---- HF-2 A: oversized answers deliver IN FULL via the split send path ---- */

test('answer over the transport cap streams a capped tail window and delivers the full text at settlement', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));

  // ~4.6k chars of plain prose: markdownToHtml only escapes/wraps, so the
  // rendered HTML exceeds the 4096 transport cap (getConfigPath stub falls
  // back to the transport default).
  const longText = `HEADMARK ${'a'.repeat(4000)} MIDMARK ${'b'.repeat(500)} ENDMARK`;
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: longText } }));
  await sleep(1150);

  assert.equal(host.sends.length, 2, 'activity placeholder + streamed answer bubble');
  const answerId = host.sends[1].id;
  const streamedEdits = host.edits.filter((e) => e.messageId === answerId);
  assert.ok(streamedEdits.length >= 1, 'long prose still streams live');
  for (const edit of streamedEdits) {
    assert.ok(edit.text.length <= 4096, `mid-stream edits stay under the transport cap, got ${edit.text.length}`);
  }
  const lastStreamed = streamedEdits.at(-1).text;
  assert.ok(lastStreamed.includes('\u2702'), `tail window carries the truncation marker: ${lastStreamed.slice(0, 80)}`);
  assert.ok(lastStreamed.includes('ENDMARK'), 'the tail window keeps the NEWEST prose');
  assert.ok(!lastStreamed.includes('HEADMARK'), 'the stale head is what gets trimmed');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  for (let i = 0; i < 3; i += 1) await settle();

  // Settlement retracts the bubble and delivers the COMPLETE text through
  // the splitting send path (the real transport splits; the stub records one
  // call carrying everything).
  assert.ok(host.deletes.some((d) => d.chatId === 7 && d.messageId === answerId), 'oversize settlement retracts the streamed bubble');
  const finalSends = host.sends.slice(2);
  assert.equal(finalSends.length, 1, 'exactly one delivery of the full answer — no duplicates');
  assert.ok(finalSends[0].text.includes('HEADMARK'), 'full answer keeps its head');
  assert.ok(finalSends[0].text.includes('ENDMARK'), 'full answer keeps its tail');
  assert.equal(finalSends[0].options.reply_parameters?.message_id, 99, 'the re-sent answer still quotes the inbound');
  assert.ok(!host.sends.some((s) => s.text.includes('could not be delivered')), 'no degraded warning — delivery succeeded');
  assert.equal(host.inboundRepliedMarks, 1);
});

/* ---- HF-2 B: in-flight "…" answer placeholders settle or get cleaned up ---- */

test('turn end while the answer send is in flight settles the landing bubble exactly once (HF-2 B)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  assert.equal(host.sends.length, 1, 'activity placeholder landed');

  let releaseAnswer;
  const gated = new Promise((resolve) => { releaseAnswer = resolve; });
  host.sendGate = () => gated;
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'in-flight prose' } }));
  await settle();
  assert.equal(host.sends.length, 1, 'the "…" answer send is still in flight');

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(host.sends.length, 1, 'settlement defers instead of racing a duplicate fresh send');
  assert.equal(host.deletes.length, 0, 'the claimed send is not orphan-deleted');

  releaseAnswer(); // the "…" bubble lands AFTER turn/end handled the chat
  await settle();
  await settle();

  assert.equal(host.sends.length, 2, 'no duplicate fresh-send answer');
  const landedId = host.sends[1].id;
  const settledEdit = host.edits.filter((e) => e.messageId === landedId).at(-1);
  assert.ok(settledEdit.text.includes('in-flight prose'), `landing bubble settles in place: ${settledEdit.text}`);
  assert.equal(host.inboundRepliedMarks, 1);
  assert.equal(host.deletes.length, 0, 'no orphan cleanup needed — the bubble was settled');
});

test('teardown while the answer send is in flight deletes the late-landing "…" orphan (HF-2 B)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();

  let releaseAnswer;
  const gated = new Promise((resolve) => { releaseAnswer = resolve; });
  host.sendGate = () => gated;
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'doomed prose' } }));
  await settle();

  ctx.disposeAll(); // hot teardown clears the chat's turn entry mid-send
  await settle();
  const sendsAtTeardown = host.sends.length;
  releaseAnswer(); // the "…" send lands with no owner turn left
  await settle();
  await settle();

  assert.equal(host.sends.length - sendsAtTeardown, 1, 'exactly the late landing, nothing else sent after teardown');
  assert.equal(host.sends.at(-1).text, '\u2026', 'the late landing is the bare "…" placeholder');
  // The gated answer send resolves to a fresh id; it must be deleted, not stranded.
  assert.deepEqual(host.deletes, [{ chatId: 7, messageId: host.sends.at(-1).id }], 'late "…" placeholder deleted, not stranded');
});

/* ---- HF-2 C: remount must not stack session/event listeners ---- */

test('hot re-apply renders each turn exactly once (HF-2 C)', async () => {
  const host = makeHost();
  const bus = new Map(); // one shared event bus across service rebuilds
  const ctxA = makeCtx(host, { listeners: bus });
  const ctxB = makeCtx(host, { listeners: bus });
  host.requireCtx = () => ctxB;
  const { apply } = await import('../dist/extensions/harness-feed.js');

  apply(ctxA, undefined);
  ctxA.disposeAll(); // config restart: old extension service torn down…
  apply(ctxB, undefined); // …and remounted on the SAME bridge host

  host.inboundPending = true;
  ctxB.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctxB.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctxB.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'once only' } }));
  await sleep(1150);

  // Before the fix the torn-down ctx kept its listener: two mounts rendered
  // every event twice (two placeholders + two answer bubbles).
  assert.equal(bus.get('session/event')?.length, 1, 'exactly one live listener on the bus');
  assert.equal(host.sends.length, 2, 'one placeholder + one answer bubble, not two of each');
  ctxB.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  assert.equal(host.sends.length, 2, 'settlement adds no duplicates');
  assert.equal(host.inboundRepliedMarks, 1, 'the inbound is answered exactly once');
});

/* ---- HF-3 A/B/C: lifecycle vs rendering under outbound.liveFeed ---- */

test('off at turn/start, back on before turn/end: no spurious empty response, no double delivery (HF-3 A)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  host.liveFeed = false;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'real answer' } }));
  await settle();
  assert.equal(host.sends.length, 0, 'disabled at start: nothing rendered');

  host.liveFeed = true; // user flips the flag back BEFORE turn/end
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  // Pre-fix the dropped turn/start left no entry, so the no-draft branch
  // pushed "🤷 Empty response" even though the core forwarded the real answer.
  assert.equal(host.sends.length, 0, 'no spurious Empty response push, no duplicated delivery');
  assert.equal(host.edits.length, 0, 'stale renders are not resurrected for a turn that never rendered');
  assert.equal(host.inboundRepliedMarks, 0, 'inbound lifecycle stays with the core forwarder while disabled');
});

test('errored turn with streamed prose deletes the placeholder instead of a success receipt (HF-3 B)', async () => {
  const { host, ctx } = await setup();
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('tool/call', { callId: 'c1', name: 'bash', arguments: 'ls' }));
  ctx.emit('agent-1', ev('tool/result', { message: { source: { kind: 'tool', callId: 'c1' }, content: [{ type: 'tool-result', isError: false }] } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: 'partial prose then death' } }));
  await sleep(1150);
  const activityId = host.sends[0].id;
  const answerId = host.sends[1].id;

  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'error', error: { message: 'boom' } } }));
  await settle();

  // HF-3 B chose SUPPRESS over a failure-flavored receipt: the core bridge's
  // classified ❌ message is the single outcome voice (#37).
  assert.ok(!host.edits.some((e) => e.text.includes('\u5B8C\u6210')), `no \u2699\uFE0F 完成 receipt next to the core failure: ${JSON.stringify(host.edits.map((e) => e.text))}`);
  assert.ok(host.deletes.some((d) => d.chatId === 7 && d.messageId === activityId), 'placeholder takes the delete path instead of the success receipt');
  // Pre-existing behavior untouched: whatever streamed still settles into its own bubble.
  const finalEdit = host.edits.filter((e) => e.messageId === answerId).at(-1);
  assert.ok(finalEdit.text.includes('partial prose then death'), `partial stream still settles in place: ${finalEdit.text}`);
});

test('quiet reasoning block-end flushes the frozen Think line by itself (HF-3 C)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;

  // Live tail streams first…
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'reasoning-delta', index: 0, text: 'first thought\nsecond thought' } }));
  await sleep(1150);
  const liveEdit = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.ok(liveEdit?.text.includes('<i>second thought</i>'), `live tail streams: ${liveEdit?.text}`);

  // …then the block-end freezes the burst: it CLEARS liveThinkRaw and moves
  // no answerText, so neither post-fold schedule condition can fire. Pre-fix
  // the frozen snapshot waited for an unrelated event that never came.
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'first thought\nsecond thought' } } }));
  await sleep(1150);
  const frozenEdit = host.edits.filter((e) => e.messageId === activityId).at(-1);
  assert.notEqual(frozenEdit, liveEdit, 'the freeze produced its own frame');
  assert.ok(frozenEdit.text.includes('<i>first thought</i>'), `frozen first-line flushed by the commit itself: ${frozenEdit.text}`);
});

test('authoritative reasoning block-end without any delta still renders the frozen line (HF-3 C)', async () => {
  const { host, ctx } = await setup();
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  await settle();
  const activityId = host.sends[0].id;

  // Provider shortcut: the complete reasoning block lands with no prior
  // reasoning-delta, so liveThinkRaw was never non-empty while streaming.
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'only line' } } }));
  await sleep(1150);
  assert.ok(
    host.edits.some((e) => e.messageId === activityId && e.text.includes('<i>only line</i>')),
    `frozen Think line rendered without any later event: ${JSON.stringify(host.edits.map((e) => e.text))}`,
  );
});
