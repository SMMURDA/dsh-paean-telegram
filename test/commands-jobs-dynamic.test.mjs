import test from 'node:test';
import assert from 'node:assert/strict';
import { listJobs } from '../dist/harness/adapters/jobs.js';
import { listCommands, executeCommand } from '../dist/harness/adapters/commands.js';
import { listDynamicCordis } from '../dist/harness/adapters/dynamicCordis.js';

test('listJobs delegates the caller agent and degrades without the service', () => {
  const agent = { id: 'agent-1' };
  let caller;
  const jobs = [{ id: 'j1', kind: 'subagent', label: 'one', status: 'running', startedAt: 1 }];
  const ctx = {
    agents: { get: (id) => (id === 'agent-1' ? agent : undefined) },
    get: (name) => (name === 'jobs' ? { list: (received) => { caller = received; return jobs; } } : undefined),
  };
  assert.deepEqual(listJobs(ctx, 'agent-1'), jobs);
  assert.equal(caller, agent);
  assert.deepEqual(listJobs({ get: () => undefined }), []);
});

test('listCommands projects name/description/input hint and degrades', () => {
  const agent = { id: 'agent-1' };
  const ctx = {
    get: (name) => (name === 'commands' ? { list: () => [{ name: 'foo', description: 'bar', input: { hint: 'hint' } }, { name: 'no-hint', description: 'x' }] } : undefined),
  };
  assert.deepEqual(listCommands(ctx, agent), [
    { name: 'foo', description: 'bar', input: 'hint' },
    { name: 'no-hint', description: 'x' },
  ]);
  assert.deepEqual(listCommands({ get: () => undefined }, agent), []);
});

test('executeCommand mirrors web success/error/unknown outcomes', async () => {
  const agent = { id: 'agent-1' };
  const ctx = {
    get: (name) => (name === 'commands' ? {
      execute: async (_agent, line) => {
        if (line === '/ok') return { kind: 'success', text: 'done' };
        if (line === '/bad') return { kind: 'error', message: 'failed' };
        return undefined;
      },
    } : undefined),
  };
  assert.deepEqual(await executeCommand(ctx, agent, '/ok'), { ok: true, text: 'done' });
  assert.equal((await executeCommand(ctx, agent, '/bad')).ok, false);
  assert.match((await executeCommand(ctx, agent, '/ghost')).text, /unknown or malformed/);
  assert.equal((await executeCommand({ get: () => undefined }, agent, '/ok')).ok, false);
});

test('listDynamicCordis returns inventory and swallows missing/throwy seams', () => {
  assert.deepEqual(listDynamicCordis({ get: () => undefined }), []);
  assert.deepEqual(listDynamicCordis({ get: () => ({ inventory: () => { throw new Error('boom'); } }) }), []);
  assert.deepEqual(listDynamicCordis({ get: () => ({ inventory: () => [{ pluginId: 'p1', status: 'running' }] }) }), [{ pluginId: 'p1', status: 'running' }]);
});

test('listDynamicCordis reads a runner whose lifecycle seams hang (IA-2)', () => {
  // Inventory stays synchronous and unbounded on purpose (a sync hang would
  // block the event loop before any timer could fire); the lifecycle deadline
  // must not latch or otherwise disturb these read paths.
  const hungLifecycle = {
    inventory: () => [{ pluginId: 'p-live' }, { pluginId: '' }, { agentId: 'no-id' }],
    run: () => new Promise(() => {}),
    stop: () => new Promise(() => {}),
    undefine: () => new Promise(() => {}),
  };
  assert.deepEqual(listDynamicCordis({ get: (name) => (name === 'dynamicCordisRunner' ? hungLifecycle : undefined) }), [
    { pluginId: 'p-live' },
  ]);
});
