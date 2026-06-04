import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const defaultApiModel = 'grok-4.3';
export const defaultCliModel = '';
export const aiConnectionModes = {
  apiKey: 'api-key',
  grokCli: 'grok-cli',
};

const xaiResponsesUrl = 'https://api.x.ai/v1/responses';
const maxStyleSampleCharacters = 12000;
const grokCliTimeoutMs = 180000;
const modelCachePath = path.join(os.homedir(), '.grok/models_cache.json');

export const writingAssistantActions = [
  {
    id: 'ask',
    label: 'Ask',
    help: 'Ask about the draft',
    replaceable: false,
  },
  {
    id: 'polish',
    label: 'Polish',
    help: 'Rewrite the body',
    replaceable: true,
  },
  {
    id: 'continue',
    label: 'Continue',
    help: 'Continue the draft',
    replaceable: true,
  },
  {
    id: 'outline',
    label: 'Outline',
    help: 'Plan structure',
    replaceable: false,
  },
  {
    id: 'metadata',
    label: 'Metadata',
    help: 'Suggest title and summary',
    replaceable: false,
  },
];

const actionDefinitions = new Map(writingAssistantActions.map((action) => [action.id, action]));

const responseSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'notes', 'replacementBody', 'titleSuggestions', 'descriptionSuggestion'],
  properties: {
    reply: {
      type: 'string',
      description: 'The main response shown to the writer.',
    },
    notes: {
      type: 'array',
      items: { type: 'string' },
      description: 'Brief supporting notes or caveats.',
    },
    replacementBody: {
      type: ['string', 'null'],
      description:
        'Complete Markdown body to replace the draft body. Only provide for polish or continue.',
    },
    titleSuggestions: {
      type: 'array',
      items: { type: 'string' },
      description: 'Potential titles for the draft.',
    },
    descriptionSuggestion: {
      type: ['string', 'null'],
      description: 'One concise blog description or summary.',
    },
  },
};

export function getWritingAssistantAction(actionId) {
  return actionDefinitions.get(actionId) ?? writingAssistantActions[0];
}

export function canReplaceWithAction(actionId) {
  return Boolean(getWritingAssistantAction(actionId).replaceable);
}

export function normalizeAiConnection(value) {
  return value === aiConnectionModes.grokCli ? aiConnectionModes.grokCli : aiConnectionModes.apiKey;
}

export function normalizeAiModel(value, connection = aiConnectionModes.apiKey) {
  const model = String(value ?? '').trim();
  if (model) return model;
  return normalizeAiConnection(connection) === aiConnectionModes.grokCli
    ? defaultCliModel
    : process.env.XAI_MODEL || defaultApiModel;
}

export function aiConnectionLabel(connection) {
  return normalizeAiConnection(connection) === aiConnectionModes.grokCli
    ? 'Grok CLI login'
    : 'XAI_API_KEY';
}

export function hasApiKeyConnection() {
  return Boolean(process.env.XAI_API_KEY);
}

export function assistantConnectionStatus({ cliDefaultModel = '', connection, model } = {}) {
  const normalizedConnection = normalizeAiConnection(connection);
  const resolvedModel = normalizeAiModel(model, normalizedConnection);
  if (normalizedConnection === aiConnectionModes.grokCli) {
    return `Grok CLI · ${resolvedModel || cliDefaultModel || 'default'}`;
  }
  if (hasApiKeyConnection()) {
    return `Ready · ${resolvedModel}`;
  }
  return 'Run /connect to use Grok.';
}

export async function listKnownGrokModels({ connection, selectedModel } = {}) {
  const normalizedConnection = normalizeAiConnection(connection);
  const known = new Map();
  const add = (id, name = '', description = '') => {
    const model = String(id ?? '').trim();
    if (!model || known.has(model)) return;
    known.set(model, {
      description: String(description ?? ''),
      id: model,
      name: String(name ?? '') || model,
    });
  };

  if (normalizedConnection === aiConnectionModes.grokCli) {
    const cached = await readGrokModelCache();
    for (const model of cached) {
      add(model.id, model.name, model.description);
    }
    if (!known.size) {
      add('grok-build', 'Grok Build', 'Grok CLI default');
    }
  }
  // Always expose grok-4.3 (API-only model) so users can select it in any mode
  add(selectedModel);
  add(defaultApiModel, 'Grok 4.3', 'xAI Responses API (requires XAI_API_KEY)');

  return [...known.values()];
}

