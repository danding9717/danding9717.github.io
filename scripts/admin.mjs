#!/usr/bin/env node
import { spawn } from 'node:child_process';
import net from 'node:net';
import os from 'node:os';
import readline from 'node:readline';
import {
  BlogError,
  commitAndPush,
  compactDateForToday,
  createDraft,
  formatTrashItems,
  formatNoteRows,
  listTrashItems,
  listNotes,
  moveNoteToTrash,
  previewUrl,
  projectRoot,
  publishDraft,
} from './blog-core.mjs';

const brandName = "Dan's Notes";
const maxLogLines = 8;
const commands = [
  { name: '/today', label: 'Today draft', help: 'Open or create today draft' },
  { name: '/new', label: 'New draft', help: 'Create draft for a date, e.g. /new 20260530' },
  { name: '/list', label: 'Posts', help: 'Show drafts and published posts' },
  { name: '/preview', label: 'Preview', help: 'Start or open local preview' },
  { name: '/publish', label: 'Publish', help: 'Publish a draft, optional date allowed' },
  { name: '/commit', label: 'Commit', help: 'Build, commit, and push current changes' },
  { name: '/delete', label: 'Delete', help: 'Move a draft or post into .blog-trash' },
  { name: '/trash', label: 'Trash', help: 'Show archived deleted files' },
  { name: '/refresh', label: 'Refresh', help: 'Refresh post and draft status' },
  { name: '/help', label: 'Help', help: 'Show command help' },
  { name: '/quit', label: 'Quit', help: 'Exit blog admin' },
];
const commandNames = new Set(commands.map((command) => command.name));
const homeActions = [
  ['Today draft', '/today'],
  ['Posts', '/list'],
  ['Preview', '/preview'],
  ['Publish', '/publish'],
  ['Commit', '/commit'],
  ['Delete', '/delete'],
  ['Quit', '/quit'],
];
const dLogo = [
  'DDDDDD ',
  'D     D',
  'D      D',
  'D      D',
  'D     D',
  'DDDDDD ',
];
const ansi = {
  bg: '\x1b[48;5;255m',
  border: '\x1b[38;5;250m',
  dark: '\x1b[38;5;236m',
  faint: '\x1b[38;5;252m',
  muted: '\x1b[38;5;246m',
  reset: '\x1b[0m',
  strong: '\x1b[1m',
};

let rows = [];
let logs = [];
let input = '';
let view = 'home';
let selectedCommandIndex = 0;
let publishIndex = 0;
let deleteIndex = 0;
let trashItems = [];
let lastPublishedDate = '';
let busy = false;
let previewProcess = null;
let previewStartedHere = false;
let cursorTarget = { column: 1, row: 1 };

if (process.argv.includes('--check')) {
  rows = await listNotes();
  console.log(`Blog Admin OK\n项目：${projectRoot}\n\n${formatNoteRows(rows)}`);
  process.exit(0);
}

await refreshRows();
setupTerminal();
render();

readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', async (value, key = {}) => {
  if (key.ctrl && key.name === 'c') {
    await exitAdmin();
    return;
  }

  if (busy) return;

  await handleKey(value, key);
});
process.stdout.on('resize', render);

