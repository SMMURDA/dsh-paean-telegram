import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

test('broadcast roster only contains whitelisted chats and reconciles on allow/disallow', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-security-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;

  const subscribed = [];
  const sent = [];
  const ctx = {
    get: () => undefined,
    provide: (_name, value) => {
      ctx.services.set(_name, value);
    },
    on: (name) => {
      subscribed.push(name);
      return () => {};
    },
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
  };

  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  const originalSetCommands = TelegramTransport.prototype.setCommands;
  const originalSetMenuButton = TelegramTransport.prototype.setMenuButtonToCommands;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  TelegramTransport.prototype.sendText = async (chatId, text, options) => {
    sent.push({ chatId, text, options });
    return sent.length;
  };
  TelegramTransport.prototype.sendTextControl = TelegramTransport.prototype.sendText;
  TelegramTransport.prototype.sendTextFallback = TelegramTransport.prototype.sendText;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.editTextControl = async () => true;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async () => {};
  TelegramTransport.prototype.setCommands = async () => {};
  TelegramTransport.prototype.setMenuButtonToCommands = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [] } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:security-test';

    applyPlugin(ctx, {});

    const telegram = ctx.services.get('telegram');
    assert.ok(telegram);
    assert.deepEqual(telegram.chats(), []);

    // The web's forwarded host/remote events must all be subscribed: open
    // panels re-read their data source when any of them fires.
    for (const name of [
      'session/created', 'session/disposed', 'agent/error', 'domain/changed',
      'agent-preset/selected', 'commands/change', 'credentials/updated',
      'settings/document-updated', 'llm/adapters-updated',
      'cordis/request-run', 'cordis/request-run-resolved',
      'cordis/dynamic-package', 'cordis/dynamic-retract',
      'cordis/inspect-query', 'cordis/inspect-query-resolved',
    ]) {
      assert.ok(subscribed.includes(name), `missing subscription: ${name}`);
    }

    // An unauthorized `/start` gets the allow prompt and queues a welcome
    // replay for after the allow tap; it must not enter the roster yet.
    await handlers.onText(222, '/start');
    assert.deepEqual(telegram.chats(), []);

    // Agent tools must not bypass the whitelist either.
    const send = JSON.parse(await ctx.toolsDefs.get('telegram_send').execute({ chatId: '222', text: 'x' }));
    assert.equal(send.ok, false);
    assert.match(send.error, /not in the allowed roster/);
    const broadcast = JSON.parse(await ctx.toolsDefs.get('telegram_broadcast').execute({ targets: [{ chatId: '222' }], text: 'x' }));
    assert.equal(broadcast.ok, false);
    assert.match(broadcast.results[0].error, /not in the allowed roster/);

    // The self-service allow button promotes the chat and replays the /start
    // welcome the user originally asked for.
    await handlers.onCallback(222, 'm:allowthis');
    assert.deepEqual(telegram.chats(), [222]);
    assert.ok(sent.some((entry) => String(entry.text).includes('ready')), 'the queued /start welcome must land after allow');

    // A bound session must be unbound together with the roster slot so it
    // cannot keep receiving assistant events after losing whitelist access.
    telegram.bindAgent(222, 'fake-agent');
    assert.equal(telegram.chatIdForAgent('fake-agent'), 222);

    // dsh-side disallow must remove it immediately, without a restart.
    await ctx.command.handler({ rawInput: 'disallow 222' });
    assert.deepEqual(telegram.chats(), []);
    assert.deepEqual(telegram.getConfig().security.allowedChatIds, []);
    assert.equal(telegram.chatIdForAgent('fake-agent'), undefined);
  } finally {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    TelegramTransport.prototype.setHandlers = originalSetHandlers;
    TelegramTransport.prototype.sendText = originalSendText;
    TelegramTransport.prototype.editText = originalEditText;
    TelegramTransport.prototype.deleteMessage = originalDeleteMessage;
    TelegramTransport.prototype.setCommands = originalSetCommands;
    TelegramTransport.prototype.setMenuButtonToCommands = originalSetMenuButton;
    rmSync(base, { recursive: true, force: true });
  }
});