export async function refreshGrokCliModels() {
  const { stdout } = await runGrokCli(['models'], { timeoutMs: 30000 });
  const parsed = parseGrokModelsOutput(stdout);
  const cached = await readGrokModelCache();
  const cachedById = new Map(cached.map((model) => [model.id, model]));
  const ids = parsed.models.length ? parsed.models : cached.map((model) => model.id);
  const models = ids
    .map((id) => {
      const cachedModel = cachedById.get(id);
      return {
        description: cachedModel?.description ?? '',
        id,
        name: cachedModel?.name ?? id,
      };
    })
    .filter((model, index, list) => list.findIndex((item) => item.id === model.id) === index);

  return {
    defaultModel: parsed.defaultModel || findDefaultCliModel(models),
    models,
    raw: stdout,
  };
}

export async function isKnownGrokCliModel(model) {
  const id = String(model ?? '').trim();
  if (!id) return true;

  const cached = await readGrokModelCache();
  if (!cached.length) return id === 'grok-build';
  return cached.some((item) => item.id === id);
}

export async function repairAiModelForConnection({ connection, model } = {}) {
  const normalizedConnection = normalizeAiConnection(connection);
  const selectedModel = String(model ?? '').trim();
  if (normalizedConnection !== aiConnectionModes.grokCli || !selectedModel) {
    return { changed: false, model: selectedModel };
  }

  if (await isKnownGrokCliModel(selectedModel)) {
    return { changed: false, model: selectedModel };
  }

  return { changed: true, model: '' };
}

export async function loadWritingStyleSamples(projectRoot) {
  const postsDir = path.join(projectRoot, 'src/content/posts');
  let files = [];

  try {
    files = (await readdir(postsDir))
      .filter((file) => /\.(md|mdx)$/i.test(file))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return '';
  }

  const samples = [];
  let totalCharacters = 0;

  for (const file of files) {
    if (totalCharacters >= maxStyleSampleCharacters) break;

    const filePath = path.join(postsDir, file);
    const rawContent = await readFile(filePath, 'utf8');
    const { body, frontmatter } = splitMarkdownFrontmatter(rawContent);
    const content = [`File: ${file}`, frontmatter ? `Frontmatter:\n${frontmatter}` : '', body.trim()]
      .filter(Boolean)
      .join('\n\n');
    const remaining = maxStyleSampleCharacters - totalCharacters;
    const sample = content.slice(0, remaining);
    samples.push(sample);
    totalCharacters += sample.length;
  }

  return samples.join('\n\n---\n\n');
}

export async function requestWritingAssistance({
  actionId,
  connection = aiConnectionModes.apiKey,
  draftContent,
  model,
  prompt,
  projectRoot,
}) {
  const action = getWritingAssistantAction(actionId);
  const { body, frontmatter } = splitMarkdownFrontmatter(draftContent);
  const styleSamples = await loadWritingStyleSamples(projectRoot);
  const request = {
    action,
    body,
    frontmatter,
    prompt,
    styleSamples,
  };
  const normalizedConnection = normalizeAiConnection(connection);
  const resolvedModel = normalizeAiModel(model, normalizedConnection);
  const parsed =
    normalizedConnection === aiConnectionModes.grokCli
      ? await requestViaGrokCli({ model: resolvedModel, projectRoot, request })
      : await requestViaXaiApi({ model: resolvedModel, request });

  const replacementBody =
    canReplaceWithAction(action.id) && typeof parsed.replacementBody === 'string'
      ? parsed.replacementBody.trim()
      : null;

  return {
    actionId: action.id,
    descriptionSuggestion:
      typeof parsed.descriptionSuggestion === 'string'
        ? parsed.descriptionSuggestion.trim()
        : '',
    notes: Array.isArray(parsed.notes) ? parsed.notes.filter(Boolean).map(String) : [],
    raw: parsed.raw ?? null,
    reply: String(parsed.reply ?? '').trim(),
    replacementBody,
    titleSuggestions: Array.isArray(parsed.titleSuggestions)
      ? parsed.titleSuggestions.filter(Boolean).map(String)
      : [],
  };
}

