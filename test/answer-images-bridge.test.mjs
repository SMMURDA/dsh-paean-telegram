import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcff1f0003030200' +
    'c1f3a2b60000000049454e44ae426082',
  'hex',
);

function makeTransport() {
  const sent = [];
  const uploads = [];
  return {
    sent,
    uploads,
    sendText: async (chatId, text, extra) => {
      sent.push({ chatId, text, extra });
      return 500 + sent.length;
    },
    sendPhoto: async (chatId, buffer, filename, caption) => {
      uploads.push({ method: 'sendPhoto', chatId, filename, bytes: buffer.length, caption });
      return 900 + uploads.length;
    },
    sendDocument: async (chatId, buffer, filename) => {
      uploads.push({ method: 'sendDocument', chatId, filename });
      return 950 + uploads.length;
    },
  };
}

function makeCtx() {
  const agent = { id: 'agent-1', send: () => {}, followup: () => {} };
  const listeners = new Map();
  return {
    agents: { get: (id) => (id === 'agent-1' ? agent : undefined), list: () => [agent] },
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {};
    },
    emit: (name, ...args) => {
      for (const cb of listeners.get(name) ?? []) cb(...args);
    },
  };
}

async function setup(options = {}) {
  const transport = makeTransport();
  const ctx = makeCtx();
  const delivered = [];
  const { Bridge } = await import('../dist/harness/bridge.js');
  const bridge = new Bridge({
    ctx,
    transport,
    ...(options.workspaceRoot === undefined ? {} : { workspaceRoot: options.workspaceRoot }),
    getConfig: () => ({ inbound: { rules: [], defaultMode: 'auto-handle' }, outbound: { parseMode: 'HTML' } }),
    onStateChange: () => {},
    onAssistantDelivered: (chatId, telegramMessageId, sessionId, assistantMessageId) =>
      delivered.push({ chatId, telegramMessageId, sessionId, assistantMessageId }),
    log: () => {},
  });
  bridge.attach();
  return { bridge, transport, ctx, delivered };
}

const am = (text) => ({ type: 'assistant/message', data: { message: { id: 'm-1', content: [{ type: 'text', text }] } } });
const turnEnd = (reason = { kind: 'completed' }) => ({ type: 'turn/end', data: { reason } });

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-img-'));
  writeFileSync(join(root, 'shot.png'), PNG);
  return root;
}

/* The core forwarder owns delivery whenever no live-feed renderer is mounted
   (`outbound.liveFeed=false`, or a plugin that never registered a consumer).
   The same acceptance rule must hold there: a referenced image arrives as a
   photo, never as a path. */

test('legacy forwarder uploads a referenced workspace image as a photo', async () => {
  const root = workspace();
  try {
    const { bridge, transport, ctx } = await setup({ workspaceRoot: () => root });
    bridge.deliver(7, 'hi', 501);
    ctx.emit('session/event', { id: 'agent-1' }, am('Hasil: ![terang](shot.png) selesai.'));
    await sleep(20);

    assert.equal(transport.sent.length, 1);
    assert.equal(transport.sent[0].text, 'Hasil: selesai.', 'the dead path must not reach the chat');
    assert.deepEqual(transport.uploads.map((u) => [u.method, u.filename]), [['sendPhoto', 'shot.png']]);
    assert.equal(transport.uploads[0].chatId, 7);
    assert.equal(bridge.hasPendingInbound(), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy forwarder keeps a remote reference in the prose and uploads nothing', async () => {
  const root = workspace();
  try {
    const { bridge, transport, ctx } = await setup({ workspaceRoot: () => root });
    bridge.deliver(7, 'hi', 501);
    ctx.emit('session/event', { id: 'agent-1' }, am('Lihat ![r](https://example.com/a.png)'));
    await sleep(20);
    assert.equal(transport.uploads.length, 0);
    assert.match(transport.sent[0].text, /https:\/\/example\.com\/a\.png/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('legacy forwarder sends an images-only answer as photos with no empty message', async () => {
  const root = workspace();
  try {
    const { bridge, transport, ctx } = await setup({ workspaceRoot: () => root });
    bridge.deliver(7, 'hi', 501);
    ctx.emit('session/event', { id: 'agent-1' }, am('![](shot.png)'));
    await sleep(20);
    ctx.emit('session/event', { id: 'agent-1' }, turnEnd());
    await sleep(20);

    assert.equal(transport.sent.length, 0, 'Telegram rejects an empty message body, so none is sent');
    assert.deepEqual(transport.uploads.map((u) => u.filename), ['shot.png']);
    assert.equal(transport.sent.length, 0, 'no "turn ended without a reply" reminder either');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a bridge without a workspace root keeps the legacy byte-for-byte behaviour', async () => {
  const { bridge, transport, ctx } = await setup();
  bridge.deliver(7, 'hi', 501);
  ctx.emit('session/event', { id: 'agent-1' }, am('Lihat ![x](shot.png) ya'));
  await sleep(20);
  assert.equal(transport.uploads.length, 0, 'no root means no uploads, ever');
  assert.equal(transport.sent[0].text, 'Lihat ![x](shot.png) ya', 'embedders without a root are unaffected');
});

test('with a live-feed consumer the core uploads nothing — the renderer owns delivery', async () => {
  const root = workspace();
  try {
    const { bridge, transport, ctx } = await setup({ workspaceRoot: () => root });
    const consumed = [];
    bridge.setAssistantConsumer((chatId, text) => consumed.push({ chatId, text }));
    bridge.deliver(7, 'hi', 501);
    ctx.emit('session/event', { id: 'agent-1' }, am('![](shot.png)'));
    await sleep(20);
    assert.equal(consumed.length, 1, 'the renderer receives the raw text');
    assert.equal(transport.uploads.length, 0, 'no double upload: exactly one owner');
    assert.equal(transport.sent.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an unreadable image reference degrades to text instead of losing the answer', async () => {
  const root = workspace();
  try {
    const { bridge, transport, ctx } = await setup({ workspaceRoot: () => root });
    bridge.deliver(7, 'hi', 501);
    ctx.emit('session/event', { id: 'agent-1' }, am('Hilang: ![x](nope.png) ya'));
    await sleep(20);
    assert.equal(transport.uploads.length, 0);
    assert.equal(transport.sent[0].text, 'Hilang: ![x](nope.png) ya');
    assert.equal(bridge.hasPendingInbound(), false, 'the turn still counts as answered');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
