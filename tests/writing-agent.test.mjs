import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backupAndReplaceMarkdownBody,
  defaultApiModel,
  defaultOpenAiModel,
  listKnownGrokModels,
  requestWritingAssistanceStream,
  repairAiModelForConnection,
  writingAssistantActions,
} from '../scripts/grok-writing-agent.mjs';
import {
  maxOutputTokensForCommand,
  runWritingAgent,
  streamWritingAgent,
  trimAgentRequest,
} from '../scripts/writing-agent/agents.mjs';
import { aiProviderModes, listKnownModels, resolveModelForAction } from '../scripts/writing-agent/providers.mjs';
import { MockProvider } from '../scripts/writing-agent/mock-provider.mjs';
import { autosavePathFor, exportPathFor } from '../scripts/writing-agent/storage.mjs';

test('MockProvider returns applicable output for every remote writing command', async () => {
  const remoteActions = writingAssistantActions.filter((action) => !action.local);

  for (const action of remoteActions) {
    const result = await runWritingAgent({
      command: action.id,
      documentText: '我想写一篇关于为什么普通人应该拥有自己的 AI Agent 的文章。',
      model: '',
      projectRoot: process.cwd(),
      provider: aiProviderModes.mock,
      styleSamples: '',
      targetText: '普通人需要稳定执行。',
      userInput: '',
    });

    assert.equal(result.actionId, action.id);
    assert.ok(result.reply || result.insertText || result.replacementText);
  }
});

test('MockProvider streams display chunks and final JSON', async () => {
  const provider = new MockProvider();
  const chunks = [];
  let doneText = '';

  for await (const event of provider.stream({
    context: {
      request: {
        command: 'outline',
        documentText: '普通人应该拥有自己的 AI Agent',
      },
    },
  })) {
    if (event.type === 'delta' && event.displayText) chunks.push(event.displayText);
    if (event.type === 'done') doneText = event.text;
  }

  assert.ok(chunks.length > 1);
  assert.ok(JSON.parse(doneText).insertText);
});

test('Agent stream dispatches partial output and final result', async () => {
  const events = [];
  for await (const event of streamWritingAgent({
    command: 'title',
    documentText: '普通人应该拥有自己的 AI Agent',
    model: '',
    projectRoot: process.cwd(),
    provider: aiProviderModes.mock,
    styleSamples: '',
    targetText: '',
    userInput: '',
  })) {
    events.push(event);
  }

  assert.ok(events.some((event) => event.type === 'first_token'));
  assert.ok(events.some((event) => event.type === 'delta' && event.text));
  const result = events.find((event) => event.type === 'result')?.result;
  assert.equal(result.actionId, 'title');
  assert.equal(result.titleSuggestions.length, 10);
});

test('Agent registry exposes the requested writing commands', () => {
  const commands = new Set(writingAssistantActions.map((action) => action.command));
  for (const command of [
    '/idea',
    '/outline',
    '/draft',
    '/rewrite',
    '/polish',
    '/expand',
    '/compress',
    '/title',
    '/tweet',
    '/summary',
    '/critic',
    '/save',
    '/help',
  ]) {
    assert.ok(commands.has(command), `${command} should be registered`);
  }
});

test('Grok CLI mode rejects grok-4.3 and does not list it', async () => {
  const repaired = await repairAiModelForConnection({
    connection: aiProviderModes.grokCli,
    model: defaultApiModel,
  });
  assert.equal(repaired.changed, true);
  assert.equal(repaired.model, '');

  const models = await listKnownGrokModels({
    connection: aiProviderModes.grokCli,
    selectedModel: defaultApiModel,
  });
  assert.equal(models.some((model) => model.id === defaultApiModel), false);
});

test('Provider model lists keep API-only models on API providers', async () => {
  const openAiModels = await listKnownModels({ connection: aiProviderModes.openai });
  assert.ok(openAiModels.some((model) => model.id === defaultOpenAiModel));

  const xaiModels = await listKnownModels({ connection: aiProviderModes.xai });
  assert.ok(xaiModels.some((model) => model.id === defaultApiModel));
});

