/**
 * SC-2 regression: askConfirm's confirm/cancel tokens must be minted BOUND to
 * the asking chat (RF-1 owner map in telegram/tokens.ts). Before SC-2 the
 * CardRegistryDeps.token seam dropped chatId, so a destructive-action confirm
 * card rendered in chat A could be consumed from any other whitelisted chat B.
 *
 * Layered like menu.test.mjs: one seam-level unit test on createCardRegistry,
 * then full-plugin harness runs driving the real session-delete flow
 * (Sessions list → Delete → ✅ Confirm / ✖ Cancel) over two whitelisted chats.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';
import { createCardRegistry } from '../dist/core/cards.js';

// ---------------------------------------------------------------------------
// Seam contract: askConfirm passes its chatId into BOTH token mints.
// ---------------------------------------------------------------------------

test('askConfirm mints both keyboard tokens bound to the asking chat (SC-2)', async () => {
  const mints = [];
  const registry = createCardRegistry({
    requireTransport: () => ({}),
    uiOps: () => ({}),
    ephemeral: { replace: async () => {} },
    token: (payload, chatId) => {
      mints.push({ payload, chatId });
      return `t:${mints.length}`;
    },
    log: () => {},
    uiSend: async () => 1,
  });
  await registry.askConfirm(7, 'Sure?', { action: 'do-it' }, { action: 'skip-it' });
  assert.deepEqual(mints, [
    { payload: { action: 'do-it' }, chatId: 7 },
    { payload: { action: 'skip-it' }, chatId: 7 },
  ]);
});

// ---------------------------------------------------------------------------
// CD-1: openCard must not mutate activeCardRenderers until the ephemeral
// replace succeeds. A failed replace leaves no renderer behind that could
// later resurrect a card from web events.
// ---------------------------------------------------------------------------

test('openCard does not register a refresh renderer when ephemeral.replace throws (CD-1)', async () => {
  const registry = createCardRegistry({
    requireTransport: () => ({}),
    uiOps: () => ({}),
    ephemeral: {
      replace: async () => {
        throw new Error('replace failed');
      },
    },
    token: () => 't',
    log: () => {},
    uiSend: async () => 1,
  });

  const refresh = async () => {};
  await assert.rejects(registry.openCard(7, 'card', {}, refresh));
  assert.equal(registry.activeCardRenderers.has(7), false, 'failed replace must not leave a refresh renderer behind');
});

test('openCard registers a refresh renderer after a resolving ephemeral.replace (CD-1)', async () => {
  const registry = createCardRegistry({
    requireTransport: () => ({}),
    uiOps: () => ({}),
    ephemeral: {
      replace: async () => {},
    },
    token: () => 't',
    log: () => {},
    uiSend: async () => 1,
  });

  const refresh = async () => {};
  await registry.openCard(7, 'card', {}, refresh);
  assert.equal(registry.activeCardRenderers.get(7), refresh, 'successful replace must register the refresh renderer');
});

// ---------------------------------------------------------------------------
// Full-plugin card harness (menu.test.mjs idiom) with TWO whitelisted private
// chats — exactly the RF-1 threat model: both chats pass the router
// whitelist, so only the token owner map can keep them apart.
// ---------------------------------------------------------------------------

async function bootConfirmHarness() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-confirm-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const liveAgents = new Map();
  const sent = [];
  const ctx = {
    services: new Map(),
    toolsDefs: new Map(),
    command: undefined,
    provide(name, value) { ctx.services.set(name, value); },
    get(name) { return ctx.services.get(name); },
    on: () => () => {},
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    commands: { register: (definition) => { ctx.command = definition; } },
    agents: {
      get: (id) => liveAgents.get(String(id)),
      list: () => [...liveAgents.values()],
      create: async () => {
        const agent = makeFakeAgent(`agent-${liveAgents.size + 1}`);
        liveAgents.set(agent.id, agent);
        // SessionLifecycle tracks this handle verbatim; deleteSession later
        // calls tracked.dispose() — route it into the agent's spy.
        return { agent, dispose: async () => { agent.disposeCalls += 1; } };
      },
    },
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
  const recordSend = async function (chatId, text, options) {
    sent.push({ chatId, text, options });
    return sent.length;
  };
  TelegramTransport.prototype.sendText = recordSend;
  TelegramTransport.prototype.sendTextControl = recordSend;
  TelegramTransport.prototype.sendTextFallback = recordSend;
  TelegramTransport.prototype.editText = async (chatId, messageId, text, options) => {
    // Card re-renders replace the ephemeral card message in place; record
    // them like sends so keyboard assertions see the latest markup.
    sent.push({ chatId, text, options });
    return true;
  };
  TelegramTransport.prototype.editTextControl = TelegramTransport.prototype.editText;
  TelegramTransport.prototype.deleteMessage = async () => {};
  TelegramTransport.prototype.deleteMessageControl = async () => {};
  TelegramTransport.prototype.setCommands = async () => {};
  TelegramTransport.prototype.setMenuButtonToCommands = async () => {};

  mkdirSync(join(base, '.pi'));
  writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7, 8] } }));
  process.chdir(base);
  process.env.TELEGRAM_BOT_TOKEN = '123456:confirm-test';
  await applyPlugin(ctx, {});
  const telegram = ctx.services.get('telegram');
  return {
    ctx,
    liveAgents,
    sent,
    handlers,
    telegram,
    cleanup() {
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
    },
  };
}

function makeFakeAgent(id) {
  return {
    id,
    status: 'idle',
    options: { provider: 'test', model: 'test' },
    session: { events: [] },
    // deleteSession disposes through the tracked handle or the registry
    // fallback; the spy keeps that path observable and harmless on fakes.
    disposeCalls: 0,
    async dispose() { this.disposeCalls += 1; },
    inbox: {
      nextTurn: [],
      nextStep: [],
      remove(itemId) {
        this.nextTurn = this.nextTurn.filter((m) => m.id !== itemId);
        this.nextStep = this.nextStep.filter((m) => m.id !== itemId);
      },
      replace() { return false; },
    },
  };
}

/** Flatten every inline button rendered by the sends recorded so far. */
function keyboardButtons(sent) {
  const buttons = [];
  for (const entry of sent) {
    const kb = entry.options?.reply_markup?.inline_keyboard;
    if (Array.isArray(kb)) for (const row of kb) for (const button of row ?? []) buttons.push(button);
  }
  return buttons;
}

