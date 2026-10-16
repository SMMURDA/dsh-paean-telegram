import test from 'node:test';
import assert from 'node:assert/strict';
import { diffTodos, listTodos, normalizeTodos, pendingTodoCount, renderTodos, todoIcon, todoPriority, TODOS_RENDER_MAX_CHARS } from '../dist/harness/adapters/todos.js';

const todo = (content, status = 'pending') => ({ content, status });

test('listTodos reads the latest todo/write snapshot and ignores malformed writes', () => {
  const agent = {
    session: {
      events: [
        { type: 'user/message', data: {} },
        { type: 'todo/write', data: { todos: [todo('old', 'completed')] } },
        { type: 'todo/write', data: { todos: [todo('do it', 'in_progress'), { content: 42, status: 'nope' }] } },
      ],
    },
  };
  const ctx = { agents: { get: () => agent } };
  assert.deepEqual(listTodos(ctx, 'a'), [todo('do it', 'in_progress'), todo('42', 'pending')]);
});

test('pendingTodoCount counts every status except completed', () => {
  assert.equal(pendingTodoCount([todo('a'), todo('b', 'in_progress'), todo('c', 'completed')]), 2);
});

test('diffTodos reports additions, transitions, and remaining work', () => {
  const diff = diffTodos(
    [todo('read docs'), todo('write code', 'in_progress'), todo('ship', 'pending')],
    [todo('read docs', 'completed'), todo('write code', 'in_progress'), todo('ship', 'completed'), todo('announce')],
  );
  assert.deepEqual(diff.added, [todo('announce')]);
  assert.deepEqual(diff.started, []);
  assert.deepEqual(diff.completed, [todo('read docs', 'completed'), todo('ship', 'completed')]);
  assert.equal(diff.remaining, 2);
});

test('priority and icons are display-only derivations from content tags', () => {
  assert.equal(todoPriority('[P0] auth outage'), 'high');
  assert.equal(todoPriority('🔴 fix leak'), 'high');
  assert.equal(todoPriority('medium clean up'), 'medium');
  assert.equal(todoPriority('water plants'), 'low');
  assert.equal(todoIcon(todo('x', 'completed')), '\u2705');
  assert.equal(todoIcon(todo('x', 'in_progress')), '\u23F3');
});

test('renderTodos keeps the card one readable line per todo (strike-through done, no tag noise)', () => {
  const text = renderTodos([todo('a', 'completed'), todo('b <cfg>'), todo('c', 'in_progress')]);
  assert.match(text, /✅ <s>a<\/s>/);
  assert.match(text, /⏳ c/);
  assert.match(text, /🟢 b &lt;cfg&gt;/, 'content is HTML-escaped');
  assert.doesNotMatch(text, /\[(completed|pending|in_progress)\]/, 'status tags are gone — icons carry state');
});

test('listTodos caches the scanned end and only walks newly appended events', () => {
  const events = [
    { type: 'user/message', data: {} },
    { type: 'todo/write', data: { todos: [todo('cached item', 'pending')] } },
  ];
  const agent = { session: { events } };
  const ctx = { agents: { get: () => agent } };
  assert.deepEqual(listTodos(ctx, 'a'), [todo('cached item', 'pending')]);
  events.push({ type: 'todo/write', data: { todos: [todo('new item', 'in_progress')] } });
  assert.deepEqual(listTodos(ctx, 'a'), [todo('new item', 'in_progress')]);
});

test('listTodos caches an empty scan and still notices a later first write', () => {
  const events = [{ type: 'user/message', data: {} }];
  const agent = { session: { events } };
  const ctx = { agents: { get: () => agent } };
  assert.deepEqual(listTodos(ctx, 'a'), []);
  events.push({ type: 'todo/write', data: { todos: [todo('first write', 'completed')] } });
  assert.deepEqual(listTodos(ctx, 'a'), [todo('first write', 'completed')]);
});

