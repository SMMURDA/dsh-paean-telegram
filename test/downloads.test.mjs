import test from 'node:test';
import assert from 'node:assert/strict';
import { exportSessionLog, setExportSeamForTest, TELEGRAM_DOCUMENT_LIMIT_BYTES } from '../dist/harness/adapters/downloads.js';

/** Minimal ctx: the injected seam owns every read, so the ctx is unused. */
const ctx = { get: () => undefined };

/** A JSONL payload as the current seam's `readSessionLogText` returns it. */
const JSONL = '{"type":"session","seq":0}\n{"type":"turn/start","seq":1}\n';

function streamOf(bytes) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
}

test('Telegram document limit is exactly the Bot API 50 MB bound', () => {
  assert.equal(TELEGRAM_DOCUMENT_LIMIT_BYTES, 50 * 1024 * 1024);
});

test('exportSessionLog degrades with web guidance when no export seam is available', async () => {
  // Pinned instead of probed: on a host where the profile packages resolve (any
  // machine running Paean) a real probe would succeed and this branch would
  // never be exercised. The module-level promise is also the negative cache, so
  // the repeat call must stay fail-closed rather than re-probing.
  setExportSeamForTest(undefined);
  const res = await exportSessionLog(ctx, 'session-1', false);
  assert.equal(res.result.ok, false);
  assert.match(res.result.text, /web UI/);
  assert.equal(res.buffer, undefined);

  const again = await exportSessionLog(ctx, 'session-2', true);
  assert.equal(again.result.ok, false);
  assert.match(again.result.text, /web UI/);
  assert.equal(again.buffer, undefined);
});

test('exportSessionLog reads the root log through readSessionLogText and returns the ZIP', async () => {
  const calls = [];
  const persistence = { open: async () => ({ read: async () => ({ events: [] }), close: async () => {} }) };
  setExportSeamForTest({
    sessionLogExportDeps: () => ({ sessionPersistence: persistence }),
    flushLiveSessionLog: async (deps, id) => {
      calls.push(['flush', id]);
    },
    readSessionLogText: async (received, id) => {
      calls.push(['readText', received === persistence, id]);
      return JSONL;
    },
    streamSessionLogZip: (deps, root, sessionId, includeDescendants, level) => {
      calls.push(['zip', root, sessionId, includeDescendants, level]);
      return streamOf([1, 2, 3, 4]);
    },
  });

  const res = await exportSessionLog(ctx, 'session-9', true);
  assert.equal(res.result.ok, true);
  assert.equal(res.buffer.byteLength, 4);
  assert.deepEqual(calls[0], ['flush', 'session-9']);
  // The persistence service handed to readSessionLogText is the seam's own dep.
  assert.deepEqual(calls[1], ['readText', true, 'session-9']);
  // The ZIP writer receives the serialized JSONL TEXT on the current seam,
  // not a readRaw payload — the shape that moved between host generations.
  assert.equal(calls[2][1], JSONL);
  assert.equal(calls[2][2], 'session-9');
  assert.equal(calls[2][3], true);
  assert.equal(calls[2][4], 6);
});

test('exportSessionLog falls back to the legacy readRaw payload', async () => {
  const raw = { meta: { id: 'legacy-1' }, filename: 'session.jsonl', content: JSONL };
  const calls = [];
  setExportSeamForTest({
    sessionLogExportDeps: () => ({
      sessionPersistence: {
        readRaw: async (id) => {
          calls.push(['readRaw', id]);
          return raw;
        },
      },
    }),
    flushLiveSessionLog: async () => {},
    streamSessionLogZip: (deps, root) => {
      calls.push(['zip', root]);
      return streamOf([7]);
    },
  });

  const res = await exportSessionLog(ctx, 'legacy-1', false);
  assert.equal(res.result.ok, true);
  assert.equal(res.buffer.byteLength, 1);
  // No readSessionLogText on this seam, so the legacy payload passes through.
  assert.deepEqual(calls, [['readRaw', 'legacy-1'], ['zip', raw]]);
});

test('an unknown session id is reported as not found', async () => {
  setExportSeamForTest({
    sessionLogExportDeps: () => ({ sessionPersistence: {} }),
    flushLiveSessionLog: async () => {},
    readSessionLogText: async () => undefined,
    streamSessionLogZip: () => {
      throw new Error('the ZIP writer must not run for a missing session');
    },
  });
  const res = await exportSessionLog(ctx, 'missing', false);
  assert.equal(res.result.ok, false);
  assert.match(res.result.text, /not found/);
});

test('a seam that cannot read the log fails with a clear message', async () => {
  setExportSeamForTest({
    sessionLogExportDeps: () => ({ sessionPersistence: {} }),
    flushLiveSessionLog: async () => {},
    streamSessionLogZip: () => {
      throw new Error('the ZIP writer must not run without a root log');
    },
  });
  const res = await exportSessionLog(ctx, 's-1', false);
  assert.equal(res.result.ok, false);
  assert.match(res.result.text, /cannot read the session log/);
});

test('a profile without session persistence is refused before any read', async () => {
  setExportSeamForTest({
    sessionLogExportDeps: () => ({}),
    flushLiveSessionLog: async () => {},
    streamSessionLogZip: () => {
      throw new Error('the ZIP writer must not run without persistence');
    },
  });
  const res = await exportSessionLog(ctx, 's-2', false);
  assert.equal(res.result.ok, false);
  assert.match(res.result.text, /session persistence is unavailable/);
});

test('an oversize archive is refused with the web-UI guidance', async () => {
  setExportSeamForTest({
    sessionLogExportDeps: () => ({ sessionPersistence: {} }),
    flushLiveSessionLog: async () => {},
    readSessionLogText: async () => JSONL,
    streamSessionLogZip: () =>
      new ReadableStream({
        start(controller) {
          // One chunk past the Bot API document limit.
          controller.enqueue(new Uint8Array(TELEGRAM_DOCUMENT_LIMIT_BYTES + 1));
          controller.close();
        },
      }),
  });
  const res = await exportSessionLog(ctx, 'big-1', false);
  assert.equal(res.result.ok, false);
  assert.match(res.result.text, /exceeds the 50 MB Telegram limit/);
  assert.match(res.result.text, /web UI/);
  assert.equal(res.buffer, undefined);
});
