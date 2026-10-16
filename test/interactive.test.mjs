import test from 'node:test';
import assert from 'node:assert/strict';
import { questionKeyboard, questionIdAt, renderQuestions, attachInteractive } from '../dist/harness/adapters/interactive.js';

function fakeDelivery() {
  const sent = [];
  return {
    sent,
    async broadcast(text, keyboard, chatId) {
      sent.push({ text, keyboard, chatId });
      return [{ chatId: chatId ?? 111, messageId: 999 }];
    },
    async edit(chatId, messageId, text, keyboard) {
      sent.push({ edit: { chatId, messageId, text, keyboard } });
      return true;
    },
  };
}

function questionRequest(agentId, questions, signal) {
  return { agent: { id: agentId }, questions, ...(signal === undefined ? {} : { signal }) };
}

function fakeEvents() {
  const listeners = new Map();
  return {
    on(name, listener) {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
    listeners,
  };
}

function fakeCtx({ approval = false, userQuestions = false } = {}) {
  const events = fakeEvents();
  let provider;
  const ctx = {
    get: (name) => {
      if (name === 'approval' && approval) return {};
      if (name === 'userQuestions' && userQuestions) return {};
      return undefined;
    },
    registerProvider: undefined,
  };
  const questionsService = {
    registerProvider(p) {
      provider = p;
      return () => {
        provider = undefined;
      };
    },
  };
  ctx.userQuestionsService = questionsService;
  ctx.events = events;
  return ctx;
}

test('renderQuestions numbers questions and reflects selections', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [
      { id: 'q1', question: 'A or B?', options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }] },
      { id: 'q2', question: 'Why?' },
    ],
    selections: new Map([['q1', ['A']], ['q2', []]]),
    custom: new Map(),
  };
  const text = renderQuestions(pending, 0);
  assert.match(text, /1\. A or B\?/);
  assert.match(text, /✅ A/);
  assert.match(text, /○ B/);
  assert.match(text, /2\. Why\?/);
});

test('questionKeyboard builds one row per option plus submit/cancel', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [{ id: 'q1', question: 'A or B?', options: [{ id: 'a', label: 'A' }] }],
    selections: new Map([['q1', ['a']]]),
  };
  const keyboard = questionKeyboardFor(pending);
  const rows = keyboard.inline_keyboard;
  assert.equal(rows[0][0].callback_data, 'qu:7:0:a');
  assert.equal(rows[0][0].text.includes('✅'), true);
  assert.equal(rows[1][0].callback_data, 'qu:7:s');
  assert.equal(rows[1][1].callback_data, 'qu:7:c');
});

test('questionIdAt resolves the question by index', () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s1', [{ id: 'q-abc', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }]));
  promise.catch(() => {});
  assert.equal(questionIdAt(1, 0), 'q-abc');
  assert.equal(questionIdAt(1, 1), undefined);
  interactive.detach();
});

test('answerApproval settles once and rejects the second answer', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = {
    get: (name) => (name === 'approval' ? {} : undefined),
  };
  ctx.on = events.on.bind(events);
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  assert.equal(typeof listener, 'function');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app1', callId: 'c1' } }] } },
    toolName: 'bash',
    callId: 'c1',
    reason: 'needs a shell',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  // The broadcast is deferred to a microtask (IA-1 #2 error-path unwind), so
  // give it a tick before reading the delivered card.
  await new Promise((resolve) => setImmediate(resolve));
  let settled;
  answer.then((outcome) => {
    settled = outcome;
  });
  const prompt = delivery.sent[0];
  const data = prompt.keyboard.inline_keyboard[0][0].callback_data;
  const id = Number(data.split(':')[1]);
  const first = interactive.answerApproval(111, id, 'allowed-once');
  assert.equal(first, true);
  assert.equal(interactive.answerApproval(111, id, 'rejected'), false);
  return answer.then((outcome) => {
    assert.equal(outcome, 'allowed-once');
    void settled;
    interactive.detach();
  });
});

test('approval waterfall defers to next when no matching approval/asked event', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [] } },
    toolName: 'bash',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'fallback');
  interactive.detach();
});

function questionKeyboardFor(pending) {
  return {
    inline_keyboard: [
      [{ text: '✅ A', callback_data: 'qu:7:0:a' }],
      [
        { text: '✔️ Submit', callback_data: 'qu:7:s' },
        { text: '✖ Cancel', callback_data: 'qu:7:c' },
      ],
    ],
  };
}

test('userQuestions provider is left alone when another UI owns it', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { registered += 1; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  assert.equal(registered, 0);
  interactive.detach();
});

test('userQuestions provider yields to a mounted web api proxy', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
  };
  const interactive = attachInteractive(ctx, delivery);
  assert.equal(registered, 0);
  interactive.detach();
});

test('approval settle edits the card in place and removes its keyboard', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app2', callId: 'c2' } }] } },
    toolName: 'bash',
    callId: 'c2',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(111, id, 'allowed-once');
  await answer.catch(() => {});
  // The settle must edit the existing card (not spawn a second message) and
  // hand over no keyboard so the host can remove the now-dead buttons.
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.startsWith('🛡 Approval requested') && entry.edit.text.includes('allowed-once'));
  assert.ok(settle, 'settlement must edit the card in place');
  assert.equal(settle.edit.keyboard, undefined);
  assert.equal(settle.edit.messageId, 999);
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no separate settle message next to the card');
  interactive.detach();
});

