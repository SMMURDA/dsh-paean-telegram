import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('two rapid first messages create exactly one session (handler awaits create)', async () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-apply-race-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;

  const listeners = new Map();
  const liveAgents = new Map();
  let creates = 0;
  const ctx = {
    get: () => undefined,
    provide: (_name, value) => {
      ctx.services.set(_name, value);
    },
    on: (name, listener) => {
      if (!listeners.has(name)) listeners.set(name, []);
      listeners.get(name).push(listener);
      return () => {};
    },
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
    agents: {
      async create(options) {
        creates += 1;
        await sleep(30); // give the second inbound a chance to slip in
        const id = String(options.sessionId);
        const agent = {
          id,
          status: 'running',
          options: { provider: 'test-provider', model: 'test-model' },
          send: () => {},
          followup: () => {},
          session: { events: [] },
          inbox: { nextTurn: [], nextStep: [] },
        };
        liveAgents.set(id, agent);
        return { agent, dispose: async () => { liveAgents.delete(id); } };
      },
      get: (id) => liveAgents.get(String(id)),
      list: () => [...liveAgents.values()],
    },
  };

  let handlers;
  const originalSetHandlers = TelegramTransport.prototype.setHandlers;
  const originalSendText = TelegramTransport.prototype.sendText;
  const originalEditText = TelegramTransport.prototype.editText;
  const originalDeleteMessage = TelegramTransport.prototype.deleteMessage;
  TelegramTransport.prototype.setHandlers = function (value) {
    handlers = value;
    return originalSetHandlers.call(this, value);
  };
  TelegramTransport.prototype.sendText = async () => 71;
  TelegramTransport.prototype.sendTextControl = async () => 71;
  TelegramTransport.prototype.sendTextFallback = async () => 71;
  TelegramTransport.prototype.editText = async () => true;
  TelegramTransport.prototype.editTextControl = async () => true;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.sendChatAction = async () => {};
  TelegramTransport.prototype.sendChatActionControl = async () => {};

  try {
    mkdirSync(join(base, '.pi'));
    writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] } }));
    process.chdir(base);
    process.env.TELEGRAM_BOT_TOKEN = '123456:apply-race-test';

    applyPlugin(ctx, {});

    const first = handlers.onText(7, 'first message');
    const second = handlers.onText(7, 'second message');
    await Promise.all([first, second]);

    assert.equal(creates, 1, 'the second first-message must reuse the session created by the first');
    assert.equal(liveAgents.size, 1);
    assert.equal(ctx.services.get('telegram').agentIdForChat(7), [...liveAgents.keys()][0]);
  } finally {
    process.chdir(oldCwd);
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    // Deliberately leave sendText/editText/deleteMessage patched for this
    // isolated test process: a debounced bar-sync timer may fire after the
    // test returns, and it must hit the stub instead of the real Bot API.
    TelegramTransport.prototype.setHandlers = originalSetHandlers;
    rmSync(base, { recursive: true, force: true });
  }
});