test('Model repair clears cross-provider defaults', async () => {
  const repairedOpenAi = await repairAiModelForConnection({
    connection: aiProviderModes.openai,
    model: defaultApiModel,
  });
  assert.equal(repairedOpenAi.changed, true);
  assert.equal(repairedOpenAi.model, '');

  const repairedXai = await repairAiModelForConnection({
    connection: aiProviderModes.xai,
    model: defaultOpenAiModel,
  });
  assert.equal(repairedXai.changed, true);
  assert.equal(repairedXai.model, '');

  const repairedMock = await repairAiModelForConnection({
    connection: aiProviderModes.mock,
    model: defaultOpenAiModel,
  });
  assert.equal(repairedMock.changed, true);
  assert.equal(repairedMock.model, 'mock-writer');
});

test('Context trimming limits long documents before prompting', () => {
  const longDocument = '开头'.repeat(5000) + '结尾'.repeat(5000);
  const request = trimAgentRequest({
    command: 'polish',
    documentText: longDocument,
    styleSamples: longDocument,
    targetText: longDocument,
    userInput: longDocument,
  });

  assert.ok(request.documentText.length <= 3100);
  assert.ok(request.styleSamples.length <= 2600);
  assert.ok(request.targetText.length <= 6100);
  assert.match(request.documentText, /已截断/);
});

test('Per-command token caps and model routing favor short tasks', () => {
  assert.equal(maxOutputTokensForCommand('title'), 300);
  assert.equal(maxOutputTokensForCommand('summary'), 500);
  assert.equal(maxOutputTokensForCommand('draft'), 3000);
  assert.equal(
    resolveModelForAction({ actionId: 'title', provider: aiProviderModes.openai }),
    process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel,
  );
});

test('Mock streaming can be cancelled with AbortController', async () => {
  const controller = new AbortController();
  const provider = new MockProvider();
  const stream = provider.stream({
    context: {
      request: {
        command: 'draft',
        documentText: '普通人应该拥有自己的 AI Agent',
      },
    },
    signal: controller.signal,
  });

  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  await assert.rejects(async () => {
    while (!(await iterator.next()).done) {
      // Drain until abort surfaces.
    }
  }, /cancelled|canceled|aborted/i);
});

test('Compatibility stream helper returns final Mock result', async () => {
  const events = [];
  for await (const event of requestWritingAssistanceStream({
    actionId: 'summary',
    connection: aiProviderModes.mock,
    draftContent: '普通人应该拥有自己的 AI Agent',
    model: '',
    projectRoot: process.cwd(),
    prompt: '',
    targetText: '',
  })) {
    events.push(event.type);
  }

  assert.ok(events.includes('delta'));
  assert.ok(events.includes('result'));
});

test('Markdown body replacement preserves frontmatter and creates backup', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'writing-agent-test-'));
  const filePath = path.join(tempDir, 'draft.md');
  const original = '---\ntitle: Test\n---\n\nOld body\n';
  await writeFile(filePath, original, 'utf8');

  const result = await backupAndReplaceMarkdownBody(filePath, original, 'New body');
  const nextContent = await readFile(filePath, 'utf8');
  const backupContent = await readFile(result.backupPath, 'utf8');

  assert.equal(nextContent, '---\ntitle: Test\n---\nNew body\n');
  assert.equal(backupContent, original);
});

test('Autosave and export paths stay inside project workspace', () => {
  const projectRoot = '/repo';
  const filePath = '/repo/src/content/drafts/20260605.md';

  assert.equal(
    autosavePathFor({ filePath, projectRoot }),
    '/repo/src/content/drafts/.autosave/20260605.md.autosave.md',
  );
  assert.equal(exportPathFor({ filePath, projectRoot }), '/repo/exports/20260605.md');
});
