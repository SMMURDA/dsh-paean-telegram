// Durable chat→session bindings (core/chat-bindings.ts) + Bridge.onBind.
//
// Regression context: bindings were memory-only, so every bot restart
// unbound every chat — /history answered "none bound" and a Models tap
// auto-CREATED a session instead of switching the model in-session.

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function makeBridge(onBind) {
  const { Bridge } = await import('../dist/harness/bridge.js');
  const ctx = {
    agents: {
      get: (id) => ({ id }),
      list: () => [],
    },
    on: () => () => {},
  };
  const transport = { sendText: async () => 1 };
  const bridge = new Bridge({
    ctx,
    transport,
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onBind,
    log: () => {},
  });
  bridge.attach();
  return bridge;
}

test('onBind fires on new/changed binds, stays quiet on repeats, and reports unbinds', async () => {
  const events = [];
  const bridge = await makeBridge((chatId, agentId) => events.push([chatId, agentId]));
  bridge.bindAgent(1, 'agent-a');
  assert.deepEqual(events.at(-1), [1, 'agent-a']);
  // Same binding again (every inbound message re-touches): no new event.
  bridge.bindAgent(1, 'agent-a');
  assert.equal(events.filter(([, id]) => id === 'agent-a').length, 1);
  // Changed binding: fires once with the new id.
  bridge.bindAgent(1, 'agent-b');
  assert.deepEqual(events.at(-1), [1, 'agent-b']);
  // Unbind: agentId undefined.
  bridge.bindAgent(1, undefined);
  assert.deepEqual(events.at(-1), [1, undefined]);
});

test('saveChatBinding + readChatBindings round-trip, unbind, prune and tolerate corruption', async () => {
  const { saveChatBinding, readChatBindings, bindingsFilePath } = await import('../dist/core/chat-bindings.js');
  const root = mkdtempSync(join(tmpdir(), 'tg-bindings-'));
  try {
    saveChatBinding(root, 100, 'session-a');
    saveChatBinding(root, 200, 'session-b');
    assert.deepEqual(readChatBindings(root), {
      '100': { agentId: 'session-a', at: readChatBindings(root)['100'].at },
      '200': { agentId: 'session-b', at: readChatBindings(root)['200'].at },
    });
    // Unbind removes exactly the one chat.
    saveChatBinding(root, 100, undefined);
    assert.equal(readChatBindings(root)['100'], undefined);
    assert.equal(readChatBindings(root)['200'].agentId, 'session-b');

    // Corrupt file reads as empty instead of throwing.
    writeFileSync(bindingsFilePath(root), '{not json', 'utf8');
    assert.deepEqual(readChatBindings(root), {});
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('readChatBindings drops expired entries', async () => {
  const { readChatBindings, bindingsFilePath } = await import('../dist/core/chat-bindings.js');
  const root = mkdtempSync(join(tmpdir(), 'tg-bindings-ttl-'));
  try {
    const fresh = Date.now();
    const stale = fresh - 31 * 24 * 60 * 60 * 1000;
    mkdirSync(join(root, '.pi'), { recursive: true });
    writeFileSync(
      bindingsFilePath(root),
      JSON.stringify({ '1': { agentId: 'old', at: stale }, '2': { agentId: 'new', at: fresh } }),
      'utf8',
    );
    const bindings = readChatBindings(root);
    assert.equal(bindings['1'], undefined);
    assert.equal(bindings['2'].agentId, 'new');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
