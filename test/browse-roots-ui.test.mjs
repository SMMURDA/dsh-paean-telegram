/**
 * SC-1 regression suite: security.browseRoots confinement across the
 * first-party UI flows that used to bypass it.
 *
 * Contract under test:
 *  - applyProjectPath enforces browseRoots BEFORE any state/persistence/
 *    registry mutation; refusal replies ❌ and changes nothing. Unset roots
 *    keep the legacy behavior byte-for-byte (opt-in posture, B-7r).
 *  - A whitelist-refused listing renders no "✅ Use this folder" /
 *    "✅ Create here" escape and no nav jumps to refused targets; ordinary
 *    listing errors (e.g. EACCES) keep the legacy escapes.
 *  - The card-driven ws-create-here passes browseRoots exactly like its
 *    /workspacecreate command twin.
 *
 * The cards run through their real factories over fake deps (dtl-injection
 * style); ws-create-here runs through createDispatchers over a minimal deps
 * slice covering exactly that case's reads.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { createWorkspaceCards } from '../dist/cards/workspaces.js';
import { createDispatchers } from '../dist/core/dispatch.js';

function fakeCtx(seams = {}) {
  return {
    agents: { list: () => [], get: () => undefined },
    get: (name) => seams[name],
  };
}

function makeRegistry(calls) {
  return {
    archivedSessionIds: [],
    list: () => [],
    get: () => undefined,
    async create(path, title) {
      calls.push({ path, title });
      return { id: 'w1', path, title: title ?? path, sessionIds: [] };
    },
  };
}

/** State slice shaped like the plugin-root singleton's relevant fields. */
function makeState(configRoot, { root, roots }) {
  return {
    workspaceRoot: root,
    configRoot,
    config: { workspace: {}, security: { browseRoots: roots }, outbound: {} },
  };
}

function workspaceCards(state, seams, sends) {
  const captured = {};
  const openCard = async (_chatId, text, keyboard) => {
    captured.text = text;
    captured.keyboard = keyboard;
  };
  const cards = createWorkspaceCards({
    state,
    requireCtx: () => fakeCtx(seams),
    uiSend: async (_chatId, text) => {
      sends.push(text);
    },
    openCard,
    token: (p) => JSON.stringify(p),
    log: () => {},
    openMenuAt: async () => {},
  });
  return { cards, captured };
}

function callbackData(kb) {
  return kb.inline_keyboard.flat().map((button) => button.callback_data);
}

function payloads(kb) {
  // Fixed menu/close entries ("m:back") are not token JSON — skip them.
  return callbackData(kb)
    .map((cb) => {
      try {
        return JSON.parse(cb);
      } catch {
        return undefined;
      }
    })
    .filter((p) => p !== undefined);
}

/** temp tree: base/inside (whitelisted) + base/outside (refused when rooted). */
function makeTree() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-telegram-sc1-'));
  const inside = join(base, 'inside');
  const outside = join(base, 'outside');
  mkdirSync(inside);
  mkdirSync(outside);
  return { base, inside, outside };
}

// ── applyProjectPath: enforce before any commit ─────────────────────────────

