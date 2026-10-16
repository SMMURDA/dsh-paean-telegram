import test from 'node:test';
import assert from 'node:assert/strict';
import { SendQueue } from '../dist/telegram/queue.js';
import { createQueueCards, renderQueuePreviewLine } from '../dist/cards/queue.js';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function captureQueueCard() {
  const seen = {};
  const openCard = async (_chatId, text, keyboard) => {
    seen.text = text;
    seen.keyboard = keyboard;
  };
  return { seen, openCard };
}

function queueCardFor(agent) {
  const { seen, openCard } = captureQueueCard();
  const cards = createQueueCards({
    state: { transport: undefined },
    requireCtx: () => ({
      agents: { list: () => [agent], get: () => agent },
      get: () => undefined,
    }),
    currentAgent: () => agent,
    boundAgentId: () => undefined,
    progressFor: () => undefined,
    openCard,
  });
  return { cards, seen };
}

test('global sliding window throttles bursts', async () => {
  let now = 0;
  const times = [];
  const queue = new SendQueue({
    maxPerWindow: 3,
    windowMs: 100,
    now: () => now,
    sleep: async (ms) => {
      now += ms;
    },
  });
  const jobs = Array.from({ length: 6 }, () =>
    queue.push('c', async () => {
      times.push(now);
      return 1;
    }),
  );
  await Promise.all(jobs);
  assert.deepEqual(times, [0, 0, 0, 100, 100, 100]);
  assert.equal(queue.pendingCount(), 0);
});

test('per-chat chains run in FIFO order while other chats proceed', async () => {
  const queue = new SendQueue({ maxPerWindow: 100 });
  const order = [];
  const a1 = queue.push('a', async () => {
    order.push('a1:start');
    await delay(30);
    order.push('a1:end');
    return 1;
  });
  const a2 = queue.push('a', async () => {
    order.push('a2');
    return 2;
  });
  const b1 = queue.push('b', async () => {
    order.push('b1');
    return 3;
  });
  await Promise.all([a1, a2, b1]);
  assert.deepEqual(order, ['a1:start', 'b1', 'a1:end', 'a2']);
});

test('429 honors retry_after and retries up to attempts', async () => {
  const sleeps = [];
  let calls = 0;
  const queue = new SendQueue({
    retry: { attempts: 2, baseDelayMs: 500 },
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  const result = await queue.push('c', async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('rate limited');
      err.error_code = 429;
      err.parameters = { retry_after: 2 };
      throw err;
    }
    return 'ok';
  });
  assert.equal(result, 'ok');
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2000, 2000]);
});

test('non-429 failures reject without retry', async () => {
  const queue = new SendQueue({ retry: { attempts: 3, baseDelayMs: 10 }, sleep: async () => {} });
  await assert.rejects(
    queue.push('c', async () => {
      throw new Error('boom');
    }),
    /boom/,
  );
});

test('permanent Telegram 4xx errors are attempted exactly once', async () => {
  let calls = 0;
  const queue = new SendQueue({ retry: { attempts: 3, baseDelayMs: 5 }, sleep: async () => {} });
  await assert.rejects(
    queue.push('c', async () => {
      calls += 1;
      const err = new Error('bad request');
      err.error_code = 400;
      throw err;
    }),
    /bad request/,
  );
  assert.equal(calls, 1, 'a 400 cannot be fixed by retrying');
});

test('Telegram 5xx and network failures are retried', async () => {
  const queue = new SendQueue({ retry: { attempts: 2, baseDelayMs: 5 }, sleep: async () => {} });
  let serverCalls = 0;
  const server = queue.push('c', async () => {
    serverCalls += 1;
    if (serverCalls < 3) {
      const err = new Error('server error');
      err.error_code = 500;
      throw err;
    }
    return 'recovered';
  });
  assert.equal(await server, 'recovered');
  assert.equal(serverCalls, 3);

  let networkCalls = 0;
  const network = queue.push('d', async () => {
    networkCalls += 1;
    if (networkCalls < 3) throw new TypeError('fetch failed');
    return 'online';
  });
  assert.equal(await network, 'online');
  assert.equal(networkCalls, 3);
});

