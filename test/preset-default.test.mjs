import test from 'node:test';
import assert from 'node:assert/strict';
import { setDefaultAgentPreset } from '../dist/harness/adapters/presets.js';

test('setDefaultAgentPreset writes the agent-presets settings default', async () => {
  let mutated;
  const ctx = {
    get: (name) => (name === 'settings' ? { mutate: async (ns, ops) => { mutated = { ns, ops }; } } : undefined),
  };
  const res = await setDefaultAgentPreset(ctx, 'standard');
  assert.equal(res.ok, true);
  assert.equal(mutated.ns, 'agent-presets');
  assert.deepEqual(mutated.ops, [{ op: 'set', path: ['default'], value: 'standard' }]);
});

test('setDefaultAgentPreset fails gracefully without settings', async () => {
  const res = await setDefaultAgentPreset({ get: () => undefined }, 'standard');
  assert.equal(res.ok, false);
});

test('setDefaultAgentPreset propagates errors', async () => {
  const ctx = { get: () => ({ mutate: async () => { throw new Error('no-write'); } }) };
  const res = await setDefaultAgentPreset(ctx, 'standard');
  assert.equal(res.ok, false);
  assert.ok(res.text.includes('no-write'));
});