test('SC-1: project-select on an outside path is refused and changes nothing', async () => {
  const { base, inside, outside } = makeTree();
  try {
    const state = makeState(base, { root: inside, roots: [inside] });
    const calls = [];
    const sends = [];
    const { cards, captured } = workspaceCards(state, { workspaceRegistry: makeRegistry(calls) }, sends);

    await cards.applyProjectPath(1, outside);

    assert.match(sends[0], /\u274C/);
    assert.match(sends[0], /browseRoots/);
    // Nothing committed: root, persisted config and registry all untouched.
    assert.equal(state.workspaceRoot, inside);
    assert.equal(state.config.workspace.activePath, undefined);
    assert.deepEqual(calls, [], 'the registry must never see a refused project');
    assert.equal(existsSync(join(base, '.pi')), false, 'config must not be persisted for a refusal');
    // The follow-up card at the refused folder offers no Use-this-folder escape.
    assert.ok(captured.text.includes('browseRoots'), captured.text);
    assert.equal(payloads(captured.keyboard).some((p) => p.action === 'project-select'), false);
    // ...and no nav jumps into refused territory either (everything here is).
    assert.deepEqual(
      payloads(captured.keyboard).filter((p) => p.action === 'project-open' && (p.path === homedir() || p.path === '/')),
      [],
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('SC-1: project-select inside the roots still switches, persists, registers', async () => {
  const { base, inside, outside } = makeTree();
  try {
    const sub = join(inside, 'sub');
    mkdirSync(sub);
    const state = makeState(base, { root: outside, roots: [inside] });
    const calls = [];
    const sends = [];
    const { cards } = workspaceCards(state, { workspaceRegistry: makeRegistry(calls) }, sends);

    await cards.applyProjectPath(1, sub);

    assert.match(sends[0], /Project set/);
    assert.equal(state.workspaceRoot, sub);
    assert.equal(state.config.workspace.activePath, sub);
    assert.deepEqual(calls, [{ path: sub, title: 'sub' }]);
    assert.equal(existsSync(join(base, '.pi', 'telegram.json')), true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('SC-1: unset browseRoots keep the legacy project-select behavior byte-for-byte', async () => {
  const { base, inside, outside } = makeTree();
  try {
    for (const roots of [undefined, []]) {
      const state = makeState(base, { root: inside, roots });
      const calls = [];
      const sends = [];
      const { cards, captured } = workspaceCards(state, { workspaceRegistry: makeRegistry(calls) }, sends);

      await cards.applyProjectPath(1, outside);
      assert.match(sends[0], /Project set/, `roots=${JSON.stringify(roots)} must keep legacy success`);
      assert.equal(state.workspaceRoot, outside);
      assert.deepEqual(calls, [{ path: outside, title: 'outside' }]);
      // A normal (listable) browse keeps its full legacy keyboard: Use + ~/​/ nav.
      await cards.openProjectCard(1, inside);
      const actions = payloads(captured.keyboard);
      assert.ok(actions.some((p) => p.action === 'project-select'), `roots=${JSON.stringify(roots)} must keep the Use escape`);
      assert.ok(actions.some((p) => p.action === 'project-open' && p.path === homedir()));
      assert.ok(actions.some((p) => p.action === 'project-open' && p.path === '/'));
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

// ── refused listings render no escapes ──────────────────────────────────────

test('SC-1: a roots-refused project listing renders no Use/Create escapes', async () => {
  const { base, inside, outside } = makeTree();
  try {
    const state = makeState(base, { root: inside, roots: [inside] });
    const sends = [];
    const { cards, captured } = workspaceCards(state, { workspaceRegistry: makeRegistry() }, sends);

    await cards.openProjectCard(1, outside);

    const actions = payloads(captured.keyboard);
    assert.equal(actions.some((p) => p.action === 'project-select'), false, 'no Use-this-folder on a whitelisted-out folder');
    assert.ok(captured.text.includes('outside security.browseRoots'), captured.text);
    assert.doesNotMatch(captured.text, /The folder itself is valid/);

    await cards.openWorkspaceCreatePicker(1, outside);
    assert.equal(payloads(captured.keyboard).some((p) => p.action === 'ws-create-here'), false, 'no Create-here on a whitelisted-out folder');
    assert.ok(captured.text.includes('outside security.browseRoots'), captured.text);

    // Positive control: an allowed target keeps both buttons.
    await cards.openProjectCard(1, inside);
    assert.ok(payloads(captured.keyboard).some((p) => p.action === 'project-select'));
    await cards.openWorkspaceCreatePicker(1, inside);
    assert.ok(payloads(captured.keyboard).some((p) => p.action === 'ws-create-here'));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('SC-1: ordinary listing failures keep the legacy Use escape (only the whitelist removes it)', { skip: process.getuid?.() === 0 ? 'permission tests are meaningless as root' : false }, async (t) => {
  const { base, inside } = makeTree();
  const secret = join(inside, 'secret');
  mkdirSync(secret, { mode: 0o000 });
  try {
    const state = makeState(base, { root: inside, roots: [inside] });
    const sends = [];
    const { cards, captured } = workspaceCards(state, { workspaceRegistry: makeRegistry() }, sends);

    await cards.openProjectCard(1, secret);
    if (!captured.text.includes('EACCES') && !captured.text.includes('permission denied')) {
      t.skip(`filesystem did not produce a permission failure: ${captured.text}`);
      return;
    }
    // Not a whitelist refusal: the folder itself stays usable as before.
    assert.ok(payloads(captured.keyboard).some((p) => p.action === 'project-select'));
    assert.match(captured.text, /The folder itself is valid/);
  } finally {
    chmodSync(secret, 0o700);
    rmSync(base, { recursive: true, force: true });
  }
});

// ── dispatch ws-create-here passes the roots argument ───────────────────────

function dispatchDeps({ state, registry, sends }) {
  return {
    state,
    version: 'test',
    sessionLifecycle: {},
    ephemeral: {},
    tokens: {},
    compactionWatcher: () => undefined,
    log: () => {},
    requireTransport: () => {
      throw new Error('no transport in test');
    },
    uiOps: () => {
      throw new Error('no ops in test');
    },
    uiSend: async (_chatId, text) => {
      sends.push(text);
    },
    requireCtx: () => fakeCtx({ workspaceRegistry: registry }),
    currentAgent: () => undefined,
    boundAgentId: () => undefined,
    extensionForCallback: () => undefined,
    openWorkspacesCard: async () => {},
  };
}

test('SC-1: ws-create-here enforces browseRoots like the /workspacecreate twin', async () => {
  const { base, inside, outside } = makeTree();
  try {
    const calls = [];
    const sends = [];
    const dispatch = createDispatchers(dispatchDeps({ state: makeState(base, { root: inside, roots: [inside] }), registry: makeRegistry(calls), sends }));

    await dispatch.dispatchToken(1, { action: 'ws-create-here', path: outside });

    assert.match(sends[0], /\u274C/);
    assert.match(sends[0], /browseRoots/);
    assert.deepEqual(calls, [], 'the registry is never invoked for an out-of-root create');

    // Positive control: inside the roots the same tap registers normally.
    await dispatch.dispatchToken(1, { action: 'ws-create-here', path: inside });
    assert.match(sends[1], /Workspace/);
    assert.deepEqual(calls, [{ path: inside, title: 'inside' }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('SC-1: ws-create-here with unset roots keeps the legacy unconstrained create', async () => {
  const { base, inside, outside } = makeTree();
  try {
    const calls = [];
    const sends = [];
    const dispatch = createDispatchers(dispatchDeps({ state: makeState(base, { root: inside, roots: undefined }), registry: makeRegistry(calls), sends }));

    await dispatch.dispatchToken(1, { action: 'ws-create-here', path: outside });

    assert.match(sends[0], /Workspace/);
    assert.deepEqual(calls, [{ path: outside, title: 'outside' }]);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