test('goal-scoped approval grants cover every later approval in the same goal', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery, { goalIdForSession: () => 'goal-42' });
  const listener = events.listeners.get('approval/request');
  const request = (callId) => ({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName: 'bash',
    callId,
    signal: undefined,
  });

  const first = listener(request('c1'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const goalRow = prompt.keyboard.inline_keyboard.find((row) => row[0].callback_data?.startsWith('ap:') && row[0].callback_data.endsWith(':g'));
  assert.ok(goalRow, 'a goal-scoped allow button is offered when a goal exists');
  const id = Number(goalRow[0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(111, id, 'allowed-goal'), true);
  await first;

  const secondOutcome = await listener(request('c2'), async () => 'fallback');
  assert.equal(secondOutcome, 'allowed-once', 'the same goal is auto-allowed without another card');
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no second approval card was broadcast');
  interactive.detach();
});

test('approval keyboard offers session + forever buttons and warns on risky tools (#27)', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-kb', callId: 'c-kb' } }] } },
    toolName: 'bash',
    callId: 'c-kb',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const rows = delivery.sent[0].keyboard.inline_keyboard;
  const session = rows.find((row) => row[0].callback_data?.endsWith(':s'));
  const once = rows.find((row) => row[0].callback_data?.endsWith(':y'));
  const forever = rows.find((row) => row[0].callback_data?.endsWith(':a'));
  assert.ok(session, 'session-scoped allow button is offered');
  assert.equal(session[0].text.includes('Allow for this session'), true);
  assert.ok(once, 'allow-once is still offered');
  assert.ok(forever, 'forever-by-tool allow button is offered');
  assert.match(forever[0].text, /⚠️/, 'risky tools mark the forever button');
  const id = Number(session[0].callback_data.split(':')[1]);
  interactive.answerApproval(111, id, 'allowed-once');
  await answer;
  interactive.detach();
});

test('session-scoped grants cover the same tool in the same session only (#27)', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const request = (toolName, callId, agentId = 's1') => ({
    agent: { id: agentId, session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName,
    callId,
    signal: undefined,
  });

  const first = listener(request('bash', 'c1'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(111, id, 'allowed-session'), true);
  assert.equal(await first, 'allowed-once');

  assert.equal(await listener(request('bash', 'c2'), async () => 'fallback'), 'allowed-once', 'same session + tool auto-allows');
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no second card for the granted tool');

  const different = listener(request('web_search', 'c3'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 2, 'a different tool still asks');
  const otherId = Number(delivery.sent.filter((entry) => !entry.edit)[1].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(111, otherId, 'allowed-once');
  await different;

  const otherSession = listener(request('bash', 'c4', 's2'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 3, 'another session still asks for the same tool');
  const thirdId = Number(delivery.sent.filter((entry) => !entry.edit)[2].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(111, thirdId, 'allowed-once');
  await otherSession;
  interactive.detach();
});

test('forever-by-tool grants persist through the host hook and reload on attach (#27)', async () => {
  const persisted = [];
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery, { persistToolAllow: (toolName) => { persisted.push(toolName); return true; } });
  const listener = events.listeners.get('approval/request');
  const request = (agentId, callId) => ({
    agent: { id: agentId, session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName: 'bash',
    callId,
    signal: undefined,
  });

  const first = listener(request('s1', 'c1'), async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const forever = delivery.sent[0].keyboard.inline_keyboard.find((row) => row[0].callback_data?.endsWith(':a'));
  const id = Number(forever[0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(111, id, 'allowed-always'), true);
  assert.equal(await first, 'allowed-once');
  assert.deepEqual(persisted, ['bash'], 'host persistence hook receives the granted tool');
  assert.equal(await listener(request('s2', 'c2'), async () => 'fallback'), 'allowed-once', 'forever grant covers other sessions');
  interactive.detach();

  const events2 = fakeEvents();
  const ctx2 = { get: (name) => (name === 'approval' ? {} : undefined), on: events2.on.bind(events2) };
  const delivery2 = fakeDelivery();
  const reloaded = attachInteractive(ctx2, delivery2, { allowedTools: persisted });
  const listener2 = events2.listeners.get('approval/request');
  assert.equal(await listener2(request('s3', 'c3'), async () => 'fallback'), 'allowed-once', 'persisted grants survive a restart');
  assert.equal(delivery2.sent.length, 0, 'reloaded grant never shows a card');
  reloaded.detach();
});

test('allowed-goal still rejects when the request has no goal', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const answer = listener({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-nogoal', callId: 'c-nogoal' } }] } },
    toolName: 'bash',
    callId: 'c-nogoal',
    signal: undefined,
  }, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(111, id, 'allowed-goal'), false, 'no goal id means the goal grant cannot apply');
  assert.equal(interactive.answerApproval(111, id, 'allowed-once'), true);
  await answer;
  interactive.detach();
});

test('approval request and settle route to the session-owned chat only', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 777 : undefined);
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's-owner', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app3', callId: 'c3' } }] } },
    toolName: 'bash',
    callId: 'c3',
    signal: undefined,
  };
  const answer = listener(req, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  assert.equal(prompt.chatId, 777, 'request card goes to the owner chat');
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  interactive.answerApproval(777, id, 'allowed-once');
  await answer;
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.startsWith('🛡 Approval requested'));
  assert.ok(settle, 'settlement edits the card');
  assert.equal(settle.edit.chatId, 777, 'settle edit goes to the same chat, not every roster chat');
  interactive.detach();
});

test('question cards and the answered status route to the session-owned chat', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s-owner', [{ id: 'q1', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  assert.equal(prompt.chatId, 555);
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(555, id, 'q1', 'o1');
  await interactive.submitQuestions(555, id);
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text?.startsWith('✅ Questions answered'));
  assert.ok(settle, 'answered status edits the card in place');
  assert.equal(settle.edit.chatId, 555);
  assert.equal(settle.edit.keyboard, undefined);
  assert.equal(delivery.sent.filter((entry) => !entry.edit && entry.text?.startsWith('✅ Questions answered')).length, 0);
  interactive.detach();
});

test('a question nobody receives rejects instead of waiting forever (#20)', async () => {
  const delivery = fakeDelivery();
  delivery.broadcast = async () => [];
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  await assert.rejects(
    provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick one' }])),
    /no allowed Telegram chat is available/,
  );
  interactive.detach();
});

test('an approval nobody receives cancels instead of blocking the tool (#20)', async () => {
  const delivery = fakeDelivery();
  delivery.broadcast = async () => [];
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app0', callId: 'c0' } }] } },
    toolName: 'bash',
    callId: 'c0',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'cancelled');
  interactive.detach();
});

test('a broadcast rejection rejects the question instead of waiting forever (#2)', async () => {
  const delivery = fakeDelivery();
  let mintedId;
  delivery.broadcast = async (text, keyboard) => {
    // The card keyboard is built before delivery, so it carries the minted
    // pending id even though the send itself fails.
    mintedId = Number(keyboard.inline_keyboard.at(-1)[0].callback_data.split(':')[1]);
    throw new Error('network down');
  };
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  await assert.rejects(
    provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick one' }])),
    /no allowed Telegram chat is available/,
    'the tool promise settles with the same error as the zero-delivery path',
  );
  assert.notEqual(mintedId, undefined);
  assert.equal(questionIdAt(mintedId, 0), undefined, 'the rejected question leaves no pending entry behind');
  interactive.detach();
});

