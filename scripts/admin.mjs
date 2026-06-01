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

const onlineBlogUrl = 'https://danding9717.github.io/';
const maxLogLines = 12;
const themeNames = ['light', 'dark', 'diablo'];
const commands = [
  { name: '/home', label: 'Home', help: 'Return to the dashboard' },
  { name: '/write', label: 'Write', help: 'Open today draft, or use /write YYYYMMDD' },
  { name: '/posts', label: 'Posts', help: 'Manage drafts, posts, and local trash' },
  { name: '/preview', label: 'Preview', help: 'Open the deployed blog website' },
  { name: '/publish', label: 'Publish', help: 'Choose a draft to publish, optional date allowed' },
  { name: '/sync', label: 'Sync', help: 'Build, commit, and push current changes' },
  { name: '/theme', label: 'Theme', help: 'Choose theme, or use /theme light|dark|diablo' },
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
const brandLogo = [
  '      ▄█████████▄      ',
  '   ▄███████████████▄   ',
  ' ▄███████████████████▄ ',
  '███████████████████████',
  '                       ',
  '          ███          ',
  '          ███          ',
  '          ███          ',
  '     ▄    ███          ',
  '     ████████          ',
  '      ▀████▀           ',
];
const compactBrandLogo = [
  '   ▄█████▄   ',
  '▄███████████▄',
  '      ██     ',
  '  ▄   ██     ',
  '  ▀████      ',
];
const configPath = path.join(os.homedir(), '.config/myblog/config.json');
const themes = {
  light: {
    bg: '\x1b[48;5;255m',
    surfaceBg: '\x1b[48;5;254m',
    selectedBg: '\x1b[48;5;250m',
    selectedText: '\x1b[38;5;236m',
    border: '\x1b[38;5;250m',
    faint: '\x1b[38;5;252m',
    logo: '\x1b[38;5;252m',
    muted: '\x1b[38;5;246m',
    accent: '\x1b[38;5;236m',
    text: '\x1b[38;5;236m',
  },
  dark: {
    bg: '',
    surfaceBg: '\x1b[48;5;235m',
    selectedBg: '\x1b[48;5;240m',
    selectedText: '\x1b[38;5;255m',
    border: '\x1b[38;5;240m',
    faint: '\x1b[38;5;239m',
    logo: '\x1b[38;5;239m',
    muted: '\x1b[38;5;245m',
    accent: '\x1b[38;5;252m',
    text: '\x1b[38;5;252m',
  },
  diablo: {
    bg: '',
    surfaceBg: '\x1b[48;5;232m',
    selectedBg: '\x1b[48;5;88m',
    selectedText: '\x1b[38;5;230m',
    border: '\x1b[38;5;88m',
    faint: '\x1b[38;5;238m',
    logo: '\x1b[38;5;88m',
    muted: '\x1b[38;5;244m',
    accent: '\x1b[38;5;178m',
    text: '\x1b[38;5;250m',
  },
};
const ansi = {
  dim: '\x1b[2m',
  reset: '\x1b[0m',
  strong: '\x1b[1m',
};

let rows = [];
let logs = [];
let input = '';
let view = 'home';
let selectedCommandIndex = 0;
let commandScroll = 0;
let optionSelector = null;
let postsIndex = 0;
let postsScroll = 0;
let postsMode = 'notes';
let pendingDeletePath = '';
let trashItems = [];
let lastPublishedDate = '';
let pendingSyncMessage = '';
let reader = null;
const readerPositions = new Map();
let busy = false;
let themeName = 'light';
let resizeTimer = null;
let readerPrefix = '';
let readerPrefixTimer = null;
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
    if (optionSelector) {
      closeOptionSelector();
      render();
      return;
    }

    if (input.startsWith('/')) {
      input = '';
      selectedCommandIndex = 0;
      commandScroll = 0;
      render();
      return;
    }

    clearReaderPrefix();
    if (view === 'sync-confirm') {
      log('Sync postponed. Run /sync when the GitHub Pages update is ready to send.');
    }
    input = '';
    pendingDeletePath = '';
    pendingSyncMessage = '';
    selectedCommandIndex = 0;
    commandScroll = 0;
    view = view === 'reader' ? 'posts' : 'home';
    render();
    return;
  }

  if (optionSelector) {
    await handleOptionSelectorKeys(value, key);
    return;
  }

  if (input.startsWith('/')) {
    await handleCommandInput(value, key);
    return;
  }

  if (value === '/') {
    clearReaderPrefix();
    input = '/';
    selectedCommandIndex = 0;
    commandScroll = 0;
    render();
    return;
  }

  if (view === 'posts') {
    await handlePostsKeys(value, key);
    return;
  }

  if (view === 'reader') {
    await handleReaderKeys(value, key);
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
    if (view === 'home' && input.trim().toLowerCase() === 'quit') {
      await exitAdmin();
      return;
    }
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

async function handleOptionSelectorKeys(value, key) {
  if (!optionSelector) return;

  if (key.name === 'backspace') {
    optionSelector.query = optionSelector.query.slice(0, -1);
    resetOptionSelectorSelection();
    render();
    return;
  }

  if (key.ctrl && key.name === 'u') {
    optionSelector.query = '';
    resetOptionSelectorSelection();
    render();
    return;
  }

  const options = getOptionSelectorMatches();

  if (key.name === 'up') {
    optionSelector.selectedIndex = Math.max(0, optionSelector.selectedIndex - 1);
    render();
    return;
  }

  if (key.name === 'down') {
    optionSelector.selectedIndex = Math.min(
      Math.max(0, options.length - 1),
      optionSelector.selectedIndex + 1,
    );
    render();
    return;
  }

  if (key.name === 'return') {
    const selected = options[optionSelector.selectedIndex];
    if (!selected) return;

    closeOptionSelector();
    await selected.onSelect();
    return;
  }

  if (isPrintable(value)) {
    optionSelector.query += value;
    resetOptionSelectorSelection();
    render();
  }
}

async function handleCommandInput(value, key) {
  if (key.name === 'backspace') {
    input = input.slice(0, -1);
    if (!input.startsWith('/')) input = '';
    selectedCommandIndex = 0;
    commandScroll = 0;
    render();
    return;
  }

  if (key.ctrl && key.name === 'u') {
    input = '/';
    selectedCommandIndex = 0;
    commandScroll = 0;
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
    commandScroll = 0;
    render();
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
    postsScroll = 0;
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
    await openReader(selectedRow);
    return;
  }

  if (key.name === 'e' && selectedRow) {
    openFile(selectedRow.filePath, { editor: 'Typora' });
    log(`Opened ${selectedRow.path}`);
    render();
    return;
  }

  if (key.name === 'd' && selectedRow) {
    await requestOrConfirmDelete(selectedRow);
  }
}

async function handleReaderKeys(value, key) {
  if (value === '/') {
    clearReaderPrefix();
    input = '/';
    selectedCommandIndex = 0;
    render();
    return;
  }

  if (!reader) {
    clearReaderPrefix();
    view = 'posts';
    render();
    return;
  }

  const pageRows = getReaderPageRows();
  const maxScroll = Math.max(0, reader.lines.length - pageRows);

  if (readerPrefix) {
    const prefix = readerPrefix;
    clearReaderPrefix();

    if (prefix === 'g' && key.name === 'g' && !key.shift) {
      setReaderScroll(0, maxScroll);
      return;
    }

    if (prefix === '1' && key.name === 'g' && key.shift) {
      setReaderScroll(0, maxScroll);
      return;
    }
  }

  if (key.ctrl && key.name === 'b') {
    setReaderScroll(reader.scroll - pageRows, maxScroll);
    return;
  }

  if (key.ctrl && key.name === 'f') {
    setReaderScroll(reader.scroll + pageRows, maxScroll);
    return;
  }

  if (key.name === 'up' || key.name === 'k') {
    setReaderScroll(reader.scroll - 1, maxScroll);
    return;
  }

  if (key.name === 'down' || key.name === 'j') {
    setReaderScroll(reader.scroll + 1, maxScroll);
    return;
  }

  if (key.name === 'pageup') {
    setReaderScroll(reader.scroll - pageRows, maxScroll);
    return;
  }

  if (key.name === 'pagedown' || key.name === 'space' || value === ' ') {
    setReaderScroll(reader.scroll + pageRows, maxScroll);
    return;
  }

  if (key.shift && key.name === 'g') {
    setReaderScroll(maxScroll, maxScroll);
    return;
  }

  if (key.name === 'g') {
    setReaderPrefix('g');
    return;
  }

  if (value === '1') {
    setReaderPrefix('1');
    return;
  }

  if (key.name === 'e') {
    openFile(reader.row.filePath, { editor: 'Typora' });
    log(`Opened ${reader.row.path}`);
    render();
    return;
  }

  if (key.name === 'n') {
    await openAdjacentReader(1);
    return;
  }

  if (key.name === 'p') {
    await openAdjacentReader(-1);
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
  commandScroll = 0;
  await executeCommand(commandLine);
}

async function executeCommand(commandLine) {
  const [name = '', ...args] = commandLine.trim().split(/\s+/);

  switch (name.toLowerCase()) {
    case '/home':
      openHome();
      return;

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
      if (args[0]) {
        await changeTheme(args[0]);
      } else {
        openThemeSelector();
      }
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

function openHome() {
  pendingDeletePath = '';
  view = 'home';
  render();
}

async function openPublishFlow() {
  await refreshRows();
  const draftRows = getDraftRows();

  if (!draftRows.length) {
    log('No drafts to publish.');
    render();
    return;
  }

  openOptionSelector({
    title: 'Publish draft',
    options: draftRows.map((row) => ({
      id: row.filePath,
      label: `${row.compact}  ${row.title}  ${row.path}`,
      searchText: `${row.compact} ${row.title} ${row.path}`,
      onSelect: () => publishSelectedDraft(row),
    })),
  });
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
  postsScroll = 0;
  postsMode = 'notes';
  pendingDeletePath = '';
  view = 'posts';
  render();
}

async function openReader(row) {
  try {
    clearReaderPrefix();
    const rawContent = await readFile(row.filePath, 'utf8');
    const document = parseReaderDocument(rawContent, row);
    reader = {
      document,
      layoutWidth: 0,
      lines: [],
      row,
      scroll: readerPositions.get(row.filePath) ?? 0,
    };
    view = 'reader';
    render();
  } catch (error) {
    log(`Could not read ${row.path}: ${error?.message ?? error}`);
    view = 'posts';
    render();
  }
}

async function openAdjacentReader(offset) {
  const noteRows = getVisiblePostRows();
  const currentIndex = noteRows.findIndex((row) => row.filePath === reader?.row.filePath);
  const nextIndex = clamp(currentIndex + offset, 0, Math.max(0, noteRows.length - 1));
  if (nextIndex === currentIndex || !noteRows[nextIndex]) return;

  postsIndex = nextIndex;
  await openReader(noteRows[nextIndex]);
}

function setReaderScroll(nextScroll, maxScroll) {
  reader.scroll = clamp(nextScroll, 0, maxScroll);
  readerPositions.set(reader.row.filePath, reader.scroll);
  render();
}

function setReaderPrefix(prefix) {
  clearReaderPrefix();
  readerPrefix = prefix;
  readerPrefixTimer = setTimeout(() => {
    readerPrefix = '';
    readerPrefixTimer = null;
    if (view === 'reader') render();
  }, 1000);
  render();
}

function clearReaderPrefix() {
  readerPrefix = '';
  if (readerPrefixTimer) {
    clearTimeout(readerPrefixTimer);
    readerPrefixTimer = null;
  }
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
    const nextTheme = requestedTheme.toLowerCase();

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
  });
}

function openThemeSelector() {
  openOptionSelector({
    title: 'Themes',
    options: themeNames.map((name) => ({
      active: name === themeName,
      id: name,
      label: name,
      searchText: name,
      onSelect: () => changeTheme(name),
    })),
    selectedId: themeName,
  });
}

function openOptionSelector({ title, options, selectedId = '' }) {
  input = '';
  selectedCommandIndex = 0;
  commandScroll = 0;
  optionSelector = {
    options,
    query: '',
    scroll: 0,
    selectedIndex: Math.max(0, options.findIndex((option) => option.id === selectedId)),
    title,
  };
  render();
}

function closeOptionSelector() {
  optionSelector = null;
}

function resetOptionSelectorSelection() {
  if (!optionSelector) return;

  optionSelector.selectedIndex = 0;
  optionSelector.scroll = 0;
}

function getOptionSelectorMatches() {
  if (!optionSelector) return [];

  const query = optionSelector.query.trim().toLowerCase();
  if (!query) return optionSelector.options;

  return optionSelector.options.filter((option) =>
    option.searchText.toLowerCase().includes(query),
  );
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
  const styles = Array.from({ length: height }, () => Array(width).fill('normal'));

  if (isTinyLayout(width, height) || (view === 'reader' && height < 12)) {
    renderTiny(lines, styles, width, height);
  } else {
    renderCurrentView(lines, styles, width, height);
    renderFooter(lines, styles, width, height);
    if (optionSelector || input.startsWith('/')) {
      dimStyles(styles);
      renderPaletteFooter(lines, styles, width, height);
      if (optionSelector) {
        renderOptionSelector(lines, styles, width, height);
      } else {
        renderCommandPalette(lines, styles, width, height);
      }
    }
  }

  const body = lines
    .map((line, index) => paintLine(line, styles[index]))
    .join('\r\n');

  process.stdout.write(
    `${ansi.reset}\x1b[?7l\x1b[2J\x1b[H${body}\x1b[${cursorTarget.row};${cursorTarget.column}H\x1b[?7h`,
  );
}

function renderCurrentView(lines, styles, width, height) {
  if (view === 'posts') {
    renderPosts(lines, styles, width, height);
  } else if (view === 'reader') {
    renderReader(lines, styles, width, height);
  } else if (view === 'sync-confirm') {
    renderSyncConfirm(lines, styles, width, height);
  } else if (view === 'logs') {
    renderLogs(lines, styles, width, height);
  } else if (view === 'help') {
    renderHelp(lines, styles, width, height);
  } else {
    renderHome(lines, styles, width, height);
  }
}

function renderHome(lines, styles, width, height) {
  if (isCompactLayout(width, height)) {
    renderCompactHome(lines, styles, width, height);
    return;
  }

  const logoStart = clamp(Math.floor((height - brandLogo.length - 5) / 2), 2, 6);
  centerBlock(lines, styles, brandLogo, logoStart, width, 'logo');
  centerBlock(lines, styles, [dashboardSummary()], logoStart + brandLogo.length + 1, width, 'muted');
  centerBlock(lines, styles, homeActionRows(width), logoStart + brandLogo.length + 3, width, 'accent');
}

function renderCompactHome(lines, styles, width, height) {
  const content = [
    ...compactBrandLogo,
    dashboardSummary(),
    '',
    ...homeActionRows(width),
  ];
  const availableRows = Math.max(0, height - 2);
  const visibleRows = Math.min(content.length, availableRows);
  const start = Math.max(1, Math.floor((availableRows - visibleRows) / 2) + 1);

  for (let index = 0; index < visibleRows; index += 1) {
    const style =
      index < compactBrandLogo.length
        ? 'logo'
        : index === compactBrandLogo.length
          ? 'muted'
          : 'accent';
    centerBlock(lines, styles, [content[index]], start + index, width, style);
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
  const panelWidth = Math.min(88, Math.max(36, width - 4));
  const availableHeight = Math.max(6, height - 2);
  const visibleCount = Math.max(1, Math.min(suggestions.length || 1, availableHeight - 5));
  const panelHeight = visibleCount + 5;
  const startRow = Math.max(1, Math.floor((height - 2 - panelHeight) / 2) + 1);
  const startCol = Math.max(1, Math.floor((width - panelWidth) / 2) + 1);
  const innerWidth = panelWidth - 2;

  commandScroll = clamp(commandScroll, 0, Math.max(0, suggestions.length - visibleCount));
  if (selectedCommandIndex < commandScroll) commandScroll = selectedCommandIndex;
  if (selectedCommandIndex >= commandScroll + visibleCount) {
    commandScroll = selectedCommandIndex - visibleCount + 1;
  }

  fillRect(lines, styles, startRow, startCol, panelWidth, panelHeight, 'surface:normal');
  put(lines, styles, startRow, startCol, panelTopLine(panelWidth, 'Commands', 'esc'), 'surface:border');

  const searchText = startEllipsis(input, Math.max(0, innerWidth - 3));
  put(
    lines,
    styles,
    startRow + 1,
    startCol,
    `│ ${padDisplayWidth(`› ${searchText}`, innerWidth - 2)} │`,
    'surface:normal',
  );
  put(
    lines,
    styles,
    startRow + 2,
    startCol,
    `├${'─'.repeat(Math.max(0, innerWidth))}┤`,
    'surface:border',
  );

  const pageCommands = suggestions.slice(commandScroll, commandScroll + visibleCount);
  for (let pageIndex = 0; pageIndex < visibleCount; pageIndex += 1) {
    const row = startRow + 3 + pageIndex;
    const commandIndex = commandScroll + pageIndex;
    const command = pageCommands[pageIndex];
    const selected = command && commandIndex === selectedCommandIndex;
    const styleName = selected ? 'surface:selected' : 'surface:normal';
    const text = command
      ? `${selected ? '›' : ' '} ${command.name.padEnd(12, ' ')} ${command.help}`
      : '  No matching command.';

    fillRect(lines, styles, row, startCol + 1, innerWidth, 1, styleName);
    put(lines, styles, row, startCol, '│', 'surface:border');
    put(lines, styles, row, startCol + 1, padDisplayWidth(text, innerWidth), styleName);
    put(lines, styles, row, startCol + panelWidth - 1, '│', 'surface:border');
  }

  put(
    lines,
    styles,
    startRow + panelHeight - 2,
    startCol,
    `│ ${padDisplayWidth('Enter run  Esc close  ↑/↓ select', innerWidth - 2)} │`,
    'surface:muted',
  );
  put(
    lines,
    styles,
    startRow + panelHeight - 1,
    startCol,
    `└${'─'.repeat(Math.max(0, innerWidth))}┘`,
    'surface:border',
  );

  cursorTarget = {
    column: clamp(startCol + 3 + displayWidth(searchText), 1, width),
    row: startRow + 1,
  };
}

function panelTopLine(width, title, rightLabel) {
  const left = `┌ ${title} `;
  const right = ` ${rightLabel} ┐`;
  return `${left}${'─'.repeat(Math.max(0, width - displayWidth(left) - displayWidth(right)))}${right}`;
}

function renderOptionSelector(lines, styles, width, height) {
  const options = getOptionSelectorMatches();
  optionSelector.selectedIndex = clamp(
    optionSelector.selectedIndex,
    0,
    Math.max(0, options.length - 1),
  );
  const panelWidth = Math.min(72, Math.max(32, width - 4));
  const availableHeight = Math.max(6, height - 4);
  const visibleCount = Math.max(1, Math.min(options.length || 1, availableHeight - 4));
  const panelHeight = visibleCount + 4;
  const startRow = Math.max(1, Math.floor((height - 2 - panelHeight) / 2) + 1);
  const startCol = Math.max(1, Math.floor((width - panelWidth) / 2) + 1);
  const innerWidth = panelWidth - 4;

  optionSelector.scroll = clamp(
    optionSelector.scroll,
    0,
    Math.max(0, options.length - visibleCount),
  );
  if (optionSelector.selectedIndex < optionSelector.scroll) {
    optionSelector.scroll = optionSelector.selectedIndex;
  }
  if (optionSelector.selectedIndex >= optionSelector.scroll + visibleCount) {
    optionSelector.scroll = optionSelector.selectedIndex - visibleCount + 1;
  }

  fillRect(lines, styles, startRow, startCol, panelWidth, panelHeight, 'surface:normal');
  put(lines, styles, startRow + 1, startCol + 2, optionSelector.title, 'surface:strong');
  put(
    lines,
    styles,
    startRow + 1,
    startCol + panelWidth - 5,
    'esc',
    'surface:muted',
  );

  const queryWidth = Math.max(0, innerWidth - 1);
  const query = optionSelector.query
    ? startEllipsis(optionSelector.query, queryWidth)
    : 'Search';
  put(
    lines,
    styles,
    startRow + 3,
    startCol + 2,
    query,
    optionSelector.query ? 'surface:normal' : 'surface:muted',
  );

  const pageOptions = options.slice(optionSelector.scroll, optionSelector.scroll + visibleCount);
  for (let pageIndex = 0; pageIndex < visibleCount; pageIndex += 1) {
    const row = startRow + 4 + pageIndex;
    const optionIndex = optionSelector.scroll + pageIndex;
    const option = pageOptions[pageIndex];
    const selected = option && optionIndex === optionSelector.selectedIndex;
    const styleName = selected ? 'surface:selected' : 'surface:normal';
    const marker = option?.active ? '●' : ' ';
    const text = option ? `${marker} ${option.label}` : '  No matching option.';

    if (selected) {
      fillRect(lines, styles, row, startCol + 1, panelWidth - 2, 1, styleName);
    }
    put(lines, styles, row, startCol + 2, padDisplayWidth(text, innerWidth), styleName);
  }

  cursorTarget = {
    column: clamp(
      startCol + 2 + (optionSelector.query ? displayWidth(query) : 0),
      1,
      width,
    ),
    row: startRow + 3,
  };
}

function renderPosts(lines, styles, width, height) {
  const contentWidth = Math.min(96, Math.max(28, width - 8));
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));

  if (postsMode === 'trash') {
    const content = ['Local trash', '', ...wrapLines(formatTrashItems(trashItems), contentWidth)];
    for (let index = 0; index < Math.min(content.length, height - 5); index += 1) {
      put(lines, styles, index + 3, col, content[index], index === 0 ? 'accent' : 'normal');
    }
    return;
  }

  const visibleRows = getVisiblePostRows();
  postsIndex = clamp(postsIndex, 0, Math.max(0, visibleRows.length - 1));
  const visibleCount = Math.max(1, height - 7);
  postsScroll = clamp(postsScroll, 0, Math.max(0, visibleRows.length - visibleCount));
  if (postsIndex < postsScroll) postsScroll = postsIndex;
  if (postsIndex >= postsScroll + visibleCount) postsScroll = postsIndex - visibleCount + 1;

  put(lines, styles, 3, col, 'Posts', 'accent');

  if (!visibleRows.length) {
    put(lines, styles, 5, col, 'No drafts or posts yet.', 'normal');
    return;
  }

  const pageRows = visibleRows.slice(postsScroll, postsScroll + visibleCount);
  for (let pageIndex = 0; pageIndex < pageRows.length; pageIndex += 1) {
    const rowIndex = postsScroll + pageIndex;
    const row = pageRows[pageIndex];
    const prefix = rowIndex === postsIndex ? '> ' : '  ';
    put(
      lines,
      styles,
      pageIndex + 5,
      col,
      `${prefix}${padDisplayWidth(row.status, 6)} ${padDisplayWidth(row.date, 10)} ${row.title}  ${row.path}`,
      rowIndex === postsIndex ? 'selected' : 'normal',
    );
  }
}

function renderReader(lines, styles, width, height) {
  const contentWidth = Math.min(96, Math.max(28, width - 8));
  const col = Math.max(2, Math.floor((width - contentWidth) / 2));

  if (!reader) {
    put(lines, styles, 3, col, 'Could not open this post.', 'accent');
    return;
  }

  const { metadata } = reader.document;
  put(lines, styles, 2, col, metadata.title, 'accent');

  const details = [metadata.date, metadata.category].filter(Boolean).join('  ·  ');
  if (details) put(lines, styles, 3, col, details, 'muted');
  if (metadata.tags.length) {
    put(lines, styles, 4, col, metadata.tags.map((tag) => `#${tag}`).join('  '), 'muted');
  }

  put(lines, styles, 5, col, '─'.repeat(contentWidth), 'border');

  ensureReaderLayout(contentWidth);
  const pageRows = getReaderPageRows(height);
  const maxScroll = Math.max(0, reader.lines.length - pageRows);
  reader.scroll = clamp(reader.scroll, 0, maxScroll);
  readerPositions.set(reader.row.filePath, reader.scroll);

  const visibleLines = reader.lines.slice(reader.scroll, reader.scroll + pageRows);
  for (let index = 0; index < visibleLines.length; index += 1) {
    const line = visibleLines[index];
    put(lines, styles, index + 7, col, line.text, line.style);
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
  const leftColumn = width > 54 ? 3 : 1;
  const statusRow = Math.max(1, height - 1);
  const inputRow = Math.max(1, height);
  const maxInput = Math.max(1, width - leftColumn - 2);
  const displayInput = startEllipsis(input, maxInput);
  const inputText = `› ${displayInput}`;

  put(lines, styles, statusRow, leftColumn, footerStatus(width, height), 'muted');
  put(lines, styles, inputRow, leftColumn, inputText, 'normal');

  cursorTarget = {
    column: Math.min(width, leftColumn + 2 + displayWidth(displayInput)),
    row: clamp(inputRow, 1, height),
  };
}

function renderPaletteFooter(lines, styles, width, height) {
  clearRow(lines, styles, height - 1);
  clearRow(lines, styles, height);
  put(lines, styles, height - 1, width > 54 ? 3 : 1, 'Esc close', 'muted');
}

function footerStatus(width, height) {
  if (busy) return 'Working...';
  if (view === 'reader') return readerFooterStatus(width, height);
  if (view === 'posts' && pendingDeletePath) return `Press d again to trash: ${pendingDeletePath}`;
  if (view === 'posts' && postsMode === 'trash') return 't posts  Esc home  / commands';
  if (view === 'posts') return 'Enter read  e edit  d d trash  t trash  Esc home  / commands';
  if (view === 'sync-confirm') return 'Enter sync  Esc later  / commands';
  if (view === 'logs' || view === 'help') return 'Esc home  / commands';
  return '/ commands  quit exit';
}

function readerFooterStatus(width, height) {
  if (!reader) return 'Esc posts  / commands';

  const pageRows = getReaderPageRows(height);
  const start = reader.lines.length ? reader.scroll + 1 : 0;
  const end = Math.min(reader.lines.length, reader.scroll + pageRows);
  const progress = reader.lines.length ? Math.round((end / reader.lines.length) * 100) : 100;
  const progressText = `${start}-${end}/${reader.lines.length}  ${progress}%`;
  const prefix = readerPrefix ? `${readerPrefix}…  ` : '';
  const controls =
    width >= 90
      ? 'j/k scroll  ^F/^B page  gg top  G end  n/p next  e edit  Esc posts  / commands'
      : 'j/k  ^F/^B  gg/G  n/p  e  Esc  /';
  const footerWidth = width - (width > 54 ? 2 : 0);
  const controlsWidth = Math.max(
    0,
    footerWidth - displayWidth(prefix) - displayWidth(progressText) - 3,
  );
  return `${prefix}${clipDisplayWidth(controls, controlsWidth)}   ${progressText}`;
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

    for (let offset = 0; offset < width; offset += 1) {
      clearCell(lines[row], cursor + offset);
    }
    lines[row][cursor] = character;
    styles[row][cursor] = styleName;
    for (let offset = 1; offset < width; offset += 1) {
      lines[row][cursor + offset] = '';
      styles[row][cursor + offset] = styleName;
    }
    cursor += width;
  }
}

function fillRect(lines, styles, rowNumber, columnNumber, width, height, styleName) {
  for (let row = rowNumber - 1; row < rowNumber - 1 + height; row += 1) {
    if (row < 0 || row >= lines.length) continue;
    for (let column = columnNumber - 1; column < columnNumber - 1 + width; column += 1) {
      if (column < 0 || column >= lines[row].length) continue;
      clearCell(lines[row], column);
      lines[row][column] = ' ';
      styles[row][column] = styleName;
    }
  }
}

function clearCell(line, column) {
  let start = column;
  while (start > 0 && !line[start]) start -= 1;

  const width = characterWidth(line[start] || ' ');
  if (start === column && width === 1) return;

  for (let offset = 0; offset < width && start + offset < line.length; offset += 1) {
    line[start + offset] = ' ';
  }
}

function clearRow(lines, styles, rowNumber) {
  fillRect(lines, styles, rowNumber, 1, lines[0]?.length ?? 0, 1, 'normal');
}

function dimStyles(styles) {
  for (const row of styles) {
    for (let index = 0; index < row.length; index += 1) {
      row[index] = `dim:${row[index]}`;
    }
  }
}

function paintLine(line, styles) {
  let activeStyle = '';
  let result = '';

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (!character) continue;

    const style = ansiForStyle(styles[index]);
    if (style !== activeStyle) {
      result += `${ansi.reset}${style}`;
      activeStyle = style;
    }
    result += character;
  }

  return `${result}${ansi.reset}`;
}