/** Create+bind one session through the real New Session card flow. */
async function createBoundSession(harness) {
  await harness.handlers.onCallback(7, 'm:new');
  const button = keyboardButtons(harness.sent).find((entry) => entry.text.includes('Use default preset'));
  assert.ok(button, 'the New Session card must offer the default-preset button');
  await harness.handlers.onCallback(7, button.callback_data);
  const sessionId = [...harness.liveAgents.keys()][0];
  assert.ok(sessionId, 'the default-preset tap must create a session');
  return String(sessionId);
}

/** Walk the real delete-confirm flow: `s:<id>:delete` renders the
 * askConfirm card; return its Confirm/Cancel token strings. */
async function openDeleteConfirmCard(harness, sessionId) {
  harness.sent.length = 0;
  await harness.handlers.onCallback(7, `s:${sessionId}:delete`);
  const confirm = keyboardButtons(harness.sent).find((entry) => entry.text.includes('Confirm') && entry.callback_data.startsWith('t:'));
  const cancel = keyboardButtons(harness.sent).find((entry) => entry.text.includes('Cancel') && entry.callback_data.startsWith('t:'));
  assert.ok(confirm && cancel, 'delete must ask for confirmation via the Confirm/Cancel card');
  return { confirm: confirm.callback_data, cancel: cancel.callback_data };
}

function deletionAnnouncements(sent) {
  return sent.filter((entry) => String(entry.text).includes('deleted'));
}

