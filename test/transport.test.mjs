import test from 'node:test';
import assert from 'node:assert/strict';
import { TelegramTransport, callbackUpdateChatId } from '../dist/telegram/transport.js';
import { GrammyError } from 'grammy';

function makeTransport() {
  return new TelegramTransport({
    token: '123456:test-token',
    log: () => {},
    queue: { push: async (_key, fn) => fn(), pendingCount: () => 0, configure: () => {} },
  });
}

/** Long-poll stand-in that stays pending until the transport aborts it. */
function pendingPoll() {
  const calls = [];
  const options = [];
  return {
    calls,
    options,
    async getUpdates(opts, signal) {
      calls.push(signal);
      options.push(opts);
      await new Promise((resolve) => {
        const settle = () => {
          signal.removeEventListener('abort', settle);
          resolve();
        };
        if (signal.aborted) return settle();
        signal.addEventListener('abort', settle);
      });
      return [];
    },
  };
}

test('callbackUpdateChatId prefers the documented callback_query.message.chat shape', () => {
  assert.equal(callbackUpdateChatId({ message: { chat: { id: 42 } } }), 42);
  assert.equal(callbackUpdateChatId({ chat: { id: 7 }, message: { chat: { id: 9 } } }), 9);
  assert.equal(callbackUpdateChatId({}), undefined);
});

test('start aborts the previous long-poll generation before launching a new one', async () => {
  const transport = makeTransport();
  const poll = pendingPoll();
  transport.api.getUpdates = poll.getUpdates;

  await transport.start();
  assert.equal(poll.calls.length, 1);
  assert.equal(poll.calls[0].aborted, false);

  const stopping = transport.stop();
  assert.equal(poll.calls[0].aborted, true);
  await transport.start();
  assert.equal(poll.calls.length, 2);
  assert.equal(poll.calls[1].aborted, false);

  await stopping;
  await transport.stop();
  assert.equal(poll.calls[1].aborted, true);
});

test('concurrent start calls create one polling loop', async () => {
  const transport = makeTransport();
  const poll = pendingPoll();
  transport.api.getUpdates = poll.getUpdates;

  await Promise.all([transport.start(), transport.start(), transport.start()]);
  assert.equal(poll.calls.length, 1);
  await transport.stop();
});

test('poll offset is preserved across a stop/start generation', async () => {
  const transport = makeTransport();
  const offsets = [];
  transport.api.getUpdates = async (opts, signal) => {
    offsets.push(opts.offset);
    if (offsets.length === 1) {
      await new Promise((resolve) => {
        const settle = () => {
          signal.removeEventListener('abort', settle);
          resolve();
        };
        signal.addEventListener('abort', settle);
      });
      return [];
    }
    return [];
  };

  // First generation never receives updates, so offset stays at 0.
  await transport.start();
  assert.deepEqual(offsets, [0]);
  await transport.stop();

  // Second generation receives one update; the next long poll must stay
  // pending until stop() aborts it. Returning [] here would create a
  // microtask spin that starves the test timer (not a transport bug).
  transport.api.getUpdates = async (opts, signal) => {
    offsets.push(opts.offset);
    if (offsets[2] === undefined) return [{ update_id: 41, message: { chat: { id: 1 }, text: 'x' } }];
    await new Promise((resolve) => {
      const settle = () => {
        signal.removeEventListener('abort', settle);
        resolve();
      };
      if (signal.aborted) return settle();
      signal.addEventListener('abort', settle);
    });
    return [];
  };
  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 20));
  await transport.stop();
  assert.deepEqual(offsets, [0, 0, 42]);
});

test('stop is idempotent and a later start works again', async () => {
  const transport = makeTransport();
  const poll = pendingPoll();
  transport.api.getUpdates = poll.getUpdates;

  await transport.start();
  await transport.stop();
  await transport.stop();
  await transport.start();
  await transport.stop();
  assert.equal(poll.calls.length, 2);
});