test('a broadcast rejection cancels the approval instead of blocking the tool (#2)', async () => {
  const delivery = fakeDelivery();
  let mintedId;
  delivery.broadcast = async (text, keyboard) => {
    mintedId = Number(keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
    throw new Error('network down');
  };
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const req = {
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-net', callId: 'c-net' } }] } },
    toolName: 'bash',
    callId: 'c-net',
    signal: undefined,
  };
  const outcome = await listener(req, async () => 'fallback');
  assert.equal(outcome, 'cancelled', 'the tool promise settles instead of waiting forever');
  assert.notEqual(mintedId, undefined);
  assert.equal(interactive.answerApproval(111, mintedId, 'allowed-once'), false, 'the settled approval leaves no pending entry behind');
  interactive.detach();
});

test('telegram ownership answers ask_user_question at tools/execute when the web proxy owns the provider seam', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  const events = fakeEvents();
  let registered = 0;
  let nextCalled = 0;
  const liveAgent = { id: 's-owner' };
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      if (name === 'agents') return {
        get: (id) => (id === 's-owner' ? liveAgent : undefined),
        roots: () => [liveAgent],
      };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const logs = [];
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'telegram', log: (message) => logs.push(message) });
  assert.equal(registered, 0, 'never competes for the single userQuestions provider');
  const listener = events.listeners.get('tools/execute');
  assert.equal(typeof listener, 'function', 'tools/execute interception is installed');
  const answerPromise = listener(
    {
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }] },
      agent: liveAgent,
    },
    () => { nextCalled += 1; },
  );
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(nextCalled, 0, 'the original tool body (and web provider) is bypassed');
  const prompt = delivery.sent.find((entry) => entry.text?.startsWith('❓ Session s-owner asks'));
  assert.ok(prompt, 'question card reaches the Telegram chat');
  assert.equal(prompt.chatId, 555);
  const callback = prompt.keyboard.inline_keyboard[0][0].callback_data;
  const id = Number(callback.split(':')[1]);
  await interactive.toggleQuestionOption(555, id, 'q1', '0');
  await interactive.submitQuestions(555, id);
  const result = await answerPromise;
  assert.deepEqual(result, { value: { answers: [{ id: 'q1', selected: ['One'] }] } });
  assert.ok(logs.some((line) => line.includes('another UI owns ctx.userQuestions')), 'competition diagnostic is emitted');
  interactive.detach();
});

test('telegram ownership still answers at tools/execute when this host mounts no userQuestions service', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  const events = fakeEvents();
  const liveAgent = { id: 's-owner' };
  const ctx = {
    get: (name) => {
      // The 0.2.x host reads services at apply time: a service mounted later,
      // or a release without this one, is simply absent here.
      if (name === 'agents') return { get: (id) => (id === 's-owner' ? liveAgent : undefined), roots: () => [liveAgent] };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const logs = [];
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'telegram', log: (message) => logs.push(message) });
  const listener = events.listeners.get('tools/execute');
  assert.equal(typeof listener, 'function', 'the service-independent seam is installed without a userQuestions service');
  const answerPromise = listener(
    {
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }] },
      agent: liveAgent,
    },
    () => { throw new Error('the tool body must not run when Telegram answers'); },
  );
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent.find((entry) => entry.text?.startsWith('❓ Session s-owner asks'));
  assert.ok(prompt, 'question card reaches the Telegram chat');
  assert.equal(prompt.chatId, 555);
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(555, id, 'q1', '0');
  await interactive.submitQuestions(555, id);
  assert.deepEqual(await answerPromise, { value: { answers: [{ id: 'q1', selected: ['One'] }] } });
  assert.ok(logs.some((line) => line.includes('no userQuestions service is available')), 'the fallback reason is logged');
  interactive.detach();
});

test('an older userQuestions service without registerProvider falls back to the tools/execute seam', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = () => 555;
  const events = fakeEvents();
  const liveAgent = { id: 's-owner' };
  const ctx = {
    get: (name) => {
      // Shape seen on a host whose service predates registerProvider.
      if (name === 'userQuestions') return { ask: async () => ({ answers: [] }) };
      if (name === 'agents') return { get: (id) => (id === 's-owner' ? liveAgent : undefined), roots: () => [liveAgent] };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const logs = [];
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'telegram', log: (message) => logs.push(message) });
  assert.equal(typeof events.listeners.get('tools/execute'), 'function', 'the unusable provider seam does not disable the bridge');
  assert.ok(logs.some((line) => line.includes('exposes no registerProvider')), 'the incompatible service is reported');
  interactive.detach();
});

test('web ownership yields the provider seam and installs no tools/execute interception', () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  let registered = 0;
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'web' });
  assert.equal(registered, 0);
  assert.equal(events.listeners.get('tools/execute'), undefined);
  interactive.detach();
});

test('auto ownership keeps the legacy inference: register without web proxy, yield with one', () => {
  const delivery = fakeDelivery();
  let registered = 0;
  const bare = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider() { registered += 1; return () => {}; } } : undefined),
  };
  const first = attachInteractive(bare, delivery, { userQuestions: 'auto' });
  assert.equal(registered, 1, 'no web proxy: Telegram registers the provider');
  first.detach();

  const withWeb = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      if (name === 'loader') return { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] };
      return undefined;
    },
  };
  const second = attachInteractive(withWeb, delivery, { userQuestions: 'auto' });
  assert.equal(registered, 1, 'web proxy mounted: the legacy inference yields');
  second.detach();
});

test('an already-aborted tools/execute question fails fast instead of hanging', () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const liveAgent = { id: 's-owner' };
  const ctx = {
    get: (name) => {
      if (name === 'userQuestions') return { provider: { ask: async () => ({ answers: [] }) }, registerProvider() { return () => {}; } };
      if (name === 'agents') return { get: (id) => (id === 's-owner' ? liveAgent : undefined), roots: () => [liveAgent] };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'telegram', log: () => {} });
  const listener = events.listeners.get('tools/execute');
  const controller = new AbortController();
  controller.abort();
  const signal = controller.signal;
  assert.throws(() => listener(
    { name: 'ask_user_question', arguments: { questions: [{ id: 'q1', question: 'Pick' }] }, agent: liveAgent, signal },
    () => { throw new Error('next must not run for an aborted ask'); },
  ), /aborted before the user answered/);
  interactive.detach();
});

