import test from 'node:test';
import assert from 'node:assert/strict';
import { Context } from '@deepseek-ai/cordis';
import ToolRuntime, { defineTool } from '@deepseek-ai/dsh-tools';
import { attachInteractive } from '../dist/harness/adapters/interactive.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));

function makeDelivery() {
  const sent = [];
  return {
    sent,
    async broadcast(text, keyboard, chatId) {
      sent.push({ text, keyboard, chatId });
      return [{ chatId: chatId ?? 555, messageId: 900 + sent.length }];
    },
    async edit(chatId, messageId, text, keyboard) {
      sent.push({ edit: { chatId, messageId, text, keyboard } });
      return true;
    },
    chatForSession: (sessionId) => (sessionId === 'session-owner' ? 555 : undefined),
  };
}

function askUserTool() {
  return defineTool({
    name: 'ask_user_question',
    description: 'Ask the user.',
    parameters: {
      questions: {
        type: 'array',
        required: true,
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            id: { type: 'string', required: true },
            question: { type: 'string', required: true },
            header: { type: 'string' },
            options: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: true,
                properties: {
                  label: { type: 'string', required: true },
                  description: { type: 'string' },
                },
              },
            },
            multi_select: { type: 'boolean' },
          },
        },
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          answers: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                selected: { type: 'array', required: true, items: { type: 'string' } },
                custom: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }],
    },
    execute: async () => {
      throw new Error('the web-owned tool body must not run: Telegram intercepts at tools/execute');
    },
  });
}

async function setupWebProfile(inputAgents = [{ id: 'session-owner' }]) {
  const root = new Context();
  root.provide('systemPrompt', { tools() {}, section() { return {}; } });
  await root.plugin(ToolRuntime);

  const liveAgents = inputAgents;
  const chatBySession = new Map([
    ['session-owner', 555],
    ['session-b', 666],
  ]);
  root.provide('agents', {
    get: (id) => liveAgents.find((agent) => agent.id === String(id)),
    list: () => liveAgents,
    roots: () => liveAgents,
  });
  let webAsks = 0;
  root.provide('userQuestions', {
    provider: {
      ask: async () => {
        webAsks += 1;
        return { answers: [] };
      },
    },
    registerProvider() {
      throw new Error('a user-questions provider is already registered');
    },
  });
  root.provide('loader', { entries: () => [{ options: { name: '@deepseek-ai/dsh-host-apiproxy' } }] });
  root.tools.register(askUserTool());

  const delivery = makeDelivery();
  delivery.chatForSession = (sessionId) => chatBySession.get(sessionId);
  const logs = [];
  const interactive = attachInteractive(root, delivery, { userQuestions: 'telegram', log: (message) => logs.push(message) });
  return { root, delivery, interactive, logs, liveAgents, webAsks: () => webAsks };
}

test('web profile + Telegram: the real tools/execute seam settles ask_user_question through Telegram', async () => {
  const { root, delivery, interactive, logs, liveAgents, webAsks } = await setupWebProfile();
  const [liveAgent] = liveAgents;
  try {
    const controller = new AbortController();
    const execution = root.tools.execute({
      callId: 'call-web-profile-1',
      name: 'ask_user_question',
      arguments: {
        questions: [
          { id: 'q1', question: 'Which one?', options: [{ label: 'Alpha' }, { label: 'Beta' }] },
        ],
      },
      agent: liveAgent,
      signal: controller.signal,
    });

    await tick();
    const prompt = delivery.sent.find((entry) => entry.text?.startsWith('❓ Session session-owner asks'));
    assert.ok(prompt, 'question card reaches Telegram');
    assert.equal(prompt.chatId, 555);
    const callback = prompt.keyboard.inline_keyboard[0][0].callback_data;
    const id = Number(callback.split(':')[1]);
    await interactive.toggleQuestionOption(555, id, 'q1', '0');
    await interactive.submitQuestions(555, id);

    const result = await execution;
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { answers: [{ id: 'q1', selected: ['Alpha'] }] });
    assert.equal(webAsks(), 0, 'web provider never receives the ask');
    assert.ok(logs.some((line) => line.includes('another UI owns ctx.userQuestions')), 'ownership diagnostic emitted');
  } finally {
    interactive.detach();
    await root.fiber.dispose();
  }
});

