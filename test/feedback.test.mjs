import test from 'node:test';
import assert from 'node:assert/strict';
import { listFeedback, putFeedback, deleteFeedback } from '../dist/harness/adapters/feedback.js';

function ctxWith(service) {
  return { get: (key) => (key === 'messageFeedback' ? service : undefined) };
}

test('listFeedback mirrors the web items and degrades without the service', async () => {
  const item = { messageId: 'm1', rating: 'positive', note: 'good', version: 'v1', createdAt: 1, updatedAt: 2 };
  const ctx = ctxWith({ list: async () => ({ items: [item] }) });
  assert.deepEqual(await listFeedback(ctx, 's1'), [item]);
  assert.deepEqual(await listFeedback(ctxWith(undefined), 's1'), []);
});

test('putFeedback forwards session/message/rating to the web seam', async () => {
  let captured;
  const ctx = ctxWith({
    put: async (request) => {
      captured = request;
      return { ...request, version: 'v1' };
    },
  });
  const res = await putFeedback(ctx, 's1', 'm1', 'negative', 'needs work');
  assert.equal(res.ok, true);
  assert.deepEqual(captured, { sessionId: 's1', messageId: 'm1', rating: 'negative', note: 'needs work' });
});

test('putFeedback fails cleanly without the service', async () => {
  const res = await putFeedback(ctxWith(undefined), 's1', 'm1', 'positive');
  assert.equal(res.ok, false);
  assert.match(res.text, /unavailable/);
});

test('deleteFeedback forwards the optimistic version', async () => {
  let captured;
  const ctx = ctxWith({
    delete: async (request) => {
      captured = request;
      return { deleted: true };
    },
  });
  const res = await deleteFeedback(ctx, 's1', 'm1', 'v2');
  assert.equal(res.ok, true);
  assert.deepEqual(captured, { sessionId: 's1', messageId: 'm1', ifVersion: 'v2' });
});
