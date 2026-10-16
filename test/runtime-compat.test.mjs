/**
 * Runtime-shape compatibility (dsh 0.2.1-alpha.1 vs the 0.1.1-rc.2 seams this
 * plugin was written against).
 *
 * Real incident: tapping "Sessions" in Telegram answered
 * `sessions roster load failed: session.events is not iterable`. The host's
 * `Session` no longer carries an `events` array — it materializes the log
 * through `snapshotEvents()` — so every fold threw (and a function is not
 * iterable). The same release renamed the event timestamp `at` → `time` and
 * replaced `sessionPersistence.readRaw(id)` with `open(id, 'read')` plus
 * snapshot rows (`{ header, revision }`) from `list()`.
 *
 * These tests pin the NEW shapes; the pre-existing suites keep pinning the old
 * ones, so together they prove one build serves both hosts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { listSessionDetails, searchSessions, readTrajectory } from '../dist/harness/adapters/sessions.js';
import { forkSession } from '../dist/harness/adapters/session-lifecycle.js';
import { sessionHasStarted } from '../dist/harness/adapters/presets.js';
import { listTodos } from '../dist/harness/adapters/todos.js';
import { contextUsageOf } from '../dist/harness/adapters/compaction-watch.js';

/** A live session in the CURRENT host shape: log behind `snapshotEvents()`. */
function liveSession(id, events, cwd = '/proj/alpha') {
  return { id, header: { cwd }, snapshotEvents: () => events };
}

function ctxWith({ sessions = [], agents = [], persistence, sessionTitle } = {}) {
  const agentMap = new Map(agents.map((agent) => [String(agent.id), agent]));
  return {
    agents: {
      list: () => [...agentMap.values()],
      get: (id) => agentMap.get(String(id)),
    },
    get: (name) => {
      if (name === 'sessions') {
        return { list: () => sessions, get: (id) => sessions.find((session) => String(session.id) === String(id)) };
      }
      if (name === 'sessionPersistence') return persistence;
      if (name === 'sessionTitle') return sessionTitle;
      return undefined;
    },
  };
}

test('sessions roster reads a snapshotEvents()-only live session (the reported crash)', async () => {
  const sessions = [
    liveSession('s-old', [{ seq: 0, type: 'user/message', time: 100, data: { content: [{ type: 'text', text: 'old prompt' }] } }]),
    liveSession('s-new', [
      { seq: 0, type: 'session/title', time: 50, data: { title: 'Newest work' } },
      { seq: 1, type: 'user/message', time: 300, data: { content: [{ type: 'text', text: 'new prompt' }] } },
    ]),
    liveSession('s-blank', []),
  ];
  const details = await listSessionDetails(ctxWith({ sessions }));

  // Recency order comes from the `time` field (the old `at` read would leave
  // every row at -Infinity and fall back to id order).
  assert.deepEqual(details.map((entry) => entry.id), ['s-new', 's-old', 's-blank']);
  assert.equal(details[0].title, 'Newest work');
  assert.equal(details[0].lastPromptAt, 300);
  assert.equal(details[0].eventCount, 2);
  assert.equal(details[0].blank, false);
  assert.equal(details[0].live, true);
  assert.equal(details[0].cwd, '/proj/alpha');
  assert.equal(details[1].lastPromptAt, 100);
  assert.equal(details[2].blank, true);
  assert.equal(details[2].eventCount, 0);
});

test('sessions roster reads the legacy events-array session identically', async () => {
  const events = [
    { seq: 0, type: 'user/message', at: 700, data: { content: [{ type: 'text', text: 'legacy prompt' }] } },
  ];
  const details = await listSessionDetails(ctxWith({ sessions: [{ id: 's-legacy', header: { cwd: '/proj/alpha' }, events }] }));
  assert.equal(details.length, 1);
  assert.equal(details[0].lastPromptAt, 700);
  assert.equal(details[0].eventCount, 1);
});

test('sessions roster reads cold logs through persistence open()/list() snapshots', async () => {
  const persistence = {
    list: async () => [
      { header: { id: 'cold-1', cwd: '/proj/beta' }, revision: 'rev-1', eventCount: 2 },
      { header: { id: 'cold-2', cwd: '/proj/beta' }, revision: 'rev-2' },
    ],
    open: async (id) => ({
      read: async () => ({
        events: String(id) === 'cold-1'
          ? [
              { seq: 0, type: 'session/title', time: 10, data: { title: 'Cold one' } },
              { seq: 1, type: 'user/message', time: 500, data: { content: [{ type: 'text', text: 'cold prompt' }] } },
            ]
          : [],
      }),
      close: async () => {},
    }),
  };
  const details = await listSessionDetails(ctxWith({ persistence }));
  const cold = details.find((entry) => entry.id === 'cold-1');
  assert.ok(cold, 'cold roster row must render');
  assert.equal(cold.title, 'Cold one');
  assert.equal(cold.cwd, '/proj/beta');
  assert.equal(cold.lastPromptAt, 500);
  assert.equal(cold.eventCount, 2);
  assert.equal(cold.live, false);
  assert.ok(details.some((entry) => entry.id === 'cold-2'), 'an empty cold log still lists');
});