async function requestViaXaiApi({ model, request }) {
  const apiKey = process.env.XAI_API_KEY;
  if (!apiKey) {
    throw new Error('Missing XAI_API_KEY. Run /connect or set it in your shell before using Grok.');
  }

  const response = await fetch(xaiResponsesUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      input: [
        {
          role: 'system',
          content: buildSystemPrompt(),
        },
        {
          role: 'user',
          content: buildUserPrompt(request),
        },
      ],
      model,
      text: {
        format: {
          type: 'json_schema',
          name: 'writing_assistant_response',
          schema: responseSchema,
          strict: true,
        },
      },
      store: false,
    }),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(formatXaiError(response.status, text));
  }

  const payload = parseJson(text, 'xAI response');
  return {
    ...parseStructuredOutput(payload),
    raw: payload,
  };
}

async function requestViaGrokCli({ model, projectRoot, request }) {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'myblog-grok-'));
  const promptPath = path.join(tempDir, 'prompt.txt');

  try {
    await writeFile(promptPath, buildCliPrompt(request), 'utf8');
    const args = [
      '--prompt-file',
      promptPath,
      '--output-format',
      'json',
      '--cwd',
      projectRoot,
      '--no-memory',
      '--disable-web-search',
      '--max-turns',
      '1',
      '--permission-mode',
      'dontAsk',
      '--tools',
      '',
    ];
    if (model) args.push('--model', model);

    const { stdout } = await runGrokCli(args, { timeoutMs: grokCliTimeoutMs });
    const payload = parseJson(stdout, 'Grok CLI response');
    const text = String(payload?.text ?? '').trim();
    if (!text) {
      throw new Error('Grok CLI response did not include text.');
    }
    return {
      ...extractJsonFromText(text, 'Grok CLI structured output'),
      raw: payload,
    };
  } catch (error) {
    throw new Error(formatGrokCliError(error));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
}

export function runGrokLogin({ deviceAuth = false } = {}) {
  const args = ['login', deviceAuth ? '--device-auth' : '--oauth'];
  return spawn('grok', args, { stdio: 'inherit' });
}

function runGrokCli(args, { timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn('grok', args, {
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('Grok CLI request timed out.'));
    }, timeoutMs);

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve({ stderr, stdout });
      } else {
        reject(new Error(sanitizeCliOutput(stderr) || `Grok CLI exited with code ${code}.`));
      }
    });
  });
}

async function readGrokModelCache() {
  try {
    const cache = parseJson(await readFile(modelCachePath, 'utf8'), 'Grok model cache');
    return Object.entries(cache?.models ?? {}).map(([id, value]) => ({
      description: value?.info?.description ?? '',
      id,
      name: value?.info?.name ?? id,
    }));
  } catch {
    return [];
  }
}

function parseGrokModelsOutput(value) {
  const models = [];
  let defaultModel = '';

  for (const line of String(value ?? '').split(/\r?\n/)) {
    const defaultMatch = line.match(/^\s*Default model:\s*(\S+)/i);
    if (defaultMatch) {
      defaultModel = defaultMatch[1];
      continue;
    }

    const modelMatch = line.match(/^\s*[-*]\s+([^\s(]+)/);
    if (modelMatch) {
      models.push(modelMatch[1]);
    }
  }

  return {
    defaultModel,
    models: [...new Set(models)],
  };
}

function findDefaultCliModel(models) {
  if (models.some((model) => model.id === 'grok-build')) return 'grok-build';
  return models[0]?.id ?? '';
}

function buildCliPrompt(request) {
  return [
    buildSystemPrompt(),
    '',
    buildUserPrompt(request),
    '',
    '只输出 JSON，不要输出 Markdown 代码围栏，不要输出解释文字。',
    `JSON schema: ${JSON.stringify(responseSchema)}`,
  ].join('\n');
}

function extractJsonFromText(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return parseJson(text, label);

  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return parseJson(fenced[1], label);

    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return parseJson(text.slice(start, end + 1), label);
    }
    throw new Error(`Could not parse ${label}.`);
  }
}

function formatGrokCliError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('ENOENT')) {
    return 'Grok CLI was not found. Install it or use /connect with XAI_API_KEY.';
  }
  if (/unknown model id|couldn'?t set model|run 'grok models'/i.test(message)) {
    return '当前模型不是 Grok CLI 可用模型，已切回 CLI 默认模型，请重试。';
  }
  if (/auth|login|credential|unauthorized|forbidden|401|403/i.test(message)) {
    return 'Grok CLI is not connected. Run /connect and choose Grok browser login.';
  }
  return message;
}