function ansiForStyle(styleName) {
  const theme = themes[themeName];
  const parts = String(styleName).split(':');
  const tone = parts.at(-1);
  const flags = new Set(parts.slice(0, -1));
  const selected = tone === 'selected' || flags.has('selected');
  const foreground = {
    accent: theme.accent,
    border: theme.border,
    faint: theme.faint,
    logo: theme.logo,
    muted: theme.muted,
    normal: theme.text,
    selected: theme.selectedText,
    strong: theme.text,
  };
  const background = selected
    ? theme.selectedBg
    : flags.has('surface')
      ? theme.surfaceBg
      : theme.bg;
  const emphasis = tone === 'accent' || tone === 'selected' || tone === 'strong' ? ansi.strong : '';
  return `${background}${flags.has('dim') ? ansi.dim : ''}${emphasis}${foreground[tone] ?? theme.text}`;
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

function getReaderPageRows(height = process.stdout.rows || 32) {
  return Math.max(1, height - 8);
}

function ensureReaderLayout(width) {
  if (!reader || reader.layoutWidth === width) return;

  reader.lines = layoutReaderDocument(reader.document, width);
  reader.layoutWidth = width;
}

function parseReaderDocument(rawContent, row) {
  const { frontmatter, body } = splitReaderFrontmatter(rawContent);
  const values = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][\w-]*):\s*(.*)$/);
    if (match) values[match[1]] = match[2];
  }

  return {
    body,
    metadata: {
      category: stripReaderQuotes(values.category),
      date: stripReaderQuotes(values.date) || row.date,
      tags: parseReaderTags(values.tags),
      title: stripReaderQuotes(values.title) || row.title,
    },
  };
}