test('non-409 polling failures back off exponentially and log only the first', async () => {
  const delays = [];
  const logs = [];
  const transport = new TelegramTransport({
    token: '123456:backoff-test',
    log: (message) => logs.push(message),
    sleep: async (ms) => {
      delays.push(ms);
      // Yield to the macrotask queue: an instantly-resolving promise would
      // starve the setTimeout that stops the poll loop.
      await new Promise((resolve) => setTimeout(resolve, 1));
    },
    queue: { push: async (_key, fn) => fn(), pendingCount: () => 0, configure: () => {} },
  });
  let calls = 0;
  transport.api.getUpdates = async () => {
    calls += 1;
    const err = new Error('Bad Gateway');
    err.error_code = 502;
    throw err;
  };

  await transport.start();
  await new Promise((resolve) => setTimeout(resolve, 30));
  await transport.stop();

  assert.ok(calls > 4, `expected several retries, got ${calls}`);
  assert.deepEqual(delays.slice(0, 4), [2000, 4000, 8000, 16000], 'retry delay doubles up to the cap');
  const errorLogs = logs.filter((line) => line.includes('backing off'));
  assert.equal(errorLogs.length, 1, 'only the first failure logs; later ones stay quiet');
  assert.match(errorLogs[0], /backing off/);
});

test('unsupported media routes to the document handler with metadata', async () => {
  const transport = makeTransport();
  const calls = [];
  transport.setHandlers({
    onText: () => {},
    onPhoto: () => {},
    onCallback: () => {},
    onDocument: (chatId, kind, fileId, name, mimeType, messageId) => calls.push({ chatId, kind, fileId, name, mimeType, messageId }),
  });
  await transport.handleUpdate({
    message: { message_id: 77, chat: { id: 7 }, document: { file_id: 'file-doc', file_name: 'notes.txt', mime_type: 'text/plain' } },
  });
  assert.deepEqual(calls, [{ chatId: 7, kind: 'document', fileId: 'file-doc', name: 'notes.txt', mimeType: 'text/plain', messageId: 77 }]);
  await transport.handleUpdate({ message: { message_id: 78, chat: { id: 7 }, voice: { file_id: 'file-voice', mime_type: 'audio/ogg' } } });
  assert.equal(calls[1].kind, 'voice');
  assert.equal(calls[1].messageId, 78);
});

test('sendPhoto uploads image bytes through the per-chat send queue', async () => {
  const transport = makeTransport();
  let captured;
  transport.api.sendPhoto = async (chatId, input, options) => {
    captured = { chatId, input, options };
    return { message_id: 88 };
  };
  const id = await transport.sendPhoto(7, new Uint8Array([9, 8, 7]), 'photo.jpg', 'caption');
  assert.equal(id, 88);
  assert.equal(captured.chatId, 7);
  assert.equal(captured.options.caption, 'caption');
  assert.equal(captured.input !== undefined, true);
});

test('sendText strips reply quote and keyboard from later split parts', async () => {
  const transport = makeTransport();
  const calls = [];
  transport.api.sendMessage = async (chatId, text, options) => {
    calls.push({ chatId, text, options });
    return { message_id: calls.length };
  };
  await transport.sendText(7, 'a'.repeat(100), { reply_parameters: { message_id: 9 }, reply_markup: { keyboard: [[{ text: 'x' }]] } });
  // queue stub executes fn synchronously; transport max length defaults 4096,
  // so override the splitter by monkey-patching maxMessageLength via applyLimits.
  transport.applyLimits({ maxMessageLength: 10 });
  calls.length = 0;
  await transport.sendText(7, 'a'.repeat(25), { reply_parameters: { message_id: 9 }, reply_markup: { keyboard: [[{ text: 'x' }]] } });
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[0].options.reply_parameters, { message_id: 9 });
  assert.equal(calls[1].options.reply_parameters, undefined);
  assert.equal(calls[2].options.reply_markup, undefined);
});

