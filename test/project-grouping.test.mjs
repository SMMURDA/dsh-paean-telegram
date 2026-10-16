import test from 'node:test';
import assert from 'node:assert/strict';

// ---------------------------------------------------------------------------
// Project grouping must not split one project into look-alike groups.
//
// User report (#4): after selecting the dsh-telegram project, sessions kept
// appearing under a separate bucket ("Ungrouped"/shadow copy) instead of the
// project group. Root cause: the host workspace registry folds new sessions
// into `sessionIds` lazily (boot-time reconciliation), so live sessions are
// routinely unclaimed while their cwd already equals the workspace path —
// and the old grouping fell straight through to a cwd pseudo project,
// producing "dsh-telegram" beside "dsh-telegram (cx)".
//
// Contract now: an unclaimed session whose cwd matches a known group path
// joins THAT group; only truly unknown cwds spawn pseudo projects, and
// cwd-less sessions still trail under __ungrouped__.
// ---------------------------------------------------------------------------
const { groupSessionsByProject, orderProjectGroups, UNGROUPED_KEY } = await import('../dist/harness/adapters/session-render.js');

function detail(id, cwd, extra = {}) {
  return {
    id,
    cwd,
    live: false,
    running: false,
    title: undefined,
    blank: true,
    lastPromptAt: undefined,
    eventCount: 0,
    archived: false,
    ...extra,
  };
}

const WS = { workspaceId: 'ws-1', title: 'dsh-telegram', path: '/Users/cx/dsh-telegram', sessionIds: ['session-a'] };

test('unclaimed sessions with the workspace cwd join the project group (no shadow duplicate)', () => {
  const details = [
    detail('session-a', '/Users/cx/dsh-telegram'),
    detail('telegram-live-1', '/Users/cx/dsh-telegram'),
    detail('subagent-child', '/Users/cx/dsh-telegram'),
  ];
  const groups = groupSessionsByProject(details, [WS]);
  assert.equal(groups.length, 1, `expected one merged group, got ${groups.map((g) => g.label).join(', ')}`);
  assert.equal(groups[0].label, 'dsh-telegram');
  assert.equal(groups[0].workspaceId, 'ws-1');
  assert.deepEqual(groups[0].sessions.map((s) => s.id).sort(), ['session-a', 'subagent-child', 'telegram-live-1']);
});

test('trailing-separator variants of the workspace path still merge', () => {
  const details = [detail('t1', '/Users/cx/dsh-telegram/')];
  const groups = groupSessionsByProject(details, [{ ...WS, sessionIds: [] }]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].label, 'dsh-telegram');
});

test('an unknown cwd still spawns its own pseudo project', () => {
  const details = [
    detail('s1', '/Users/cx/dsh-telegram'),
    detail('x1', '/Users/cx/other-project'),
  ];
  const groups = groupSessionsByProject(details, [{ ...WS, sessionIds: ['s1'] }]);
  const labels = groups.map((g) => g.label);
  assert.ok(labels.includes('dsh-telegram'));
  assert.ok(labels.includes('other-project'));
  assert.equal(groups.length, 2);
});

test('two same-basename pseudo projects stay disambiguated and register their paths separately', () => {
  const details = [
    detail('a1', '/Users/cx/work/dsh-telegram'),
    detail('b1', '/Users/cx/dsh-telegram'),
  ];
  // No workspaces at all: both fall to pseudo projects keyed by cwd.
  const groups = groupSessionsByProject(details, []);
  assert.equal(groups.length, 2);
  const labels = groups.map((g) => g.label).sort();
  assert.deepEqual(labels, ['dsh-telegram', 'dsh-telegram (cx)']);
  // Each pseudo group keeps exactly its own session.
  for (const group of groups) assert.equal(group.sessions.length, 1);
});

test('explicit registry membership wins over a cwd path match', () => {
  const wsOther = { workspaceId: 'ws-2', title: 'Elsewhere', path: '/Users/cx/elsewhere', sessionIds: ['pinned'] };
  const details = [detail('pinned', '/Users/cx/dsh-telegram')];
  const groups = groupSessionsByProject(details, [WS, wsOther]);
  const pinned = groups.find((g) => g.sessions.some((s) => s.id === 'pinned'));
  assert.equal(pinned.workspaceId, 'ws-2');
  assert.equal(pinned.label, 'Elsewhere');
});

test('cwd-less sessions still trail under the ungrouped key, ordered last', () => {
  const details = [
    detail('live-x', undefined),
    detail('s1', '/Users/cx/dsh-telegram'),
  ];
  const groups = orderProjectGroups(groupSessionsByProject(details, [{ ...WS, sessionIds: ['s1'] }]));
  assert.equal(groups[groups.length - 1].key, UNGROUPED_KEY);
  assert.equal(groups[0].label, 'dsh-telegram');
  const ungrouped = groups.find((g) => g.key === UNGROUPED_KEY);
  assert.equal(ungrouped.label, 'Ungrouped');
  assert.equal(ungrouped.sessions.length, 1);
});

test('real-world shape: stale registry roster merges into one project group', () => {
  // Mirrors the reported production state: the registry record lists 53 old
  // web ids while 58 newer sessions share the cwd but were never folded in.
  const claimed = Array.from({ length: 53 }, (_, i) => detail(`session-${i}`, '/Users/cx/dsh-telegram'));
  const unclaimed = Array.from({ length: 58 }, (_, i) => detail(`telegram-or-sub-${i}`, '/Users/cx/dsh-telegram'));
  const strays = [detail('home-1', '/Users/cx'), detail('no-cwd', undefined)];
  const groups = orderProjectGroups(
    groupSessionsByProject([...claimed, ...unclaimed, ...strays], [WS]),
    'session-0',
  );
  assert.equal(groups.length, 3); // dsh-telegram + cx + Ungrouped
  const main = groups[0];
  assert.equal(main.label, 'dsh-telegram');
  assert.equal(main.sessions.length, 111);
});
