/**
 * IX-1 (audit P2) regression net — four defects, one file:
 *
 * D1  /config get (chat side, RE-3) and the `/telegram config get` host twin
 *     mask secret-shaped values; masking is display-only and /config set
 *     still persists the real value. Section-level gets mask secret-shaped
 *     KEYS inside the returned slice too.
 * D2  a bad config crashing a (re-)apply must leave exactly zero live
 *     pollers: the old transport's stop starts BEFORE any fallible work, and
 *     a mid-construction mount failure disposes the half-mounted transport
 *     before polling could ever start.
 * D3  notifyTodoChange escapes agent-authored todo content for its
 *     parse_mode:"HTML" message instead of interpolating raw markup.
 * D4  the card-driven mkdir flow (host-mkdir-prompt pending input) passes
 *     security.browseRoots through to createDirectory like its /mkdir command
 *     twin; unset roots keep the legacy unconstrained behavior.
 *
 * Full-plugin boots over mocked TelegramTransport prototype methods (never
 * the real Telegram API), same shape as security.test.mjs's harness.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { apply as applyPlugin } from '../dist/index.js';
import { TelegramTransport } from '../dist/telegram/transport.js';

/** Minimal cordis ctx stub. `onMode`: ignore (default) | record (keep
 * listeners for synthetic event firing) | throw (fault injection). */
function makeCtx({ onMode = 'ignore' } = {}) {
  const listeners = new Map();
  const ctx = {
    get: () => undefined,
    provide: (name, value) => { ctx.services.set(name, value); },
    on: (name, listener) => {
      if (onMode === 'throw' && name === 'commands/change') throw new Error(`boom: ${name}`);
      if (onMode === 'record') {
        if (!listeners.has(name)) listeners.set(name, []);
        listeners.get(name).push(listener);
      }
      return () => {};
    },
    effect: () => {},
    tools: { register: (definition) => { ctx.toolsDefs.set(definition.name, definition); } },
    toolsDefs: new Map(),
    commands: { register: (definition) => { ctx.command = definition; } },
    services: new Map(),
    command: undefined,
    listeners,
  };
  return ctx;
}

const MOCKED_METHODS = [
  'setHandlers',
  'sendText', 'sendTextControl', 'sendTextFallback',
  'editText', 'editTextControl',
  'deleteMessage', 'deleteMessageControl',
  'sendChatAction', 'sendChatActionControl',
  'setCommands', 'setDefaultMenuButtonToCommands', 'setMenuButtonToCommands',
  'start', 'stop', 'pending', 'lastOutgoingMessageId',
];

const flush = async () => {
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
};

async function bootHarness({ config, onMode }) {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ix1-'));
  const oldCwd = process.cwd();
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  mkdirSync(join(base, '.pi'));
  writeFileSync(join(base, '.pi', 'telegram.json'), JSON.stringify(config));
  process.chdir(base);
  process.env.TELEGRAM_BOT_TOKEN = '123456:ix1-test';

  const saved = new Map();
  const counters = { starts: 0, stops: 0 };
  const sent = [];
  let handlers;
  for (const name of MOCKED_METHODS) saved.set(name, TelegramTransport.prototype[name]);
  const mock = (name, fn) => { TelegramTransport.prototype[name] = fn; };
  mock('setHandlers', function (value) {
    handlers = value;
    return saved.get('setHandlers').call(this, value);
  });
  const recordSend = async (chatId, text, options) => {
    sent.push({ chatId, text, options });
    return sent.length;
  };
  for (const name of ['sendText', 'sendTextControl', 'sendTextFallback']) mock(name, recordSend);
  for (const name of ['editText', 'editTextControl']) {
    mock(name, async (chatId, messageId, text, options) => {
      sent.push({ chatId, messageId, text, options });
      return true;
    });
  }
  for (const name of ['deleteMessage', 'deleteMessageControl', 'sendChatAction', 'sendChatActionControl', 'setCommands', 'setDefaultMenuButtonToCommands', 'setMenuButtonToCommands']) mock(name, async () => {});
  // start/stop are counted, never polled for real.
  mock('start', async function () { counters.starts += 1; });
  mock('stop', async function () { counters.stops += 1; });
  mock('pending', () => 0);
  mock('lastOutgoingMessageId', async () => undefined);

  const ctx = makeCtx({ onMode });
  await applyPlugin(ctx, {});
  return {
    base, ctx, sent, handlers, counters,
    telegram: ctx.services.get('telegram'),
    /** Deterministic between-test quiesce: crash a re-apply ON PURPOSE. The
     * IX-1/D2 guarantee under test is that the crash path STILL stops the
     * live poller (previousStop begins before the fallible config read) and
     * tears the mount down, leaving state.transport undefined — so the NEXT
     * boot deterministically takes the first-mount branch. (Deleting the
     * token env is NOT enough: mountToken falls back to the checkout-local
     * .telegram-token, which would silently mount a real transport.) */
    async stopWorld() {
      writeFileSync(join(base, '.pi', 'telegram.json'), '{oops not json');
      assert.throws(() => applyPlugin(makeCtx(), {}), /invalid JSON/);
    },
    cleanup() {
      process.chdir(oldCwd);
      if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN;
      else process.env.TELEGRAM_BOT_TOKEN = oldToken;
      for (const [name, fn] of saved) TelegramTransport.prototype[name] = fn;
      rmSync(base, { recursive: true, force: true });
    },
  };
}

