#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
  openFile,
  projectRoot,
  publishDraft,
} from './blog-core.mjs';

const brandName = "Dan's Notes";
const onlineBlogUrl = 'https://danding9717.github.io/';
const maxLogLines = 12;
const themeNames = ['light', 'dark', 'diablo'];
const commands = [
  { name: '/write', label: 'Write', help: 'Open today draft, or use /write YYYYMMDD' },
  { name: '/posts', label: 'Posts', help: 'Manage drafts, posts, and local trash' },
  { name: '/preview', label: 'Preview', help: 'Open the deployed blog website' },
  { name: '/publish', label: 'Publish', help: 'Publish a draft, optional date allowed' },
  { name: '/sync', label: 'Sync', help: 'Build, commit, and push current changes' },
  { name: '/theme', label: 'Theme', help: 'Cycle theme, or use /theme light|dark|diablo' },
  { name: '/logs', label: 'Logs', help: 'Show recent activity' },
  { name: '/help', label: 'Help', help: 'Show command help' },
  { name: '/quit', label: 'Quit', help: 'Exit blog admin' },
];
const commandNames = new Set(commands.map((command) => command.name));
const homeActions = [
  ['Write', '/write'],
  ['Posts', '/posts'],
  ['Preview', '/preview'],
  ['Publish', '/publish'],
];
const dLogo = [
  'DDDDDD ',
  'D     D',
  'D      D',
  'D      D',
  'D     D',
  'DDDDDD ',
];
const configPath = path.join(os.homedir(), '.config/myblog/config.json');
const themes = {
  light: {
    bg: '\x1b[48;5;255m',
    border: '\x1b[38;5;250m',
    faint: '\x1b[38;5;252m',
    logo: '\x1b[38;5;252m',
    muted: '\x1b[38;5;246m',
    accent: '\x1b[38;5;236m',
    text: '\x1b[38;5;236m',
  },
  dark: {
    bg: '\x1b[48;5;235m',
    border: '\x1b[38;5;240m',
    faint: '\x1b[38;5;239m',
    logo: '\x1b[38;5;239m',
    muted: '\x1b[38;5;245m',
    accent: '\x1b[38;5;252m',
    text: '\x1b[38;5;252m',
  },
  diablo: {
    bg: '\x1b[48;5;232m',
    border: '\x1b[38;5;88m',
    faint: '\x1b[38;5;238m',
    logo: '\x1b[38;5;88m',
    muted: '\x1b[38;5;244m',
    accent: '\x1b[38;5;178m',
    text: '\x1b[38;5;250m',
  },
};
const ansi = {
  reset: '\x1b[0m',
  strong: '\x1b[1m',
};

let rows = [];
let logs = [];
let input = '';
let view = 'home';
let selectedCommandIndex = 0;
let publishIndex = 0;
let postsIndex = 0;
let postsMode = 'notes';
let pendingDeletePath = '';
let trashItems = [];
let lastPublishedDate = '';
let pendingSyncMessage = '';
let busy = false;
let themeName = 'light';
let resizeTimer = null;
let terminalReady = false;
let cursorTarget = { column: 1, row: 1 };

if (process.argv.includes('--check')) {
  rows = await listNotes();
  console.log(`Blog Admin OK\n项目：${projectRoot}\n\n${formatNoteRows(rows)}`);
  process.exit(0);
}

await loadThemePreference();
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
process.stdout.on('resize', scheduleResizeRender);