test('lastOutgoingMessageId tracks the LAST part of a split send (TL-8)', async () => {
  const transport = makeTransport();
  const calls = [];
  transport.api.sendMessage = async (chatId, text, options) => {
    calls.push({ chatId, text, options });
    return { message_id: calls.length + 10 };
  };
  transport.applyLimits({ maxMessageLength: 10 });
  const first = await transport.sendText(7, 'a'.repeat(15));
  assert.equal(first, 11, 'sendText still resolves the first part');
  assert.equal(calls.length, 2, 'the payload splits into exactly two parts');
  assert.equal(transport.lastOutgoingMessageId(7), 12, 'the re-anchor hint must be the second part\'s id');
});

test('stop requested while start is awaiting the old generation wins', async () => {
  const transport = makeTransport();
  const calls = [];
  let releaseFirst = () => {};
  const gate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  transport.api.getUpdates = async (_opts, signal) => {
    calls.push(signal);
    await new Promise((resolve) => {
      const done = () => resolve([]);
      if (signal.aborted) return done();
      signal.addEventListener('abort', async () => {
        await gate; // hold the old generation until the second stop arrived
        done();
      }, { once: true });
    });
    return [];
  };

  await transport.start(); // generation 1, pending
  const stopping = transport.stop(); // aborts generation 1
  const restarting = transport.start(); // enters its await-previous-loop window
  await new Promise((resolve) => setTimeout(resolve, 5));
  const stoppingDuringRestart = transport.stop();
  releaseFirst();
  await Promise.all([stopping, restarting, stoppingDuringRestart]);
  assert.equal(calls.length, 1, 'the start in flight must not launch a second generation');
  assert.equal(transport.polling, false);
});

test('UI control lane is a separate SendQueue key from assistant content (#11/#12)', async () => {
  const keys = [];
  const transport = new TelegramTransport({
    token: '123456:lanes',
    log: () => {},
    queue: {
      push: async (key, fn) => {
        keys.push(key);
        return fn();
      },
      pendingCount: () => 0,
      configure: () => {},
    },
  });
  transport.api.sendMessage = async () => ({ message_id: 1 });
  transport.api.editMessageText = async () => ({ message_id: 1 });
  transport.api.deleteMessage = async () => true;
  await transport.sendText(7, 'assistant content');
  await transport.sendTextControl(7, 'ui card');
  await transport.editTextControl(7, 5, 'card');
  await transport.deleteMessageControl(7, 5);
  assert.deepEqual(keys, [7, 'control:7', 'control:7', 'control:7']);
});

test('sendText logs ok and FAILED attempts instead of swallowing (#11)', async () => {
  const logs = [];
  const transport = new TelegramTransport({
    token: '123456:logs',
    log: (message) => logs.push(message),
    queue: { push: async (_key, fn) => fn(), pendingCount: () => 0, configure: () => {} },
  });
  transport.api.sendMessage = async () => ({ message_id: 11 });
  await transport.sendText(7, 'ok');
  assert.ok(logs.some((line) => line.includes('sendText ok') && line.includes('reply_markup=null')));

  const err = new Error('bad request');
  err.error_code = 400;
  transport.api.sendMessage = async () => {
    throw err;
  };
  await assert.rejects(transport.sendText(7, 'bad'), /bad request/);
  assert.ok(logs.some((line) => line.startsWith('sendText FAILED') && line.includes('text.len=3')));
});

test('handlePhotos batches media groups through onPhotos', async () => {
  const transport = makeTransport();
  const batches = [];
  transport.setHandlers({
    onText: () => {},
    onPhoto: () => {},
    onCallback: () => {},
    onPhotos: (chatId, photos, groupId) => batches.push({ chatId, photos, groupId }),
  });
  await transport.handlePhotos(9, [
    { fileId: 'a', caption: '', messageId: 1 },
    { fileId: 'b', caption: 'two', messageId: 2 },
  ], 'grp');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].chatId, 9);
  assert.equal(batches[0].groupId, 'grp');
  assert.deepEqual(batches[0].photos.map((p) => p.fileId), ['a', 'b']);
});