test('listTodos rescans when the event array shrank', () => {
  const events = [
    { type: 'todo/write', data: { todos: [todo('first', 'completed')] } },
    { type: 'todo/write', data: { todos: [todo('second', 'pending')] } },
  ];
  const agent = { session: { events } };
  const ctx = { agents: { get: () => agent } };
  assert.deepEqual(listTodos(ctx, 'a'), [todo('second', 'pending')]);
  events.pop();
  assert.deepEqual(listTodos(ctx, 'a'), [todo('first', 'completed')]);
});

test('listTodos rescans when the events array is replaced at the same length', () => {
  // Compaction/reset can swap in a fresh array with the SAME length; a
  // length-only cache check would serve the stale snapshot forever.
  const agent = { session: { events: [{ type: 'todo/write', data: { todos: [todo('stale', 'pending')] } }] } };
  const ctx = { agents: { get: () => agent } };
  assert.deepEqual(listTodos(ctx, 'a'), [todo('stale', 'pending')]);
  agent.session.events = [{ type: 'todo/write', data: { todos: [todo('fresh', 'in_progress')] } }];
  assert.deepEqual(listTodos(ctx, 'a'), [todo('fresh', 'in_progress')]);
});

test('normalizeTodos coerces malformed entries into display-safe views', () => {
  assert.deepEqual(normalizeTodos([
    { content: 'ok', status: 'completed' },
    { content: 42, status: 'nope' },
  ]), [todo('ok', 'completed'), todo('42', 'pending')]);
});

// ---------------------------------------------------------------------------
// TL-1: an uncapped render made the >4096-char card uneditable — the edit
// lane failed fast and every 5s refresh tick re-sent the whole list. The
// item block now clamps under TODOS_RENDER_MAX_CHARS with a "+N more" tail.
// ---------------------------------------------------------------------------

test('renderTodos clamps a huge list under the render budget with a "+N more" tail (#TL-1)', () => {
  const todos = Array.from({ length: 500 }, (_, i) => todo(
    `task ${i} with enough padding text to push the raw render far past any message limit`,
    i % 2 ? 'completed' : 'in_progress',
  ));
  const text = renderTodos(todos);
  assert.ok(text.length <= TODOS_RENDER_MAX_CHARS, `clamped output is ${text.length}`);
  const hidden = Number(text.match(/\u2026 \+(\d+) more$/)?.[1]);
  assert.ok(hidden > 0, 'the hidden remainder is counted');
  assert.equal(text.split('\n').length - 1 + hidden, todos.length, 'every todo is either shown or counted');
});

test('clamping keeps strike-through formatting on the shown completed items (#TL-1)', () => {
  const todos = Array.from({ length: 300 }, (_, i) => todo(`job ${i}`, 'completed'));
  const text = renderTodos(todos);
  assert.ok(text.length <= TODOS_RENDER_MAX_CHARS);
  assert.match(text, /✅ <s>job 0<\/s>/);
  assert.match(text, /\u2026 \+\d+ more$/);
});

test('a single gigantic todo is clipped pre-escape instead of busting the card', () => {
  // '<>&' grows ~3.7x under escapeHtml — clipping must happen BEFORE escaping
  // so the rendered line (and its markup) stays balanced and bounded.
  const giant = '<>&'.repeat(2000);
  const text = renderTodos([todo(giant), todo('small tail')]);
  assert.ok(text.length <= TODOS_RENDER_MAX_CHARS, `rendered ${text.length}`);
  assert.match(text, /\u2026 \+1 more$/, 'the second todo is counted, not lost');
  const opens = (text.match(/<s>/g) ?? []).length;
  const closes = (text.match(/<\/s>/g) ?? []).length;
  assert.equal(opens, closes, 'markup stays balanced after the clip');
});

test('sub-limit lists render byte-identically — clamping only trims overflow', () => {
  assert.equal(
    renderTodos([todo('a', 'completed'), todo('b <cfg>'), todo('c', 'in_progress')]),
    '✅ <s>a</s>\n🟢 b &lt;cfg&gt;\n⏳ c',
  );
});