async function handleKey(value, key) {
  if (key.name === 'escape') {
    input = '';
    selectedCommandIndex = 0;
    view = 'home';
    render();
    return;
  }

  if (input.startsWith('/')) {
    await handleCommandInput(value, key);
    return;
  }

  if (value === '/') {
    input = '/';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (view === 'publish') {
    await handlePublishKeys(value, key);
    return;
  }

  if (view === 'delete') {
    await handleDeleteKeys(value, key);
    return;
  }

  if (key.name === 'backspace') {
    input = input.slice(0, -1);
    render();
    return;
  }

  if (key.name === 'return') {
    if (input.trim()) {
      log('Commands start with /. Try /help.');
      input = '';
    }
    render();
    return;
  }

  if (isPrintable(value)) {
    input += value;
    render();
  }
}

async function handleCommandInput(value, key) {
  if (key.name === 'backspace') {
    input = input.slice(0, -1);
    if (!input.startsWith('/')) input = '';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (key.ctrl && key.name === 'u') {
    input = '/';
    selectedCommandIndex = 0;
    render();
    return;
  }

  const suggestions = getCommandSuggestions();

  if (key.name === 'up' || key.name === 'k') {
    selectedCommandIndex = Math.max(0, selectedCommandIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    selectedCommandIndex = Math.min(Math.max(0, suggestions.length - 1), selectedCommandIndex + 1);
    render();
    return;
  }

  if (key.name === 'return') {
    await submitCommand();
    return;
  }

  if (isPrintable(value)) {
    input += value;
    selectedCommandIndex = 0;
    render();
  }
}

async function handlePublishKeys(value, key) {
  const draftRows = getDraftRows();

  if (value === '/') {
    input = '/';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (key.name === 'up' || key.name === 'k') {
    publishIndex = Math.max(0, publishIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    publishIndex = Math.min(Math.max(0, draftRows.length - 1), publishIndex + 1);
    render();
    return;
  }

  if (key.name === 'return' && draftRows[publishIndex]) {
    await publishSelectedDraft(draftRows[publishIndex]);
  }
}

async function handleDeleteKeys(value, key) {
  const deletableRows = getDeletableRows();

  if (value === '/') {
    input = '/';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (key.name === 'up' || key.name === 'k') {
    deleteIndex = Math.max(0, deleteIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    deleteIndex = Math.min(Math.max(0, deletableRows.length - 1), deleteIndex + 1);
    render();
    return;
  }

  if (key.name === 'return' && deletableRows[deleteIndex]) {
    await deleteSelectedNote(deletableRows[deleteIndex]);
  }
}

async function submitCommand() {
  const trimmed = input.trim();
  const suggestions = getCommandSuggestions();
  const firstWord = trimmed.split(/\s+/)[0];
  let commandLine = trimmed;

  if (trimmed === '/' || !commandNames.has(firstWord)) {
    commandLine = suggestions[selectedCommandIndex]?.name ?? trimmed;
  }

  input = '';
  selectedCommandIndex = 0;
  await executeCommand(commandLine);
}

async function executeCommand(commandLine) {
  const [name = '', ...args] = commandLine.trim().split(/\s+/);

  switch (name.toLowerCase()) {
    case '/today':
      await runTask(async () => {
        const result = await createDraft(compactDateForToday(), {
          editor: 'Typora',
          open: true,
        });
        logMany(result.messages);
        await refreshRows();
        view = 'home';
      });
      return;

    case '/new':
      await runTask(async () => {
        const result = await createDraft(args[0], {
          editor: 'Typora',
          open: true,
        });
        logMany(result.messages);
        await refreshRows();
        view = 'home';
      });
      return;

    case '/list':
      await refreshRows();
      view = 'list';
      log('Posts refreshed.');
      render();
      return;

    case '/preview':
      await runTask(startPreview);
      return;

    case '/publish':
      if (args[0]) {
        await publishByDate(args[0]);
      } else {
        await openPublishFlow();
      }
      return;

    case '/commit':
      await commitChanges(args.join(' '));
      return;

    case '/delete':
      if (args[0]) {
        await deleteByIdentifier(args[0]);
      } else {
        await openDeleteFlow();
      }
      return;

    case '/trash':
      await openTrash();
      return;

    case '/refresh':
      await refreshRows();
      log('Refreshed.');
      render();
      return;

    case '/help':
      view = 'help';
      log('Help opened.');
      render();
      return;

    case '/quit':
      await exitAdmin();
      return;

    default:
      log(`Unknown command: ${commandLine || '/'}`);
      render();
  }
}

async function openPublishFlow() {
  await refreshRows();
  const draftRows = getDraftRows();

  if (!draftRows.length) {
    log('No drafts to publish.');
    view = 'home';
    render();
    return;
  }

  if (draftRows.length === 1) {
    await publishSelectedDraft(draftRows[0]);
    return;
  }

  publishIndex = 0;
  view = 'publish';
  log('Choose a draft, then press Enter.');
  render();
}

async function publishByDate(date) {
  await runTask(async () => {
    log(`Publishing ${date}...`);
    const result = await publishDraft(date, { stdio: 'pipe' });
    lastPublishedDate = result.compactDate || date;
    logMany(result.messages);
    if (result.buildOutput) {
      log(buildSummary(result.buildOutput));
    }
    await refreshRows();
    view = 'list';
  });
}

async function publishSelectedDraft(row) {
  await runTask(async () => {
    log(`Publishing ${row.title}...`);
    const result = await publishDraft(row.compact, { stdio: 'pipe' });
    lastPublishedDate = result.compactDate || row.compact;
    logMany(result.messages);
    if (result.buildOutput) {
      log(buildSummary(result.buildOutput));
    }
    await refreshRows();
    view = 'list';
  });
}

async function commitChanges(message) {
  await runTask(async () => {
    const commitMessage = message.trim() || (lastPublishedDate ? `Add note ${lastPublishedDate}` : 'Update blog');
    log(`Committing: ${commitMessage}`);
    const result = commitAndPush(commitMessage, { stdio: 'pipe' });
    logMany(result.messages);
    if (result.buildOutput) {
      log(buildSummary(result.buildOutput));
    }
    await refreshRows();
    view = 'home';
  });
}

async function openDeleteFlow() {
  await refreshRows();
  const deletableRows = getDeletableRows();

  if (!deletableRows.length) {
    log('No drafts or posts to delete.');
    view = 'home';
    render();
    return;
  }

  deleteIndex = 0;
  view = 'delete';
  log('Choose a draft or post, then press Enter.');
  render();
}

async function deleteByIdentifier(identifier) {
  await runTask(async () => {
    log(`Deleting ${identifier}...`);
    const result = await moveNoteToTrash(identifier);
    logMany(result.messages);
    await refreshRows();
    await refreshTrashItems();
    view = 'trash';
  });
}

async function deleteSelectedNote(row) {
  await runTask(async () => {
    log(`Deleting ${row.title}...`);
    const result = await moveNoteToTrash(row);
    logMany(result.messages);
    await refreshRows();
    await refreshTrashItems();
    view = 'trash';
  });
}

async function openTrash() {
  await refreshTrashItems();
  view = 'trash';
  log('Trash refreshed.');
  render();
}

async function startPreview() {
  if (await isPreviewReachable()) {
    log(`Preview is already running: ${previewUrl}`);
    openUrl(previewUrl);
    view = 'home';
    return;
  }

  log('Starting local preview...');
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
      log(`Preview exited: ${code}`);
    }
    previewProcess = null;
    render();
  });

  for (let attempt = 0; attempt < 30; attempt += 1) {
    if (await isPreviewReachable()) {
      log(`Preview ready: ${previewUrl}`);
      openUrl(previewUrl);
      view = 'home';
      return;
    }
    await sleep(500);
  }

  throw new BlogError('Preview timed out. Check the log.');
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
}

async function refreshTrashItems() {
  trashItems = await listTrashItems();
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
  process.stdout.write('\x1b[?25h');
}

function render() {
  const width = process.stdout.columns || 100;
  const height = Math.max(18, process.stdout.rows || 32);
  const lines = Array.from({ length: height }, () => ''.padEnd(width, ' '));
  const styles = Array.from({ length: height }, () => 'normal');

  put(lines, styles, 1, 2, displayProjectPath(), 'muted');

  if (input.startsWith('/')) {
    renderCommandPalette(lines, styles, width, height);
  } else if (view === 'publish') {
    renderPublish(lines, styles, width, height);
  } else if (view === 'delete') {
    renderDelete(lines, styles, width, height);
  } else if (view === 'list') {
    renderList(lines, styles, width, height);
  } else if (view === 'trash') {
    renderTrash(lines, styles, width, height);
  } else if (view === 'help') {
    renderHelp(lines, styles, width, height);
  } else {
    renderHome(lines, styles, width, height);
  }

  renderFooter(lines, styles, width, height);

  const body = lines
    .map((line, index) => paint(line.slice(0, width).padEnd(width, ' '), styles[index]))
    .join('\n');

  process.stdout.write(`\x1b[2J\x1b[H${body}\x1b[${cursorTarget.row};${cursorTarget.column}H`);
}

function renderHome(lines, styles, width, height) {
  const logoStart = clamp(Math.floor(height * 0.25), 3, Math.max(3, height - 16));
  centerBlock(lines, styles, dLogo, logoStart, width, 'faint');

  const actionRows = homeActions.map(
    ([label, command]) => `${label.padEnd(16, ' ')} ${command}`,
  );
  const actionsStart = Math.min(height - 10, logoStart + dLogo.length + 3);
  centerBlock(lines, styles, actionRows, actionsStart, width, 'strong');

  const lastLines = logs.slice(-3);
  const logStart = actionsStart + actionRows.length + 2;
  const availableLogRows = Math.max(0, height - 4 - logStart);
  if (availableLogRows > 0) {
    centerBlock(lines, styles, lastLines.slice(-availableLogRows), logStart, width, 'muted');
  }
}

function renderCommandPalette(lines, styles, width, height) {
  const suggestions = getCommandSuggestions();
  selectedCommandIndex = clamp(
    selectedCommandIndex,
    0,
    Math.max(0, suggestions.length - 1),
  );

  const panelRows = ['Commands', ''];
  if (suggestions.length) {
    for (const [index, command] of suggestions.entries()) {
      const prefix = index === selectedCommandIndex ? '> ' : '  ';
      panelRows.push(`${prefix}${command.name.padEnd(12, ' ')} ${command.help}`);
    }
  } else {
    panelRows.push('No matching command.');
  }
  panelRows.push('', 'Enter run  Esc home  Up/Down select');

  const start = clamp(Math.floor(height * 0.32), 3, Math.max(3, height - panelRows.length - 6));
  centerBlock(lines, styles, panelRows, start, width, 'normal', selectedCommandIndex + 2);
}

function renderPublish(lines, styles, width, height) {
  const draftRows = getDraftRows();
  const panelRows = ['Choose draft to publish', ''];

  if (draftRows.length) {
    for (const [index, row] of draftRows.entries()) {
      const prefix = index === publishIndex ? '> ' : '  ';
      panelRows.push(`${prefix}${row.compact}  ${row.path}`);
    }
  } else {
    panelRows.push('No drafts to publish.');
  }

  panelRows.push('', 'Enter publish  / command  Esc home');
  const start = clamp(Math.floor(height * 0.28), 3, Math.max(3, height - panelRows.length - 6));
  centerBlock(lines, styles, panelRows, start, width, 'normal', publishIndex + 2);
}

function renderDelete(lines, styles, width, height) {
  const deletableRows = getDeletableRows();
  const panelRows = ['Move to .blog-trash', ''];

  if (deletableRows.length) {
    for (const [index, row] of deletableRows.entries()) {
      const prefix = index === deleteIndex ? '> ' : '  ';
      panelRows.push(`${prefix}${row.status.padEnd(5, ' ')} ${row.compact}  ${row.path}`);
    }
  } else {
    panelRows.push('No drafts or posts to delete.');
  }

  panelRows.push('', 'Enter delete  / command  Esc home');
  const start = clamp(Math.floor(height * 0.24), 3, Math.max(3, height - panelRows.length - 6));
  centerBlock(lines, styles, panelRows, start, width, 'normal', deleteIndex + 2);
}

function renderList(lines, styles, width, height) {
  const contentWidth = Math.min(96, Math.max(28, width - 8));
  const content = ['Posts', '', ...wrapLines(formatNoteRows(rows), contentWidth)];
  const start = 4;
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));

  for (let index = 0; index < Math.min(content.length, height - 9); index += 1) {
    put(lines, styles, start + index, col, content[index], index === 0 ? 'strong' : 'normal');
  }
}

function renderTrash(lines, styles, width, height) {
  const contentWidth = Math.min(96, Math.max(28, width - 8));
  const content = ['Trash', '', ...wrapLines(formatTrashItems(trashItems), contentWidth)];
  const start = 4;
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));

  for (let index = 0; index < Math.min(content.length, height - 9); index += 1) {
    put(lines, styles, start + index, col, content[index], index === 0 ? 'strong' : 'normal');
  }
}

