import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureOpencodeGoResponsesRoute, OPENCODE_GO_RESPONSES_ROUTE } from '../dist/harness/adapters/opencodeGo.js';

test('a hung settings.update cannot pin the provisioning latch forever (#20)', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const providers = ['opencode-go'];
  const settings = {
    describe: () => [{
      ns: 'llm-pi-ai',
      revision: 1,
      value: { providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' } } },
    }],
    update: () => new Promise(() => {}),
  };
  const ctx = {
    get: (name) => {
      if (name === 'llm') return { listProviders: () => providers.map((id) => ({ id })) };
      if (name === 'settings') return settings;
      return undefined;
    },
  };
  const logs = [];
  const stuck = ensureOpencodeGoResponsesRoute(ctx, (message) => logs.push(message));
  t.mock.timers.tick(15_000);
  assert.equal(await stuck, false, 'deadline resolves the caller instead of hanging');
  assert.match(logs.at(-1), /deadline exceeded/);

  // The latch was cleared even though the stuck provision is still pending.
  // Point the SAME ctx at an already-provisioned world and a fresh call must
  // make real progress instead of returning the old stuck `false`.
  providers.push(OPENCODE_GO_RESPONSES_ROUTE);
  settings.describe = () => [{
    ns: 'llm-pi-ai',
    revision: 2,
    value: { providers: {
      'opencode-go': { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
      [OPENCODE_GO_RESPONSES_ROUTE]: { apiKeyEnv: 'OPENCODE_GO_API_KEY' },
    } },
  }];
  assert.equal(await ensureOpencodeGoResponsesRoute(ctx, () => {}), true);
});