test('TokenRegistry binds minted tokens to their minting chat (RF-1)', async () => {
  const { TokenRegistry } = await import('../dist/telegram/tokens.js');
  const registry = new TokenRegistry();

  // A chat-bound token executes only for its minting chat; a foreign tap is
  // rejected WITHOUT consuming the token (it stays pending for the owner).
  const owned = registry.mint({ action: 'x' }, 111);
  assert.equal(registry.take(owned, 222), undefined, 'a foreign chat must not execute the token');
  assert.equal(registry.wasUsed(owned), false, 'the rejection must not consume the token');
  assert.deepEqual(registry.take(owned, 111), { action: 'x' });

  // Tokens minted without a chat stay world-usable — every pre-RF-1 caller
  // and card keeps working unchanged.
  const legacy = registry.mint({ action: 'y' });
  assert.deepEqual(registry.take(legacy, 222), { action: 'y' });
  const legacy2 = registry.mint({ action: 'y2' });
  assert.deepEqual(registry.take(legacy2), { action: 'y2' });

  // An owned token cannot be taken without proving the chat either.
  const owned2 = registry.mint({ action: 'z' }, 111);
  assert.equal(registry.take(owned2), undefined);
  assert.deepEqual(registry.take(owned2, 111), { action: 'z' });

  // restore() re-establishes ownership with the chat that legitimately took
  // the token, so a retryable failed callback keeps its binding.
  const owned3 = registry.mint({ action: 'w' }, 111);
  registry.take(owned3, 111);
  assert.equal(registry.restore(owned3, { action: 'w' }, 111), true);
  assert.equal(registry.take(owned3, 222), undefined);
  assert.deepEqual(registry.take(owned3, 111), { action: 'w' });

  // reset wipes every ledger — payload, used marks, and ownership.
  registry.mint({ action: 'v' }, 111);
  registry.reset();
  assert.equal(registry.pending(), 0);
});

/** Compact full-plugin boot for the security regressions below: stubs the
 * transport, records every outbound send, mounts the plugin over a temp
 * workspace with the given allowed-chat roster. `selfAllow` seeds the CF-1
 * kill-switch into .pi/telegram.json to prove a hand-edited file is honored
 * at boot; absent keeps the historical key-less file shape. */
