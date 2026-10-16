import test from 'node:test';
import assert from 'node:assert/strict';

/** The retired `dsh-telegram/extensions/openclaw` entry is a deprecated shim
 * over the harness-native feed: existing loader profiles must keep working
 * and must never double-mount against the built-in feed. */
test('openclaw entry re-binds the harness feed under the legacy names', async () => {
  const legacy = await import('../dist/extensions/openclaw.js');
  const modern = await import('../dist/extensions/harness-feed.js');
  assert.equal(legacy.apply, modern.apply);
  assert.equal(legacy.inject, modern.inject);
  assert.equal(legacy.mountOpenclawFeed, modern.mountHarnessFeed);
  assert.equal(legacy.unmountOpenclawFeed, modern.unmountHarnessFeed);
});

test('legacy loader mount and builtin mount share one singleton (no double feed)', async () => {
  const listeners = new Map();
  const sends = [];
  let nextId = 1;
  const host = {
    sends,
    edits: [],
    deletes: [],
    liveFeed: true,
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    liveFeedEnabled: () => host.liveFeed !== false,
    bindAgent: () => {},
    unbindChat: () => {},
    send: async (chatId, text) => {
      const id = nextId++;
      sends.push({ chatId, text, id });
      return id;
    },
    editMessage: async () => true,
    deleteMessage: async () => {},
    attachFeedback: () => {},
    statusStats: () => undefined,
    setAssistantConsumer: () => {},
    pendingInbound: () => false,
    inboundMessageId: () => undefined,
    markInboundReplied: () => {},
    stopLiveFeed: undefined,
    goalForChat: () => undefined,
    getConfigPath: () => true,
  };
  const ctx = {
    telegram: host,
    get: () => undefined,
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
    effect: (_fn) => () => {},
    emit: (sessionId, event) => {
      for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
    },
  };
  const legacy = await import('../dist/extensions/openclaw.js');
  const modern = await import('../dist/extensions/harness-feed.js');

  modern.apply(ctx, undefined);
  legacy.apply(ctx, undefined); // second mount through the shim: no-op
  ctx.emit('agent-1', { type: 'turn/start', data: { turn: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(sends.length, 1, 'exactly one placeholder despite two apply calls');
});
