import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractLocalImageRefs, IMAGE_REF_MAX_BYTES } from '../dist/media/image-refs.js';
import { makeAttachmentHandlers, ATTACH_MAX_BYTES } from '../dist/media/attachments.js';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const settle = async () => {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
};

/** Minimal PNG payload; content never matters, only that the file exists. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63fcff1f0003030200' +
    'c1f3a2b60000000049454e44ae426082',
  'hex',
);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), 'dsh-answer-img-'));
  mkdirSync(join(root, 'shots'), { recursive: true });
  writeFileSync(join(root, 'shots', 'a.png'), PNG);
  writeFileSync(join(root, 'shots', 'b.jpg'), PNG);
  writeFileSync(join(root, 'notes.pdf'), '%PDF-1.4\n');
  return root;
}

/* ---------------- extractor: what becomes a photo, what stays text --------- */

test('extractLocalImageRefs turns an existing workspace image into an upload and strips it from the prose', async () => {
  const root = workspace();
  try {
    const out = await extractLocalImageRefs('Lihat tangkapan ini ![light](shots/a.png) ya.', { workspaceRoot: root });
    assert.deepEqual(out.images, ['shots/a.png']);
    assert.equal(out.text, 'Lihat tangkapan ini ya.', 'the dead path must not reach the chat');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs accepts the title and angle-bracket forms', async () => {
  const root = workspace();
  try {
    const out = await extractLocalImageRefs('![](shots/a.png "terang")\n![](<shots/b.jpg>)', { workspaceRoot: root });
    assert.deepEqual(out.images, ['shots/a.png', 'shots/b.jpg']);
    assert.equal(out.text, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs keeps references it cannot verify (remote, missing, non-photo)', async () => {
  const root = workspace();
  try {
    const text = '![r](https://example.com/a.png) ![m](shots/missing.png) ![d](notes.pdf) ![](data:image/png;base64,AAAA)';
    const out = await extractLocalImageRefs(text, { workspaceRoot: root });
    assert.deepEqual(out.images, [], 'nothing unverified is ever uploaded');
    assert.equal(out.text, text, 'unverified references stay exactly as the model wrote them');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs refuses a symlink that escapes the workspace root', async () => {
  const root = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'dsh-answer-img-outside-'));
  try {
    writeFileSync(join(outside, 'secret.png'), PNG);
    symlinkSync(join(outside, 'secret.png'), join(root, 'shots', 'link.png'));
    const out = await extractLocalImageRefs('![x](shots/link.png)', { workspaceRoot: root });
    assert.deepEqual(out.images, [], 'a symlink out of the workspace must never be uploaded');
    assert.equal(out.text, '![x](shots/link.png)');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs sends a repeated path once and removes every mention', async () => {
  const root = workspace();
  try {
    const out = await extractLocalImageRefs('![a](shots/a.png) tengah ![a](shots/a.png)', { workspaceRoot: root });
    assert.deepEqual(out.images, ['shots/a.png']);
    assert.equal(out.text, 'tengah');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs honours the per-message cap and keeps the overflow in the text', async () => {
  const root = workspace();
  try {
    const refs = Array.from({ length: 12 }, (_, i) => {
      writeFileSync(join(root, 'shots', `c${i}.png`), PNG);
      return `![c${i}](shots/c${i}.png)`;
    });
    const out = await extractLocalImageRefs(refs.join(' '), { workspaceRoot: root });
    assert.equal(out.images.length, 10, 'Telegram accepts at most 10 files per batch');
    assert.ok(out.text.includes('![c10](shots/c10.png)'), 'the overflow reference is preserved, not silently dropped');
    assert.ok(out.text.includes('![c11](shots/c11.png)'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs collapses the blank lines a removal leaves behind', async () => {
  const root = workspace();
  try {
    const out = await extractLocalImageRefs('baris satu\n\n![](shots/a.png)\n\nbaris dua', { workspaceRoot: root });
    assert.equal(out.text, 'baris satu\n\nbaris dua');
    assert.deepEqual(out.images, ['shots/a.png']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs leaves plain prose untouched', async () => {
  const root = workspace();
  try {
    const text = 'Tanpa gambar sama sekali di sini.';
    const out = await extractLocalImageRefs(text, { workspaceRoot: root });
    assert.deepEqual(out.images, []);
    assert.equal(out.text, text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs never touches a reference inside a fenced code block', async () => {
  const root = workspace();
  try {
    const text = 'Contoh sintaks:\n\n```md\n![light](shots/a.png)\n```\n\nSelesai.';
    const out = await extractLocalImageRefs(text, { workspaceRoot: root });
    assert.deepEqual(out.images, [], 'documentation is not an attachment');
    assert.equal(out.text, text, 'the example must survive byte-for-byte');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs never touches a reference inside an inline code span', async () => {
  const root = workspace();
  try {
    const text = 'Tulis `![light](shots/a.png)` di jawabanmu, lalu ![nyata](shots/b.jpg).';
    const out = await extractLocalImageRefs(text, { workspaceRoot: root });
    assert.deepEqual(out.images, ['shots/b.jpg'], 'only the real reference is uploaded');
    assert.equal(out.text, 'Tulis `![light](shots/a.png)` di jawabanmu, lalu.');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs treats two spellings of one file as one upload', async () => {
  const root = workspace();
  try {
    const out = await extractLocalImageRefs('![a](shots/a.png) dan ![a](./shots/a.png)', { workspaceRoot: root });
    assert.deepEqual(out.images, ['shots/a.png'], 'the same file is sent once');
    assert.equal(out.text, 'dan', 'and neither mention survives in the prose');  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('extractLocalImageRefs keeps a reference above the upload ceiling in the text', async () => {
  const root = workspace();
  try {
    const big = join(root, 'shots', 'huge.png');
    writeFileSync(big, PNG);
    truncateSync(big, IMAGE_REF_MAX_BYTES + 1);
    const text = 'Besar: ![big](shots/huge.png) ya.';
    const out = await extractLocalImageRefs(text, { workspaceRoot: root });
    assert.deepEqual(out.images, [], 'a file the transport would reject is never promised');
    assert.equal(out.text, text);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the extractor mirror of the attachment ceiling matches the real one', () => {
  assert.equal(IMAGE_REF_MAX_BYTES, ATTACH_MAX_BYTES, 'a drifted mirror silently hides oversize references');
});

/* ---------------- shared upload path (tool + answer images) --------------- */

function fakeTransport() {
  const calls = [];
  const record = (method) => async (chatId, buffer, filename, caption) => {
    calls.push({ method, chatId, filename, bytes: buffer.length, caption });
    return calls.length;
  };
  return {
    calls,
    sendPhoto: record('sendPhoto'),
    sendDocument: record('sendDocument'),
    sendVoice: record('sendVoice'),
    sendAudio: record('sendAudio'),
  };
}

function handlers(root, transport) {
  return makeAttachmentHandlers({
    state: { chats: new Set([7]), workspaceRoot: root, config: {}, bridge: undefined },
    requireTransport: () => transport,
    requireCtx: () => ({}),
    uiSend: async () => undefined,
    currentAgent: () => undefined,
    createSessionForChat: async () => ({}),
    bindCreatedSession: () => true,
    scheduleBarSync: () => {},
  });
}

test('sendFilesToChat routes by extension and reports per-file outcomes', async () => {
  const root = workspace();
  const transport = fakeTransport();
  try {
    const { sendFilesToChat } = handlers(root, transport);
    const { results } = await sendFilesToChat(7, ['shots/a.png', 'notes.pdf', 'shots/nope.png']);
    assert.deepEqual(
      results.map((r) => [r.path, r.ok, r.method]),
      [
        ['shots/a.png', true, 'sendPhoto'],
        ['notes.pdf', true, 'sendDocument'],
        ['shots/nope.png', false, undefined],
      ],
    );
    assert.match(results[2].error, /ENOENT|no such file/);
    assert.deepEqual(transport.calls.map((c) => c.method), ['sendPhoto', 'sendDocument']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sendFilesToChat downgrades a photo over 10MB to sendDocument', async () => {
  const root = workspace();
  const transport = fakeTransport();
  try {
    const big = join(root, 'shots', 'big.png');
    writeFileSync(big, PNG);
    truncateSync(big, 11 * 1024 * 1024);
    const { sendFilesToChat } = handlers(root, transport);
    const { results } = await sendFilesToChat(7, ['shots/big.png']);
    assert.equal(results[0].method, 'sendDocument', 'sendPhoto would reject >10MB');
    assert.equal(results[0].ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('sendFilesToChat refuses paths outside the workspace', async () => {
  const root = workspace();
  const outside = mkdtempSync(join(tmpdir(), 'dsh-answer-img-outside-'));
  const transport = fakeTransport();
  try {
    writeFileSync(join(outside, 'evil.png'), PNG);
    const { sendFilesToChat } = handlers(root, transport);
    const { results } = await sendFilesToChat(7, ['../' + 'x/evil.png']);
    assert.equal(results[0].ok, false);
    assert.deepEqual(transport.calls, [], 'nothing outside the workspace is uploaded');
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

/* ---------------- integration: the reply lane itself --------------------- */

function makeHost(root) {
  const host = {
    sends: [],
    edits: [],
    deletes: [],
    feedback: [],
    nextId: 100,
    inboundPending: false,
    inboundRepliedMarks: 0,
    consumer: undefined,
    uploads: [],
    currentAgentId: () => 'agent-1',
    currentChatId: () => 7,
    currentAgent: () => ({ id: 'agent-1' }),
    agentIdForChat: (chatId) => (chatId === 7 ? 'agent-1' : undefined),
    chatIdForAgent: (agentId) => (agentId === 'agent-1' ? 7 : undefined),
    liveFeedEnabled: () => true,
    bindAgent: () => {},
    unbindChat: () => {},
    workspaceRoot: () => root,
    sendLocalFiles: async (chatId, paths, caption) => {
      host.uploads.push({ chatId, paths: [...paths], caption });
      return { ok: true, delivered: paths.length, failed: [] };
    },
    send: async (chatId, text, options) => {
      const id = host.nextId++;
      host.sends.push({ chatId, text, options, id });
      return id;
    },
    editMessage: async (chatId, messageId, text, options) => {
      host.edits.push({ chatId, messageId, text, options });
      return true;
    },
    deleteMessage: async (chatId, messageId) => {
      host.deletes.push({ chatId, messageId });
    },
    attachFeedback: (chatId, telegramMessageId, sessionId, assistantMessageId) => {
      host.feedback.push({ chatId, telegramMessageId, sessionId, assistantMessageId });
    },
    statusStats: () => ({}),
    setAssistantConsumer: (consumer) => {
      host.consumer = consumer;
    },
    pendingInbound: () => host.inboundPending,
    inboundMessageId: () => (host.inboundPending ? 99 : undefined),
    markInboundReplied: () => {
      host.inboundRepliedMarks += 1;
      host.inboundPending = false;
    },
    stopLiveFeed: undefined,
    goalForChat: () => undefined,
    getConfigPath: () => true,
  };
  return host;
}

function makeCtx(host) {
  const listeners = new Map();
  const disposers = [];
  return {
    host,
    // apply() resolves its host from ctx.telegram (cordis service seam).
    telegram: host,
    get: () => undefined,
    on: (name, cb) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(cb);
      return () => {
        const list = listeners.get(name);
        const at = list ? list.indexOf(cb) : -1;
        if (at >= 0) list.splice(at, 1);
      };
    },
    effect: (fn) => {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    emit: (sessionId, event) => {
      for (const cb of [...(listeners.get('session/event') ?? [])]) cb({ id: sessionId }, event);
    },
  };
}

async function setup(root) {
  const host = makeHost(root);
  const ctx = makeCtx(host);
  host.requireCtx = () => ctx;
  const { apply } = await import('../dist/extensions/harness-feed.js');
  apply(ctx, undefined);
  return { host, ctx };
}

const ev = (type, data) => ({ type, data });

/** Drive one full turn whose committed answer is `finalText`. */
async function runTurn(host, ctx, finalText) {
  host.inboundPending = true;
  ctx.emit('agent-1', ev('turn/start', { turn: 1 }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'block-start', index: 0, blockType: 'text' } }));
  ctx.emit('agent-1', ev('assistant/chunk', { chunk: { type: 'text-delta', index: 0, text: finalText } }));
  await settle();
  const answerBubbleId = host.sends.at(-1)?.id;
  host.consumer?.(7, finalText, 'am-1');
  ctx.emit('agent-1', ev('turn/end', { turn: 1, reason: { kind: 'completed' } }));
  await settle();
  await sleep(5);
  return answerBubbleId;
}

test('a final answer referencing a workspace image uploads it as a photo and keeps the prose clean', async () => {
  const root = workspace();
  try {
    const { host, ctx } = await setup(root);
    const bubbleId = await runTurn(host, ctx, 'Tangkapan terang: ![light](shots/a.png) selesai.');

    assert.deepEqual(host.uploads, [{ chatId: 7, paths: ['shots/a.png'], caption: undefined }], 'the image must actually be uploaded');
    const settled = host.edits.filter((e) => e.messageId === bubbleId).at(-1);
    assert.ok(settled, 'the streamed bubble settles into the committed answer');
    assert.equal(settled.text, 'Tangkapan terang: selesai.', 'no dead path may survive in the bubble');
    assert.ok(!settled.text.includes('!['), 'Markdown image syntax never reaches the user');
    assert.equal(host.inboundRepliedMarks, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an answer that is only an image still delivers the photo instead of a "no reply" reminder', async () => {
  const root = workspace();
  try {
    const { host, ctx } = await setup(root);
    const sendsBefore = host.sends.length;
    await runTurn(host, ctx, '![](shots/b.jpg)');
    assert.deepEqual(host.uploads.map((u) => u.paths), [['shots/b.jpg']]);
    const after = host.sends.slice(sendsBefore);
    assert.ok(
      !after.some((s) => /NO_REPLY|Empty response|no reply/i.test(s.text)),
      'a delivered photo is not "no output"',
    );
    assert.equal(host.inboundRepliedMarks, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a remote image reference is left alone and uploads nothing', async () => {
  const root = workspace();
  try {
    const { host, ctx } = await setup(root);
    const bubbleId = await runTurn(host, ctx, 'Lihat ![remote](https://example.com/a.png) di sana.');
    assert.deepEqual(host.uploads, [], 'remote URLs are not workspace files');
    const settled = host.edits.filter((e) => e.messageId === bubbleId).at(-1);
    assert.ok(settled.text.includes('https://example.com/a.png'), 'the reference stays available to the reader');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing image reference degrades to text instead of failing the delivery', async () => {
  const root = workspace();
  try {
    const { host, ctx } = await setup(root);
    const bubbleId = await runTurn(host, ctx, 'Hilang: ![gone](shots/gone.png) ya.');
    assert.deepEqual(host.uploads, []);
    const settled = host.edits.filter((e) => e.messageId === bubbleId).at(-1);
    assert.equal(settled.text, 'Hilang: ![gone](shots/gone.png) ya.', 'the model intent is preserved, the turn still delivers');
    assert.equal(host.inboundRepliedMarks, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/* ---------------- the served host seam (index.ts closure) ---------------- */

test('the provided telegram service exposes sendLocalFiles and enforces the roster', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-answer-img-host-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '123456:answer-image-test';

  const sent = [];
  const originalSendPhoto = TelegramTransport.prototype.sendPhoto;
  const originalSendDocument = TelegramTransport.prototype.sendDocument;
  TelegramTransport.prototype.sendPhoto = async function (chatId, buffer, filename, caption) {
    sent.push({ method: 'sendPhoto', chatId, filename, caption, bytes: buffer.length });
    return 1;
  };
  TelegramTransport.prototype.sendDocument = async function (chatId, buffer, filename) {
    sent.push({ method: 'sendDocument', chatId, filename });
    return 2;
  };

  const ctx = {
    get: () => undefined,
    provide: (_name, value) => ctx.services.set(_name, value),
    on: () => () => {},
    effect: () => {},
    tools: { register: (definition) => ctx.toolsDefs.set(definition.name, definition) },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
  };

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [] } }));
    writeFileSync(join(base, 'shot.png'), PNG);
    process.chdir(base);
    applyPlugin(ctx, {});

    const telegram = ctx.services.get('telegram');
    assert.ok(telegram, 'the plugin provides its host service');
    assert.equal(typeof telegram.sendLocalFiles, 'function', 'the streaming renderer needs this seam');
    await ctx.command.handler({ rawInput: 'allow 7' });

    const ok = await telegram.sendLocalFiles(7, ['shot.png']);
    assert.equal(ok.ok, true);
    assert.equal(ok.delivered, 1);
    assert.deepEqual(ok.failed, []);
    assert.deepEqual(sent.map((c) => [c.method, c.chatId, c.filename]), [['sendPhoto', 7, 'shot.png']]);

    const blocked = await telegram.sendLocalFiles(999, ['shot.png']);
    assert.equal(blocked.ok, false);
    assert.match(blocked.failed[0].error, /roster/);
    assert.equal(sent.length, 1, 'a chat outside the roster receives nothing');

    const missing = await telegram.sendLocalFiles(7, ['nope.png']);
    assert.equal(missing.ok, false);
    assert.equal(missing.delivered, 0);
    assert.match(missing.failed[0].error, /ENOENT|no such file/i);
  } finally {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    TelegramTransport.prototype.sendPhoto = originalSendPhoto;
    TelegramTransport.prototype.sendDocument = originalSendDocument;
    rmSync(base, { recursive: true, force: true });
  }
});

test('a host without the upload seam keeps the old behaviour for an images-only answer', async () => {
  const root = workspace();
  try {
    const { host, ctx } = await setup(root);
    delete host.sendLocalFiles;
    const bubbleId = await runTurn(host, ctx, '![](shots/a.png)');
    const settled = host.edits.filter((e) => e.messageId === bubbleId).at(-1);
    assert.ok(settled, 'the answer still settles into its bubble');
    assert.ok(
      settled.text.includes('shots/a.png'),
      'without an upload seam the reference must still be shown, never silently dropped',
    );
    assert.ok(!/no reply|turn ended without/i.test(settled.text), 'and never replaced by a reminder');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an images-only answer whose upload fails falls back to text instead of vanishing', async () => {
  const root = workspace();
  try {
    const { host, ctx } = await setup(root);
    host.sendLocalFiles = async (chatId, paths) => ({
      ok: false,
      delivered: 0,
      failed: paths.map((path) => ({ path, error: 'boom' })),
    });
    const sendsBefore = host.sends.length;
    await runTurn(host, ctx, '![](shots/a.png)');
    const after = host.sends.slice(sendsBefore);
    assert.ok(after.length > 0, 'a turn with zero delivered content must still say something');
    assert.ok(after.some((s) => s.text.includes('shots/a.png')), 'the fallback carries the original reference');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