function renderHelp(lines, styles, width, height) {
  const content = [
    'Commands',
    '',
    ...commands.map((command) => `${command.name.padEnd(12, ' ')} ${command.help}`),
    '',
    'Press / to type a command. Esc returns home.',
  ];
  const contentWidth = Math.min(86, Math.max(28, width - 8));
  const start = 4;
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));

  for (let index = 0; index < Math.min(content.length, height - 9); index += 1) {
    put(lines, styles, start + index, col, content[index], index === 0 ? 'strong' : 'normal');
  }
}

function renderFooter(lines, styles, width, height) {
  const margin = width > 54 ? 2 : 0;
  const boxWidth = Math.max(4, width - margin * 2);
  const topRow = Math.max(1, height - 2);
  const inputRow = Math.max(1, height - 1);
  const bottomRow = Math.max(1, height);
  const tipRow = Math.max(1, height - 3);
  const latestLog = logs.at(-1);
  const tip = busy
    ? 'Working...'
    : input.startsWith('/')
      ? 'Enter run · Esc home · Up/Down select'
      : latestLog
        ? `${latestLog}  ·  Press / for commands.`
        : 'Tip: Press / to open commands.';
  const meta = ` ${brandName} · blog-admin `;
  const maxInput = Math.max(1, boxWidth - 6);
  const displayInput = input.length > maxInput ? `...${input.slice(-(maxInput - 3))}` : input;
  const inputText = `› ${displayInput}`;

  put(lines, styles, tipRow, margin + 1, tip, 'muted');
  put(
    lines,
    styles,
    topRow,
    margin,
    `┌${'─'.repeat(Math.max(0, boxWidth - 2))}┐`,
    'border',
  );
  put(
    lines,
    styles,
    inputRow,
    margin,
    `│ ${inputText.padEnd(boxWidth - 4, ' ')} │`,
    'normal',
  );

  let bottom = `└${'─'.repeat(Math.max(0, boxWidth - 2))}┘`;
  if (meta.length < boxWidth - 4) {
    const insertAt = Math.max(1, boxWidth - meta.length - 2);
    bottom = `${bottom.slice(0, insertAt)}${meta}${bottom.slice(insertAt + meta.length)}`;
  }
  put(lines, styles, bottomRow, margin, bottom, 'muted');

  cursorTarget = {
    column: Math.min(width, margin + 4 + displayInput.length),
    row: clamp(inputRow, 1, height),
  };
}

