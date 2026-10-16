import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { normalizeConfig, overlayConfig, getConfigPath } from '../dist/config.js';
import { isDirectory, parentOf } from '../dist/harness/adapters/host.js';
import { buildProjectKeyboard } from '../dist/telegram/keyboard.js';

test('workspace.activePath normalizes, overlays, and reads by dot path', () => {
  const config = normalizeConfig({ workspace: { activePath: '/srv/proj' } });
  assert.equal(config.workspace.activePath, '/srv/proj');
  const { config: merged, changed } = overlayConfig(normalizeConfig(undefined), { workspace: { activePath: '/tmp/x' } });
  assert.deepEqual(changed, ['workspace']);
  assert.equal(merged.workspace.activePath, '/tmp/x');
  assert.equal(getConfigPath(merged, 'workspace.activePath'), '/tmp/x');
});

test('normalizeConfig rejects a non-string activePath', () => {
  assert.throws(() => normalizeConfig({ workspace: { activePath: 7 } }), /workspace\.activePath/);
});

test('isDirectory accepts real directories and rejects files and ghosts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-telegram-proj-'));
  try {
    const file = join(dir, 'note.txt');
    writeFileSync(file, 'x');
    assert.equal(await isDirectory(dir), true);
    assert.equal(await isDirectory(file), false);
    assert.equal(await isDirectory(join(dir, 'missing')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('parentOf walks one level up and stops at root', () => {
  assert.equal(parentOf('/a/b/c'), '/a/b');
  assert.equal(parentOf('/'), '/');
});

test('buildProjectKeyboard renders nav, quick, dirs, and use/close rows', () => {
  const kb = buildProjectKeyboard(
    [
      { label: 'alpha', cb: 'o:a' },
      { label: 'beta', cb: 'o:b' },
      { label: 'gamma', cb: 'o:g' },
    ],
    {
      up: 'u:1',
      home: 'h:1',
      root: 'r:1',
      use: 'use:1',
      close: 'm:close',
      quick: [{ label: '🗂 ws', cb: 'q:1' }],
    },
  );
  const rows = kb.inline_keyboard;
  assert.deepEqual(rows[0].map((b) => b.callback_data), ['u:1', 'h:1', 'r:1']);
  assert.deepEqual(rows[1].map((b) => b.callback_data), ['q:1']);
  assert.deepEqual(rows[2].map((b) => b.callback_data), ['o:a', 'o:b']);
  assert.deepEqual(rows[3].map((b) => b.callback_data), ['o:g']);
  const last = rows[rows.length - 1].map((b) => b.callback_data);
  assert.deepEqual(last, ['use:1', 'm:close']);
});

test('buildProjectKeyboard omits the Use row when absent', () => {
  const kb = buildProjectKeyboard([], { close: 'm:close' });
  const rows = kb.inline_keyboard;
  assert.deepEqual(rows[rows.length - 1].map((b) => b.callback_data), ['m:close']);
  assert.equal(rows.some((row) => row.some((b) => b.callback_data.startsWith('use:'))), false);
});