// ── D1: secret masking on every /config get surface ─────────────────────────

test('IX-1 D1: maskConfigValue masks secret-shaped leaf paths, section slices, and credential-shaped keys', async () => {
  const { maskConfigValue } = await import('../dist/core/commands.js');

  // Leaf rule (RE-3, unchanged): last four characters only.
  assert.equal(maskConfigValue('media.transcribe.apiKey', '1234abcd'), '***abcd');
  assert.equal(maskConfigValue('smtp.password', 'p@55w0rd'), '***w0rd');
  assert.equal(maskConfigValue('a.b.secret', 'kittens'), '***tens');
  assert.equal(maskConfigValue('x.token', 'tok-1234567890'), '***7890');
  assert.equal(maskConfigValue('db.credential', 'cred-9999'), '***9999', 'credential-shaped keys are covered too');

  // Non-secret primitives render exactly as before.
  assert.equal(maskConfigValue('media.transcribe.model', 'whisper'), '"whisper"');
  assert.equal(maskConfigValue('outbound.maxRetries', 3), '3');

  // Section-level get: the secret-shaped KEY inside the object is masked, so
  // `/config get media.transcribe` is not a side channel around the leaf rule.
  const section = JSON.parse(maskConfigValue('media.transcribe', {
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'super-secret-ab12',
    model: 'whisper-1',
  }));
  assert.equal(section.baseUrl, 'https://api.example.com/v1', 'non-secret siblings stay raw');
  assert.equal(section.model, 'whisper-1');
  assert.equal(section.apiKey, '***ab12');

  // Nested arrays/objects are walked recursively.
  const nested = JSON.parse(maskConfigValue('future', [{ apiKey: 'zzzz-last4' }, { plain: 'visible' }]));
  assert.equal(nested[0].apiKey, '***ast4');
  assert.equal(nested[1].plain, 'visible');
});

test('IX-1 D1: /telegram config get masks secrets while /config set keeps persisting the real value', async () => {
  const harness = await bootHarness({ config: { security: { allowedChatIds: [7] } } });
  try {
    assert.ok(harness.telegram);

    // Set through the documented path, then read through the HOST twin.
    await harness.ctx.command.handler({ rawInput: 'config set media.transcribe.apiKey "super-secret-ab12"' });
    const got = await harness.ctx.command.handler({ rawInput: 'config get media.transcribe.apiKey' });
    assert.equal(got.kind, 'success');
    assert.match(String(got.text), /\*\*\*ab12$/, 'the twin must apply the exact same mask as the chat side');
    assert.equal(String(got.text).includes('super-secret'), false, 'no plaintext fragment may leak');

    // Non-secret paths print their raw JSON value, byte-for-byte as before.
    const retries = await harness.ctx.command.handler({ rawInput: 'config get outbound.maxRetries' });
    assert.equal(retries.text, String(harness.telegram.getConfig().outbound.maxRetries));

    // A section-level get masks the nested key but keeps the rest readable.
    const section = await harness.ctx.command.handler({ rawInput: 'config get media.transcribe' });
    const view = JSON.parse(String(section.text));
    assert.equal(view.apiKey, '***ab12');
    assert.equal(view.model, 'whisper-1'); // schema default survives the roundtrip
    assert.equal(String(section.text).includes('super-secret'), false);

    // Masking is display-only: the stored + persisted value stays real.
    assert.equal(harness.telegram.getConfig().media.transcribe.apiKey, 'super-secret-ab12');
    const persisted = JSON.parse(await import('node:fs').then((fs) => fs.readFileSync(join(process.cwd(), '.pi', 'telegram.json'), 'utf8')));
    assert.equal(persisted.media.transcribe.apiKey, 'super-secret-ab12');
  } finally {
    await harness.stopWorld();
    harness.cleanup();
  }
});