function getCommandSuggestions() {
  const query = input.slice(1).trim().toLowerCase();
  if (!query) return commands;

  const commandQuery = query.split(/\s+/)[0];
  const nameMatches = commands.filter((command) =>
    command.name.slice(1).startsWith(commandQuery),
  );
  if (nameMatches.length) return nameMatches;

  return commands.filter((command) => {
    const name = command.name.slice(1);
    return (
      name.startsWith(commandQuery) ||
      command.label.toLowerCase().includes(query) ||
      command.help.toLowerCase().includes(query)
    );
  });
}

function getDraftRows() {
  return rows.filter((row) => row.status === 'draft');
}

function getDeletableRows() {
  return rows.filter((row) => ['draft', 'post'].includes(row.status));
}

function displayProjectPath() {
  const home = os.homedir();
  return projectRoot.startsWith(home) ? projectRoot.replace(home, '~') : projectRoot;
}

function centerBlock(lines, styles, block, startRow, width, styleName, selectedRelativeIndex = -1) {
  const blockWidth = Math.max(...block.map((line) => line.length), 0);
  const col = Math.max(1, Math.floor((width - blockWidth) / 2));

  for (const [index, line] of block.entries()) {
    const row = startRow + index;
    const rowStyle = index === selectedRelativeIndex ? 'selected' : styleName;
    put(lines, styles, row, col, line, rowStyle);
  }
}

