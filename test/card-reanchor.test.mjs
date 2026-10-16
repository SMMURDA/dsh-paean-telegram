import test from 'node:test';
import assert from 'node:assert/strict';
import { Ephemeral, REANCHOR_MESSAGE_GAP } from '../dist/telegram/ephemeral.js';

// ---------------------------------------------------------------------------
// Issue: bar buttons (esp. 🧩 Models / ⌛ Queue) "felt dead". The card bubble
// was edited IN PLACE successfully — but dozens of later messages had pushed
// that bubble above the viewport, so a tap morphed content the user never
// saw. Fix: when the transport's outgoing hint reports the anchored card is
// more than REANCHOR_MESSAGE_GAP messages behind the chat, retract it and
// anchor a fresh card at the bottom instead.
// ---------------------------------------------------------------------------

function makeOps({ withHint = true } = {}) {
  const ops = {
    store: new Map(),
    sends: [],
    edits: [],
    deletes: [],
    deletedIds: new Set(),
    nextId: 500,
    async sendText(chatId, text, options) {
      const id = ops.nextId++;
      ops.store.set(id, text);
      ops.sends.push({ chatId, text, options, id });
      return id;
    },
    async deleteMessage(chatId, messageId) {
      ops.deletes.push(messageId);
      ops.deletedIds.add(messageId);
      ops.store.delete(messageId);
    },
    async editText(chatId, messageId, text, options) {
      ops.edits.push({ chatId, messageId, text, options });
      if (ops.deletedIds.has(messageId)) return false;
      if (!ops.store.has(messageId)) return false;
      ops.store.set(messageId, text);
      return true;
    },
    ...(withHint ? { outgoingHint: () => ops.nextId - 1 } : {}),
  };
  return ops;
}

/** Simulate unrelated downstream traffic on the SAME monotonic id sequence. */
function pushTraffic(ops, count) {
  for (let i = 0; i < count; i += 1) {
    const id = ops.nextId++;
    ops.store.set(id, `unrelated message ${i}`);
  }
}

test('a close-behind card keeps editing in place (no re-anchor churn)', async () => {
  const ops = makeOps();
  const eph = new Ephemeral();

  const first = await eph.replace(7, ops, 'card v1', {});
  assert.equal(first, 500);

  // Exactly AT the threshold is still "close": strictly-beyond triggers.
  pushTraffic(ops, REANCHOR_MESSAGE_GAP);

  const second = await eph.replace(7, ops, 'card v2', {});
  assert.equal(second, 500, 'the same bubble is edited in place');
  assert.equal(ops.sends.length, 1, 'no fresh send');
  assert.deepEqual(ops.deletes, [], 'nothing was retracted');
  assert.equal(ops.store.get(500), 'card v2');
});

test('a buried card is retracted and re-anchored at the bottom', async () => {
  const ops = makeOps();
  const eph = new Ephemeral();

  const anchored = await eph.replace(7, ops, 'models card', {});
  assert.equal(anchored, 500);

  // A long agent turn happens: many replies/acks push the chat far past the
  // anchored bubble.
  pushTraffic(ops, REANCHOR_MESSAGE_GAP + 6);

  ops.edits.length = 0;
  const again = await eph.replace(7, ops, 'models card v2', {});
  assert.equal(again, 500 + REANCHOR_MESSAGE_GAP + 7, 'a FRESH message was anchored');
  assert.ok(ops.sends.some((s) => s.text === 'models card v2'), 'the card was sent anew');
  assert.deepEqual(ops.edits, [], 'no pointless edit into the buried bubble');
  assert.ok(ops.deletes.includes(500), 'the buried bubble was retracted');
  assert.ok(!ops.store.has(500), 'the buried bubble is gone from Telegram');
  assert.equal(ops.store.get(again), 'models card v2', 'the fresh bubble carries the card');

  // Follow-up navigation targets the NEW anchor in place (instant again).
  const third = await eph.replace(7, ops, 'provider list', {});
  assert.equal(third, again);
  assert.equal(ops.sends.length, 2);
});

test('without an outgoing hint the behavior is exactly the legacy one', async () => {
  const ops = makeOps({ withHint: false });
  const eph = new Ephemeral();
  const first = await eph.replace(7, ops, 'card v1', {});
  pushTraffic(ops, REANCHOR_MESSAGE_GAP * 10);
  const second = await eph.replace(7, ops, 'card v2', {});
  assert.equal(second, first, 'no hint → in-place edit regardless of distance');
  assert.equal(ops.sends.length, 1);
});

test('an externally deleted card still falls back to a fresh send', async () => {
  const ops = makeOps();
  const eph = new Ephemeral();
  await eph.replace(7, ops, 'card v1', {});
  // Deleted behind our back WITHOUT going through deleteMessage: the store
  // loses it but no retraction was recorded by us.
  ops.store.delete(500);

  const id = await eph.replace(7, ops, 'card v2', {});
  assert.equal(id, 501, 'edit failed → fresh send');
  assert.deepEqual(ops.deletes, [], 'no retraction attempted for an already-gone message');
});
