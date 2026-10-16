import test from 'node:test';
import assert from 'node:assert/strict';
import { createGoal, editGoal, getGoal, pauseGoal, clearGoal } from '../dist/harness/adapters/goals.js';

function makeCtx() {
  const calls = [];
  const current = { id: 'goal-1', revision: 3, objective: 'ship it', phase: 'active', activation: 'armed', roundsStarted: 1, createdAt: 1, updatedAt: 2 };
  const service = {
    current,
    calls,
    get: () => current,
    create: (agent, request) => {
      calls.push({ op: 'create', request });
      return { ...current, objective: request.objective, maxGoalRounds: request.maxGoalRounds };
    },
    edit: (agent, ref, request) => {
      calls.push({ op: 'edit', ref, request });
      return { ...current, ...(request.objective === undefined ? {} : { objective: request.objective }), ...(request.maxGoalRounds === undefined ? {} : { maxGoalRounds: request.maxGoalRounds }) };
    },
    pause: (agent, ref) => {
      calls.push({ op: 'pause', ref });
      return { ...current, phase: 'paused' };
    },
    clear: (agent, ref) => {
      calls.push({ op: 'clear', ref });
      return { id: ref.id, revision: ref.revision + 1 };
    },
  };
  const agent = { id: 'agent-1' };
  return {
    agent,
    service,
    ctx: {
      agents: { get: () => agent },
      get: (name) => (name === 'goals' ? service : undefined),
    },
  };
}

test('createGoal forwards objective and optional maxGoalRounds', async () => {
  const { ctx, service } = makeCtx();
  const res = await createGoal(ctx, 'agent-1', 'build the bot', 5);
  assert.equal(res.ok, true);
  assert.deepEqual(service.calls[0].request, { objective: 'build the bot', maxGoalRounds: 5 });
});

test('editGoal supports maxGoalRounds and keeps objective optional', async () => {
  const { ctx, service } = makeCtx();
  const withMax = await editGoal(ctx, 'agent-1', 'goal-1', 3, { objective: 'new objective', maxGoalRounds: 9 });
  assert.equal(withMax.ok, true);
  assert.deepEqual(service.calls[0].request, { objective: 'new objective', maxGoalRounds: 9 });

  const objectiveOnly = await editGoal(ctx, 'agent-1', 'goal-1', 3, { objective: 'just text' });
  assert.deepEqual(service.calls[1].request, { objective: 'just text' });
});

test('getGoal and pauseGoal address the exact live agent', async () => {
  const { ctx, service } = makeCtx();
  assert.equal(getGoal(ctx, 'agent-1').id, 'goal-1');
  const res = await pauseGoal(ctx, 'agent-1', 'goal-1', 3);
  assert.equal(res.ok, true);
  assert.equal(service.calls[0].op, 'pause');
});

test('goal adapters degrade with readable errors', async () => {
  const ctx = { agents: undefined, get: () => undefined };
  assert.equal(getGoal(ctx, 'agent-1'), undefined);
  assert.equal((await createGoal(ctx, 'agent-1', 'x')).ok, false);
  assert.equal((await editGoal(ctx, 'agent-1', 'g', 1, { objective: 'x' })).ok, false);
});

test('clearGoal reports the revision without pretending a live view remains', async () => {
  const { ctx, service } = makeCtx();
  const res = await clearGoal(ctx, 'agent-1', 'goal-1', 3);
  assert.equal(res.ok, true);
  assert.match(res.text, /Goal cleared/);
  assert.equal(service.calls[0].op, 'clear');
});