function put(lines, styles, rowNumber, columnNumber, text, styleName = 'normal') {
  const row = rowNumber - 1;
  const column = columnNumber - 1;
  if (row < 0 || row >= lines.length || column < 0 || column >= lines[row].length) return;

  const available = lines[row].length - column;
  const clipped = String(text).slice(0, available);
  lines[row] =
    lines[row].slice(0, column) + clipped + lines[row].slice(column + clipped.length);
  styles[row] = styleName;
}

function paint(line, styleName) {
  const palette = {
    border: `${ansi.bg}${ansi.border}`,
    faint: `${ansi.bg}${ansi.faint}`,
    muted: `${ansi.bg}${ansi.muted}`,
    normal: `${ansi.bg}${ansi.dark}`,
    selected: `${ansi.bg}${ansi.strong}${ansi.dark}`,
    strong: `${ansi.bg}${ansi.strong}${ansi.dark}`,
  };
  return `${palette[styleName] ?? palette.normal}${line}${ansi.reset}`;
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
  return value.replace(/\x1b\[[0-9;]*[A-Za-z]/g, '');
}

function isPrintable(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function exitAdmin() {
  if (previewStartedHere && previewProcess) {
    previewProcess.kill('SIGTERM');
    previewProcess = null;
  }

  process.stdout.write(`${ansi.reset}\x1b[2J\x1b[H`);
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}