test('question options use labels as answer values while callback tokens stay tiny indexes', async () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const promise = provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ label: 'A very long option label that would blow the callback limit if echoed' }, { label: 'B' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const prompt = delivery.sent[0];
  const rows = prompt.keyboard.inline_keyboard;
  assert.match(rows[0][0].callback_data, /^qu:\d+:0:0$/);
  assert.match(rows[1][0].callback_data, /^qu:\d+:0:1$/);
  const id = Number(rows[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(111, id, 'q1', '0');
  await interactive.submitQuestions(111, id);
  const answer = await promise;
  assert.deepEqual(answer.answers[0].selected, ['A very long option label that would blow the callback limit if echoed']);
  interactive.detach();
});

test('re-attaching resets forever grants so hot reload cannot leave stale allows (#6)', async () => {
  const request = (toolName, callId) => ({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: `app-${callId}`, callId } }] } },
    toolName,
    callId,
    signal: undefined,
  });

  const events1 = fakeEvents();
  const ctx1 = { get: (name) => (name === 'approval' ? {} : undefined), on: events1.on.bind(events1) };
  const mount1 = attachInteractive(ctx1, fakeDelivery(), { allowedTools: ['bash'] });
  assert.equal(
    await events1.listeners.get('approval/request')(request('bash', 'c0'), async () => 'fallback'),
    'allowed-once',
    'the persisted grant auto-allows on the first mount',
  );

  // Hot-reload shape: the module state survives while mount #2 arrives with
  // a different persisted allow list and mount #1 is dropped without
  // detach(). Accumulation left `bash` granted forever; a per-attach reset
  // must ask again while honoring only mount #2's list.
  const delivery2 = fakeDelivery();
  const events2 = fakeEvents();
  const ctx2 = { get: (name) => (name === 'approval' ? {} : undefined), on: events2.on.bind(events2) };
  const mount2 = attachInteractive(ctx2, delivery2, { allowedTools: ['web_search'] });
  assert.equal(
    await events2.listeners.get('approval/request')(request('web_search', 'c1'), async () => 'fallback'),
    'allowed-once',
    "mount #2's own allow list still applies",
  );
  const reask = events2.listeners.get('approval/request')(request('bash', 'c2'), async () => 'fallback');
  reask.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery2.sent.filter((entry) => !entry.edit).length, 1, 'the stale bash grant did not survive the re-mount: bash asks again with its own card');
  mount2.detach();
  mount1.detach();
});

test('an abort racing a settled question cannot reject an already-answered ask', async () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const controller = new AbortController();
  const promise = provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ id: 'o1', label: 'One' }] }], controller.signal));
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  await interactive.toggleQuestionOption(111, id, 'q1', 'o1');
  await interactive.submitQuestions(111, id);
  controller.abort();
  const answer = await promise;
  assert.deepEqual(answer.answers[0].selected, ['One'], 'settle wins over a late abort');
  interactive.detach();
});

test('aborting an unanswered approval cancels it and settles the card in place', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const controller = new AbortController();
  const answer = listener({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-abort', callId: 'c-abort' } }] } },
    toolName: 'bash',
    callId: 'c-abort',
    signal: controller.signal,
  }, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'the approval card was broadcast');
  controller.abort();
  assert.equal(await answer, 'cancelled');
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.includes('Approval cancelled'));
  assert.ok(settle, 'the aborted approval edits its card in place');
  assert.equal(settle.edit.keyboard, undefined, 'the dead buttons are dropped');
  interactive.detach();
});

test('a question whose signal arrived already aborted fails fast without broadcasting', async () => {
  const delivery = fakeDelivery();
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  const interactive = attachInteractive(ctx, delivery);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    provider.ask(questionRequest('s1', [{ id: 'q1', question: 'Pick' }], controller.signal)),
    /aborted before the user answered/,
    'a dead ask rejects instead of waiting on a card nobody can answer',
  );
  assert.equal(delivery.sent.length, 0, 'no card is broadcast for an already-aborted ask');
  interactive.detach();
});

// --- IA-1 audit regressions -------------------------------------------------

/** Delivery that lands one copy per roster chat (multi-chat cards). */
function multiChatDelivery(chats) {
  const sent = [];
  return {
    sent,
    async broadcast(text, keyboard, chatId) {
      const targets = chatId === undefined ? chats : [chatId];
      targets.forEach((target, index) => sent.push({ chatId: target, text, keyboard }));
      return targets.map((target) => ({ chatId: target, messageId: 700 + targets.indexOf(target) }));
    },
    async edit(chatId, messageId, text, keyboard) {
      sent.push({ edit: { chatId, messageId, text, keyboard } });
      return true;
    },
  };
}

/** AbortSignal stand-in that counts registrations vs removals, so tests can
 * pin the exactly-once registration/unwind contract (IA-1 #2). Deliberately
 * models plain (non-`once`) semantics: the adapter must unwind explicitly,
 * and this fake fails loudly if it ever relies on auto-removal. */
function countingSignal() {
  const handlers = [];
  const counts = { added: 0, removed: 0 };
  let aborted = false;
  const signal = {
    get aborted() { return aborted; },
    addEventListener(_name, fn) {
      counts.added += 1;
      handlers.push(fn);
    },
    removeEventListener(_name, fn) {
      const index = handlers.indexOf(fn);
      if (index !== -1) {
        handlers.splice(index, 1);
        counts.removed += 1;
      }
    },
  };
  return {
    signal,
    counts,
    dangling: () => handlers.length,
    fire: () => {
      aborted = true;
      for (const fn of [...handlers]) fn();
    },
  };
}

/** events seam whose disposers report whether they were actually invoked. */
function countedEvents() {
  const listeners = new Map();
  const disposers = [];
  const invoked = [];
  return {
    on(name, listener) {
      listeners.set(name, listener);
      let done = false;
      const dispose = () => {
        if (done) return;
        done = true;
        listeners.delete(name);
      };
      disposers.push(dispose);
      invoked.push(() => done);
      return dispose;
    },
    listeners,
    // Read-only probe: never re-invoke a disposer here.
    allDisposed: () => disposers.length > 0 && invoked.every((read) => read()),
    disposerCount: () => disposers.length,
  };
}