function splitReaderFrontmatter(content) {
  const match = String(content).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { body: String(content), frontmatter: '' };

  return {
    body: String(content).slice(match[0].length),
    frontmatter: match[1],
  };
}

function parseReaderTags(value = '') {
  const list = String(value).trim().replace(/^\[/, '').replace(/\]$/, '');
  if (!list) return [];

  return list
    .split(',')
    .map((tag) => stripReaderQuotes(tag.trim()))
    .filter(Boolean);
}

function stripReaderQuotes(value = '') {
  const text = String(value).trim();
  if (
    (text.startsWith('"') && text.endsWith('"')) ||
    (text.startsWith("'") && text.endsWith("'"))
  ) {
    return text.slice(1, -1);
  }
  return text;
}

function layoutReaderDocument(document, width) {
  const lines = [];
  let inCodeBlock = false;

  for (const rawLine of document.body.split(/\r?\n/)) {
    const fence = rawLine.match(/^\s*(```|~~~)\s*([^`]*)$/);
    if (fence) {
      inCodeBlock = !inCodeBlock;
      const language = fence[2].trim();
      const text =
        inCodeBlock && language
          ? `[Code: ${language}]`
          : inCodeBlock
            ? '[Code]'
            : '[End code]';
      lines.push({ style: 'muted', text });
      continue;
    }

    let style = inCodeBlock ? 'faint' : 'normal';
    let text = inCodeBlock ? `  ${rawLine}` : formatReaderMarkdownLine(rawLine);

    if (!inCodeBlock && /^\s*#{1,6}\s+/.test(text)) {
      style = 'accent';
    } else if (!inCodeBlock && /^\s*>\s?/.test(text)) {
      style = 'muted';
      text = text.replace(/^(\s*)>\s?/, '$1│ ');
    } else if (!inCodeBlock && /^\s*([-*_])(?:\s*\1){2,}\s*$/.test(text)) {
      style = 'border';
      text = '─'.repeat(Math.min(width, 40));
    }

    for (const chunk of wrapLine(text, width)) {
      lines.push({ style, text: chunk });
    }
  }

  return lines.some((line) => line.text.trim())
    ? lines
    : [{ style: 'muted', text: 'This draft is empty.' }];
}

function formatReaderMarkdownLine(line) {
  return String(line)
    .replace(/!\[\[([^\]]+)\]\]/g, (_, target) => `[Image] ${target}`)
    .replace(
      /!\[([^\]]*)\]\(([^)]+)\)/g,
      (_, alt, target) => `[Image: ${alt || 'image'}] ${target}`,
    )
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, label, target) => `${label} (${target})`)
    .replace(/<\/?[A-Za-z][^>]*>/g, '')
    .replace(/(\*\*|__)(.*?)\1/g, '$2')
    .replace(/~~(.*?)~~/g, '$1');
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
  clearReaderPrefix();
  if (resizeTimer) {
    clearTimeout(resizeTimer);
    resizeTimer = null;
  }
  process.stdout.write(`${ansi.reset}\x1b[?7h\x1b[?25h\x1b[?1049l`);
}
