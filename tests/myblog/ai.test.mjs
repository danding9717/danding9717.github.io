// AI 助手的测试：用本机起的假服务和假的 grok 命令，不连真正的 AI。
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { aiConfig, buildMessages, parseTitles, streamReply } from '../../scripts/myblog/ai.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'myblog-ai-'));
after(() => rm(temp, { recursive: true, force: true }));

async function collect(stream) {
  const parts = [];
  for await (const part of stream) parts.push(part);
  return parts;
}

/** 起一个假的 OpenAI 兼容服务，handler(request, body, response)。 */
async function fakeServer(handler) {
  const server = http.createServer(async (request, response) => {
    let body = '';
    for await (const chunk of request) body += chunk;
    handler(request, JSON.parse(body || '{}'), response);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  after(() => server.close());
  return `http://127.0.0.1:${server.address().port}/v1/`;
}

async function fakeGrok(name, script) {
  const directory = path.join(temp, name);
  await rm(directory, { recursive: true, force: true });
  await mkdir(directory);
  const file = path.join(directory, 'grok');
  await writeFile(file, `#!/bin/sh\n${script}\n`);
  await chmod(file, 0o755);
  return directory;
}

test('按顺序找能用的 AI', async () => {
  assert.equal(aiConfig({ XAI_API_KEY: 'x', OPENAI_API_KEY: 'o' }).baseUrl, 'https://api.x.ai/v1');
  assert.deepEqual(aiConfig({ OPENAI_API_KEY: 'o', OPENAI_MODEL: 'm' }), {
    baseUrl: 'https://api.openai.com/v1',
    key: 'o',
    model: 'm',
    label: 'm',
  });
  assert.equal(aiConfig({ MYBLOG_AI_BASE_URL: 'u', MYBLOG_AI_KEY: 'k' }), null);
  assert.equal(aiConfig({ MYBLOG_AI_BASE_URL: 'u', MYBLOG_AI_KEY: 'k', MYBLOG_AI_MODEL: 'm' }).baseUrl, 'u');
  assert.equal(aiConfig({ PATH: '' }), null);

  const directory = await fakeGrok('found', 'exit 0');
  assert.deepEqual(aiConfig({ PATH: `/nonexistent:${directory}` }), {
    cli: path.join(directory, 'grok'),
    model: '',
    label: 'grok 命令行',
  });
  assert.equal(aiConfig({ XAI_API_KEY: 'x', PATH: directory }).baseUrl, 'https://api.x.ai/v1');
});

test('润色时带上光标所在的段落，审稿时只带全文', () => {
  const polish = buildMessages('polish', { article: '全文', paragraph: '这一段' });
  assert.equal(polish[0].role, 'system');
  assert.match(polish[1].content, /<文章>\n全文\n<\/文章>/);
  assert.match(polish[1].content, /<这一段>\n这一段\n<\/这一段>/);
  assert.match(polish[1].content, /润色上面标出的这一段/);

  const review = buildMessages('review', { article: '全文', paragraph: '这一段' });
  assert.doesNotMatch(review[1].content, /这一段>/);

  const ask = buildMessages('ask', { article: '全文', paragraph: '这一段', request: '改短一点' });
  assert.match(ask[1].content, /他的要求：改短一点/);

  const long = buildMessages('review', { article: 'a'.repeat(20000) });
  assert.match(long[1].content, /中间省略 4000 字/);
});

test('从回答里取出标题', () => {
  assert.deepEqual(parseTitles('好的：\n1. 标题一\n2、「标题二」\n3) "标题三"\n4）《标题四》\n5. 标题五\n6. 多余的'), [
    '标题一',
    '标题二',
    '标题三',
    '标题四',
    '标题五',
  ]);
});

test('流式读取回答，数据被拆开也能拼上', async () => {
  const requests = [];
  const baseUrl = await fakeServer((request, body, response) => {
    requests.push({ url: request.url, auth: request.headers.authorization, body });
    response.writeHead(200, { 'Content-Type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"你"}}]}\n\ndata: {"choices":[{"delta":{"con');
    setTimeout(() => response.end('tent":"好"}}]}\n\n: 注释\n\ndata: [DONE]\n\n'), 20);
  });
  const messages = [{ role: 'user', content: 'hi' }];
  const parts = await collect(streamReply({ baseUrl, key: 'k', model: 'm' }, messages));
  assert.deepEqual(parts, [{ thinking: true }, { text: '你' }, { text: '好' }]);
  assert.deepEqual(requests, [{ url: '/v1/chat/completions', auth: 'Bearer k', body: { model: 'm', messages, stream: true } }]);
});

test('key 不对时说清楚', async () => {
  const baseUrl = await fakeServer((_request, _body, response) => {
    response.writeHead(401, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
  });
  await assert.rejects(
    collect(streamReply({ baseUrl, key: 'bad', model: 'm' }, [])),
    { message: 'API key 不对或没有权限（401）：Incorrect API key provided' },
  );
});

test('连不上时说清楚', async () => {
  await assert.rejects(collect(streamReply({ baseUrl: 'http://127.0.0.1:9/v1', key: 'k', model: 'm' }, [])), /连不上 AI 服务（127\.0\.0\.1:9）/);
});

test('没有 key 时用 grok 命令行', async () => {
  const promptCopy = path.join(temp, 'prompt.txt');
  const directory = await fakeGrok('works', `cp "$2" "${promptCopy}"\nprintf '{"text":"  CLI 的回答  "}'`);
  const config = aiConfig({ PATH: directory });
  const parts = await collect(streamReply(config, buildMessages('review', { article: '这是全文' })));
  assert.deepEqual(parts, [{ text: 'CLI 的回答' }]);
  assert.match(await readFile(promptCopy, 'utf8'), /这是全文/);
});

test('grok 命令行没登录时提示怎么登录，能中途停止', async () => {
  const loggedOut = aiConfig({ PATH: await fakeGrok('logged-out', 'echo "Error: not logged in, run grok login" >&2\nexit 1') });
  await assert.rejects(collect(streamReply(loggedOut, [])), /grok 命令行还没登录/);

  const slow = aiConfig({ PATH: await fakeGrok('slow', 'exec sleep 5') });
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  await assert.rejects(collect(streamReply(slow, [], controller.signal)));
  assert.ok(Date.now() - started < 3000);
});