async function handleKey(value, key) {
  if (key.name === 'escape') {
    if (view === 'sync-confirm') {
      log('Sync postponed. Run /sync when the GitHub Pages update is ready to send.');
    }
    input = '';
    pendingDeletePath = '';
    pendingSyncMessage = '';
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

  if (view === 'posts') {
    await handlePostsKeys(value, key);
    return;
  }

  if (view === 'sync-confirm') {
    await handleSyncConfirmKeys(value, key);
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

  if (key.name === 'up' || (input === '/' && key.name === 'k')) {
    selectedCommandIndex = Math.max(0, selectedCommandIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || (input === '/' && key.name === 'j')) {
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

async function handlePostsKeys(value, key) {
  const visibleRows = getVisiblePostRows();

  if (value === '/') {
    input = '/';
    pendingDeletePath = '';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (key.name === 't') {
    pendingDeletePath = '';
    postsMode = postsMode === 'notes' ? 'trash' : 'notes';
    if (postsMode === 'trash') {
      await refreshTrashItems();
    }
    postsIndex = 0;
    render();
    return;
  }

  if (key.name === 'up' || key.name === 'k') {
    pendingDeletePath = '';
    postsIndex = Math.max(0, postsIndex - 1);
    render();
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    pendingDeletePath = '';
    postsIndex = Math.min(Math.max(0, visibleRows.length - 1), postsIndex + 1);
    render();
    return;
  }

  if (postsMode !== 'notes') return;

  const selectedRow = visibleRows[postsIndex];
  if (key.name === 'return' && selectedRow) {
    openFile(selectedRow.filePath, { editor: 'Typora' });
    log(`Opened ${selectedRow.path}`);
    render();
    return;
  }

  if (key.name === 'd' && selectedRow) {
    await requestOrConfirmDelete(selectedRow);
  }
}

async function handleSyncConfirmKeys(value, key) {
  if (value === '/') {
    input = '/';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (key.name === 'return') {
    await syncChanges(pendingSyncMessage);
  }
}

async function submitCommand() {
  const trimmed = input.trim();
  const suggestions = getCommandSuggestions();
  const firstWord = trimmed.split(/\s+/)[0];
  let commandLine = trimmed;

  if (
    trimmed === '/' ||
    (!commandNames.has(firstWord) &&
      suggestions[selectedCommandIndex]?.name.startsWith(firstWord))
  ) {
    commandLine = suggestions[selectedCommandIndex]?.name ?? trimmed;
  }

  input = '';
  selectedCommandIndex = 0;
  await executeCommand(commandLine);
}

async function executeCommand(commandLine) {
  const [name = '', ...args] = commandLine.trim().split(/\s+/);

  switch (name.toLowerCase()) {
    case '/write':
      await runTask(async () => {
        const result = await createDraft(args[0] || compactDateForToday(), {
          editor: 'Typora',
          open: true,
        });
        logMany(result.messages);
        await refreshRows();
        view = 'home';
      });
      return;

    case '/preview':
      openOnlinePreview();
      return;

    case '/publish':
      if (args[0]) {
        await publishByDate(args[0]);
      } else {
        await openPublishFlow();
      }
      return;

    case '/sync':
      await syncChanges(args.join(' '));
      return;

    case '/posts':
      await openPosts();
      return;

    case '/theme':
      await changeTheme(args[0]);
      return;

    case '/logs':
      view = 'logs';
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
    openSyncConfirmation(result.compactDate || date);
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
    openSyncConfirmation(result.compactDate || row.compact);
  });
}

function openSyncConfirmation(compactDate) {
  pendingSyncMessage = `Add note ${compactDate}`;
  log('Publish ready. Press Enter to sync, or Esc to sync later.');
  view = 'sync-confirm';
}

async function syncChanges(message) {
  await runTask(async () => {
    const commitMessage =
      message.trim() ||
      pendingSyncMessage ||
      (lastPublishedDate ? `Add note ${lastPublishedDate}` : 'Update blog');
    log(`Syncing: ${commitMessage}`);
    const result = commitAndPush(commitMessage, { stdio: 'pipe' });
    logMany(result.messages);
    if (result.buildOutput) {
      log(buildSummary(result.buildOutput));
    }
    if (!result.noChanges) {
      log('GitHub Pages deploys shortly. Run /preview after deployment.');
    }
    pendingSyncMessage = '';
    await refreshRows();
    view = 'home';
  });
}

async function openPosts() {
  await refreshRows();
  await refreshTrashItems();
  postsIndex = 0;
  postsMode = 'notes';
  pendingDeletePath = '';
  view = 'posts';
  render();
}

async function requestOrConfirmDelete(row) {
  if (!['draft', 'post'].includes(row.status)) {
    pendingDeletePath = '';
    log(`Cannot delete ${row.status} content from MyBlog.`);
    render();
    return;
  }

  if (pendingDeletePath !== row.filePath) {
    pendingDeletePath = row.filePath;
    log(`Press d again to move ${row.path} to .blog-trash.`);
    render();
    return;
  }

  await runTask(async () => {
    log(`Deleting ${row.title}...`);
    const result = await moveNoteToTrash(row);
    logMany(result.messages);
    await refreshRows();
    await refreshTrashItems();
    pendingDeletePath = '';
    postsIndex = clamp(postsIndex, 0, Math.max(0, rows.length - 1));
    view = 'posts';
  });
}

function openOnlinePreview() {
  openUrl(onlineBlogUrl);
  log(`Opened deployed blog: ${onlineBlogUrl}`);
  view = 'home';
  render();
}

function openUrl(url) {
  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function refreshRows() {
  rows = await listNotes();
}

async function refreshTrashItems() {
  trashItems = await listTrashItems();
}

async function changeTheme(requestedTheme) {
  await runTask(async () => {
    const nextTheme = requestedTheme
      ? requestedTheme.toLowerCase()
      : themeNames[(themeNames.indexOf(themeName) + 1) % themeNames.length];

    if (!Object.hasOwn(themes, nextTheme)) {
      throw new BlogError('主题必须是 light、dark 或 diablo。');
    }

    themeName = nextTheme;
    try {
      await saveThemePreference();
      log(`Theme switched to ${themeName}.`);
    } catch {
      log(`Theme switched to ${themeName}, but the local preference could not be saved.`);
    }
    view = 'home';
  });
}

async function loadThemePreference() {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (Object.hasOwn(themes, config.theme)) {
      themeName = config.theme;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('Theme config could not be read. Using light.');
    }
    themeName = 'light';
  }
}

async function saveThemePreference() {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, `${JSON.stringify({ theme: themeName }, null, 2)}\n`, 'utf8');
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
    console.log('请在交互式终端中运行 myblog。');
    process.exit(1);
  }

  process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalReady = true;
  process.stdout.write('\x1b[?1049h\x1b[?7h\x1b[?25h');
  process.once('exit', restoreTerminal);
  process.once('SIGTERM', () => void exitAdmin());
  process.once('SIGHUP', () => void exitAdmin());
}

function scheduleResizeRender() {
  if (resizeTimer) {
    clearTimeout(resizeTimer);
  }
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    render();
  }, 35);
}

function render() {
  const width = Math.max(1, process.stdout.columns || 100);
  const height = Math.max(1, process.stdout.rows || 32);
  const lines = Array.from({ length: height }, () => Array(width).fill(' '));
  const styles = Array.from({ length: height }, () => 'normal');

  if (isTinyLayout(width, height)) {
    renderTiny(lines, styles, width, height);
  } else if (input.startsWith('/')) {
    renderCommandPalette(lines, styles, width, height);
  } else if (view === 'publish') {
    renderPublish(lines, styles, width, height);
  } else if (view === 'posts') {
    renderPosts(lines, styles, width, height);
  } else if (view === 'sync-confirm') {
    renderSyncConfirm(lines, styles, width, height);
  } else if (view === 'logs') {
    renderLogs(lines, styles, width, height);
  } else if (view === 'help') {
    renderHelp(lines, styles, width, height);
  } else {
    renderHome(lines, styles, width, height);
  }

  if (!isTinyLayout(width, height)) {
    renderFooter(lines, styles, width, height);
  }

  const body = lines
    .map((line, index) => paint(padDisplayWidth(line.join(''), width), styles[index]))
    .join('\r\n');

  process.stdout.write(
    `${ansi.reset}\x1b[?7l\x1b[2J\x1b[H${body}\x1b[${cursorTarget.row};${cursorTarget.column}H\x1b[?7h`,
  );
}

function renderHome(lines, styles, width, height) {
  if (isCompactLayout(width, height)) {
    renderCompactHome(lines, styles, width, height);
    return;
  }

  const logoStart = clamp(Math.floor((height - 16) / 2), 2, 6);
  centerBlock(lines, styles, dLogo, logoStart, width, 'logo');
  centerBlock(lines, styles, [dashboardSummary()], logoStart + 8, width, 'muted');
  centerBlock(lines, styles, homeActionRows(width), logoStart + 10, width, 'accent');
}

function renderCompactHome(lines, styles, width, height) {
  const content = [
    'MyBlog',
    dashboardSummary(),
    '',
    ...homeActionRows(width),
  ];
  const availableRows = Math.max(0, height - 4);

  for (let index = 0; index < Math.min(content.length, availableRows); index += 1) {
    put(lines, styles, index + 2, 2, content[index], index === 0 ? 'strong' : 'normal');
  }
}

function renderTiny(lines, styles, width, height) {
  if (height > 1) {
    put(lines, styles, 1, 1, `myblog · ${width}x${height} · enlarge window`, 'muted');
  }

  const inputRow = height;
  const displayInput = startEllipsis(input, Math.max(0, width - 2));
  const prompt = `› ${displayInput}`;
  put(lines, styles, inputRow, 1, prompt, 'normal');
  cursorTarget = {
    column: clamp(displayWidth(prompt) + 1, 1, width),
    row: inputRow,
  };
}

function dashboardSummary() {
  const posts = rows.filter((row) => row.status === 'post').length;
  const drafts = rows.filter((row) => row.status.startsWith('draft')).length;
  return `Posts ${posts}   Drafts ${drafts}   Theme ${themeName}`;
}

function homeActionRows(width) {
  if (width >= 64) {
    return [
      '/write     New or open draft    /posts     Manage content',
      '/preview   Open deployed blog   /publish   Publish draft',
    ];
  }

  return homeActions
    .map(([label, command]) => `${command.padEnd(10, ' ')} ${label}`);
}

function isCompactLayout(width, height) {
  return width < 72 || height < 22;
}

function isTinyLayout(width, height) {
  return width < 40 || height < 8;
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

function renderPosts(lines, styles, width, height) {
  const contentWidth = Math.min(96, Math.max(28, width - 8));
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));

  if (postsMode === 'trash') {
    const content = ['Local trash', '', ...wrapLines(formatTrashItems(trashItems), contentWidth)];
    for (let index = 0; index < Math.min(content.length, height - 7); index += 1) {
      put(lines, styles, index + 3, col, content[index], index === 0 ? 'accent' : 'normal');
    }
    put(lines, styles, height - 4, col, 't posts  / command  Esc home', 'muted');
    return;
  }

  const visibleRows = getVisiblePostRows();
  postsIndex = clamp(postsIndex, 0, Math.max(0, visibleRows.length - 1));
  put(lines, styles, 3, col, 'Posts', 'accent');
  put(lines, styles, 4, col, 'Enter open  d d trash  t local trash  / command  Esc home', 'muted');

  if (!visibleRows.length) {
    put(lines, styles, 6, col, 'No drafts or posts yet.', 'normal');
    return;
  }

  for (let index = 0; index < Math.min(visibleRows.length, height - 10); index += 1) {
    const row = visibleRows[index];
    const prefix = index === postsIndex ? '> ' : '  ';
    put(
      lines,
      styles,
      index + 6,
      col,
      `${prefix}${padDisplayWidth(row.status, 6)} ${padDisplayWidth(row.date, 10)} ${row.title}  ${row.path}`,
      index === postsIndex ? 'selected' : 'normal',
    );
  }

  if (pendingDeletePath) {
    put(lines, styles, height - 4, col, `Press d again: ${pendingDeletePath}`, 'accent');
  }
}

function renderSyncConfirm(lines, styles, width, height) {
  centerBlock(
    lines,
    styles,
    [
      'Publish ready',
      '',
      pendingSyncMessage || 'Update blog',
      '',
      'Enter sync to GitHub   Esc sync later',
    ],
    clamp(Math.floor(height * 0.34), 3, Math.max(3, height - 10)),
    width,
    'normal',
  );
}

function renderLogs(lines, styles, width, height) {
  const contentWidth = Math.min(96, Math.max(28, width - 8));
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));
  const content = ['Activity', '', ...(logs.length ? logs : ['No activity yet.'])];

  for (let index = 0; index < Math.min(content.length, height - 7); index += 1) {
    put(lines, styles, index + 3, col, content[index], index === 0 ? 'accent' : 'normal');
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
    put(lines, styles, start + index, col, content[index], index === 0 ? 'accent' : 'normal');
  }
}

