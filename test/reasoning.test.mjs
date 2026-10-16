import test from 'node:test';
import assert from 'node:assert/strict';
import { REASONING_DEFAULT, REASONING_EFFORTS, isReasoningEffort, reasoningDirective, reasoningLabel } from '../dist/reasoning.js';

test('reasoning has the five fixed codex levels with medium default', () => {
  assert.deepEqual([...REASONING_EFFORTS], ['minimal', 'low', 'medium', 'high', 'max']);
  assert.equal(REASONING_DEFAULT, 'medium');
});

test('directives: medium is empty, high/max steer deliberation', () => {
  assert.equal(reasoningDirective('medium'), '');
  assert.ok(reasoningDirective('high').includes('carefully'));
  assert.ok(reasoningDirective('max').includes('rigor'));
  assert.ok(reasoningDirective('minimal').includes('briefly'));
});

test('labels and guards', () => {
  assert.equal(reasoningLabel('high'), 'High');
  assert.equal(reasoningLabel('max'), 'Max');
  assert.equal(isReasoningEffort('high'), true);
  assert.equal(isReasoningEffort('ultra'), false);
  assert.equal(isReasoningEffort(undefined), false);
});
