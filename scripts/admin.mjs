#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import readline from 'node:readline';
import {
  BlogError,
  compactDateForToday,
  createDraft,
  formatNoteRows,
  listNotes,
  previewUrl,
  projectRoot,
  publishDraft,
} from './blog-core.mjs';

const menuItems = ['今日草稿', '文章列表', '本地预览', '发布草稿', '退出'];
const maxLogLines = 12;
let selectedIndex = 0;
let publishIndex = 0;
let mode = 'menu';
let rows = [];
let logs = ['Blog Admin 已启动。'];
let busy = false;
let previewProcess = null;
let previewStartedHere = false;
let statusLine = `项目：${projectRoot}`;

if (process.argv.includes('--check')) {
  rows = await listNotes();
  console.log(`Blog Admin OK\n项目：${projectRoot}\n\n${formatNoteRows(rows)}`);
  process.exit(0);
}

await refreshRows();
setupTerminal();
render();

readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', async (_input, key = {}) => {
  if (key.ctrl && key.name === 'c') {
    await exitAdmin();
    return;
  }

  if (busy) return;

  if (key.name === 'q') {
    await exitAdmin();
    return;
  }

  if (key.name === 'r') {
    await refreshRows();
    log('已刷新。');
    render();
    return;
  }

  if (mode === 'publish') {
    await handlePublishKeys(key);
    return;
  }

  if (key.name === 'up' || key.name === 'k') {
    selectedIndex = Math.max(0, selectedIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    selectedIndex = Math.min(menuItems.length - 1, selectedIndex + 1);
    render();
    return;
  }

  if (key.name === 'return') {
    await runMenuAction(selectedIndex);
  }
});