function providerCtx() {
  let provider;
  const ctx = {
    get: (name) => (name === 'userQuestions' ? { provider: undefined, registerProvider(p) { provider = p; return () => {}; } } : undefined),
  };
  return { ctx, ask: (...args) => provider.ask(...args) };
}

test('IA-1 #1: aborting a question strips the keyboard on every delivered card', async () => {
  const delivery = multiChatDelivery([111, 222]);
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const controller = new AbortController();
  const promise = ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }], controller.signal));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 2, 'the card reached both roster chats');
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  controller.abort();
  await assert.rejects(promise, /aborted before the user answered/);
  const strips = delivery.sent.filter((entry) => entry.edit && /Question aborted/.test(entry.edit.text));
  assert.equal(strips.length, 2, 'every delivered copy was edited to the aborted state');
  assert.deepEqual([...new Set(strips.map((entry) => entry.edit.chatId))].sort(), [111, 222]);
  assert.ok(strips.every((entry) => entry.edit.keyboard === undefined), 'the dead buttons are dropped');
  assert.equal(questionIdAt(id, 0), undefined, 'no pending entry survives the abort');
  interactive.detach();
});

test('IA-1 #1: detaching strips the keyboard on every delivered question card', async () => {
  const delivery = multiChatDelivery([111, 222]);
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  interactive.detach();
  await new Promise((resolve) => setImmediate(resolve));
  const strips = delivery.sent.filter((entry) => entry.edit && /buttons closed/.test(entry.edit.text ?? ''));
  assert.equal(strips.length, 2, 'detach closes every delivered card instead of leaving live keyboards');
  assert.ok(strips.every((entry) => entry.edit.keyboard === undefined));
});

test('IA-1 #1: a card that lands after its ask was aborted is stripped immediately', async () => {
  const delivery = multiChatDelivery([111]);
  const queued = [];
  delivery.broadcast = (text, keyboard) => new Promise((resolve) => queued.push({ text, keyboard, resolve }));
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const controller = new AbortController();
  const promise = ask(questionRequest('s1', [{ id: 'q1', question: 'Pick' }], controller.signal));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(queued.length, 1, 'the card broadcast is still in flight');
  controller.abort();
  await assert.rejects(promise, /aborted before the user answered/);
  for (const entry of queued.splice(0)) entry.resolve([{ chatId: 111, messageId: 808 }]);
  await new Promise((resolve) => setImmediate(resolve));
  const strip = delivery.sent.find((entry) => entry.edit && /Question aborted/.test(entry.edit.text));
  assert.ok(strip, 'the late-landing copy is edited to the aborted state instead of staying live');
  assert.equal(strip.edit.messageId, 808);
  assert.equal(strip.edit.keyboard, undefined);
  interactive.detach();
});

test('IA-1 #2: repeated mount/settle/abort/detach cycles leave zero dangling listeners', async () => {
  // Per-card abort-listener balance across all three exits.
  const settleCycle = countingSignal();
  const abortCycle = countingSignal();
  const detachCycle = countingSignal();

  const delivery = multiChatDelivery([111]);
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);

  const settled = ask(questionRequest('s1', [{ id: 'qs', question: 'Pick' }], settleCycle.signal));
  const aborted = ask(questionRequest('s1', [{ id: 'qa', question: 'Pick' }], abortCycle.signal));
  aborted.catch(() => {});
  const detached = ask(questionRequest('s1', [{ id: 'qd', question: 'Pick' }], detachCycle.signal));
  detached.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));

  const cards = delivery.sent.filter((entry) => !entry.edit);
  const idOf = (index) => Number(cards[index].keyboard.inline_keyboard.at(-1)[0].callback_data.split(':')[1]);
  assert.equal(await interactive.submitQuestions(111, idOf(0)), true);
  await settled;
  abortCycle.fire();
  await assert.rejects(aborted, /aborted before the user answered/);
  interactive.detach();
  await assert.rejects(detached, /telegram interactive provider was disposed/);
  assert.equal(questionIdAt(idOf(2), 0), undefined, 'detach removed the pending entry');

  for (const [name, cycle] of [['settle', settleCycle], ['abort', abortCycle], ['detach', detachCycle]]) {
    assert.equal(cycle.counts.added, 1, `${name} cycle registered its abort listener exactly once`);
    assert.equal(cycle.counts.removed, 1, `${name} cycle unwound it exactly once`);
    assert.equal(cycle.dangling(), 0, `${name} cycle leaves no dangling listener`);
  }

  // Seam-level: every ctx.on disposer fires on detach, repeatedly.
  for (let round = 0; round < 3; round += 1) {
    const events = countedEvents();
    const approvalCtx = {
      get: (name) => (name === 'approval' ? {} : name === 'userQuestions' ? {} : undefined),
      on: events.on,
    };
    const mount = attachInteractive(approvalCtx, multiChatDelivery([111]), { log: () => {} });
    assert.equal(events.disposerCount() >= 1, true, `round ${round}: seam listeners were registered`);
    assert.equal(events.allDisposed(), false, `round ${round}: disposers idle while mounted`);
    mount.detach();
    assert.equal(events.allDisposed(), true, `round ${round}: detach ran every seam disposer`);
    assert.equal(events.listeners.size, 0, `round ${round}: no listener remains registered`);
    mount.detach();
    assert.equal(events.allDisposed(), true, `round ${round}: double detach stays a no-op`);
  }
});

test('IA-1 #2: a synchronously throwing broadcast still unwinds listener and registry', async () => {
  const delivery = multiChatDelivery([111]);
  let boom = 0;
  delivery.broadcast = () => {
    boom += 1;
    throw new Error('sync boom');
  };
  const cycle = countingSignal();
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  await assert.rejects(
    ask(questionRequest('s1', [{ id: 'q1', question: 'Pick' }], cycle.signal)),
    /no allowed Telegram chat is available/,
    'the deferred broadcast turns a sync throw into the ordinary failure path',
  );
  assert.equal(boom, 1);
  assert.equal(cycle.dangling(), 0, 'the abort listener was unwound on the error exit too');

  const events = countedEvents();
  const approvalCtx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on };
  const approvalInteractive = attachInteractive(approvalCtx, delivery, { log: () => {} });
  const outcome = await events.listeners.get('approval/request')({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-sync', callId: 'c-sync' } }] } },
    toolName: 'bash',
    callId: 'c-sync',
  }, async () => 'fallback');
  assert.equal(outcome, 'cancelled', 'a throwing broadcast cancels the approval instead of blocking');
  approvalInteractive.detach();
  interactive.detach();
});

