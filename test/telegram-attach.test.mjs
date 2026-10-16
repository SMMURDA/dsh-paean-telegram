import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, truncateSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

test('telegram_attach sends whitelisted workspace files and routes them by extension (#25)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-attach-'));
  const outsideBase = mkdtempSync(join(tmpdir(), 'dsh-attach-outside-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  process.env.TELEGRAM_BOT_TOKEN = '123456:attach-test';

  const sent = { photo: [], voice: [], audio: [], document: [] };
  const ctx = {
    get: () => undefined,
    provide: (_name, value) => {
      ctx.services.set(_name, value);
    },
    on: () => () => {},
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
  };

  const originalSendDocument = TelegramTransport.prototype.sendDocument;
  const originalSendPhoto = TelegramTransport.prototype.sendPhoto;
  const originalSendVoice = TelegramTransport.prototype.sendVoice;
  const originalSendAudio = TelegramTransport.prototype.sendAudio;
  TelegramTransport.prototype.sendDocument = async function (chatId, buffer, filename, caption) {
    sent.document.push({ chatId, filename, caption, bytes: buffer.length });
    return 1;
  };
  TelegramTransport.prototype.sendPhoto = async function (chatId, buffer, filename, caption) {
    sent.photo.push({ chatId, filename, caption, bytes: buffer.length });
    return 1;
  };
  TelegramTransport.prototype.sendVoice = async function (chatId, buffer, filename, caption) {
    sent.voice.push({ chatId, filename, caption, bytes: buffer.length });
    return 1;
  };
  TelegramTransport.prototype.sendAudio = async function (chatId, buffer, filename, caption) {
    sent.audio.push({ chatId, filename, caption, bytes: buffer.length });
    return 1;
  };

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [] } }));
    mkdirSync(join(base, 'sub'));
    writeFileSync(join(base, 'photo.png'), 'PNG-BYTES');
    writeFileSync(join(base, 'voice.ogg'), 'OGG-BYTES');
    writeFileSync(join(base, 'song.mp3'), 'MP3-BYTES');
    writeFileSync(join(base, 'sub', 'note.txt'), 'NOTE');
    writeFileSync(join(base, 'huge.bin'), '');
    truncateSync(join(base, 'huge.bin'), 50 * 1024 * 1024 + 1);
    writeFileSync(join(outsideBase, 'outside.txt'), 'OUTSIDE');

    process.chdir(base);
    applyPlugin(ctx, {});

    const telegram = ctx.services.get('telegram');
    assert.ok(telegram);
    await ctx.command.handler({ rawInput: 'allow 7' });
    telegram.bindAgent(7, 'agent-1');

    const tool = ctx.toolsDefs.get('telegram_attach');
    const alias = ctx.toolsDefs.get('telegram_send_file');
    assert.ok(tool, 'telegram_attach is registered');
    assert.ok(alias, 'telegram_send_file alias is registered');

    // Multi-file send with automatic photo/voice/audio/document routing and
    // the bound chat used as the default target.
    const result = JSON.parse(await tool.execute({
      paths: ['photo.png', 'voice.ogg', 'song.mp3', 'sub/note.txt'],
      caption: '<b>delivery</b>',
    }, { agent: { id: 'agent-1' } }));
    assert.equal(result.ok, true);
    assert.equal(sent.photo.length, 1);
    assert.equal(sent.voice.length, 1);
    assert.equal(sent.audio.length, 1);
    assert.equal(sent.document.length, 1);
    assert.equal(sent.photo[0].filename, 'photo.png');
    assert.equal(sent.voice[0].filename, 'voice.ogg');
    assert.equal(sent.audio[0].filename, 'song.mp3');
    assert.equal(sent.document[0].filename, 'note.txt');
    for (const entry of [...sent.photo, ...sent.voice, ...sent.audio, ...sent.document]) {
      assert.equal(entry.chatId, 7, 'defaults to the executing agent bound chat');
      assert.equal(entry.caption, '<b>delivery</b>');
    }

    // Roster check is shared with the other telegram_* tools.
    const blockedChat = JSON.parse(await tool.execute({ paths: ['photo.png'], chatId: '999' }, { agent: { id: 'agent-1' } }));
    assert.equal(blockedChat.ok, false);
    assert.match(blockedChat.error, /not in the allowed roster/);

    // Workspace path whitelist: ../ traversal and missing/oversized entries
    // fail per-file without aborting the whole batch.
    const guarded = JSON.parse(await tool.execute({
      paths: ['photo.png', `../${basename(outsideBase)}/outside.txt`, 'missing.bin', 'huge.bin', '.'],
    }, { agent: { id: 'agent-1' } }));
    assert.equal(guarded.ok, false);
    assert.equal(guarded.results[0].ok, true);
    assert.match(guarded.results[1].error, /outside the workspace/);
    assert.match(guarded.results[2].error, /ENOENT|not found/i);
    assert.match(guarded.results[3].error, /50MB/);
    assert.match(guarded.results[4].error, /not a file/);

    // 1-10 file bound is enforced before any send happens.
    const tooMany = JSON.parse(await tool.execute({ paths: Array.from({ length: 11 }, (_, index) => `f${index}`) }, { agent: { id: 'agent-1' } }));
    assert.equal(tooMany.ok, false);
    assert.match(tooMany.error, /1-10/);

    // The alias resolves the same executor.
    const aliasResult = JSON.parse(await alias.execute({ paths: ['photo.png'] }, { agent: { id: 'agent-1' } }));
    assert.equal(aliasResult.ok, true);
    assert.equal(aliasResult.results[0].method, 'sendPhoto');
    assert.equal(sent.photo.length, 3, 'first batch + guarded batch valid photo + alias send');
  } finally {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    TelegramTransport.prototype.sendDocument = originalSendDocument;
    TelegramTransport.prototype.sendPhoto = originalSendPhoto;
    TelegramTransport.prototype.sendVoice = originalSendVoice;
    TelegramTransport.prototype.sendAudio = originalSendAudio;
    rmSync(base, { recursive: true, force: true });
    rmSync(outsideBase, { recursive: true, force: true });
  }
});