test('editText treats "message is not modified" as success (#models card dead taps)', async () => {
  const transport = makeTransport();
  transport.api.editMessageText = async () => {
    throw new GrammyError('Bad Request: message is not modified', { error_code: 400, description: 'Bad Request: message is not modified' }, 'editMessageText', {});
  };
  assert.equal(await transport.editText(7, 5, 'same content'), true, 'alive message already showing the target content = logical success');

  transport.api.editMessageText = async () => {
    throw new GrammyError('Bad Request: message to edit not found', { error_code: 400, description: 'Bad Request: message to edit not found' }, 'editMessageText', {});
  };
  assert.equal(await transport.editText(7, 5, 'x'), false, 'genuine GrammyErrors stay failures');

  transport.api.editMessageText = async () => {
    throw new Error('network down');
  };
  await assert.rejects(transport.editText(7, 5, 'x'), /network down/, 'non-Grammy errors still propagate');
});

test('editText logs the benign "not modified" case at noop level, never FAILED (#49)', async () => {
  const lines = [];
  const transport = new TelegramTransport({
    token: '123456:test-token',
    log: (line) => lines.push(line),
    queue: { push: async (_key, fn) => fn(), pendingCount: () => 0, configure: () => {} },
  });

  // Repeated taps on an unchanged card are the designed hot path: they must
  // read as a noop, so FAILED-grep alerting stays meaningful.
  transport.api.editMessageText = async () => {
    throw new GrammyError('Bad Request: message is not modified', { error_code: 400, description: 'Bad Request: message is not modified' }, 'editMessageText', {});
  };
  assert.equal(await transport.editText(7, 5, 'same content'), true);
  assert.equal(lines.some((line) => line.includes('FAILED')), false, `benign edit must not log FAILED, got: ${lines.join(' | ')}`);
  assert.equal(lines.filter((line) => line.includes('editText noop')).length, 1);

  // A genuine failure still logs the FAILED line for alerting.
  transport.api.editMessageText = async () => {
    throw new GrammyError('Bad Request: chat not found', { error_code: 400, description: 'Bad Request: chat not found' }, 'editMessageText', {});
  };
  assert.equal(await transport.editText(7, 5, 'x'), false);
  assert.equal(lines.filter((line) => line.includes('FAILED')).length, 1);
});

// ---------------------------------------------------------------------------
// RE-4 / RE-7
// ---------------------------------------------------------------------------

test('sendTextLane resumes after a transient failure instead of re-sending delivered parts (RE-4)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const transport = new TelegramTransport({
    token: '123456:resume',
    log: () => {},
    queue: new SendQueue({ retry: { attempts: 2, baseDelayMs: 1 }, sleep: async () => {} }),
  });
  transport.applyLimits({ maxMessageLength: 10 });
  const sent = [];
  let calls = 0;
  transport.api.sendMessage = async (_chatId, text) => {
    calls += 1;
    if (calls === 2) {
      // Second part hits a 429 on its first attempt only.
      const err = new Error('Too Many Requests: retry after 0');
      err.error_code = 429;
      err.parameters = { retry_after: 0 };
      throw err;
    }
    sent.push(text);
    return { message_id: sent.length };
  };
  const first = await transport.sendText(7, 'a'.repeat(25)); // parts: 10+10+5
  assert.equal(first, 1, 'the returned message id is the FIRST part (delivered before the failure)');
  assert.equal(calls, 4, 'part1 x1, part2 x2 (one 429 retry), part3 x1');
  assert.deepEqual(
    sent,
    ['a'.repeat(10), 'a'.repeat(10), 'a'.repeat(5)],
    'delivered parts are never repeated; order stays intact',
  );
});

