import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectProviderStream,
  ProviderAbortError,
  providerEventTypes,
  throwIfAborted,
} from './streaming.mjs';

const modelCachePath = path.join(os.homedir(), '.grok/models_cache.json');
const grokCliTimeoutMs = 180000;

export class GrokCliProvider {
  async generate(request) {
    return collectProviderStream(this.stream(request));
  }

  async *stream({ context, model, signal, systemPrompt, userPrompt }) {
    throwIfAborted(signal);
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'myblog-grok-'));
    const promptPath = path.join(tempDir, 'prompt.txt');

    try {
      yield { type: providerEventTypes.start };
      yield {
        displayText: 'Grok CLI is generating. CLI mode returns final text after the command exits.',
        text: '',
        type: providerEventTypes.delta,
      };

      await writeFile(
        promptPath,
        [
          systemPrompt,
          '',
          userPrompt,
          '',
          '只输出 JSON，不要输出 Markdown 代码围栏，不要输出解释文字。',
        ].join('\n'),
        'utf8',
      );

      const args = [
        '--prompt-file',
        promptPath,
        '--output-format',
        'json',
        '--cwd',
        context?.projectRoot ?? process.cwd(),
        '--no-memory',
        '--disable-web-search',
        '--max-turns',
        '1',
        '--permission-mode',
        'dontAsk',
        '--tools',
        '',
      ];
      const selectedModel = String(model ?? '').trim();
      if (selectedModel) args.push('--model', selectedModel);

      const { stdout } = await runGrokCli(args, { signal, timeoutMs: grokCliTimeoutMs });
      const payload = parseJson(stdout, 'Grok CLI response');
      const text = String(payload?.text ?? '').trim();
      if (!text) throw new Error('Grok CLI response did not include text.');

      yield {
        raw: payload,
        text,
        type: providerEventTypes.done,
      };
    } catch (error) {
      throw new Error(formatGrokCliError(error));
    } finally {
      await rm(tempDir, { force: true, recursive: true });
    }
  }
}

export function runGrokLogin({ deviceAuth = false } = {}) {
  const args = ['login', deviceAuth ? '--device-auth' : '--oauth'];
  return spawn('grok', args, { stdio: 'inherit' });
}

export async function refreshGrokCliModels() {
    const { stdout } = await runGrokCli(['models'], { timeoutMs: 30000 });
  const parsed = parseGrokModelsOutput(stdout);
  const cached = await readGrokModelCache();
  const cachedById = new Map(cached.map((model) => [model.id, model]));
  const ids = parsed.models.length ? parsed.models : cached.map((model) => model.id);
  const models = ids
    .filter((id) => id !== 'grok-4.3')
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

export async function listGrokCliModels() {
  return readGrokModelCache();
}

export async function isKnownGrokCliModel(model) {
  const id = String(model ?? '').trim();
  if (!id) return true;

  const cached = await readGrokModelCache();
  if (!cached.length) return id === 'grok-build';
  return cached.some((item) => item.id === id);
}

function runGrokCli(args, { signal, timeoutMs }) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ProviderAbortError());
      return;
    }

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
    const abort = () => {
      clearTimeout(timer);
      child.kill('SIGTERM');
      reject(new ProviderAbortError());
    };
    signal?.addEventListener('abort', abort, { once: true });

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
      signal?.removeEventListener('abort', abort);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
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

function formatGrokCliError(error) {
  const message = String(error?.message ?? error);
  if (message.includes('ENOENT')) {
    return 'Grok CLI was not found. Install it or choose Mock/OpenAI/XAI.';
  }
  if (/unknown model id|couldn'?t set model|run 'grok models'/i.test(message)) {
    return '当前模型不是 Grok CLI 可用模型，已切回 CLI 默认模型，请重试。';
  }
  if (/auth|login|credential|unauthorized|forbidden|401|403/i.test(message)) {
    return 'Grok CLI is not connected. Run /connect and choose Grok browser login.';
  }
  return message;
}

function sanitizeCliOutput(value) {
  return String(value ?? '')
    .replace(/(authorization|bearer|token|api[_-]?key)\s*[:=]\s*\S+/gi, '$1: [redacted]')
    .trim();
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error?.message ?? error}`);
  }
}
