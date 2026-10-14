// AI 写作助手：走 OpenAI 兼容的聊天接口（xAI、OpenAI，或者自己填的服务），流式返回文字；
// 没有 API key 时，用本机登录过的 grok 命令行。
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/**
 * 从环境变量（或博客目录下的 .env）里找 API key，按顺序用第一个找到的：
 * XAI_API_KEY → OPENAI_API_KEY → 自己填的 MYBLOG_AI_BASE_URL + MYBLOG_AI_KEY + MYBLOG_AI_MODEL
 * → PATH 里的 grok 命令行（要先运行过 grok login）。
 * label 是界面上显示的名字。
 */
export function aiConfig(env = process.env) {
  if (env.XAI_API_KEY) {
    return api('https://api.x.ai/v1', env.XAI_API_KEY, env.XAI_MODEL || 'grok-4.3');
  }
  if (env.OPENAI_API_KEY) {
    return api('https://api.openai.com/v1', env.OPENAI_API_KEY, env.OPENAI_MODEL || 'gpt-5.5');
  }
  if (env.MYBLOG_AI_BASE_URL && env.MYBLOG_AI_KEY && env.MYBLOG_AI_MODEL) {
    return api(env.MYBLOG_AI_BASE_URL, env.MYBLOG_AI_KEY, env.MYBLOG_AI_MODEL);
  }
  const grok = findCommand('grok', env.PATH);
  if (grok) return { cli: grok, model: env.GROK_MODEL || '', label: env.GROK_MODEL || 'grok 命令行' };
  return null;
}

function api(baseUrl, key, model) {
  return { baseUrl, key, model, label: model };
}

function findCommand(name, searchPath = '') {
  for (const directory of searchPath.split(path.delimiter).filter(Boolean)) {
    const file = path.join(directory, name);
    try {
      accessSync(file, constants.X_OK);
      return file;
    } catch {
      // 下一个目录。
    }
  }
  return null;
}

export const NO_KEY_MESSAGE =
  '没找到能用的 AI：在博客目录的 .env 里写一行 XAI_API_KEY=… 或 OPENAI_API_KEY=…（或者装好 grok 命令行并运行 grok login），重开 myblog。';

/** 三个常用动作；也可以直接打字提要求（ask）。 */
export const AI_ACTIONS = [
  { id: 'polish', key: '1', label: '润色这一段' },
  { id: 'titles', key: '2', label: '想标题' },
  { id: 'review', key: '3', label: '审稿' },
];

const SYSTEM_PROMPT = [
  '你是 Dan Hu 的写作助手，帮他改他自己的博客文章。',
  '这个博客写 AI、财富、生意、读书、产品。每篇只讲一个观点，标题就是这个观点。',
  '他的风格：中文，简洁有力，多用短句，观点鲜明，从第一性原理出发；不要鸡汤，不要口号，不要 AI 腔。',
  '不要编造他没写过的经历、数据和引文。直接给结果，不寒暄，不解释你做了什么，除非他问。',
].join('\n');

const TASKS = {
  polish:
    '润色上面标出的这一段。保留原意和他的语气，只改表达：删掉废话，理顺句子，换掉空泛的词。只输出改好的这一段，不加引号、标题和说明。',
  titles:
    '给这篇文章想 5 个标题。每个标题都直接说出文章的观点，读标题就知道在说什么；不超过 20 个字；不用问号，不做标题党。只输出 5 行，格式是「1. 标题」。',
  review: [
    '像一个严格的编辑那样审这篇文章，逐条说问题，每条一两句话，具体到原文的句子：',
    '1. 这篇是不是只讲了一个观点？用一句话说出这个观点。',
    '2. 标题有没有说出这个观点？',
    '3. 哪里论证薄弱，哪些句子可以删？',
    '不要重写全文。',
  ].join('\n'),
};

/** 拼出发给模型的消息。article 是整篇草稿，paragraph 是光标所在的段落（可以没有）。 */
export function buildMessages(action, { article, paragraph = '', request = '' }) {
  const parts = [`整篇文章：\n<文章>\n${clipMiddle(article, 16000)}\n</文章>`];
  if (paragraph && (action === 'polish' || action === 'ask')) {
    parts.push(`光标所在的这一段：\n<这一段>\n${paragraph}\n</这一段>`);
  }
  parts.push(action === 'ask' ? `他的要求：${request}\n如果是要改写文字，只输出改好的文字。` : TASKS[action]);
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: parts.join('\n\n') },
  ];
}