// ── D2: failed mounts never leave a stray poller ────────────────────────────

test('IX-1 D2: a bad config on re-apply crashes cleanly, still stops the previous poller, and a good config remounts exactly one', async () => {
  const harness = await bootHarness({
    config: { security: { allowedChatIds: [7] }, watch: { autoStart: true } },
  });
  try {
    assert.equal(harness.counters.starts, 1, 'autoStart booted exactly one poller');
    assert.equal(harness.counters.stops, 0);

    // Hand-edited corrupt config: re-apply must throw AND the old poller must
    // still be stopped (the stop now begins before the fallible config read).
    writeFileSync(join(harness.base, '.pi', 'telegram.json'), '{oops not json');
    const beforeCrash = { ...harness.counters };
    assert.throws(() => applyPlugin(makeCtx(), {}), /invalid JSON/, 'a bad config must crash the mount loudly');
    assert.equal(harness.counters.stops, beforeCrash.stops + 1, 'the previous poller was stopped despite the crash');
    assert.equal(harness.counters.starts, beforeCrash.starts, 'no replacement poller started');

    // Positive control: with a good config the plugin remounts and exactly
    // one poller is alive (one outstanding start over all generations).
    writeFileSync(join(harness.base, '.pi', 'telegram.json'), JSON.stringify({ security: { allowedChatIds: [7] }, watch: { autoStart: true } }));
    await applyPlugin(makeCtx(), {});
    assert.equal(harness.counters.starts, 2, 'the good remount started its replacement');
    assert.equal(harness.counters.starts - harness.counters.stops, 1, 'exactly one live poller exists after the dust settles');
  } finally {
    await harness.stopWorld();
    harness.cleanup();
  }
});

test('IX-1 D2: a mid-construction mount failure disposes the half-mounted transport and never starts polling', async () => {
  // Boot healthy; the fault is injected only into the SECOND apply's ctx.
  const harness = await bootHarness({
    config: { security: { allowedChatIds: [7] }, watch: { autoStart: true } },
  });
  try {
    const before = { ...harness.counters };
    assert.equal(before.starts, 1, 'healthy boot started exactly one poller');
    // ctx.on("commands/change") throws inside attachSessionEvents — well after
    // the transport and bridge were constructed, before any polling could.
    await assert.rejects(() => applyPlugin(makeCtx({ onMode: 'throw' }), {}), /boom: commands\/change/,
      'the construction failure must surface to the loader');
    assert.equal(harness.counters.starts, before.starts, 'polling NEVER started for the failed mount (validation runs first)');
    assert.ok(harness.counters.stops >= before.stops + 2,
      'both the previous live poller AND the half-mounted replacement were stopped');
  } finally {
    await harness.stopWorld();
    harness.cleanup();
  }
});

// ── D3: todo notifications escape HTML metachars ────────────────────────────