async function bootSecurityHarness({ allowedChatIds, label, selfAllow }) {
  const base = mkdtempSync(join(tmpdir(), `dsh-telegram-${label}-`));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const sent = [];
  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  const recordSend = async (chatId, text, options) => {
    sent.push({ chatId, text, options });
    return sent.length;
  };
  TelegramTransport.prototype.sendText = recordSend;
  TelegramTransport.prototype.sendTextControl = recordSend;
  TelegramTransport.prototype.sendTextFallback = recordSend;
  // Card re-renders edit the ephemeral card in place; record those too.
  TelegramTransport.prototype.editText = async (chatId, messageId, text, options) => {
    sent.push({ chatId, text, options });
    return true;
  };
  TelegramTransport.prototype.editTextControl = TelegramTransport.prototype.editText;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};

  mkdirSync(join(base, '.pi'));
  writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({
    security: { allowedChatIds, ...(selfAllow === undefined ? {} : { selfAllow }) },
  }));
  process.chdir(base);
  process.env.TELEGRAM_BOT_TOKEN = `123456:${label}-test`;
  const ctx = {
    get: () => undefined,
    provide: (_name, value) => { ctx.services.set(_name, value); },
    on: () => () => {},
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
  };
  await applyPlugin(ctx, {});
  return {
    sent,
    handlers,
    telegram: ctx.services.get('telegram'),
    cleanup() {
      process.chdir(oldCwd);
      if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = oldToken;
      TelegramTransport.prototype.setHandlers = originalSetHandlers;
      TelegramTransport.prototype.sendText = originalSendText;
      TelegramTransport.prototype.editText = originalEditText;
      TelegramTransport.prototype.deleteMessage = originalDeleteMessage;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

test('allowthis honors security.selfAllow = false with a visible refusal (A-1)', async () => {
  // CF-1: an allowed chat flips the documented switch through the real
  // config path (/config set → overlayConfig → persist), so this exercises
  // reachability of the kill-switch instead of poking the live object.
  const harness = await bootSecurityHarness({ allowedChatIds: [7], label: 'selfallow' });
  try {
    assert.ok(harness.telegram);

    await harness.handlers.onText(7, '/config set security.selfAllow false');
    assert.ok(
      harness.sent.some((entry) => String(entry.text).includes('applied live + persisted')),
      'the documented kill-switch path must be accepted and hot-applied',
    );
    assert.equal(harness.telegram.getConfig().security.selfAllow, false);
    const persisted = JSON.parse(readFileSync(join(process.cwd(), '.pi', 'telegram.json'), 'utf8'));
    assert.equal(persisted.security.selfAllow, false, 'the flip must survive under .pi/telegram.json');

    await harness.handlers.onCallback(222, 'm:allowthis');
    assert.deepEqual(harness.telegram.chats(), [7], 'self-allow must not promote the tapping chat (7 stays the only member)');
    assert.deepEqual(harness.telegram.getConfig().security.allowedChatIds, [7], 'the roster must stay untouched');
    const refusal = harness.sent.find((entry) => String(entry.text).includes('Self-allow is disabled'));
    assert.ok(refusal, 'the tap must answer with the refusal text');

    // Re-enabling through the same route restores the bootstrap channel —
    // explicit true behaves exactly like the historical absent default.
    await harness.handlers.onText(7, '/config set security.selfAllow true');
    await harness.handlers.onCallback(222, 'm:allowthis');
    assert.deepEqual(harness.telegram.chats(), [7, 222]);
  } finally {
    harness.cleanup();
  }
});

test('a hand-edited security.selfAllow=false in telegram.json gates allowthis after boot (CF-1)', async () => {
  const harness = await bootSecurityHarness({ allowedChatIds: [], label: 'selfallow-reboot', selfAllow: false });
  try {
    // The persisted form must gate on its own — no runtime flip needed — so
    // closing the channel survives bridge restarts.
    await harness.handlers.onCallback(333, 'm:allowthis');
    assert.deepEqual(harness.telegram.chats(), []);
    assert.equal(harness.telegram.getConfig().security.selfAllow, false);
    const refusal = harness.sent.find((entry) => String(entry.text).includes('Self-allow is disabled'));
    assert.ok(refusal, 'the tap must answer with the refusal text');
  } finally {
    harness.cleanup();
  }
});

test('/config get masks secret-shaped values and /config set keeps JSON spacing (RE-3 + RH-1)', async () => {
  const { maskConfigValue } = await import('../dist/core/commands.js');

  // Masking rule: secret-shaped leaf paths show only the last four
  // characters; every other path renders exactly as before.
  assert.equal(maskConfigValue('media.transcribe.apiKey', '1234abcd'), '***abcd');
  assert.equal(maskConfigValue('smtp.password', 'p@55w0rd'), '***w0rd');
  assert.equal(maskConfigValue('a.b.secret', 'kittens'), '***tens');
  assert.equal(maskConfigValue('media.transcribe.model', 'whisper'), '"whisper"');
  assert.equal(maskConfigValue('outbound.maxRetries', 3), '3');

  const harness = await bootSecurityHarness({ allowedChatIds: [7], label: 'configmask' });
  try {
    // RH-1: consecutive spaces inside a JSON value survive into the stored
    // config instead of being collapsed by whitespace splitting.
    await harness.handlers.onText(7, '/config set media.transcribe.model "hello  world"');
    assert.ok(
      harness.sent.some((entry) => String(entry.text).includes('applied live + persisted')),
      'the set must succeed',
    );
    await harness.handlers.onText(7, '/config get media.transcribe.model');
    const modelReply = harness.sent.find((entry) => String(entry.text).startsWith('media.transcribe.model'));
    // The reply travels under parse_mode HTML, so quotes are wire-escaped as
    // &quot; — assert on the decoded semantics, not the raw byte form.
    assert.ok(modelReply && String(modelReply.text).replaceAll('&quot;', '"').includes('"hello  world"'), 'internal double space must survive the round trip');

    // RE-3: secret-shaped values never echo in full.
    await harness.handlers.onText(7, '/config set media.transcribe.apiKey "super-secret-ab12"');
    await harness.handlers.onText(7, '/config get media.transcribe.apiKey');
    const secretReply = harness.sent.filter((entry) => String(entry.text).startsWith('media.transcribe.apiKey')).pop();
    assert.ok(secretReply, 'the get must be answered');
    assert.ok(String(secretReply.text).includes('***ab12'), 'the value must be masked to its last four characters');
    assert.equal(String(secretReply.text).includes('super-secret'), false, 'no plaintext fragment may leak');

    // The stored config still holds the REAL value — masking is display-only.
    assert.equal(harness.telegram.getConfig().media.transcribe.apiKey, 'super-secret-ab12');
  } finally {
    harness.cleanup();
  }
});
