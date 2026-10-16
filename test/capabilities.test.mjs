import test from 'node:test';
import assert from 'node:assert/strict';
import { probeCapabilities, missingServices, CAPABILITY_LABELS } from '../dist/harness/adapters/capabilities.js';

function fakeCtx(present) {
  const services = new Map(present.map((name) => [name, {}]));
  return { get: (name) => services.get(name) };
}

test('probeCapabilities reports every known service as absent by default', () => {
  const caps = probeCapabilities(fakeCtx([]));
  for (const key of Object.keys(CAPABILITY_LABELS)) {
    assert.equal(caps[key], false, key);
  }
});

test('probeCapabilities reports composed services as present', () => {
  const caps = probeCapabilities(fakeCtx(['sessions', 'goals', 'skills']));
  assert.equal(caps.sessions, true);
  assert.equal(caps.goals, true);
  assert.equal(caps.skills, true);
  assert.equal(caps.llm, false);
});

test('missingServices lists only the absent ones', () => {
  const missing = missingServices(fakeCtx(['sessions']));
  assert.equal(missing.includes('sessions'), false);
  assert.equal(missing.includes('llm'), true);
  assert.equal(missing.includes('goals'), true);
});
