import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, symlinkSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeAttachmentHandlers } from '../dist/media/attachments.js';

/**
 * Regression tests for AT-1 (src/media/attachments.ts):
 * 1. symlink escape rejection (RF-4) — but symlinks staying inside the root pass.
 * 2. jpg/jpeg/png >10MB route through sendDocument, not sendPhoto.
 * 3. voice transcription failure falls back to saving the file + agent prompt
 *    (the failed transcript is never delivered as a user message).
 * All use stub deps — no real Telegram / network.
 */

function agent() {
  return { id: 'agent-1' };
}

function baseState(workspaceRoot) {
  return {
    chats: new Set([100]),
    workspaceRoot,
    config: {},
    bridge: {
      deliverImages: () => ({ ok: true, text: 'Images delivered.' }),
    },
  };
}

/** Build makeAttachmentHandlers deps around real fs, stub transport/bridge. */
function buildDeps({ workspaceRoot, transport, bridge, config = {}, currentAgent = agent }) {
  const sent = [];
  const deliveries = [];
  const barSyncs = [];
  const deps = {
    state: {
      chats: new Set([100]),
      workspaceRoot,
      config,
      bridge: bridge ?? {
        ...baseState(workspaceRoot).bridge,
        deliver: (chatId, text, messageId) => {
          deliveries.push({ chatId, text, messageId });
          return { ok: true, text: 'delivered' };
        },
      },
    },
    requireTransport: () => transport,
    requireCtx: () => ({ get: () => undefined }),
    uiSend: async (chatId, text) => {
      sent.push({ chatId, text });
      return 42;
    },
    currentAgent,
    createSessionForChat: async () => { throw new Error('should not create a session'); },
    bindCreatedSession: () => false,
    scheduleBarSync: (chatId, delayMs) => { barSyncs.push({ chatId, delayMs }); },
  };
  return { deps, sent, deliveries, barSyncs };
}

function exec(agentId = 'agent-1') {
  return { agent: { id: agentId }, logger: {} };
}