test('IA-1 #3: an approval callback from a foreign chat cannot settle the request', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 777 : undefined);
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const answer = listener({
    agent: { id: 's-owner', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-chat', callId: 'c-chat' } }] } },
    toolName: 'bash',
    callId: 'c-chat',
  }, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(888, id, 'allowed-once'), false, 'a chat the card never reached is refused');
  assert.equal(interactive.answerApproval(111, id, 'allowed-once'), false, 'even a whitelisted roster chat outside this card is refused');
  assert.equal(interactive.answerApproval(777, id, 'allowed-once'), true, 'the owning chat still settles');
  assert.equal(await answer, 'allowed-once');
  interactive.detach();
});

test('IA-1 #3: legacy-broadcast approvals answer only from delivered chats', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  const ctx = { get: (name) => (name === 'approval' ? {} : undefined), on: events.on.bind(events) };
  const interactive = attachInteractive(ctx, delivery);
  const listener = events.listeners.get('approval/request');
  const answer = listener({
    agent: { id: 's1', session: { events: [{ seq: 0, type: 'approval/asked', data: { id: 'app-bc2', callId: 'c-bc2' } }] } },
    toolName: 'bash',
    callId: 'c-bc2',
  }, async () => 'fallback');
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(222, id, 'allowed-once'), false, 'chat 222 never received this card');
  const probe = await Promise.race([
    answer.then(() => 'settled'),
    Promise.resolve().then(() => 'still-pending'),
  ]);
  assert.equal(probe, 'still-pending', 'nothing settled yet');
  assert.equal(interactive.answerApproval(111, id, 'allowed-once'), true, 'the delivered chat settles');
  assert.equal(await answer, 'allowed-once');
  interactive.detach();
});

test('IA-1 #3: question mutation and settlement from a foreign chat are refused', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(questionRequest('s-owner', [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }]));
  promise.catch(() => {});
  await new Promise((resolve) => setImmediate(resolve));
  const id = Number(delivery.sent[0].keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(await interactive.toggleQuestionOption(999, id, 'q1', '0'), false, 'foreign toggle refused');
  assert.equal(await interactive.setQuestionCustom(999, id, 'q1', 'hi'), false, 'foreign custom refused');
  assert.equal(await interactive.cancelQuestions(999, id), false, 'foreign cancel refused');
  assert.equal(await interactive.toggleQuestionOption(444, id, 'q1', '0'), false, 'another foreign chat refused');
  assert.equal(await interactive.submitQuestions(999, id), false, 'foreign submit must not settle chat A\'s question');
  assert.equal(questionIdAt(id, 0), 'q1', 'the pending question is untouched by foreign taps');
  assert.equal(await interactive.toggleQuestionOption(555, id, 'q1', '0'), true, 'the owning chat toggles');
  assert.equal(await interactive.submitQuestions(555, id), true, 'the owning chat submits');
  const result = await promise;
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['One'] }], 'only the owning chat shaped the answer');
  interactive.detach();
});

// --- SYNC-1 dual Telegram + web mode ----------------------------------------

/** Fake host api-proxy seam for dual-mode tests. `mux` replays queued frames
 * and then waits for either a later `push` or the AbortSignal, so tests can
 * feed the second half of a scenario after answering the first card. */
function fakeApiProxy(initialFrames = []) {
  const frames = [...initialFrames];
  const responded = [];
  const waiters = [];
  const api = {
    frames,
    responded,
    closed: false,
    accepted: true,
    reason: undefined,
    push(frame) {
      frames.push(frame);
      for (const resolve of waiters.splice(0)) resolve();
    },
    async respond(message) {
      responded.push(message);
      return { accepted: api.accepted, reason: api.reason };
    },
    events: {
      async *mux(request, signal) {
        for (;;) {
          if (frames.length > 0) {
            yield frames.shift();
            continue;
          }
          await new Promise((resolve, reject) => {
            if (signal.aborted) {
              api.closed = true;
              reject(new Error('AbortError'));
              return;
            }
            const onAbort = () => {
              api.closed = true;
              reject(new Error('AbortError'));
            };
            signal.addEventListener('abort', onAbort, { once: true });
            const onPush = () => {
              signal.removeEventListener('abort', onAbort);
              resolve();
            };
            waiters.push(onPush);
          });
        }
      },
    },
  };
  return api;
}

function waitTicks(count = 1) {
  const drain = async () => {
    for (let i = 0; i < count; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  return drain();
}

test('SYNC-1 dual mode installs no approval/request, tools/execute, or userQuestions provider seam', async () => {
  const delivery = fakeDelivery();
  const events = fakeEvents();
  let registered = 0;
  const ctx = {
    get: (name) => {
      if (name === 'approval') return {};
      if (name === 'userQuestions') return { provider: undefined, registerProvider() { registered += 1; return () => {}; } };
      return undefined;
    },
    on: events.on.bind(events),
  };
  const api = fakeApiProxy();
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api });
  await waitTicks(2);
  assert.equal(events.listeners.get('approval/request'), undefined, 'no approval/request listener in dual mode');
  assert.equal(events.listeners.get('tools/execute'), undefined, 'no tools/execute interception in dual mode');
  assert.equal(registered, 0, 'no userQuestions provider registration in dual mode');
  interactive.detach();
});

test('SYNC-1 approval/requested broadcasts a Telegram card and answerApproval responds to the web once', async () => {
  const delivery = fakeDelivery();
  const api = fakeApiProxy([{
    rpcId: 'rpc-a1',
    payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'app1', toolName: 'bash', reason: 'needs a shell' },
  }]);
  const ctx = { get: () => undefined };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api });
  await waitTicks(2);

  const prompt = delivery.sent.find((entry) => entry.text?.startsWith('🛡 Approval requested'));
  assert.ok(prompt, 'approval card is broadcast to Telegram');
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(111, id, 'allowed-once'), true);

  assert.equal(api.responded.length, 1, 'exactly one client-response is sent');
  assert.deepEqual(api.responded[0], {
    type: 'client-response',
    rpcId: 'rpc-a1',
    result: { ok: true, value: { sessionId: 's1', approvalId: 'app1', outcome: 'allowed-once' } },
  });
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.includes('Approval allowed-once'));
  assert.ok(settle, 'Telegram card settles after the local answer');
  assert.equal(settle.edit.keyboard, undefined, 'telegram buttons are removed');
  interactive.detach();
});