export function splitMarkdownFrontmatter(content) {
  const value = String(content ?? '');
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { body: value, frontmatter: '', opening: '' };

  return {
    body: value.slice(match[0].length),
    frontmatter: match[1],
    opening: match[0],
  };
}

export function replaceMarkdownBody(content, nextBody) {
  const { opening } = splitMarkdownFrontmatter(content);
  const normalizedBody = `${String(nextBody ?? '').trim()}\n`;
  return opening ? `${opening}${normalizedBody}` : normalizedBody;
}

export async function backupAndReplaceMarkdownBody(filePath, expectedContent, nextBody) {
  const currentContent = await readFile(filePath, 'utf8');
  if (currentContent !== expectedContent) {
    throw new Error('Draft changed on disk. Reload the draft before applying the AI result.');
  }

  const backupPath = backupFilePath(filePath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);

  const nextContent = replaceMarkdownBody(currentContent, nextBody);
  await writeFile(filePath, nextContent, 'utf8');

  return {
    backupPath,
    content: nextContent,
  };
}

function buildSystemPrompt() {
  return [
    '你是 Dan Ding 个人博客 TUI 内置的中文写作助手。',
    '你的任务是帮助作者把草稿写得更清楚、更克制、更有个人观察。',
    '保持中文表达自然、清晰、不过度营销，不要把文章改成夸张的公众号语气。',
    '尊重原意，不编造事实，不添加作者没有提供的具体经历。',
    'Markdown 输出要干净，可以使用标题、列表、引用和代码块。',
    '如果需要替换正文，只返回 frontmatter 之后的 Markdown 正文，不要包含 YAML frontmatter。',
  ].join('\n');
}

function buildUserPrompt({ action, body, frontmatter, prompt, styleSamples }) {
  const instructions = {
    ask: '回答作者关于这篇草稿的问题，重点给可执行的写作建议。',
    polish: '润色并重写草稿正文。保留原意和主要结构，可改善节奏、逻辑和表达。',
    continue: '在现有草稿基础上续写。返回包含原文和续写内容的完整正文。',
    outline: '基于草稿生成结构提纲、缺口和下一步写作建议。',
    metadata: '给出标题建议和一条适合博客 frontmatter 的 description。',
  };

  return [
    `当前动作：${action.label}`,
    `动作说明：${instructions[action.id] ?? instructions.ask}`,
    prompt ? `作者输入：${prompt}` : '作者输入：（无）',
    '',
    '当前草稿 frontmatter：',
    frontmatter || '（无）',
    '',
    '当前草稿正文：',
    body.trim() || '（空草稿）',
    '',
    '已发布文章风格样本：',
    styleSamples || '（暂无样本）',
    '',
    '请严格返回符合 JSON schema 的结果。',
    action.replaceable
      ? '如果你认为可以写回，replacementBody 必须是完整正文。'
      : '该动作不允许写回，replacementBody 必须为 null。',
  ].join('\n');
}

function parseStructuredOutput(payload) {
  if (typeof payload?.output_text === 'string') {
    return parseJson(payload.output_text, 'structured output');
  }

  const textBlocks = [];
  for (const outputItem of payload?.output ?? []) {
    for (const contentItem of outputItem?.content ?? []) {
      if (typeof contentItem?.text === 'string') {
        textBlocks.push(contentItem.text);
      }
    }
  }

  if (textBlocks.length) {
    return parseJson(textBlocks.join('\n'), 'structured output');
  }

  throw new Error('xAI response did not include structured text output.');
}

function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`Could not parse ${label}.`);
  }
}

function formatXaiError(status, text) {
  const fallback = `xAI request failed with status ${status}.`;
  if (!text) return fallback;

  try {
    const payload = JSON.parse(text);
    const message = payload?.error?.message || payload?.message;
    return message ? `${fallback} ${message}` : fallback;
  } catch {
    return `${fallback} ${text.slice(0, 240)}`;
  }
}

function sanitizeCliOutput(value) {
  return String(value ?? '')
    .replace(/xai-[A-Za-z0-9._-]+/g, 'xai-...')
    .replace(/Bearer\s+[A-Za-z0-9._-]+/gi, 'Bearer ...')
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-6)
    .join('\n')
    .slice(0, 600);
}

function backupFilePath(filePath) {
  const parsed = path.parse(filePath);
  return path.join(parsed.dir, `${parsed.name}.agent-backup-${formatLocalTimestamp(new Date())}${parsed.ext}`);
}

function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: process.env.BLOG_TIMEZONE || 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}
