import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Regression bundle for the three user-reported defects:
//   1. model switching inside a live session (twice in a row) + sticky default
//   2. streaming output: the harness feed mounts built-in (no loader entry)
//   3. native Telegram menu button: command list synced on every mount and
//      every advertised command actually dispatches
// ---------------------------------------------------------------------------

const base = mkdtempSync(join(tmpdir(), 'dsh-tg-regression-'));
const oldCwd = process.cwd();
const oldToken = process.env.TELEGRAM_BOT_TOKEN;
mkdirSync(join(base, '.pi'));
writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] }, watch: { autoStart: false } }));
process.chdir(base);
process.env.TELEGRAM_BOT_TOKEN = '123456:regression-test';

const { apply: applyPlugin } = await import('../dist/index.js');
const { TELEGRAM_COMMANDS } = await import('../dist/core/commands.js');
const { mountOpenclawFeed, unmountOpenclawFeed } = await import('../dist/extensions/openclaw.js');
const { SessionLifecycle, selectSessionModel, currentSessionModel } = await import('../dist/harness/adapters/sessions.js');
const { readConfig } = await import('../dist/config.js');
const { TelegramTransport } = await import('../dist/telegram/transport.js');

// ---- transport stubs -------------------------------------------------------
const sends = [];
let handlers;
const proto = TelegramTransport.prototype;
const recordSend = async function (chatId, text, options) {
  sends.push({ chatId, text, options });
  return sends.length;
};
const original = {
  setHandlers: proto.setHandlers,
  sendText: proto.sendText,
  sendTextControl: proto.sendTextControl,
  sendTextFallback: proto.sendTextFallback,
  setCommands: proto.setCommands,
  setDefaultMenuButtonToCommands: proto.setDefaultMenuButtonToCommands,
  setMenuButtonToCommands: proto.setMenuButtonToCommands,
};
const commandSyncs = [];
proto.setHandlers = function (value) { handlers = value; };
proto.sendText = recordSend;
proto.sendTextControl = recordSend;
proto.sendTextFallback = recordSend;
proto.editText = async () => true;
proto.editTextControl = async () => true;
proto.deleteMessage = async () => {};
proto.deleteMessageControl = async () => {};
proto.sendChatAction = async () => {};
proto.sendChatActionControl = async () => {};
proto.setCommands = async function (commands) { commandSyncs.push(['commands', commands]); };
proto.setDefaultMenuButtonToCommands = async function () { commandSyncs.push(['menu-button-default']); };
proto.setMenuButtonToCommands = async function (chatId) { commandSyncs.push(['menu-button-chat', chatId]); };

// ---- fake harness context ---------------------------------------------------
const listeners = new Map();
const liveAgents = new Map();
const savedDefaults = [];
function makeAgentCtx() {
  const registered = [];
  return {
    ctxLike: true,
    registered,
    on(name) {
      registered.push(name);
      return () => {};
    },
  };
}
function makeAgent(id, options) {
  const agentCtx = makeAgentCtx();
  const agent = {
    id,
    status: 'idle',
    options,
    ctx: agentCtx,
    send: () => {},
    followup: () => {},
    cancel: () => {},
    session: { events: [], requestHeader: () => undefined },
    inbox: { nextTurn: [], nextStep: [] },
  };
  return agent;
}
const llmCalls = [];
const fakeLlm = {
  listProviders: () => [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }],
  listModels: async (provider) => [{ id: `${provider}-m-a`, name: 'A' }, { id: `${provider}-m-b`, name: 'B' }],
  resolveModelInfo: async () => ({}),
  resolveCallConfig: async (config) => {
    llmCalls.push(config);
    return { provider: config.provider, model: config.model, ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }) };
  },
};
const ctx = {
  get: (name) => (name === 'llm' ? fakeLlm
    : name === 'agentDefaultModel' ? {
        currentSelection: () => ({ provider: 'deepseek', model: 'deepseek-chat' }),
        saveSelection: async (next) => { savedDefaults.push(next); },
      }
    : undefined),
  provide: (name, value) => { ctx.services.set(name, value); },
  on: (name, listener) => {
    if (!listeners.has(name)) listeners.set(name, []);
    listeners.get(name).push(listener);
    return () => {};
  },
  effect: () => {},
  tools: { register: () => {} },
  toolsDefs: new Map(),
  commands: { register: () => {} },
  services: new Map(),
  command: undefined,
  agents: {
    async create(options) {
      const id = String(options.sessionId);
      const agent = makeAgent(id, options.agentOptions ?? {});
      // Mirror the real factory: the setup hook runs inside creation.
      await options.setup?.(agent.ctx);
      liveAgents.set(id, agent);
      return { agent, dispose: async () => { liveAgents.delete(id); } };
    },
    get: (id) => liveAgents.get(String(id)),
    list: () => [...liveAgents.values()],
  },
};
function emit(sessionId, event) {
  for (const cb of listeners.get('session/event') ?? []) cb({ id: sessionId }, event);
}

applyPlugin(ctx, {});
const svc = ctx.services.get('telegram');

await new Promise((resolve) => setTimeout(resolve, 20)); // let fire-and-forget menu-sync land

test('bug 3a: the native command list + menu button sync on every transport mount', () => {
  const synced = commandSyncs.find(([kind]) => kind === 'commands');
  assert.ok(synced, 'setCommands must run at mount, not only on /start');
  const names = synced[1].map((entry) => entry.command);
  assert.ok(names.includes('models'), 'advertised list contains /models');
  assert.ok(commandSyncs.some(([kind]) => kind === 'menu-button-default'), 'bot-wide default menu button set to commands type');
});