test('SYNC-1 approval/resolved settles the Telegram card without responding to the web', async () => {
  const delivery = fakeDelivery();
  const api = fakeApiProxy([
    { rpcId: 'rpc-a1', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'app1', toolName: 'bash' } },
    { rpcId: 'rpc-a2', payload: { type: 'approval/resolved', sessionId: 's1', approvalId: 'app1', outcome: 'rejected' } },
  ]);
  const ctx = { get: () => undefined };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api });
  await waitTicks(2);

  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'one Telegram approval card was sent');
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.includes('Approval rejected'));
  assert.ok(settle, 'web-side resolution settles the local card');
  assert.equal(api.responded.length, 0, 'a resolved frame never triggers a respond call');
  interactive.detach();
});

test('SYNC-1 question/requested broadcasts a card and submitQuestions responds with the answers', async () => {
  const delivery = fakeDelivery();
  const api = fakeApiProxy([{
    rpcId: 'rpc-q1',
    payload: {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }, { label: 'Two' }] }],
    },
  }]);
  const ctx = { get: () => undefined };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api });
  await waitTicks(2);

  const prompt = delivery.sent.find((entry) => entry.text?.startsWith('❓ Session s1 asks'));
  assert.ok(prompt, 'question card is broadcast to Telegram');
  const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
  assert.equal(await interactive.toggleQuestionOption(111, id, 'q1', '0'), true);
  assert.equal(await interactive.submitQuestions(111, id), true);

  assert.equal(api.responded.length, 1, 'exactly one client-response is sent');
  assert.deepEqual(api.responded[0], {
    type: 'client-response',
    rpcId: 'rpc-q1',
    result: { ok: true, value: { sessionId: 's1', answer: { answers: [{ id: 'q1', selected: ['One'] }] } } },
  });
  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text?.startsWith('✅ Questions answered'));
  assert.ok(settle, 'Telegram question card settles after submit');
  interactive.detach();
});

test('SYNC-1 question/resolved settles the Telegram card without responding to the web', async () => {
  const delivery = fakeDelivery();
  const api = fakeApiProxy([
    {
      rpcId: 'rpc-q1',
      payload: {
        type: 'question/requested',
        sessionId: 's1',
        questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }],
      },
    },
    { rpcId: 'rpc-q2', payload: { type: 'question/resolved', sessionId: 's1', questionRpcId: 'rpc-q1', outcome: 'answered' } },
  ]);
  const ctx = { get: () => undefined };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api });
  await waitTicks(2);

  const settle = delivery.sent.find((entry) => entry.edit && entry.edit.text.includes('Questions answered on the web'));
  assert.ok(settle, 'web-side question resolution settles the local card');
  assert.equal(api.responded.length, 0, 'a resolved frame never triggers a respond call');
  interactive.detach();
});

test('SYNC-1 zero Telegram delivery in dual mode leaves the web ask alive and removes the local pending', async () => {
  const delivery = fakeDelivery();
  let mintedId;
  delivery.broadcast = async (text, keyboard) => {
    mintedId = Number(keyboard.inline_keyboard.at(-1)[0].callback_data.split(':')[1]);
    return [];
  };
  const api = fakeApiProxy([{
    rpcId: 'rpc-q-zero',
    payload: {
      type: 'question/requested',
      sessionId: 's1',
      questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }],
    },
  }]);
  const ctx = { get: () => undefined };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api, log: () => {} });
  await waitTicks(2);

  assert.notEqual(mintedId, undefined, 'the card id is captured from the attempted broadcast');
  assert.equal(await interactive.toggleQuestionOption(111, mintedId, 'q1', '0'), false, 'local pending is removed when Telegram delivery failed');
  assert.equal(api.responded.length, 0, 'the web side is not cancelled when Telegram delivery fails');
  interactive.detach();
});

test('SYNC-1 detach aborts the mux loop and settles open dual cards', async () => {
  const delivery = fakeDelivery();
  const api = fakeApiProxy([
    { rpcId: 'rpc-adv', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'app-d', toolName: 'bash' } },
    {
      rpcId: 'rpc-qdv',
      payload: {
        type: 'question/requested',
        sessionId: 's1',
        questions: [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }],
      },
    },
  ]);
  const ctx = { get: () => undefined };
  const interactive = attachInteractive(ctx, delivery, { userQuestions: 'both', apiProxy: api });
  await waitTicks(2);

  interactive.detach();
  await waitTicks(2);

  assert.equal(api.closed, true, 'detach aborts the mux subscription');
  const localCloses = delivery.sent.filter((entry) => entry.edit && entry.edit.text.includes('Telegram interactive detached'));
  assert.equal(localCloses.length, 2, 'open approval and question cards both close locally');
  assert.ok(localCloses.every((entry) => entry.edit.keyboard === undefined), 'closed local cards drop their buttons');
  assert.equal(api.responded.length, 0, 'detach responds to neither the web approval nor the web question');
  assert.equal(api.responded.some((message) => message.rpcId === 'rpc-adv'), false, 'approval detach does not respond cancelled to the web');
  assert.equal(api.responded.some((message) => message.rpcId === 'rpc-qdv'), false, 'question detach does not respond cancelled to the web');
});

test('SYNC-1 scoped goal grant responds allowed-once immediately without broadcasting a second Telegram card', async () => {
  const delivery = fakeDelivery();
  const ctx = { get: () => undefined };
  const api = fakeApiProxy([{ rpcId: 'rpc-g1', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'app-g1', toolName: 'bash' } }]);
  const interactive = attachInteractive(ctx, delivery, {
    userQuestions: 'both',
    apiProxy: api,
    goalIdForSession: () => 'goal-1',
  });
  await waitTicks(2);

  const prompt = delivery.sent.find((entry) => entry.text?.startsWith('🛡 Approval requested'));
  assert.ok(prompt, 'the first approval asks on Telegram');
  const id = Number(prompt.keyboard.inline_keyboard.find((row) => row[0].callback_data.endsWith(':g'))[0].callback_data.split(':')[1]);
  assert.equal(interactive.answerApproval(111, id, 'allowed-goal'), true);

  // The mux is waiting for the next pushed frame; the same-goal grant should
  // auto-allow it without minting another Telegram card.
  api.push({ rpcId: 'rpc-g2', payload: { type: 'approval/requested', sessionId: 's1', approvalId: 'app-g2', toolName: 'bash' } });
  await waitTicks(2);

  assert.equal(delivery.sent.filter((entry) => !entry.edit).length, 1, 'no second Telegram card is broadcast');
  assert.equal(api.responded.length, 2, 'first answer and the grant auto-response are both sent');
  assert.deepEqual(api.responded[1].result.value, { sessionId: 's1', approvalId: 'app-g2', outcome: 'allowed-once' });
  interactive.detach();
});

