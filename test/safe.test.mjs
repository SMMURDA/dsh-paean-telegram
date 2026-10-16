import test from 'node:test';
import assert from 'node:assert/strict';
import { safeWrap } from '../dist/telegram/safe.js';

test('safeWrap logs failures with label and never rejects (#13)', async () => {
  const logs = [];
  const result = await safeWrap('test-op', async () => {
    throw new Error('boom');
  }, (message, error) => logs.push({ message, error }));
  assert.equal(result, undefined);
  assert.equal(logs.length, 1);
  assert.match(logs[0].message, /test-op FAILED/);
  assert.match(logs[0].error, /boom/);
});

test('safeWrap passes through successful values', async () => {
  assert.equal(await safeWrap('ok-op', async () => 42, () => {}), 42);
});