function renderFooter(lines, styles, width, height) {
  const margin = width > 54 ? 2 : 0;
  const boxWidth = Math.max(4, width - margin * 2);
  const leftColumn = margin + 1;
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
  const meta = ` ${brandName} · myblog `;
  const maxInput = Math.max(1, boxWidth - 6);
  const displayInput = startEllipsis(input, maxInput);
  const inputText = `› ${displayInput}`;

  put(lines, styles, tipRow, leftColumn, tip, 'muted');
  put(
    lines,
    styles,
    topRow,
    leftColumn,
    `┌${'─'.repeat(Math.max(0, boxWidth - 2))}┐`,
    'border',
  );
  put(
    lines,
    styles,
    inputRow,
    leftColumn,
    `│ ${padDisplayWidth(inputText, boxWidth - 4)} │`,
    'normal',
  );

  let bottom = `└${'─'.repeat(Math.max(0, boxWidth - 2))}┘`;
  if (displayWidth(meta) < boxWidth - 4) {
    const insertAt = Math.max(1, boxWidth - displayWidth(meta) - 2);
    bottom = `${bottom.slice(0, insertAt)}${meta}${bottom.slice(insertAt + displayWidth(meta))}`;
  }
  put(lines, styles, bottomRow, leftColumn, bottom, 'muted');

  cursorTarget = {
    column: Math.min(width, leftColumn + 4 + displayWidth(displayInput)),
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

function getVisiblePostRows() {
  return postsMode === 'notes' ? rows : [];
}

function centerBlock(lines, styles, block, startRow, width, styleName, selectedRelativeIndex = -1) {
  const blockWidth = Math.max(...block.map((line) => displayWidth(line)), 0);
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

  let cursor = column;
  for (const character of String(text)) {
    const width = characterWidth(character);
    if (width === 0) {
      appendCombiningCharacter(lines[row], cursor, character);
      continue;
    }
    if (cursor + width > lines[row].length) break;

    lines[row][cursor] = character;
    for (let offset = 1; offset < width; offset += 1) {
      lines[row][cursor + offset] = '';
    }
    cursor += width;
  }
  styles[row] = styleName;
}

function paint(line, styleName) {
  const theme = themes[themeName];
  const palette = {
    border: `${theme.bg}${theme.border}`,
    faint: `${theme.bg}${theme.faint}`,
    logo: `${theme.bg}${theme.logo}`,
    muted: `${theme.bg}${theme.muted}`,
    normal: `${theme.bg}${theme.text}`,
    accent: `${theme.bg}${ansi.strong}${theme.accent}`,
    selected: `${theme.bg}${ansi.strong}${theme.accent}`,
    strong: `${theme.bg}${ansi.strong}${theme.text}`,
  };
  return `${palette[styleName] ?? palette.normal}${line}${ansi.reset}`;
}

function wrapLines(text, width) {
  return text.split('\n').flatMap((line) => wrapLine(line, width));
}

function wrapLine(line, width) {
  if (displayWidth(line) <= width) return [line];

  const chunks = [];
  let chunk = '';
  let chunkWidth = 0;

  for (const character of line) {
    const widthOfCharacter = characterWidth(character);
    if (chunk && chunkWidth + widthOfCharacter > width) {
      chunks.push(chunk);
      chunk = '';
      chunkWidth = 0;
    }
    chunk += character;
    chunkWidth += widthOfCharacter;
  }
  if (chunk) chunks.push(chunk);

  return chunks;
}

function displayWidth(value) {
  let width = 0;
  for (const character of String(value)) {
    width += characterWidth(character);
  }
  return width;
}

function characterWidth(character) {
  const codePoint = character.codePointAt(0);
  if (
    codePoint === 0 ||
    codePoint < 32 ||
    (codePoint >= 0x7f && codePoint < 0xa0) ||
    /\p{Mark}/u.test(character) ||
    codePoint === 0x200d ||
    (codePoint >= 0xfe00 && codePoint <= 0xfe0f)
  ) {
    return 0;
  }

  return isWideCodePoint(codePoint) ? 2 : 1;
}

function isWideCodePoint(codePoint) {
  return (
    codePoint >= 0x1100 &&
    (codePoint <= 0x115f ||
      codePoint === 0x2329 ||
      codePoint === 0x232a ||
      (codePoint >= 0x2e80 && codePoint <= 0xa4cf && codePoint !== 0x303f) ||
      (codePoint >= 0xac00 && codePoint <= 0xd7a3) ||
      (codePoint >= 0xf900 && codePoint <= 0xfaff) ||
      (codePoint >= 0xfe10 && codePoint <= 0xfe19) ||
      (codePoint >= 0xfe30 && codePoint <= 0xfe6f) ||
      (codePoint >= 0xff00 && codePoint <= 0xff60) ||
      (codePoint >= 0xffe0 && codePoint <= 0xffe6) ||
      (codePoint >= 0x1f300 && codePoint <= 0x1faff) ||
      (codePoint >= 0x20000 && codePoint <= 0x3fffd))
  );
}

function appendCombiningCharacter(line, cursor, character) {
  for (let index = Math.min(cursor - 1, line.length - 1); index >= 0; index -= 1) {
    if (line[index]) {
      line[index] += character;
      return;
    }
  }
}

function clipDisplayWidth(value, width) {
  if (width <= 0) return '';

  let result = '';
  let used = 0;
  for (const character of String(value)) {
    const widthOfCharacter = characterWidth(character);
    if (used + widthOfCharacter > width) break;
    result += character;
    used += widthOfCharacter;
  }
  return result;
}

function padDisplayWidth(value, width) {
  const clipped = clipDisplayWidth(value, Math.max(0, width));
  return `${clipped}${' '.repeat(Math.max(0, width - displayWidth(clipped)))}`;
}

function startEllipsis(value, width) {
  const text = String(value);
  if (displayWidth(text) <= width) return text;
  if (width <= 3) return '.'.repeat(Math.max(0, width));

  const targetWidth = width - 3;
  const characters = Array.from(text);
  let result = '';
  let used = 0;

  for (let index = characters.length - 1; index >= 0; index -= 1) {
    const character = characters[index];
    const widthOfCharacter = characterWidth(character);
    if (used + widthOfCharacter > targetWidth) break;
    result = `${character}${result}`;
    used += widthOfCharacter;
  }

  return `...${result}`;
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

function isPrintable(value) {
  return typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

async function exitAdmin() {
  restoreTerminal();
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
  }
  process.exit(0);
}

function restoreTerminal() {
  if (!terminalReady) return;

  terminalReady = false;
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  process.stdout.write(`${ansi.reset}\x1b[?7h\x1b[?25h\x1b[?1049l`);
}
