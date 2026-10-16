import test from 'node:test';
import assert from 'node:assert/strict';
import { TokenRegistry } from '../dist/telegram/tokens.js';

test('callback tokens round-trip payloads and are strictly single-use', () => {
  const registry = new TokenRegistry();
  const cb = registry.mint({ action: 'session-delete-confirm', sessionId: 's-1' });
  assert.match(cb, /^t:\d+$/);
  assert.deepEqual(registry.take(cb), { action: 'session-delete-confirm', sessionId: 's-1' });
  assert.equal(registry.take(cb), undefined, 'a consumed token must not execute twice');
  assert.equal(registry.wasUsed(cb), true);
  assert.equal(registry.wasUsed('t:1234567890'), false);
});

test('the token registry evicts the oldest live entry while staying bounded', () => {
  const registry = new TokenRegistry(3);
  const first = registry.mint({ action: 'a' });
  registry.mint({ action: 'b' });
  registry.mint({ action: 'c' });
  const fourth = registry.mint({ action: 'd' });
  assert.equal(registry.pending(), 3);
  assert.equal(registry.take(first), undefined, 'the oldest token was evicted');
  assert.deepEqual(registry.take(fourth), { action: 'd' });
});

test('a failed callback can restore its token exactly once for retry', () => {
  const registry = new TokenRegistry();
  const cb = registry.mint({ action: 'model-select', provider: 'opencode-go', model: 'x' });
  const payload = registry.take(cb);
  assert.ok(payload);
  assert.equal(registry.wasUsed(cb), true);
  assert.equal(registry.restore(cb, payload), true);
  assert.equal(registry.wasUsed(cb), false);
  assert.deepEqual(registry.take(cb), { action: 'model-select', provider: 'opencode-go', model: 'x' });
  // A token can be restored after every failed attempt; unknown tokens and
  // tokens that are still live can never be restored.
  assert.equal(registry.restore('t:1234567890', { action: 'x' }), false);
  assert.equal(registry.restore(cb, payload), true, 'a retried callback that fails again stays retryable');
});

test('reset clears both the live and the handled ledgers', () => {
  const registry = new TokenRegistry();
  const cb = registry.mint({ action: 'x' });
  assert.deepEqual(registry.take(cb), { action: 'x' });
  registry.reset();
  assert.equal(registry.wasUsed(cb), false);
  assert.equal(registry.pending(), 0);
});