async function handlePublishKeys(key) {
  const draftRows = rows.filter((row) => row.status === 'draft');

  if (key.name === 'escape') {
    mode = 'menu';
    render();
    return;
  }

  if (key.name === 'up' || key.name === 'k') {
    publishIndex = Math.max(0, publishIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    publishIndex = Math.min(draftRows.length - 1, publishIndex + 1);
    render();
    return;
  }

  if (key.name === 'return' && draftRows[publishIndex]) {
    await publishSelectedDraft(draftRows[publishIndex]);
  }
}

async function runMenuAction(index) {
  const label = menuItems[index];

  if (label === '今日草稿') {
    await runTask(async () => {
      const result = await createDraft(compactDateForToday(), {
        editor: 'Typora',
        open: true,
      });
      logMany(result.messages);
      await refreshRows();
    });
    return;
  }

  if (label === '文章列表') {
    await refreshRows();
    mode = 'list';
    log('文章列表已更新。');
    render();
    return;
  }

  if (label === '本地预览') {
    await runTask(startPreview);
    return;
  }

  if (label === '发布草稿') {
    await refreshRows();
    const draftRows = rows.filter((row) => row.status === 'draft');

    if (!draftRows.length) {
      log('没有可发布的草稿。');
      render();
      return;
    }

    if (draftRows.length === 1) {
      await publishSelectedDraft(draftRows[0]);
      return;
    }

    mode = 'publish';
    publishIndex = 0;
    log('选择一篇草稿发布，Esc 返回。');
    render();
    return;
  }

  await exitAdmin();
}

async function publishSelectedDraft(row) {
  await runTask(async () => {
    log(`开始发布：${row.title}`);
    const result = await publishDraft(row.compact, { stdio: 'pipe' });
    logMany(result.messages);
    if (result.buildOutput) {
      log(buildSummary(result.buildOutput));
    }
    await refreshRows();
    mode = 'list';
  });
}

async function startPreview() {
  if (await isPreviewReachable()) {
    log(`预览已在运行：${previewUrl}`);
    openUrl(previewUrl);
    return;
  }

  log('正在启动本地预览服务...');
  previewProcess = spawn(
    'npm',
    ['run', 'dev', '--', '--host', '127.0.0.1', '--port', '4321'],
    {
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  previewStartedHere = true;

  previewProcess.stdout.on('data', (chunk) => {
    for (const line of stripAnsi(String(chunk)).split(/\r?\n/).filter(Boolean)) {
      log(line);
    }
    render();
  });

  previewProcess.stderr.on('data', (chunk) => {
    for (const line of stripAnsi(String(chunk)).split(/\r?\n/).filter(Boolean)) {
      log(line);
    }
    render();
  });

  previewProcess.on('exit', (code) => {
    if (code !== null && code !== 0) {
      log(`预览服务已退出：${code}`);
    }
    previewProcess = null;
    render();
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isPreviewReachable()) {
      log(`预览已启动：${previewUrl}`);
      openUrl(previewUrl);
      return;
    }
    await sleep(500);
  }

  throw new BlogError('预览服务启动超时，请查看日志。');
}

function openUrl(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function isPreviewReachable() {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host: '127.0.0.1', port: 4321 });
    const finish = (value) => {
      socket.destroy();
      resolve(value);
    };

    socket.setTimeout(700);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function refreshRows() {
  rows = await listNotes();
  statusLine = `项目：${projectRoot}  文章：${rows.filter((row) => row.status === 'post').length}  草稿：${rows.filter((row) => row.status === 'draft').length}`;
}

async function runTask(task) {
  busy = true;
  render();

  try {
    await task();
  } catch (error) {
    if (error instanceof BlogError) {
      log(error.message);
      if (error.details) log(buildSummary(error.details));
    } else {
      log(String(error?.message ?? error));
    }
  } finally {
    busy = false;
    render();
  }
}

function setupTerminal() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('请在交互式终端中运行 blog-admin。');
    process.exit(1);
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdout.write('\x1b[?25l');
}

function render() {
  const width = process.stdout.columns || 100;
  const height = process.stdout.rows || 32;
  const leftWidth = Math.min(28, Math.max(22, Math.floor(width * 0.28)));
  const rightWidth = Math.max(40, width - leftWidth - 5);
  const left = renderMenu(leftWidth);
  const right = renderPanel(rightWidth, height - 5);
  const lines = [];

  lines.push('Blog Admin'.padEnd(width, ' '));
  lines.push(statusLine.slice(0, width));
  lines.push('─'.repeat(width));

  const maxRows = Math.max(left.length, right.length, height - 5);
  for (let index = 0; index < maxRows; index += 1) {
    lines.push(
      `${(left[index] ?? '').padEnd(leftWidth, ' ')} │ ${(right[index] ?? '').slice(
        0,
        rightWidth,
      )}`,
    );
  }

  lines.push('─'.repeat(width));
  lines.push(
    `${busy ? '处理中...' : 'Enter 执行  ↑/↓ 或 j/k 移动  r 刷新  q 退出'}`.slice(0, width),
  );

  process.stdout.write(`\x1b[2J\x1b[H${lines.slice(0, height).join('\n')}`);
}

function renderMenu(width) {
  const lines = [];

  for (const [index, label] of menuItems.entries()) {
    const prefix = mode !== 'publish' && index === selectedIndex ? '› ' : '  ';
    lines.push(`${prefix}${label}`.slice(0, width));
  }

  return lines;
}

function renderPanel(width, availableRows) {
  if (mode === 'publish') {
    const draftRows = rows.filter((row) => row.status === 'draft');
    const lines = ['选择要发布的草稿：', ''];

    for (const [index, row] of draftRows.entries()) {
      const prefix = index === publishIndex ? '› ' : '  ';
      lines.push(`${prefix}${row.title}  ${row.path}`);
    }

    lines.push('', 'Esc 返回，Enter 发布。');
    return lines.slice(0, availableRows);
  }

  if (mode === 'list') {
    return wrapLines(formatNoteRows(rows), width).slice(0, availableRows);
  }

  const lines = ['日志', ''];
  for (const line of logs.slice(-maxLogLines)) {
    lines.push(...wrapLine(line, width));
  }
  return lines.slice(0, availableRows);
}

function wrapLines(text, width) {
  return text.split('\n').flatMap((line) => wrapLine(line, width));
}

function wrapLine(line, width) {
  if (line.length <= width) return [line];

  const chunks = [];
  for (let index = 0; index < line.length; index += width) {
    chunks.push(line.slice(index, index + width));
  }
  return chunks;
}

function log(message) {
  logs.push(...String(message).split(/\r?\n/).filter(Boolean));
  logs = logs.slice(-maxLogLines);
}

function logMany(messages) {
  for (const message of messages) {
    log(message);
  }
}

function buildSummary(output) {
  const lines = output.split(/\r?\n/).filter(Boolean);
  const diagnostics = lines.filter(
    (line) =>
      line.includes('Result (') ||
      line.includes('error') ||
      line.includes('warning') ||
      line.includes('Complete!') ||
      line.includes('built in'),
  );
  return diagnostics.length ? diagnostics.join('\n') : lines.slice(-8).join('\n');
}

function stripAnsi(value) {
  return value.replace(/\x1b\[[0-9;]*m/g, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exitAdmin() {
  if (previewStartedHere && previewProcess) {
    previewProcess.kill('SIGTERM');
    previewProcess = null;
  }

  process.stdout.write('\x1b[?25h\x1b[2J\x1b[H');
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}