test('sendWorkspaceAttachments rejects a symlink escaping the workspace root', async () => {
  const base = mkdtempSync(join(tmpdir(), 'atch-symlink-'));
  const ws = join(base, 'ws');
  const outside = join(base, 'outside'); // outside the workspace
  const target = join(outside, 'secret.txt');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ws, { recursive: true });
    mkdirSync(outside, { recursive: true });
    writeFileSync(target, 'top secret');
    const link = join(ws, 'escape.txt');
    symlinkSync(target, link);

    const transport = {
      sendPhoto: async () => 1,
      sendDocument: async () => 2,
      sendVoice: async () => 3,
      sendAudio: async () => 4,
    };
    const { deps } = buildDeps({ workspaceRoot: ws, transport });
    const handlers = makeAttachmentHandlers(deps);
    const result = JSON.parse(await handlers.sendWorkspaceAttachments({ paths: ['escape.txt'], chatId: 100 }, exec()));
    assert.equal(result.ok, false);
    assert.equal(result.results[0].ok, false);
    assert.equal(result.results[0].error, 'path resolves outside the workspace root (symlink escape)');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sendWorkspaceAttachments does NOT reject a symlink that stays inside the root', async () => {
  const base = mkdtempSync(join(tmpdir(), 'atch-symlink-in-'));
  const ws = join(base, 'ws');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'real.txt'), 'hello');
    symlinkSync(join(ws, 'real.txt'), join(ws, 'alias.txt'));

    const transport = {
      sendPhoto: async () => 1,
      sendDocument: async () => 2,
      sendVoice: async () => 3,
      sendAudio: async () => 4,
    };
    const { deps } = buildDeps({ workspaceRoot: ws, transport });
    const handlers = makeAttachmentHandlers(deps);
    const result = JSON.parse(await handlers.sendWorkspaceAttachments({ paths: ['alias.txt'], chatId: 100 }, exec()));
    assert.equal(result.ok, true);
    assert.equal(result.results[0].ok, true);
    assert.equal(result.results[0].bytes, 5);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sendWorkspaceAttachments routes a jpg over 10MB through sendDocument, not sendPhoto', async () => {
  const base = mkdtempSync(join(tmpdir(), 'atch-photo-'));
  const ws = join(base, 'ws');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ws, { recursive: true });
    const big = Buffer.alloc(10 * 1024 * 1024 + 1, 0xff);
    writeFileSync(join(ws, 'big.jpg'), big);

    const calls = [];
    const transport = {
      sendPhoto: async (chatId, buffer, filename, caption) => {
        calls.push({ method: 'sendPhoto', filename });
        return 1;
      },
      sendDocument: async (chatId, buffer, filename, caption) => {
        calls.push({ method: 'sendDocument', filename });
        return 2;
      },
      sendVoice: async () => { calls.push({ method: 'sendVoice' }); return 3; },
      sendAudio: async () => { calls.push({ method: 'sendAudio' }); return 4; },
    };
    const { deps } = buildDeps({ workspaceRoot: ws, transport });
    const handlers = makeAttachmentHandlers(deps);
    const result = JSON.parse(await handlers.sendWorkspaceAttachments({ paths: ['big.jpg'], chatId: 100 }, exec()));
    assert.equal(result.ok, true);
    assert.equal(result.results[0].method, 'sendDocument');
    assert.equal(result.results[0].bytes, big.length);
    assert.deepEqual(calls.map((c) => c.method), ['sendDocument']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('sendWorkspaceAttachments still routes a small jpg through sendPhoto', async () => {
  const base = mkdtempSync(join(tmpdir(), 'atch-photo-small-'));
  const ws = join(base, 'ws');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(ws, { recursive: true });
    writeFileSync(join(ws, 'small.jpg'), Buffer.from('tiny'));

    const calls = [];
    const transport = {
      sendPhoto: async (chatId, buffer, filename, caption) => { calls.push('sendPhoto'); return 1; },
      sendDocument: async () => { calls.push('sendDocument'); return 2; },
      sendVoice: async () => 3,
      sendAudio: async () => 4,
    };
    const { deps } = buildDeps({ workspaceRoot: ws, transport });
    const handlers = makeAttachmentHandlers(deps);
    const result = JSON.parse(await handlers.sendWorkspaceAttachments({ paths: ['small.jpg'], chatId: 100 }, exec()));
    assert.equal(result.ok, true);
    assert.equal(result.results[0].method, 'sendPhoto');
    assert.deepEqual(calls, ['sendPhoto']);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('voice transcription failure saves the file and prompts the agent (no failed transcript as user message)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'atch-voice-'));
  const oldHome = process.env.DSH_HOME;
  const oldOpenAi = process.env.OPENAI_API_KEY;
  const oldVoiceKey = process.env.TELEGRAM_VOICE_API_KEY;
  process.env.DSH_HOME = base;
  delete process.env.OPENAI_API_KEY;
  delete process.env.TELEGRAM_VOICE_API_KEY;
  try {
    const deliveries = [];
    const bridge = {
      deliver: (chatId, text, messageId) => {
        deliveries.push({ chatId, text, messageId });
        return { ok: true, text: 'delivered' };
      },
    };
    const transport = {
      downloadFile: async () => new Uint8Array([1, 2, 3, 4]),
    };
    const { deps, sent, barSyncs } = buildDeps({
      workspaceRoot: '/tmp/irrelevant',
      transport,
      bridge,
      // No apiKey and no env key => transcribeVoice fails cleanly (no network).
      config: { media: { transcribe: {} } },
    });

    const handlers = makeAttachmentHandlers(deps);
    await handlers.dispatchDocument(100, 'voice', 'f1', 'voice.ogg', 'audio/ogg', 777);

    // The voice file must be saved under the session attachment dir.
    assert.equal(existsSync(join(base, 'sessions', 'agent-1', 'attachments')), true);
    // Chat was notified once with the failure reason + saved path.
    assert.equal(sent.length, 1);
    assert.match(sent[0].text, /transcription needs an api key/);
    assert.match(sent[0].text, /saved voice to/);
    assert.match(sent[0].text, /attachments/);
    // Agent received the fallback prompt including path + failure reason.
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0].chatId, 100);
    assert.equal(deliveries[0].messageId, 777);
    assert.match(deliveries[0].text, /Voice transcription failed/);
    assert.match(deliveries[0].text, /original voice file was saved to/);
    assert.match(deliveries[0].text, /attachments/);
    assert.match(deliveries[0].text, /api key/);
    // The prompt is NOT the failed transcript delivered as a plain user turn.
    assert.doesNotMatch(deliveries[0].text, /^transcription returned no text$/);
    assert.deepEqual(barSyncs, [{ chatId: 100, delayMs: 0 }]);
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = oldHome;
    if (oldOpenAi === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = oldOpenAi;
    if (oldVoiceKey === undefined) delete process.env.TELEGRAM_VOICE_API_KEY;
    else process.env.TELEGRAM_VOICE_API_KEY = oldVoiceKey;
    rmSync(base, { recursive: true, force: true });
  }
});