test('IX-1 D3: todo notifications escape HTML metachars and keep parse_mode HTML', async () => {
  const harness = await bootHarness({
    config: { security: { allowedChatIds: [7] } },
    onMode: 'record',
  });
  try {
    harness.telegram.bindAgent(7, 'agent-x');
    const listeners = harness.ctx.listeners.get('session/event') ?? [];
    assert.ok(listeners.length > 0, 'the session/event feed must be wired');
    const emit = (event) => {
      for (const listener of listeners) {
        try { listener({ id: 'agent-x' }, event); } catch { /* non-todo consumers may ignore synthetic events */ }
      }
    };

    // First observation only primes the baseline — no notification burst.
    emit({ type: 'todo/write', data: { todos: [{ content: '<b>task</b> & done', status: 'pending' }] } });
    await flush();
    const baselineLeaks = harness.sent.filter((entry) => String(entry.text).includes('<b>task</b>'));
    assert.deepEqual(baselineLeaks, [], 'the baseline write sends nothing');

    // Status flip (started) plus an added item whose content is pure markup.
    emit({
      type: 'todo/write',
      data: {
        todos: [
          { content: '<b>task</b> & done', status: 'in_progress' },
          { content: '<img src=x onerror=alert(1)>', status: 'pending' },
        ],
      },
    });
    await flush();

    const notes = harness.sent.filter((entry) => entry.options?.parse_mode === 'HTML' && String(entry.text).includes('\u23F3'));
    assert.ok(notes.length > 0, 'the incremental todo note was sent as HTML');
    const text = String(notes[notes.length - 1].text);
    assert.ok(text.includes('&lt;b&gt;task&lt;/b&gt; &amp; done'), `metachars must arrive escaped, got: ${text}`);
    assert.ok(text.includes('&lt;img src=x onerror=alert(1)&gt;'), `added-item markup must be escaped too, got: ${text}`);
    assert.equal(text.includes('<b>task</b>') || text.includes('<img'), false, 'no raw tag may reach the wire');
    assert.ok(text.includes('\u{1F4CB} New task'), 'both diff lanes rendered');
  } finally {
    await harness.stopWorld();
    harness.cleanup();
  }
});

// ── D4: card-driven mkdir enforces browseRoots like its /mkdir twin ─────────

function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-ix1-d4-'));
  const inside = join(base, 'inside');
  const outside = join(base, 'outside');
  mkdirSync(inside);
  mkdirSync(outside);
  return { base, inside, outside };
}

async function armMkdirPrompt(harness, chatId, path) {
  const data = harness.telegram.token({ action: 'host-mkdir-prompt', path }, chatId);
  await harness.handlers.onCallback(chatId, data);
}

test('IX-1 D4: pending-input mkdir refuses outside-root targets, allows inside-root ones (roots configured)', async () => {
  const tree = makeTree();
  const harness = await bootHarness({
    config: { security: { allowedChatIds: [7], browseRoots: [tree.inside] } },
  });
  try {
    // Outside the roots: refused, and NOTHING is created on disk.
    await armMkdirPrompt(harness, 7, tree.outside);
    await harness.handlers.onText(7, 'evil-dir');
    await flush();
    assert.equal(existsSync(join(tree.outside, 'evil-dir')), false, 'the refused mkdir must not touch the filesystem');
    const refusal = harness.sent.find((entry) => String(entry.text).includes('evil-dir') && String(entry.text).includes('browseRoots'));
    assert.ok(refusal, `fail-closed message expected, sent: ${JSON.stringify(harness.sent.map((s) => s.text))}`);

    // Inside the roots: works like the /mkdir command twin.
    await armMkdirPrompt(harness, 7, tree.inside);
    await harness.handlers.onText(7, 'good-dir');
    await flush();
    assert.equal(existsSync(join(tree.inside, 'good-dir')), true, 'an in-root folder is created');
    assert.ok(
      harness.sent.some((entry) => String(entry.text).includes('good-dir') && !String(entry.text).includes('\u274C')),
      'the success reply lands',
    );
  } finally {
    await harness.stopWorld();
    harness.cleanup();
    rmSync(tree.base, { recursive: true, force: true });
  }
});

test('IX-1 D4: unset browseRoots keep the legacy unconstrained card-driven mkdir', async () => {
  const tree = makeTree(); // roots intentionally NOT configured
  const harness = await bootHarness({
    config: { security: { allowedChatIds: [7] } },
  });
  try {
    await armMkdirPrompt(harness, 7, tree.outside);
    await harness.handlers.onText(7, 'legacy-dir');
    await flush();
    assert.equal(existsSync(join(tree.outside, 'legacy-dir')), true, 'opt-in stays opt-in: unset roots behave exactly as before');
  } finally {
    await harness.stopWorld();
    harness.cleanup();
    rmSync(tree.base, { recursive: true, force: true });
  }
});