test('web profile + Telegram: custom input and cancel settle the same execution', async () => {
  const { root, delivery, interactive, liveAgents } = await setupWebProfile();
  const [liveAgent] = liveAgents;
  try {
    const controller = new AbortController();
    const execution = root.tools.execute({
      callId: 'call-web-profile-2',
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'q1', question: 'Why?' }] },
      agent: liveAgent,
      signal: controller.signal,
    });
    await tick();
    const prompt = delivery.sent.find((entry) => entry.text?.startsWith('❓ Session session-owner asks'));
    const id = Number(prompt.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
    await interactive.setQuestionCustom(555, id, 'q1', 'because');
    await interactive.submitQuestions(555, id);
    const result = await execution;
    assert.equal(result.isError, false);
    assert.deepEqual(result.value, { answers: [{ id: 'q1', selected: [], custom: 'because' }] });

    const second = root.tools.execute({
      callId: 'call-web-profile-3',
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'q2', question: 'Sure?' }] },
      agent: liveAgent,
      signal: controller.signal,
    });
    await tick();
    const secondPrompt = delivery.sent.filter((entry) => entry.text?.startsWith('❓ Session session-owner asks')).at(-1);
    const secondId = Number(secondPrompt.keyboard.inline_keyboard.at(-1)[0].callback_data.split(':')[1]);
    await interactive.cancelQuestions(555, secondId);
    const cancelled = await second;
    assert.equal(cancelled.isError, true);
    assert.match(cancelled.error.message, /cancelled/);
  } finally {
    interactive.detach();
    await root.fiber.dispose();
  }
});

test('web profile + Telegram: concurrent questions route to their own chats', async () => {
  const agentA = { id: 'session-owner' };
  const agentB = { id: 'session-b' };
  const { root, delivery, interactive } = await setupWebProfile([agentA, agentB]);
  try {
    const controller = new AbortController();
    const executionA = root.tools.execute({
      callId: 'call-multi-a',
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'qa', question: 'A or B?', options: [{ label: 'A' }, { label: 'B' }] }] },
      agent: agentA,
      signal: controller.signal,
    });
    const executionB = root.tools.execute({
      callId: 'call-multi-b',
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'qb', question: 'C or D?', options: [{ label: 'C' }, { label: 'D' }] }] },
      agent: agentB,
      signal: controller.signal,
    });
    await tick();

    const promptA = delivery.sent.find((entry) => entry.text?.includes('Session session-owner asks'));
    const promptB = delivery.sent.find((entry) => entry.text?.includes('Session session-b asks'));
    assert.ok(promptA && promptB, 'both chats receive their own card');
    assert.equal(promptA.chatId, 555);
    assert.equal(promptB.chatId, 666);
    const idA = Number(promptA.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
    const idB = Number(promptB.keyboard.inline_keyboard[0][0].callback_data.split(':')[1]);
    await interactive.toggleQuestionOption(555, idA, 'qa', '0');
    await interactive.toggleQuestionOption(666, idB, 'qb', '1');
    await interactive.submitQuestions(555, idA);
    await interactive.submitQuestions(666, idB);

    const [resultA, resultB] = await Promise.all([executionA, executionB]);
    assert.deepEqual(resultA.value, { answers: [{ id: 'qa', selected: ['A'] }] });
    assert.deepEqual(resultB.value, { answers: [{ id: 'qb', selected: ['D'] }] });
  } finally {
    interactive.detach();
    await root.fiber.dispose();
  }
});