test('editText refuses overlong payloads without calling the API and reports false (RE-7)', async () => {
  const logs = [];
  const transport = new TelegramTransport({
    token: '123456:len-guard',
    log: (message) => logs.push(message),
    queue: { push: async (_key, fn) => fn(), pendingCount: () => 0, configure: () => {} },
  });
  let apiCalls = 0;
  transport.api.editMessageText = async () => {
    apiCalls += 1;
    return { message_id: 5 };
  };
  assert.equal(await transport.editText(7, 5, 'x'.repeat(5000)), false, 'overlong edit fails fast as "card gone"');
  assert.equal(apiCalls, 0, 'the doomed API call never happens');
  assert.ok(logs.some((line) => line.includes('editText skipped') && line.includes('len=5000')), logs.join(' | '));

  // Within the limit the edit still flows normally.
  assert.equal(await transport.editText(7, 5, 'x'.repeat(100)), true);
  assert.equal(apiCalls, 1);
});

// ---------------------------------------------------------------------------
// TR-1: edit/markup lanes must let retryable transients (429/5xx/network)
// REACH SendQueue instead of converting them into a permanent `false` — the
// old swallow made Ephemeral drop a live bubble id and fire a fresh message
// mid-flood, and made StatusPanel delete its own panel.
// ---------------------------------------------------------------------------

test('editText propagates a 429 so SendQueue retries the SAME bubble honoring retry_after (TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const sleeps = [];
  const transport = new TelegramTransport({
    token: '123456:edit-429',
    log: () => {},
    queue: new SendQueue({ retry: { attempts: 2, baseDelayMs: 1 }, sleep: async (ms) => sleeps.push(ms) }),
  });
  const targets = [];
  let calls = 0;
  transport.api.editMessageText = async (_chatId, messageId) => {
    calls += 1;
    targets.push(messageId);
    if (calls === 1) {
      throw new GrammyError('Too Many Requests: retry after 3', { error_code: 429, description: 'Too Many Requests: retry after 3', parameters: { retry_after: 3 } }, 'editMessageText', {});
    }
    return true;
  };
  assert.equal(await transport.editText(7, 55, 'updated card'), true, 'the queue retry lands the edit');
  assert.equal(calls, 2);
  assert.deepEqual(targets, [55, 55], 'the live bubble id survives; no fresh-send fallback fired');
  assert.deepEqual(sleeps, [3000], 'the lane 429 reaches the queue with its retry_after intact');
});

test('exhausted transient edit retries reject instead of faking a classification (TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const transport = new TelegramTransport({
    token: '123456:edit-exhaust',
    log: () => {},
    queue: new SendQueue({ retry: { attempts: 1, baseDelayMs: 1 }, sleep: async () => {} }),
  });
  let calls = 0;
  transport.api.editMessageText = async () => {
    calls += 1;
    const err = new Error('Bad Gateway');
    err.error_code = 502;
    throw err;
  };
  await assert.rejects(transport.editTextControl(7, 5, 'x'), /Bad Gateway/, 'callers see the truth, not a forged false');
  assert.equal(calls, 2, 'attempts=1 means exactly one retry');
});

test('a permanent 400 edit fails once as false without burning retries (TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const sleeps = [];
  const transport = new TelegramTransport({
    token: '123456:edit-400',
    log: () => {},
    queue: new SendQueue({ retry: { attempts: 3, baseDelayMs: 1 }, sleep: async (ms) => sleeps.push(ms) }),
  });
  let calls = 0;
  transport.api.editMessageText = async () => {
    calls += 1;
    throw new GrammyError('Bad Request: message to edit not found', { error_code: 400, description: 'Bad Request: message to edit not found' }, 'editMessageText', {});
  };
  assert.equal(await transport.editText(7, 5, 'x'), false, '"card gone" semantics preserved (RE-7)');
  assert.equal(calls, 1, 'a permanent 4xx never re-enters the API');
  assert.deepEqual(sleeps, [], 'and never takes a retry nap');
});