test('a confirm token asked in chat 7 is rejected from chat 8 and stays executable by chat 7 (SC-2)', async () => {
  const harness = await bootConfirmHarness();
  try {
    const sessionId = await createBoundSession(harness);
    const { confirm } = await openDeleteConfirmCard(harness, sessionId);

    // Foreign tap from the OTHER whitelisted chat: take() must reject the
    // ownership check — no deletion anywhere, and the token stays pending.
    harness.sent.length = 0;
    await harness.handlers.onCallback(8, confirm);
    assert.equal(deletionAnnouncements(harness.sent).length, 0, 'a foreign tap must NOT run the destructive action');
    assert.equal(harness.liveAgents.get(sessionId)?.disposeCalls ?? 0, 0, 'a foreign tap must not dispose the session');
    const foreignMiss = harness.sent.find((entry) => entry.chatId === 8 && String(entry.text).includes('older card'));
    assert.ok(foreignMiss, 'the foreign tap must be answered with the token-miss notice, not silence');

    // The same token is still pending for its owner: the legit tap deletes
    // exactly once, proving the foreign tap neither ran nor consumed it.
    await harness.handlers.onCallback(7, confirm);
    const announcements = deletionAnnouncements(harness.sent).filter((entry) => entry.chatId === 7);
    assert.equal(announcements.length, 1, 'the owning chat must still execute the confirmed delete');
    assert.ok(String(announcements[0].text).includes(sessionId), 'the delete must act on the asked session');
    assert.equal(harness.liveAgents.get(sessionId)?.disposeCalls, 1, 'the confirmed delete must dispose the session exactly once');
  } finally {
    harness.cleanup();
  }
});

test('same-chat confirm executes exactly once and consumes the token (SC-2)', async () => {
  const harness = await bootConfirmHarness();
  try {
    const sessionId = await createBoundSession(harness);
    const { confirm } = await openDeleteConfirmCard(harness, sessionId);

    await harness.handlers.onCallback(7, confirm);
    const first = deletionAnnouncements(harness.sent).filter((entry) => entry.chatId === 7);
    assert.equal(first.length, 1, 'the confirmed delete must run once');
    assert.ok(String(first[0].text).includes(sessionId), 'the delete must act on the asked session');
    assert.equal(harness.liveAgents.get(sessionId)?.disposeCalls, 1, 'the confirmed delete must dispose the session exactly once');

    // Consume-once: a redelivered callback must not run the action twice.
    await harness.handlers.onCallback(7, confirm);
    assert.equal(deletionAnnouncements(harness.sent).length, 1, 'a replayed confirm must stay consumed');
    assert.equal(harness.liveAgents.get(sessionId)?.disposeCalls, 1, 'a replayed confirm must not dispose again');
    const replayNotice = harness.sent.find((entry) => String(entry.text).includes('already ran'));
    assert.ok(replayNotice, 'the replay must be told the button already handled');
  } finally {
    harness.cleanup();
  }
});

test('same-chat cancel runs nothing and consumes the cancel token (SC-2)', async () => {
  const harness = await bootConfirmHarness();
  try {
    const sessionId = await createBoundSession(harness);
    const { cancel } = await openDeleteConfirmCard(harness, sessionId);

    await harness.handlers.onCallback(7, cancel);
    assert.equal(deletionAnnouncements(harness.sent).length, 0, 'cancel must not run the destructive action');
    assert.equal(harness.liveAgents.get(sessionId)?.disposeCalls ?? 0, 0, 'cancel must not dispose the session');
    const cancelled = harness.sent.find((entry) => String(entry.text).includes('cancelled'));
    assert.ok(cancelled, 'cancel must answer with its cancellation notice');

    // Consume-once applies to the cancel leg too.
    await harness.handlers.onCallback(7, cancel);
    assert.equal(deletionAnnouncements(harness.sent).length, 0, 'a replayed cancel still deletes nothing');
    assert.equal(harness.liveAgents.get(sessionId)?.disposeCalls ?? 0, 0, 'a replayed cancel still disposes nothing');
    const replayNotice = harness.sent.find((entry) => String(entry.text).includes('already ran'));
    assert.ok(replayNotice, 'the replayed cancel must read as already handled');
  } finally {
    harness.cleanup();
  }
});