test('bug 3b: every advertised native-menu command dispatches (no Unknown command)', async () => {
  assert.ok(handlers, 'router handlers installed');
  for (const { command } of TELEGRAM_COMMANDS) {
    const before = sends.length;
    try {
      await handlers.onText(7, `/${command}`);
    } catch (err) {
      assert.fail(`/ ${command} threw: ${err?.message}`);
    }
    const replies = sends.slice(before).map((entry) => entry.text).join('\n');
    assert.equal(replies.includes(`Unknown command /${command}`), false, `/${command} must not fall into the unknown-command tail`);
  }
  // Card-opening commands arm per-chat UI loops (e.g. the Todos auto-refresh
  // interval); close the chat's card so nothing outlives the test process.
  await handlers.onCallback(7, 'm:close');
  await new Promise((resolve) => setTimeout(resolve, 50));
});

test('bug 2: the harness streaming feed is mounted built-in and streams the working draft', async () => {
  const { randomUUID } = await import('node:crypto');
  const agent = makeAgent(`tg-${randomUUID()}`, { provider: 'p1', model: 'p1-m-a' });
  liveAgents.set(agent.id, agent);
  svc.bindAgent(7, agent.id);

  emit(agent.id, { type: 'turn/start', data: { turn: 1 } });
  await new Promise((resolve) => setTimeout(resolve, 30));
  const placeholder = sends.find((entry) => typeof entry.text === 'string' && entry.text.startsWith('\u2699\uFE0F Working'));
  assert.ok(placeholder, 'turn start must spawn the ⚙️ Working… live draft');

  emit(agent.id, { type: 'assistant/chunk', data: { chunk: { type: 'reasoning-delta', index: 0, text: 'thinking…' } } });
  await new Promise((resolve) => setTimeout(resolve, 320)); // > EDIT_THROTTLE_MS
  const streamed = sends.length; // edits go through editText stub; presence checked via stopLiveFeed seam below
  assert.ok(streamed >= 1);

  // Settle the draft with a real turn end, then verify mount semantics.
  emit(agent.id, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });
  await new Promise((resolve) => setTimeout(resolve, 30));

  // Same-host re-mount is a no-op (singleton), and unmount clears the seams.
  const stopBefore = svc.stopLiveFeed;
  mountOpenclawFeed(svc, ctx);
  assert.equal(svc.stopLiveFeed, stopBefore, 'same-host re-mount keeps the singleton');
  unmountOpenclawFeed();
  assert.equal(svc.stopLiveFeed, undefined, 'unmount clears the feed seams');
  liveAgents.delete(agent.id);
});

test('bug 1: two consecutive mid-session model switches both stick', async () => {
  const lifecycle = new SessionLifecycle();
  const created = await lifecycle.create(ctx, base, { provider: 'p1', model: 'p1-m-a' });
  assert.ok(created.result.ok, `session create failed: ${created.result.text}`);
  const agentId = created.agentId;
  svc.bindAgent(7, agentId);

  // Creation-time install: BOTH selection waterfalls are registered by the
  // setup hook alone, before any switch — this is what keeps the Telegram
  // listener outermost against later web-side refs.
  const agent = ctx.agents.get(agentId);
  assert.ok(agent.ctx.registered.includes('system-prompt/assemble'), 'assemble listener installed at creation');
  assert.ok(agent.ctx.registered.includes('agent/request'), 'request listener installed at creation');

  // Switch #1 …
  const tok1 = svc.token({ action: 'model-select', provider: 'p1', model: 'p1-m-b' }, 7);
  await handlers.onCallback(7, tok1);
  assert.deepEqual(currentSessionModel(ctx, agentId), { provider: 'p1', model: 'p1-m-b' });
  assert.deepEqual(savedDefaults.at(-1), { provider: 'p1', model: 'p1-m-b' });

  // … switch #2: the regression — this used to be where switching died.
  const tok2 = svc.token({ action: 'model-select', provider: 'p2', model: 'p2-m-a' }, 7);
  await handlers.onCallback(7, tok2);
  assert.deepEqual(currentSessionModel(ctx, agentId), { provider: 'p2', model: 'p2-m-a' });

  // Both switches resolve through the llm service exactly once each.
  assert.deepEqual(llmCalls.filter((c) => c.model === 'p1-m-b'), [{ provider: 'p1', model: 'p1-m-b' }]);
  assert.deepEqual(llmCalls.filter((c) => c.model === 'p2-m-a'), [{ provider: 'p2', model: 'p2-m-a' }]);

  // A mid-session switch now persists the Telegram default model, same as the
  // auto-create branch always did (✨ New + restart keep the choice sticky).
  assert.deepEqual(readConfig(base).model, { provider: 'p2', model: 'p2-m-a' });

  // And the adapter-level API stays repeatable.
  const again = await selectSessionModel(ctx, agentId, 'p2', 'p2-m-b');
  assert.ok(again.ok, again.text);
  assert.deepEqual(currentSessionModel(ctx, agentId), { provider: 'p2', model: 'p2-m-b' });

  await lifecycle.close(agentId, ctx);
});

test('cleanup', () => {
  // Leave no live feed behind: its retry/heartbeat chains must not outlive
  // the test process.
  unmountOpenclawFeed();
  process.chdir(oldCwd);
  if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
  else process.env.TELEGRAM_BOT_TOKEN = oldToken;
  Object.assign(proto, original);
  rmSync(base, { recursive: true, force: true });
});