test('editReplyMarkup propagates transients but keeps permanent 400s as one-shot false (TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const sleeps = [];
  const transport = new TelegramTransport({
    token: '123456:markup-429',
    log: () => {},
    queue: new SendQueue({ retry: { attempts: 2, baseDelayMs: 1 }, sleep: async (ms) => sleeps.push(ms) }),
  });
  let calls = 0;
  transport.api.editMessageReplyMarkup = async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('server error');
      err.error_code = 500;
      throw err;
    }
    return true;
  };
  assert.equal(await transport.editReplyMarkup(7, 9, { inline_keyboard: [] }), true);
  assert.equal(calls, 3, 'transient markup failures are retried by the queue');

  transport.api.editMessageReplyMarkup = async () => {
    calls += 1;
    throw new GrammyError('Bad Request: chat not found', { error_code: 400, description: 'Bad Request: chat not found' }, 'editMessageReplyMarkup', {});
  };
  assert.equal(await transport.editReplyMarkup(7, 9, { inline_keyboard: [] }), false, 'permanent markup failures settle as false');
  assert.equal(calls, 4, 'no extra attempt for a permanent 4xx');
});

test('a server-mandated 120s retry_after is slept in FULL by the edit lane (TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const sleeps = [];
  const transport = new TelegramTransport({
    token: '123456:edit-flood120',
    log: () => {},
    // baseDelayMs equals the old blanket cap: if the lane ever fell back to
    // the exponential guess here, the sleep would read 30_000 and fail loud.
    queue: new SendQueue({ retry: { attempts: 2, baseDelayMs: 30_000 }, sleep: async (ms) => sleeps.push(ms) }),
  });
  let calls = 0;
  transport.api.editMessageText = async () => {
    calls += 1;
    if (calls === 1) {
      throw new GrammyError('Too Many Requests: retry after 120', { error_code: 429, description: 'Too Many Requests: retry after 120', parameters: { retry_after: 120 } }, 'editMessageText', {});
    }
    return true;
  };
  assert.equal(await transport.editText(7, 55, 'updated card'), true, 'one honored flood wait lands the same bubble');
  assert.equal(calls, 2);
  assert.deepEqual(sleeps, [120_000], 'the full 120s wait is slept verbatim — never clipped to 30s');
});

test('"message is not modified" settles as true through the real queue without retries or FAILED logs (#49/TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const logs = [];
  const transport = new TelegramTransport({
    token: '123456:edit-noop',
    log: (line) => logs.push(line),
    queue: new SendQueue({
      retry: { attempts: 3, baseDelayMs: 1 },
      sleep: async () => {
        throw new Error('a logical success must never take a retry nap');
      },
    }),
  });
  let calls = 0;
  transport.api.editMessageText = async () => {
    calls += 1;
    throw new GrammyError('Bad Request: message is not modified', { error_code: 400, description: 'Bad Request: message is not modified' }, 'editMessageText', {});
  };
  assert.equal(await transport.editText(7, 5, 'same content'), true);
  assert.equal(calls, 1, 'the benign classification happens before any retry decision');
  assert.equal(logs.some((line) => line.includes('FAILED')), false, logs.join(' | '));
});

test('a 5xx edit is retried with plain backoff and lands (TR-1)', async () => {
  const { SendQueue } = await import('../dist/telegram/queue.js');
  const sleeps = [];
  const transport = new TelegramTransport({
    token: '123456:edit-5xx',
    log: () => {},
    queue: new SendQueue({ retry: { attempts: 3, baseDelayMs: 2 }, sleep: async (ms) => sleeps.push(ms) }),
  });
  let calls = 0;
  transport.api.editMessageText = async () => {
    calls += 1;
    if (calls < 3) {
      const err = new Error('Bad Gateway');
      err.error_code = 502;
      throw err;
    }
    return true;
  };
  assert.equal(await transport.editText(7, 5, 'x'), true);
  assert.equal(calls, 3);
  assert.deepEqual(sleeps, [2, 4], 'server errors without retry_after use the capped exponential guess');
});