// --- QX: `/answer` settles a text-only question ------------------------------
// A question with no options has nothing left to choose, so one command must
// settle it. Before this, `/answer` only staged the text and the tool call kept
// waiting for a Submit tap the operator had no reason to expect — the turn then
// looked hung until they aborted it (ASK_ABORTED in the transcript).

/** Pending id of the first delivered question card, read from its Submit row.
 * A text-only card has no option rows, so its first button is Submit. */
function pendingIdFromCard(delivery) {
  return Number(delivery.sent.find((entry) => entry.keyboard?.inline_keyboard)?.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
}

test('QX: /answer submits a text-only question without a Submit tap', async () => {
  const delivery = fakeDelivery();
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(questionRequest('s1', [{ id: 'q1', question: 'Ketik satu kalimat apa saja' }]));
  await waitTicks(2);

  const id = pendingIdFromCard(delivery);
  assert.equal(await interactive.answerQuestionText(111, id, 0, 'tes teks berhasil'), 'submitted');
  const result = await promise;
  assert.deepEqual(result.answers, [{ id: 'q1', selected: [], custom: 'tes teks berhasil' }], 'the typed text is the answer');
  assert.equal(questionIdAt(id, 0), undefined, 'the card settled instead of waiting for Submit');
  interactive.detach();
});

test('QX: /answer on an option question stages and still waits for Submit', async () => {
  const delivery = fakeDelivery();
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }]));
  await waitTicks(2);

  const id = pendingIdFromCard(delivery);
  assert.equal(await interactive.answerQuestionText(111, id, 0, 'custom text'), 'staged', 'an option question needs its Submit tap');
  assert.equal(questionIdAt(id, 0), 'q1', 'the card stays pending');
  assert.equal(await interactive.submitQuestions(111, id), true);
  const result = await promise;
  assert.deepEqual(result.answers, [{ id: 'q1', selected: [], custom: 'custom text' }], 'the staged text survives the Submit');
  interactive.detach();
});

test('QX: /answer on a text-only question with an unanswered sibling stays staged', async () => {
  const delivery = fakeDelivery();
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(
    questionRequest('s1', [
      { id: 'q1', question: 'Ketik satu kalimat' },
      { id: 'q2', question: 'Pick', options: [{ label: 'One' }] },
    ]),
  );
  promise.catch(() => {});
  await waitTicks(2);

  const id = pendingIdFromCard(delivery);
  assert.equal(await interactive.answerQuestionText(111, id, 0, 'teks'), 'staged', 'the option question is still unanswered');
  assert.equal(questionIdAt(id, 0), 'q1', 'the card stays pending');
  assert.equal(await interactive.toggleQuestionOption(111, id, 'q2', '0'), true);
  assert.equal(await interactive.submitQuestions(111, id), true);
  const result = await promise;
  assert.deepEqual(result.answers, [
    { id: 'q1', selected: [], custom: 'teks' },
    { id: 'q2', selected: ['One'] },
  ]);
  interactive.detach();
});

test('QX: /answer from a foreign chat or with a bad index changes nothing', async () => {
  const delivery = fakeDelivery();
  delivery.chatForSession = (sessionId) => (sessionId === 's-owner' ? 555 : undefined);
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(questionRequest('s-owner', [{ id: 'q1', question: 'Ketik satu kalimat' }]));
  await waitTicks(2);

  const id = pendingIdFromCard(delivery);
  assert.equal(await interactive.answerQuestionText(999, id, 0, 'x'), 'stale', 'a foreign chat cannot answer');
  assert.equal(await interactive.answerQuestionText(555, id, 9, 'x'), 'stale', 'an out-of-range index cannot answer');
  assert.equal(questionIdAt(id, 0), 'q1', 'neither attempt touched the pending question');

  // Pre-existing semantics kept by the shared settle helper: Submit with
  // nothing typed on a text-only card is the blank "skip" answer.
  assert.equal(await interactive.submitQuestions(555, id), true);
  const result = await promise;
  assert.deepEqual(result.answers, [{ id: 'q1', selected: [] }], 'an empty Submit still settles as a skip');
  interactive.detach();
});

test('QX: Submit on an unanswered option question warns and keeps the card', async () => {
  const delivery = fakeDelivery();
  const { ctx, ask } = providerCtx();
  const interactive = attachInteractive(ctx, delivery);
  const promise = ask(questionRequest('s1', [{ id: 'q1', question: 'Pick', options: [{ label: 'One' }] }]));
  promise.catch(() => {});
  await waitTicks(2);

  const id = pendingIdFromCard(delivery);
  assert.equal(await interactive.submitQuestions(111, id), true);
  assert.equal(questionIdAt(id, 0), 'q1', 'the card stays pending');
  assert.ok(
    delivery.sent.some((entry) => entry.edit && /Answer every question first/.test(entry.edit.text)),
    'the warning is rendered on the card',
  );
  assert.equal(await interactive.toggleQuestionOption(111, id, 'q1', '0'), true);
  assert.equal(await interactive.submitQuestions(111, id), true);
  const result = await promise;
  assert.deepEqual(result.answers, [{ id: 'q1', selected: ['One'] }]);
  interactive.detach();
});

test('QX: the text-only hint promises the single /answer step', () => {
  const pending = {
    id: 7,
    sessionId: 's1',
    questions: [{ id: 'q2', question: 'Why?' }],
    selections: new Map([['q2', []]]),
    custom: new Map(),
  };
  assert.match(renderQuestions(pending, 0), /\/answer <id> <question-number> <text> — it submits by itself/);
});