test('a cold log that cannot be opened does not kill the whole roster', async () => {
  const persistence = {
    list: async () => [
      { header: { id: 'good', cwd: '/proj/beta' }, revision: 'r1' },
      { header: { id: 'broken', cwd: '/proj/beta' }, revision: 'r2' },
    ],
    open: async (id) => {
      if (String(id) === 'broken') throw new Error('log unreadable');
      return { read: async () => ({ events: [{ seq: 0, type: 'user/message', time: 42, data: {} }] }), close: async () => {} };
    },
  };
  const details = await listSessionDetails(ctxWith({ persistence }));
  assert.deepEqual(details.map((entry) => entry.id), ['good']);
  assert.equal(details[0].lastPromptAt, 42);
});

test('search scans a snapshotEvents()-only live session', async () => {
  const sessions = [
    liveSession('s-live', [
      { seq: 0, type: 'user/message', time: 1, data: { content: [{ type: 'text', text: 'find the needle here' }] } },
    ]),
  ];
  const hits = await searchSessions(ctxWith({ sessions }), 'needle');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].sessionId, 's-live');
  assert.equal(hits[0].live, true);
});

test('trajectory derives turn duration from the time field', async () => {
  const sessions = [
    liveSession('s-trajectory', [
      { seq: 0, type: 'turn/start', time: 1000, data: { turn: 1 } },
      { seq: 1, type: 'user/message', time: 1100, data: { content: [{ type: 'text', text: 'hi' }] } },
      { seq: 2, type: 'turn/end', time: 4000, data: { turn: 1, reason: { kind: 'completed' } } },
    ]),
  ];
  const trajectory = await readTrajectory(ctxWith({ sessions }), 's-trajectory');
  assert.equal(trajectory.turns.length, 1);
  assert.equal(trajectory.turns[0].seconds, 3);
  assert.equal(trajectory.turns[0].outcome, 'completed');
});

test('todos, preset-blank check and fork boundary all read the snapshot log', async () => {
  const events = [
    { seq: 0, type: 'turn/start', time: 10, data: { turn: 0 } },
    { seq: 1, type: 'todo/write', time: 20, data: { todos: [{ content: 'ship it', status: 'pending' }] } },
    { seq: 2, type: 'turn/end', time: 30, data: { turn: 0, reason: { kind: 'completed' } } },
  ];
  const agent = { id: 's-agent', status: 'idle', session: liveSession('s-agent', events) };
  const forked = [];
  const ctx = ctxWith({ sessions: [agent.session], agents: [agent] });
  ctx.get = ((inner) => (name) => {
    if (name === 'sessions') {
      return {
        list: () => [agent.session],
        get: (id) => (String(id) === 's-agent' ? agent.session : undefined),
        fork: (source, boundary, childId) => {
          forked.push({ source: String(source), boundary, childId: String(childId) });
          return { id: childId };
        },
      };
    }
    return inner(name);
  })(ctx.get);

  assert.deepEqual(listTodos(ctx, 's-agent').map((todo) => todo.content), ['ship it']);
  assert.equal(sessionHasStarted(ctx, 's-agent'), true);
  const fork = forkSession(ctx, 's-agent', 3);
  assert.equal(fork.ok, true);
  assert.equal(forked[0].boundary, 2, 'the fork boundary must come from the snapshot log');
});

test('context usage reads the agent session and the settled assistant usage', () => {
  const agent = {
    id: 's-ctx',
    session: liveSession('s-ctx', [
      { seq: 0, type: 'request/context', time: 1, data: { contextWindow: 1000 } },
      { seq: 1, type: 'assistant/message', time: 2, data: { usage: { inputTokens: 500, cacheReadTokens: 300, cacheWriteTokens: 0 } } },
    ]),
  };
  const usage = contextUsageOf(agent);
  assert.equal(usage.window, 1000);
  assert.equal(usage.used, 800);
  assert.equal(usage.ratio, 0.8);
});

test('a session that cannot materialize its log degrades to an empty roster', async () => {
  const sessions = [
    {
      id: 's-throwing',
      header: { cwd: '/proj/alpha' },
      snapshotEvents: () => {
        throw new Error('log detached');
      },
    },
  ];
  const details = await listSessionDetails(ctxWith({ sessions }));
  assert.equal(details.length, 1);
  assert.equal(details[0].id, 's-throwing');
  assert.equal(details[0].eventCount, 0);
  assert.equal(details[0].blank, true);
});