test('pendingCount reflects queued plus in-flight work', async () => {
  const queue = new SendQueue({ maxPerWindow: 1, windowMs: 1000 });
  const first = queue.push('c', async () => {
    await delay(10);
    return 1;
  });
  const second = queue.push('c', async () => 2);
  assert.equal(queue.pendingCount(), 2);
  await Promise.all([first, second]);
  assert.equal(queue.pendingCount(), 0);
});

test('configure hot-updates the limiter while in-flight work keeps flowing', async () => {
  const queue = new SendQueue({ maxPerWindow: 1, windowMs: 5000 });
  queue.configure({ maxPerWindow: 10, windowMs: 1, retry: { attempts: 1, baseDelayMs: 5 } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => queue.push(i, async () => i)));
  assert.deepEqual(results, [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(queue.pendingCount(), 0);
});

test('non-positive limiter settings clamp instead of spinning forever', async () => {
  let slept = 0;
  const queue = new SendQueue({
    maxPerWindow: 0,
    windowMs: 0,
    retry: { attempts: -1, baseDelayMs: -10 },
    sleep: async (ms) => {
      slept += ms;
    },
  });
  assert.equal(await queue.push('c', async () => 'ok'), 'ok');
  assert.equal(queue.pendingCount(), 0);
  assert.equal(slept, 0, 'a clamped queue never enters the rate-limit wait loop');
  queue.configure({ maxPerWindow: 0, windowMs: 0 });
  assert.equal(await queue.push('c', async () => 'ok2'), 'ok2');
});

// ---------------------------------------------------------------------------
// R3-3: the default retry base delay is exported exactly once.
// ---------------------------------------------------------------------------

test('DEFAULT_RETRY_BASE_DELAY_MS is the shared 500ms default (R3-3)', async () => {
  const { DEFAULT_RETRY_BASE_DELAY_MS } = await import('../dist/telegram/queue.js');
  assert.equal(DEFAULT_RETRY_BASE_DELAY_MS, 500);
  const sleeps = [];
  const queue = new SendQueue({ retry: { attempts: 1 }, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(
    queue.push('c', async () => {
      const err = new Error('server error');
      err.error_code = 500;
      throw err;
    }),
  );
  assert.deepEqual(sleeps, [DEFAULT_RETRY_BASE_DELAY_MS], 'unconfigured base delay comes from the exported constant');
});

// ---------------------------------------------------------------------------
// R3-2: the shared serializePerKey helper.
// ---------------------------------------------------------------------------

test('serializePerKey orders same-key tasks and lets other keys proceed', async () => {
  const { serializePerKey } = await import('../dist/telegram/serialize-per-key.js');
  const map = new Map();
  const order = [];
  const slow = serializePerKey(map, 'a', async () => {
    order.push('a1:start');
    await delay(20);
    order.push('a1:end');
  });
  const fastOther = serializePerKey(map, 'b', async () => order.push('b1'));
  const queued = serializePerKey(map, 'a', async () => order.push('a2'));
  await Promise.all([slow, fastOther, queued]);
  assert.equal(order.indexOf('a2'), order.indexOf('a1:end') + 1, 'a2 waits for a1 to settle');
  assert.ok(order.includes('b1'));
  await new Promise((resolve) => setImmediate(resolve)); // let the sweep run
  assert.equal(map.size, 0, 'settled lanes are swept so the map stays bounded');
});

test('serializePerKey propagates the task outcome without poisoning the lane', async () => {
  const { serializePerKey } = await import('../dist/telegram/serialize-per-key.js');
  const map = new Map();
  await assert.rejects(serializePerKey(map, 7, async () => {
    throw new Error('boom');
  }), /boom/);
  assert.equal(await serializePerKey(map, 7, async () => 'recovered'), 'recovered', 'a failed task never wedges the next one');
  assert.equal(await serializePerKey(map, 7, () => 42), 42, 'sync return values work too');
  // The lane entry is swept shortly after settlement (identity-checked);
  // give the event loop a turn before asserting the map emptied again.
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(map.size, 0);
});

// ---------------------------------------------------------------------------
// TR-1: a SERVER-mandated retry_after is slept verbatim up to an absolute
// ceiling; only the exponential-backoff GUESS keeps the old 30s cap. The old
// `Math.min(delay, 30_000)` clipped retry_after=45 to 30s, re-429'd into a
// burned attempt budget and dropped messages a longer nap would have delivered.
// ---------------------------------------------------------------------------

test('retry_after=45 is slept verbatim instead of clipped to 30s (TR-1)', async () => {
  const sleeps = [];
  const queue = new SendQueue({ retry: { attempts: 1, baseDelayMs: 500 }, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(
    queue.push('c', async () => {
      const err = new Error('Too Many Requests: retry after 45');
      err.error_code = 429;
      err.parameters = { retry_after: 45 };
      throw err;
    }),
    /retry after 45/,
  );
  assert.deepEqual(sleeps, [45_000], 'the mandated wait is honored exactly');
});

test('retry_after beyond MAX_RETRY_AFTER_MS clamps to the ceiling (TR-1)', async () => {
  const { MAX_RETRY_AFTER_MS } = await import('../dist/telegram/queue.js');
  const sleeps = [];
  const queue = new SendQueue({ retry: { attempts: 1 }, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(
    queue.push('c', async () => {
      const err = new Error('flood wait');
      err.error_code = 429;
      err.parameters = { retry_after: 3600 }; // Bot API documents values up to 3600s
      throw err;
    }),
  );
  assert.deepEqual(sleeps, [MAX_RETRY_AFTER_MS], 'a pathological value parks the lane for the ceiling, not an hour');
});

test('the 30s cap applies only to the backoff guess, never to server values (TR-1)', async () => {
  const sleeps = [];
  const queue = new SendQueue({ retry: { attempts: 1, baseDelayMs: 90_000 }, sleep: async (ms) => sleeps.push(ms) });
  await assert.rejects(
    queue.push('c', async () => {
      const err = new Error('server error');
      err.error_code = 500;
      throw err;
    }),
  );
  assert.deepEqual(sleeps, [30_000], 'no-guidance backoff keeps its old ceiling');
});

// ---------------------------------------------------------------------------
// QC-1: the queue card text window matches buildQueueKeyboard's 24-item window.
// ---------------------------------------------------------------------------

test('renderQueuePreviewLine formats numbered turn/step previews (QC-1)', () => {
  assert.equal(
    renderQueuePreviewLine({ itemId: 'a', target: 'next-turn', text: '  hello   world  ' }, 0),
    '#1  \u00B7 turn  \u00B7  hello world',
  );
  assert.equal(
    renderQueuePreviewLine({ itemId: 'b', target: 'next-step', text: '' }, 1),
    '#2  \u00B7 step  \u00B7  (no text)',
  );
});

test('queue card text renders the same 24-item window as its keyboard (QC-1)', async () => {
  const makeItem = (id, text) => ({ id, content: [{ type: 'text', text }] });
  const items = Array.from({ length: 25 }, (_, i) => makeItem(`item-${i}`, `preview ${i}`));
  const agent = {
    id: 'agent-1',
    inbox: { nextTurn: items.slice(0, 13), nextStep: items.slice(13) },
    status: 'running',
  };
  const { cards, seen } = queueCardFor(agent);
  await cards.openQueueCard(1);

  const numbered = seen.text.split('\n').filter((line) => /^#\d+ /.test(line));
  assert.equal(numbered.length, 24);
  assert.ok(numbered[0].startsWith('#1 '));
  assert.ok(numbered[23].startsWith('#24 '));
  assert.equal(numbered.some((line) => line.startsWith('#25 ')), false);

  const keyboardItemRows = seen.keyboard.inline_keyboard.filter((row) => row.some((button) => /#\d+/.test(button.text ?? ''))).length;
  assert.equal(keyboardItemRows, 24);
  assert.equal(seen.keyboard.inline_keyboard.some((row) => row.some((button) => /#25\b/.test(button.text ?? ''))), false);
});

test('queue card empty state is unchanged (QC-1)', async () => {
  const agent = {
    id: 'agent-empty',
    inbox: { nextTurn: [], nextStep: [] },
    status: 'idle',
  };
  const { cards, seen } = queueCardFor(agent);
  await cards.openQueueCard(1);

  assert.ok(seen.text.includes('(nothing pending)'));
  assert.ok(seen.text.includes('\u{1F4A1} \u8FDE\u7EED\u53D1\u4E24\u6761\u6D88\u606F\uFF0C\u7B2C\u4E8C\u6761\u4F1A\u6392\u961F\uFF0C\u6BCF\u6761\u90FD\u6709 \u270F/\u{1F5D1}/\u26A1 \u6309\u94AE\u3002'));
  assert.equal(seen.text.includes('#1 '), false);
});
