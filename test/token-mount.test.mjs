import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountToken, packageTokenFile, readTokenFile, resolveToken } from '../dist/config.js';

// ---------------------------------------------------------------------------
// Token mounting (restart durability): env first, checkout-local file fallback
// ---------------------------------------------------------------------------

test('resolveToken keeps the env-only contract', () => {
  assert.equal(resolveToken({}), undefined);
  assert.equal(resolveToken({ TELEGRAM_BOT_TOKEN: '  ' }), undefined);
  assert.equal(resolveToken({ TELEGRAM_BOT_TOKEN: ' aa:bb ' }), 'aa:bb');
});

test('readTokenFile trims and treats empty/missing as no token', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-token-'));
  try {
    const file = join(dir, 'token');
    assert.equal(readTokenFile(file), undefined, 'absent file');
    writeFileSync(file, '\n');
    assert.equal(readTokenFile(file), undefined, 'blank file');
    writeFileSync(file, '  aa:cc\n');
    assert.equal(readTokenFile(file), 'aa:cc', 'trimmed value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('packageTokenFile anchors beside the package root, not inside dist/', () => {
  const file = packageTokenFile();
  assert.ok(file.endsWith('.telegram-token'));
  assert.ok(!file.includes('dist/.telegram-token'), 'dist/config.js resolves one level above itself');
});

test('mountToken prefers the env over the file fallback', () => {
  const dir = mkdtempSync(join(tmpdir(), 'tg-token-'));
  try {
    const file = join(dir, 'token');
    writeFileSync(file, 'file:token');
    // The fallback path is anchored to this package's real location; point
    // the env override at a temp copy to prove precedence without touching
    // any local checkout state.
    assert.equal(
      mountToken({ TELEGRAM_BOT_TOKEN_FILE: file }),
      'file:token',
      'TELEGRAM_BOT_TOKEN_FILE wins over the package-local default',
    );
    assert.equal(
      mountToken({ TELEGRAM_BOT_TOKEN: 'env:token', TELEGRAM_BOT_TOKEN_FILE: file }),
      'env:token',
      'plain TELEGRAM_BOT_TOKEN still ranks first',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