/** 流式请求，逐段产出 { text }；模型还在思考时产出 { thinking: true }。 */
export async function* streamReply(config, messages, signal) {
  if (config.cli) {
    yield { text: await grokCliReply(config, messages, signal) };
    return;
  }
  let response;
  try {
    response = await fetch(`${config.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: config.model, messages, stream: true }),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error(`连不上 AI 服务（${new URL(config.baseUrl).host}）：${error.cause?.code ?? error.message}`);
  }
  if (!response.ok) throw new Error(await describeFailure(response));

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) {
      const data = line.match(/^data:\s*(.*)$/)?.[1]?.trim();
      if (!data || data === '[DONE]') continue;
      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        continue;
      }
      if (payload.error) throw new Error(`AI 返回了错误：${payload.error.message ?? JSON.stringify(payload.error)}`);
      const delta = payload.choices?.[0]?.delta ?? {};
      if (delta.content) yield { text: delta.content };
      else if (delta.reasoning_content || delta.reasoning) yield { thinking: true };
    }
  }
}

/** grok 命令行不能流式输出，等它写完一次性返回。 */
async function grokCliReply(config, messages, signal) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'myblog-grok-'));
  const promptFile = path.join(directory, 'prompt.txt');
  await writeFile(promptFile, messages.map((message) => message.content).join('\n\n'), 'utf8');
  const args = ['--prompt-file', promptFile, '--output-format', 'json', '--cwd', directory, '--no-memory'];
  args.push('--disable-web-search', '--max-turns', '1', '--permission-mode', 'dontAsk', '--tools', '');
  if (config.model) args.push('--model', config.model);

  try {
    const { code, stdout, stderr } = await runCommand(config.cli, args, signal, 180_000);
    if (code !== 0) {
      const detail = stderr.trim().split('\n').slice(-3).join(' ');
      if (/auth|login|credential|unauthorized|forbidden|401|403/i.test(detail)) {
        throw new Error('grok 命令行还没登录：在终端运行 grok login，登录后再试。');
      }
      throw new Error(`grok 命令行出错了：${detail || `退出码 ${code}`}`);
    }
    let payload;
    try {
      payload = JSON.parse(stdout);
    } catch {
      throw new Error('grok 命令行返回的内容看不懂，更新一下 grok 再试。');
    }
    return String(payload?.text ?? '').trim();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function runCommand(command, args, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { env: { ...process.env, NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const stop = (error) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      child.kill('SIGTERM');
      reject(error);
    };
    const abort = () => stop(signal.reason ?? new Error('已停止'));
    const timer = setTimeout(() => stop(new Error('grok 命令行 3 分钟还没写完，再试一次。')), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', (error) => stop(new Error(`运行 grok 命令行失败：${error.message}`)));
    child.on('close', (code) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      resolve({ code, stdout, stderr });
    });
  });
}

async function describeFailure(response) {
  const body = await response.text().catch(() => '');
  let detail = body;
  try {
    const payload = JSON.parse(body);
    detail = payload.error?.message ?? payload.message ?? payload.error ?? body;
  } catch {
    // 不是 JSON，原样显示。
  }
  const reason = response.status === 401 || response.status === 403 ? 'API key 不对或没有权限' : 'AI 请求失败';
  return `${reason}（${response.status}）：${String(detail).slice(0, 300)}`;
}

/** 从「1. 标题」这样的回答里取出标题。 */
export function parseTitles(text) {
  return text
    .split('\n')
    .map((line) => line.match(/^\s*\d+\s*[.、)）]\s*(.+?)\s*$/)?.[1])
    .filter(Boolean)
    .map((title) => title.replace(/^["“《「]|["”》」]$/g, '').trim())
    .slice(0, 5);
}

function clipMiddle(text, limit) {
  if (text.length <= limit) return text;
  const half = Math.floor(limit / 2);
  return `${text.slice(0, half)}\n\n……（中间省略 ${text.length - limit} 字）……\n\n${text.slice(-half)}`;
}
