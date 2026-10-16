import test from 'node:test';
import assert from 'node:assert/strict';
import { listSkills } from '../dist/harness/adapters/skills.js';

function summary(overrides = {}) {
  return {
    name: 'git-review',
    description: 'review git changes',
    whenToUse: 'before committing',
    source: 'project',
    provider: 'filesystem',
    invocation: { model: true, user: true },
    ...overrides,
  };
}

test('listSkills passes the sessionId option like web skill.list', async () => {
  const calls = [];
  const ctx = {
    get: (name) => (name === 'skills' ? {
      list: async (options) => {
        calls.push(options);
        return [summary()];
      },
    } : undefined),
  };
  const skills = await listSkills(ctx, 'session-1');
  assert.deepEqual(calls, [{ sessionId: 'session-1' }]);
  assert.equal(skills.length, 1);
  assert.equal(skills[0].modelInvocable, true);
  assert.equal(skills[0].userInvocable, true);
});

test('listSkills supports alternate invocation shapes and defaults', async () => {
  const ctx = {
    get: (name) => (name === 'skills' ? {
      list: async () => [
        summary({ name: 'alt', invocation: { modelInvocable: false, userInvocable: true } }),
        summary({ name: 'plain', invocation: undefined }),
        summary({ name: 'model-only', invocation: { model: true, user: false } }),
      ],
    } : undefined),
  };
  const skills = await listSkills(ctx);
  assert.equal(skills[0].modelInvocable, false);
  assert.equal(skills[1].modelInvocable, true);
  assert.equal(skills[2].userInvocable, false);
});

test('listSkills degrades without the service or on list errors', async () => {
  assert.deepEqual(await listSkills({ get: () => undefined }), []);
  assert.deepEqual(await listSkills({ get: () => ({ list: async () => { throw new Error('boom'); } }) }), []);
});
