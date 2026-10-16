import test from 'node:test';
import assert from 'node:assert/strict';
import { renderTodosCard } from '../dist/telegram/todos-card.js';
import { Ephemeral } from '../dist/telegram/ephemeral.js';
import { TELEGRAM_MAX_MESSAGE_LENGTH } from '../dist/config.js';

const todo = (content, status = 'pending') => ({ content, status });

test('todo card shows live pending/total counts while work remains', () => {
  const text = renderTodosCard([
    todo('read docs', 'completed'),
    todo('write code', 'in_progress'),
    todo('ship'),
  ], true);
  assert.match(text, /📌 <b>Todos<\/b> · 2 pending · 3 total/);
  assert.match(text, /Auto-refreshes every 5s/);
  assert.doesNotMatch(text, /No live agent/);
});

test('todo card switches to a completion state when everything is done', () => {
  const text = renderTodosCard([
    todo('read docs', 'completed'),
    todo('write code', 'completed'),
  ], true);
  assert.match(text, /✅ <b>Todos<\/b> · complete · <b>2\/2 done<\/b>/);
  assert.match(text, /▓▓▓▓▓▓▓▓▓▓ 100%/);
});

test('todo card without a live agent stays a read-only guidance card', () => {
  const text = renderTodosCard([], false);
  assert.match(text, /📌 <b>Todos<\/b> · No live agent/);
  assert.match(text, /\(no todos yet\)/);
  assert.match(text, /todos are session-scoped/);
});

// ---------------------------------------------------------------------------
// TL-1: a 2000-entry list used to render a >4096-char card that the edit
// lane could never update — every 5s tick re-sent it as a multi-part burst.
// The FULL card (header + items + progress + footer) must stay under one
// editable bubble with headroom to spare.
// ---------------------------------------------------------------------------

test('a pathological todo list still renders ONE sendable/editable bubble (#TL-1)', () => {
  const todos = Array.from({ length: 2000 }, (_, i) => todo(
    `step ${i} & <tag> "quotes" to stress escaping`,
    i % 3 === 0 ? 'completed' : 'pending',
  ));
  const text = renderTodosCard(todos, true);
  assert.ok(text.length < 3800, `full card is ${text.length}, must stay under ~3800`);
  assert.ok(text.length <= TELEGRAM_MAX_MESSAGE_LENGTH);
  assert.match(text, /\u2026 \+\d+ more/, 'the hidden tail is indicated');
  assert.match(text, /📌 <b>Todos<\/b>/, 'DTL header intact');
  assert.match(text, /✅ <s>step 0 /, 'strike-through survives on shown items');
  assert.match(text, /[▓░]+ \d+%/, 'the progress bar still reflects ALL items');
});

// ---------------------------------------------------------------------------
// TL-1 end-to-end repro: the flood was a CHAIN — overlong render → transport
// editText fast-false (transport.ts fails fast above 4096) → Ephemeral.replace
// reading false as "card gone" → fresh send → 5s tick repeats forever. The
// unit tests cover each hop; this one wires the REAL renderer into replace()
// with an edit lane that mirrors the transport's length contract and replays
// the auto-refresh loop.
// ---------------------------------------------------------------------------

/** ChatOps fake whose editText fails exactly like TelegramTransport.editText:
 * `false` for text above the 4096 ceiling ("message is too long" fast-reject)
 * and for messages that no longer exist; `true` (in-place success) otherwise. */
function makeTransportLikeOps() {
  const ops = {
    sends: [],
    edits: [],
    deletes: [],
    store: new Map(),
    nextId: 700,
    async sendText(chatId, text, options) {
      const id = ops.nextId++;
      ops.store.set(id, text);
      ops.sends.push({ chatId, text, options, id });
      return id;
    },
    async deleteMessage(chatId, messageId) {
      ops.deletes.push(messageId);
      ops.store.delete(messageId);
    },
    async editText(chatId, messageId, text, options) {
      ops.edits.push({ chatId, messageId, text, options });
      if (text.length > TELEGRAM_MAX_MESSAGE_LENGTH) return false;
      if (!ops.store.has(messageId)) return false;
      ops.store.set(messageId, text);
      return true;
    },
  };
  return ops;
}

test('a ~5000-char todo state refreshes IN PLACE forever: one send, zero resends (#TL-1)', async () => {
  // ~120 entries x ~75 rendered chars ≈ 9000 chars unclamped — the exact
  // shape the audit flagged for the 5s auto-refresh loop.
  const todos = Array.from({ length: 120 }, (_, i) => todo(
    `item ${i}: verify the release checklist entry with a realistic sentence`,
    i % 3 === 0 ? 'completed' : i % 3 === 1 ? 'in_progress' : 'pending',
  ));
  const unclamped = todos
    .map((entry) => `${entry.status === 'completed' ? '✅' : '📌'} ${entry.content}`)
    .join('\n');
  assert.ok(unclamped.length > TELEGRAM_MAX_MESSAGE_LENGTH, `sanity: raw list is ${unclamped.length}, must exceed the cap`);
  const raw = renderTodosCard(todos, true);
  assert.ok(raw.length <= TELEGRAM_MAX_MESSAGE_LENGTH, `renderer clamps to ${raw.length}`);

  const ops = makeTransportLikeOps();
  const eph = new Ephemeral();
  const first = await eph.replace(7, ops, raw, {});
  assert.equal(first, 700);

  // Simulate five 5s auto-refresh ticks re-rendering the SAME list.
  for (let tick = 0; tick < 5; tick += 1) {
    await eph.replace(7, ops, renderTodosCard(todos, true), {});
  }
  assert.equal(ops.sends.length, 1, 'the card opened once — no resend per tick');
  assert.equal(ops.edits.length, 5, 'every refresh edited in place');
  assert.ok(ops.edits.every((edit) => edit.messageId === 700), 'all edits hit the same bubble');
  assert.ok(ops.edits.every((edit) => edit.text.length <= TELEGRAM_MAX_MESSAGE_LENGTH), 'no edit trips the transport length reject');
  assert.deepEqual(ops.deletes, [], 'nothing was retracted');
});

test('even an unclamped overlong payload cannot storm fresh sends through replace (#TL-1)', async () => {
  // Defense-in-depth regression lock: if a future renderer regresses and
  // emits >4096 chars, replace() must skip (not resend) until the payload
  // fits again — the flood must be structurally impossible, not just
  // unlikely.
  const ops = makeTransportLikeOps();
  const eph = new Ephemeral();
  await eph.replace(7, ops, 'todos v1', {});
  const unclamped = 'x'.repeat(5000);
  for (let tick = 0; tick < 6; tick += 1) {
    await eph.replace(7, ops, `${unclamped} #${tick}`, {});
  }
  assert.equal(ops.sends.length, 1, 'bounded send count across repeated overlong ticks');
  assert.equal(ops.edits.length, 0, 'length-fated edits are skipped before the wire');

  // Once the payload returns under the cap, edits resume on the SAME bubble.
  await eph.replace(7, ops, 'todos v2', {});
  assert.equal(ops.sends.length, 1);
  assert.ok(ops.edits.some((edit) => edit.messageId === 700 && edit.text === 'todos v2'), 'refresh converges back to in-place edits');
});
