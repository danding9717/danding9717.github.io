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
import {
  aiConnectionLabel,
  aiConnectionModes,
  assistantConnectionStatus,
  backupAndReplaceMarkdownBody,
  backupAndWriteMarkdownContent,
  defaultApiModel,
  defaultMockModel,
  defaultOpenAiModel,
  getWritingAssistantActionByCommand,
  getWritingAssistantAction,
  hasApiKeyConnection,
  hasOpenAiApiKey,
  hasXaiApiKey,
  listKnownGrokModels,
  normalizeAiConnection,
  normalizeAiModel,
  repairAiModelForConnection,
  requestWritingAssistanceStream,
  refreshGrokCliModels,
  runGrokLogin,
  writingAssistantActions,
} from './grok-writing-agent.mjs';
import { autosavePathFor, exportPathFor } from './writing-agent/storage.mjs';

const onlineBlogUrl = 'https://danding9717.github.io/';
const maxLogLines = 12;
const themeNames = ['light', 'dark', 'diablo'];
const commandSelectionHelp = '↑/↓ select  Enter run  Esc close';
const editorFilePanelMinWidth = 22;
const editorFilePanelMaxWidth = 34;
const editorThreeColumnMinTerminalWidth = 132;
const assistantPanelMinWidth = 34;
const assistantPanelMaxWidth = 48;
const assistantSidePanelMinTerminalWidth = 100;
const editorCommands = [
  { id: 'idea', label: 'Generate Idea' },
  { id: 'outline', label: 'Generate Outline' },
  { id: 'draft', label: 'Write Draft' },
  { id: 'rewrite', label: 'Rewrite Selection' },
  { id: 'polish', label: 'Polish Selection' },
  { id: 'expand', label: 'Expand Selection' },
  { id: 'compress', label: 'Compress Selection' },
  { id: 'title', label: 'Generate Titles' },
  { id: 'critic', label: 'Critique Article' },
  { id: 'save', label: 'Save File' },
  { id: 'export', label: 'Export Markdown' },
];
const commands = [
  { name: '/home', label: 'Home', help: 'Return to the dashboard' },
  { name: '/write', label: 'Write', help: 'Open today draft, or use /write YYYYMMDD' },
  { name: '/posts', label: 'Posts', help: 'Manage drafts, posts, and local trash' },
  { name: '/preview', label: 'Preview', help: 'Open the deployed blog website' },
  { name: '/publish', label: 'Publish', help: 'Choose a draft to publish, optional date allowed' },
  { name: '/sync', label: 'Sync', help: 'Build, commit, and push current changes' },
  { name: '/theme', label: 'Theme', help: 'Choose theme, or use /theme light|dark|diablo' },
  { name: '/models', label: 'Models', help: 'Choose the AI writing model' },
  { name: '/connect', label: 'Connect', help: 'Choose Mock, API key, or Grok browser login' },
  { name: '/settings', label: 'Settings', help: 'Choose editor, keymap, model, and connection' },
  { name: '/logs', label: 'Logs', help: 'Show recent activity' },
  { name: '/help', label: 'Help', help: 'Show command help' },
  { name: '/quit', label: 'Quit', help: 'Exit blog admin' },
];
const commandNames = new Set(commands.map((command) => command.name));
const brandLogo = [
  '        ▄███████▄        ',
  '     ▄█████████████▄     ',
  '   ▄█████████████████▄   ',
  ' ▄█████████████████████▄ ',
  '█████████████████████████',
  '                         ',
  '           ███           ',
  '           ███           ',
  '      ▄    ███           ',
  '      ████████           ',
  '       ▀████▀            ',
];
const compactBrandLogo = [
  '    ▄█████▄    ',
  '  ▄█████████▄  ',
  '███████████████',
  '       ██      ',
  '   ▄   ██      ',
  '   ██████      ',
  '    ▀██▀       ',
];
const configPath = path.join(os.homedir(), '.config/myblog/config.json');
const themes = {
  light: {
    bg: '\x1b[48;5;255m',
    cursorColor: '#303030',
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
    cursorColor: '#d0d0d0',
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
    bg: '\x1b[48;5;232m',
    cursorColor: '#d7af00',
    surfaceBg: '\x1b[48;5;233m',
    selectedBg: '\x1b[48;5;58m',
    selectedText: '\x1b[38;5;230m',
    border: '\x1b[38;5;58m',
    faint: '\x1b[38;5;238m',
    logo: '\x1b[38;5;178m',
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
let defaultEditor = 'builtin';
let editorKeymap = 'simple';
let editorLineNumbers = false;
let autoSaveEnabled = true;
let aiConnection = aiConnectionModes.apiKey;
let aiModel = '';
let grokCliDefaultModel = '';
let grokCliModels = [];
let editor = null;
let resizeTimer = null;
let readerPrefix = '';
let readerPrefixTimer = null;
let terminalReady = false;
let cursorTarget = { column: 1, row: 1 };
let homeCommandInputRect = null;
let editorAutosaveTimer = null;
let assistantRequestSeq = 0;

if (process.argv.includes('--check')) {
  rows = await listNotes();
  console.log(`Blog Admin OK\n项目：${projectRoot}\n\n${formatNoteRows(rows)}`);
  process.exit(0);
}

await loadPreferences();
await repairAiModelPreference({ persist: true });
await refreshRows();
setupTerminal();
render();

readline.emitKeypressEvents(process.stdin);
process.stdin.on('keypress', async (value, key = {}) => {
  if (key.ctrl && key.name === 'c') {
    if (view === 'editor') {
      await requestEditorClose({ exitApplication: true });
    } else {
      await exitAdmin();
    }
    return;
  }

  if (busy && !(view === 'editor' && editor?.assistant?.loading)) return;

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

    if (view === 'editor') {
      await handleEditorEscape();
      return;
    }

    if (input.startsWith('/')) {
      setCommandInput('');
      render();
      return;
    }

    clearReaderPrefix();
    if (view === 'sync-confirm') {
      log('Sync postponed. Run /sync when the GitHub Pages update is ready to send.');
    }
    setCommandInput('');
    pendingDeletePath = '';
    pendingSyncMessage = '';
    view = view === 'reader' ? 'posts' : 'home';
    render();
    return;
  }

  if (optionSelector) {
    await handleOptionSelectorKeys(value, key);
    return;
  }

  if (view === 'editor') {
    await handleEditorKeys(value, key);
    return;
  }

  if (input.startsWith('/')) {
    await handleCommandInput(value, key);
    return;
  }

  if (value === '/') {
    clearReaderPrefix();
    setCommandInput('/');
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
      setCommandInput('');
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
    resetCommandSelection();
    render();
    return;
  }

  if (key.ctrl && key.name === 'u') {
    setCommandInput('/');
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
    resetCommandSelection();
    render();
  }
}

async function handlePostsKeys(value, key) {
  const visibleRows = getVisiblePostRows();

  if (value === '/') {
    setCommandInput('/');
    pendingDeletePath = '';
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

  if (await handleOpenEditorShortcut(key, selectedRow)) return;

  if (key.name === 'd' && selectedRow) {
    await requestOrConfirmDelete(selectedRow);
  }
}

async function handleReaderKeys(value, key) {
  if (value === '/') {
    clearReaderPrefix();
    setCommandInput('/');
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

  if (await handleOpenEditorShortcut(key, reader.row)) return;

  if (key.name === 'n') {
    await openAdjacentReader(1);
    return;
  }

  if (key.name === 'p') {
    await openAdjacentReader(-1);
  }
}

async function handleEditorEscape() {
  if (!editor) return;

  if (isAssistantFocused()) {
    editor.assistant.focused = false;
    editor.assistant.status = '';
    render();
    return;
  }

  if (editor.promptMode) {
    editor.promptMode = '';
    editor.commandInput = '';
    editor.status = '';
    render();
    return;
  }

  if (editor.keymap === 'vim') {
    if (editor.vimMode === 'insert') {
      editor.vimMode = 'normal';
    }
    editor.vimPending = '';
    editor.status = '';
    render();
    return;
  }

  await requestEditorClose();
}

async function handleEditorKeys(value, key) {
  if (!editor) return;

  if (key.ctrl && key.name === 'a' && isAssistantEnabled()) {
    toggleAssistantFocus();
    return;
  }

  if (key.ctrl && key.name === 'n') {
    await createAndOpenNewDraft();
    return;
  }

  if (key.ctrl && key.name === 's') {
    await saveEditor();
    return;
  }

  if (key.ctrl && key.name === 'o') {
    await openEditorFileSelector();
    return;
  }

  if (key.ctrl && key.name === 'k') {
    openEditorCommandPalette();
    return;
  }

  if (key.ctrl && key.name === 'q') {
    await requestEditorClose();
    return;
  }

  if (key.ctrl && key.name === 'x' && editor.assistant?.loading) {
    cancelAssistantRequest();
    return;
  }

  if (key.ctrl && (key.name === 'return' || key.name === 'enter')) {
    await submitAssistantRequest();
    return;
  }

  if (editor.assistant?.loading) return;

  if (!isAssistantFocused() && key.ctrl && key.name === 'r') {
    await runAssistantAction('rewrite');
    return;
  }

  if (!isAssistantFocused() && key.ctrl && key.name === 'p') {
    await runAssistantAction('polish');
    return;
  }

  if (!isAssistantFocused() && key.ctrl && key.name === 't') {
    await runAssistantAction('title');
    return;
  }

  if (isAssistantFocused()) {
    await handleAssistantKeys(value, key);
    return;
  }

  if (editor.promptMode) {
    await handleEditorPromptKeys(value, key);
    return;
  }

  if (editor.keymap === 'vim') {
    await handleVimEditorKeys(value, key);
  } else {
    await handleSimpleEditorKeys(value, key);
  }
}

async function handleAssistantKeys(value, key) {
  if (!editor?.assistant) return;

  const assistant = editor.assistant;

  if (key.ctrl && key.name === 'x' && assistant.loading) {
    cancelAssistantRequest();
    return;
  }

  if (key.name === 'escape') {
    assistant.focused = false;
    assistant.status = '';
    render();
    return;
  }

  if (key.ctrl && key.name === 'r') {
    await requestAssistantReplacement();
    return;
  }

  if (key.ctrl && key.name === 'u') {
    assistant.input = '';
    render();
    return;
  }

  if (key.ctrl && key.name === 'n') {
    moveAssistantAction(1);
    return;
  }

  if (key.ctrl && key.name === 'p') {
    moveAssistantAction(-1);
    return;
  }

  if (key.name === 'left') {
    moveAssistantAction(-1);
    return;
  }

  if (key.name === 'right' || key.name === 'tab') {
    moveAssistantAction(1);
    return;
  }

  if (key.name === 'up') {
    scrollAssistantResult(-1);
    return;
  }

  if (key.name === 'down') {
    scrollAssistantResult(1);
    return;
  }

  if (key.name === 'pageup') {
    scrollAssistantResult(-Math.max(1, Math.floor((process.stdout.rows || 32) / 2)));
    return;
  }

  if (key.name === 'pagedown') {
    scrollAssistantResult(Math.max(1, Math.floor((process.stdout.rows || 32) / 2)));
    return;
  }

  if (key.name === 'backspace') {
    assistant.input = Array.from(assistant.input).slice(0, -1).join('');
    render();
    return;
  }

  if (key.name === 'return') {
    await submitAssistantRequest();
    return;
  }

  if (isPrintable(value)) {
    assistant.input += value;
    render();
  }
}

async function handleEditorPromptKeys(value, key) {
  if (!editor) return;

  if (key.name === 'backspace') {
    editor.commandInput = Array.from(editor.commandInput).slice(0, -1).join('');
    render();
    return;
  }

  if (key.ctrl && key.name === 'u') {
    editor.commandInput = '';
    render();
    return;
  }

  if (key.name === 'return') {
    if (editor.promptMode === 'command') {
      const command = editor.commandInput;
      editor.promptMode = '';
      editor.commandInput = '';
      await executeEditorCommand(command);
      return;
    }

    if (editor.commandInput) {
      editor.searchQuery = editor.commandInput;
    }
    const direction = key.shift ? -1 : 1;
    if (editor.searchQuery) moveToEditorSearchMatch(direction);
    if (editor.promptMode === 'search') {
      editor.promptMode = '';
      editor.commandInput = '';
    }
    render();
    return;
  }

  if (isPrintable(value)) {
    editor.commandInput += value;
    render();
  }
}

async function handleSimpleEditorKeys(value, key) {
  if (!editor) return;

  if (key.ctrl && key.name === 'f') {
    editor.promptMode = 'find';
    editor.commandInput = editor.searchQuery;
    render();
    return;
  }

  if (key.ctrl && key.name === 'z' && key.shift) {
    redoEditor();
    return;
  }

  if (key.ctrl && key.name === 'z') {
    undoEditor();
    return;
  }

  if (key.ctrl && key.name === 'y') {
    redoEditor();
    return;
  }

  if (handleEditorNavigationKey(key)) return;
  if (handleEditorMutationKey(value, key)) return;
}

async function handleVimEditorKeys(value, key) {
  if (!editor) return;

  if (editor.vimMode === 'insert') {
    if (key.ctrl && key.name === 'z') {
      undoEditor();
      return;
    }
    if (key.ctrl && key.name === 'r') {
      redoEditor();
      return;
    }
    if (handleEditorNavigationKey(key)) return;
    handleEditorMutationKey(value, key);
    return;
  }

  if (key.ctrl && key.name === 'r') {
    redoEditor();
    return;
  }

  if (handleEditorNavigationKey(key)) return;

  const pending = editor.vimPending;
  editor.vimPending = '';
  if (pending === 'g' && value === 'g') {
    moveEditorToLine(0);
    return;
  }
  if (pending === 'd' && value === 'd') {
    deleteEditorLine();
    return;
  }

  if (value === 'h') {
    moveEditorCursorHorizontal(-1);
  } else if (value === 'j') {
    moveEditorCursorVertical(1);
  } else if (value === 'k') {
    moveEditorCursorVertical(-1);
  } else if (value === 'l') {
    moveEditorCursorHorizontal(1);
  } else if (value === '0') {
    moveEditorCursorToLineBoundary('start');
  } else if (value === '$') {
    moveEditorCursorToLineBoundary('end');
  } else if (value === 'w') {
    moveEditorWord(1);
  } else if (value === 'b') {
    moveEditorWord(-1);
  } else if (value === 'G') {
    moveEditorToLine(editor.lines.length - 1);
  } else if (value === 'g') {
    editor.vimPending = 'g';
    render();
  } else if (value === 'd') {
    editor.vimPending = 'd';
    render();
  } else if (value === 'i') {
    editor.vimMode = 'insert';
    render();
  } else if (value === 'a') {
    moveEditorCursorHorizontal(1, false);
    editor.vimMode = 'insert';
    render();
  } else if (value === 'o') {
    openEditorLine(1);
  } else if (value === 'O') {
    openEditorLine(0);
  } else if (value === 'x') {
    deleteEditorForward();
  } else if (value === 'u') {
    undoEditor();
  } else if (value === '/') {
    editor.promptMode = 'search';
    editor.commandInput = '';
    render();
  } else if (value === ':') {
    editor.promptMode = 'command';
    editor.commandInput = '';
    render();
  } else if (value === 'n' && editor.searchQuery) {
    moveToEditorSearchMatch(1);
  } else if (value === 'N' && editor.searchQuery) {
    moveToEditorSearchMatch(-1);
  }
}

async function executeEditorCommand(command) {
  if (!editor) return;

  if (command === 'w') {
    await saveEditor();
  } else if (command === 'q') {
    await requestEditorClose();
  } else if (command === 'wq') {
    await saveEditor({ onSaved: () => finishEditorClose() });
  } else if (command === 'q!') {
    await finishEditorClose();
  } else {
    editor.status = `Not an editor command: ${command}`;
    render();
  }
}

function handleEditorNavigationKey(key) {
  if (!editor) return false;

  if (key.name === 'left') {
    moveEditorCursorHorizontal(-1);
  } else if (key.name === 'right') {
    moveEditorCursorHorizontal(1);
  } else if (key.name === 'up') {
    moveEditorCursorVertical(-1);
  } else if (key.name === 'down') {
    moveEditorCursorVertical(1);
  } else if (key.name === 'home') {
    moveEditorCursorToLineBoundary('start');
  } else if (key.name === 'end') {
    moveEditorCursorToLineBoundary('end');
  } else if (key.name === 'pageup') {
    moveEditorCursorVertical(-getEditorPageRows());
  } else if (key.name === 'pagedown') {
    moveEditorCursorVertical(getEditorPageRows());
  } else {
    return false;
  }

  return true;
}

function handleEditorMutationKey(value, key) {
  if (!editor) return false;

  if (key.name === 'return') {
    splitEditorLine();
  } else if (key.name === 'backspace') {
    deleteEditorBackward();
  } else if (key.name === 'delete') {
    deleteEditorForward();
  } else if (key.name === 'tab') {
    insertEditorText('  ');
  } else if (
    typeof value === 'string' &&
    value &&
    !key.ctrl &&
    !key.meta &&
    (isPrintable(value) || /[\r\n]/.test(value))
  ) {
    insertEditorText(value);
  } else {
    return false;
  }

  return true;
}

function recordEditorHistory() {
  if (!editor) return;

  editor.history.push({
    cursor: { ...editor.cursor },
    lines: [...editor.lines],
  });
  editor.history = editor.history.slice(-200);
  editor.redo = [];
}

function undoEditor() {
  if (!editor || !editor.history.length) return;

  editor.redo.push({
    cursor: { ...editor.cursor },
    lines: [...editor.lines],
  });
  const snapshot = editor.history.pop();
  editor.lines = snapshot.lines;
  editor.cursor = snapshot.cursor;
  editor.status = 'Undo.';
  scheduleEditorAutosave();
  render();
}

function redoEditor() {
  if (!editor || !editor.redo.length) return;

  editor.history.push({
    cursor: { ...editor.cursor },
    lines: [...editor.lines],
  });
  const snapshot = editor.redo.pop();
  editor.lines = snapshot.lines;
  editor.cursor = snapshot.cursor;
  editor.status = 'Redo.';
  scheduleEditorAutosave();
  render();
}

function insertEditorText(value) {
  if (!editor) return;

  recordEditorHistory();
  const line = editor.lines[editor.cursor.line] ?? '';
  const characters = Array.from(line);
  const before = characters.slice(0, editor.cursor.column).join('');
  const after = characters.slice(editor.cursor.column).join('');
  const insertedLines = String(value).replace(/\r\n?/g, '\n').split('\n');

  if (insertedLines.length === 1) {
    editor.lines[editor.cursor.line] = `${before}${insertedLines[0]}${after}`;
    editor.cursor.column += Array.from(insertedLines[0]).length;
  } else {
    const replacement = [
      `${before}${insertedLines[0]}`,
      ...insertedLines.slice(1, -1),
      `${insertedLines.at(-1)}${after}`,
    ];
    editor.lines.splice(editor.cursor.line, 1, ...replacement);
    editor.cursor.line += replacement.length - 1;
    editor.cursor.column = Array.from(insertedLines.at(-1)).length;
  }

  editor.status = '';
  scheduleEditorAutosave();
  render();
}

function splitEditorLine() {
  if (!editor) return;

  recordEditorHistory();
  const characters = Array.from(editor.lines[editor.cursor.line] ?? '');
  const before = characters.slice(0, editor.cursor.column).join('');
  const after = characters.slice(editor.cursor.column).join('');
  editor.lines.splice(editor.cursor.line, 1, before, after);
  editor.cursor.line += 1;
  editor.cursor.column = 0;
  editor.status = '';
  scheduleEditorAutosave();
  render();
}

function deleteEditorBackward() {
  if (!editor) return;

  if (editor.cursor.column > 0) {
    recordEditorHistory();
    const characters = Array.from(editor.lines[editor.cursor.line] ?? '');
    characters.splice(editor.cursor.column - 1, 1);
    editor.lines[editor.cursor.line] = characters.join('');
    editor.cursor.column -= 1;
  } else if (editor.cursor.line > 0) {
    recordEditorHistory();
    const previous = editor.lines[editor.cursor.line - 1];
    const current = editor.lines[editor.cursor.line];
    editor.cursor.line -= 1;
    editor.cursor.column = Array.from(previous).length;
    editor.lines.splice(editor.cursor.line, 2, `${previous}${current}`);
  } else {
    return;
  }

  editor.status = '';
  scheduleEditorAutosave();
  render();
}

function deleteEditorForward() {
  if (!editor) return;

  const characters = Array.from(editor.lines[editor.cursor.line] ?? '');
  if (editor.cursor.column < characters.length) {
    recordEditorHistory();
    characters.splice(editor.cursor.column, 1);
    editor.lines[editor.cursor.line] = characters.join('');
  } else if (editor.cursor.line < editor.lines.length - 1) {
    recordEditorHistory();
    editor.lines.splice(
      editor.cursor.line,
      2,
      `${editor.lines[editor.cursor.line]}${editor.lines[editor.cursor.line + 1]}`,
    );
  } else {
    return;
  }

  editor.status = '';
  scheduleEditorAutosave();
  render();
}

function deleteEditorLine() {
  if (!editor) return;

  recordEditorHistory();
  if (editor.lines.length === 1) {
    editor.lines[0] = '';
  } else {
    editor.lines.splice(editor.cursor.line, 1);
    editor.cursor.line = Math.min(editor.cursor.line, editor.lines.length - 1);
  }
  editor.cursor.column = Math.min(
    editor.cursor.column,
    Array.from(editor.lines[editor.cursor.line] ?? '').length,
  );
  editor.status = '';
  scheduleEditorAutosave();
  render();
}

function openEditorLine(offset) {
  if (!editor) return;

  recordEditorHistory();
  const target = editor.cursor.line + offset;
  editor.lines.splice(target, 0, '');
  editor.cursor = { column: 0, line: target };
  editor.vimMode = 'insert';
  editor.status = '';
  scheduleEditorAutosave();
  render();
}

function moveEditorCursorHorizontal(offset, wrap = true) {
  if (!editor) return;

  const characters = Array.from(editor.lines[editor.cursor.line] ?? '');
  if (offset < 0 && editor.cursor.column > 0) {
    editor.cursor.column -= 1;
  } else if (offset > 0 && editor.cursor.column < characters.length) {
    editor.cursor.column += 1;
  } else if (wrap && offset < 0 && editor.cursor.line > 0) {
    editor.cursor.line -= 1;
    editor.cursor.column = Array.from(editor.lines[editor.cursor.line] ?? '').length;
  } else if (wrap && offset > 0 && editor.cursor.line < editor.lines.length - 1) {
    editor.cursor.line += 1;
    editor.cursor.column = 0;
  }
  render();
}

function moveEditorCursorVertical(offset) {
  if (!editor) return;

  const contentWidth = currentEditorContentWidth();
  const layout = layoutEditorBuffer(contentWidth);
  const currentIndex = findEditorCursorVisualIndex(layout);
  const currentLine = layout[currentIndex];
  const targetLine = layout[clamp(currentIndex + offset, 0, layout.length - 1)];
  const visualColumn = displayWidth(
    Array.from(editor.lines[editor.cursor.line] ?? '')
      .slice(currentLine.start, editor.cursor.column)
      .join(''),
  );
  editor.cursor.line = targetLine.lineIndex;
  editor.cursor.column =
    targetLine.start + characterIndexForDisplayWidth(targetLine.text, visualColumn);
  render();
}

function moveEditorCursorToLineBoundary(boundary) {
  if (!editor) return;

  editor.cursor.column =
    boundary === 'end' ? Array.from(editor.lines[editor.cursor.line] ?? '').length : 0;
  render();
}

function moveEditorToLine(line) {
  if (!editor) return;

  editor.cursor.line = clamp(line, 0, editor.lines.length - 1);
  editor.cursor.column = Math.min(
    editor.cursor.column,
    Array.from(editor.lines[editor.cursor.line] ?? '').length,
  );
  render();
}

function moveEditorWord(direction) {
  if (!editor) return;

  const text = editor.lines[editor.cursor.line] ?? '';
  const characters = Array.from(text);
  let column = editor.cursor.column;
  if (direction > 0) {
    while (column < characters.length && /\w/.test(characters[column])) column += 1;
    while (column < characters.length && !/\w/.test(characters[column])) column += 1;
  } else {
    column = Math.max(0, column - 1);
    while (column > 0 && !/\w/.test(characters[column])) column -= 1;
    while (column > 0 && /\w/.test(characters[column - 1])) column -= 1;
  }
  editor.cursor.column = column;
  render();
}

function moveToEditorSearchMatch(direction) {
  if (!editor || !editor.searchQuery) return;

  const query = editor.searchQuery.toLowerCase();
  const lines = editor.lines.map((line) => line.toLowerCase());
  const startLine = editor.cursor.line;
  for (let step = 0; step < lines.length; step += 1) {
    const lineIndex = (startLine + direction * step + lines.length) % lines.length;
    const source = lines[lineIndex];
    const startColumn =
      step === 0
        ? direction > 0
          ? editor.cursor.column + 1
          : Math.max(0, editor.cursor.column - 1)
        : direction > 0
          ? 0
          : source.length;
    const index =
      direction > 0
        ? source.indexOf(query, startColumn)
        : source.lastIndexOf(query, startColumn);
    if (index >= 0) {
      editor.cursor = {
        column: Array.from(source.slice(0, index)).length,
        line: lineIndex,
      };
      editor.status = `Found: ${editor.searchQuery}`;
      render();
      return;
    }
  }

  editor.status = `Not found: ${editor.searchQuery}`;
  render();
}

function characterIndexForDisplayWidth(value, targetWidth) {
  let index = 0;
  let width = 0;
  for (const character of String(value)) {
    const characterDisplayWidth = characterWidth(character);
    if (width + characterDisplayWidth > targetWidth) break;
    width += characterDisplayWidth;
    index += 1;
  }
  return index;
}

async function handleSyncConfirmKeys(value, key) {
  if (value === '/') {
    setCommandInput('/');
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

  setCommandInput('');
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
          open: false,
        });
        logMany(result.messages);
        await refreshRows();
        const row =
          rows.find((item) => item.filePath === result.filePath) ??
          createEditorRow(result.filePath);
        view = 'home';
        await openConfiguredEditor(row);
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

    case '/models':
      if (args.length) {
        await changeAiModel(args.join(' '));
      } else {
        await openModelSelector();
      }
      return;

    case '/connect':
      openConnectSelector();
      return;

    case '/settings':
      if (args.length) {
        await changeSetting(args[0], args[1]);
      } else {
        openSettingsSelector();
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
      onSelect: () => publishDraftAndConfirm(row.compact, row.title),
    })),
  });
}

async function publishDraftAndConfirm(compactDate, label = compactDate) {
  await runTask(async () => {
    log(`Publishing ${label}...`);
    const result = await publishDraft(compactDate, { stdio: 'pipe' });
    lastPublishedDate = result.compactDate || compactDate;
    logMany(result.messages);
    if (result.buildOutput) {
      log(buildSummary(result.buildOutput));
    }
    await refreshRows();
    openSyncConfirmation(result.compactDate || compactDate);
  });
}

async function publishByDate(date) {
  await publishDraftAndConfirm(date);
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

function createEditorRow(filePath) {
  return {
    date: '-',
    filePath,
    path: path.relative(projectRoot, filePath),
    status: 'draft',
    title: path.basename(filePath, path.extname(filePath)),
  };
}

async function openConfiguredEditor(row, requestedEditor = defaultEditor) {
  if (requestedEditor === 'typora') {
    openFile(row.filePath, { editor: 'Typora' });
    log(`Opened ${row.path} in Typora.`);
    render();
    return;
  }

  await openBuiltinEditor(row);
}

async function createAndOpenNewDraft() {
  await runTask(async () => {
    const result = await createDraft(compactDateForToday(), { open: false });
    logMany(result.messages);
    await refreshRows();
    const row =
      rows.find((item) => item.filePath === result.filePath) ??
      createEditorRow(result.filePath);
    await openBuiltinEditor(row);
  });
}

async function openEditorFileSelector() {
  await refreshRows();
  const options = rows
    .filter((row) => ['draft', 'post', 'draft?'].includes(row.status))
    .map((row) => ({
      active: editor?.filePath === row.filePath,
      id: row.filePath,
      label: `${row.status.padEnd(6, ' ')} ${row.date}  ${row.title}`,
      searchText: `${row.status} ${row.date} ${row.title} ${row.path}`,
      onSelect: () => switchEditorFile(row),
    }));

  openOptionSelector({
    title: 'Open Markdown',
    options: options.length
      ? options
      : [
          {
            id: 'none',
            label: 'No drafts or posts found',
            searchText: 'empty',
            onSelect: () => render(),
          },
        ],
    selectedId: editor?.filePath ?? '',
  });
}

async function switchEditorFile(row) {
  if (!editor) {
    await openBuiltinEditor(row);
    return;
  }

  if (!isEditorDirty()) {
    await openBuiltinEditor(row);
    return;
  }

  openOptionSelector({
    title: 'Unsaved changes',
    options: [
      {
        id: 'save-open',
        label: 'Save and open selected file',
        searchText: 'save open selected file',
        onSelect: () => saveEditor({ onSaved: () => openBuiltinEditor(row) }),
      },
      {
        id: 'discard-open',
        label: 'Discard and open selected file',
        searchText: 'discard open selected file',
        onSelect: () => openBuiltinEditor(row),
      },
      {
        id: 'cancel',
        label: 'Cancel',
        searchText: 'cancel',
        onSelect: () => render(),
      },
    ],
  });
}

function openEditorCommandPalette() {
  openOptionSelector({
    title: 'Command Palette',
    options: editorCommands.map((command) => ({
      id: command.id,
      label: command.label,
      searchText: `${command.id} ${command.label}`,
      onSelect: () => executeEditorPaletteCommand(command.id),
    })),
  });
}

async function executeEditorPaletteCommand(commandId) {
  if (commandId === 'save') {
    await saveEditor();
    return;
  }
  if (commandId === 'export') {
    await exportCurrentMarkdown();
    return;
  }
  await runAssistantAction(commandId);
}

async function runAssistantAction(actionId) {
  if (!isAssistantEnabled()) return;

  const index = writingAssistantActions.findIndex((action) => action.id === actionId);
  if (index >= 0) editor.assistant.actionIndex = index;
  editor.assistant.focused = true;
  await submitAssistantRequest();
}

async function handleOpenEditorShortcut(key, row) {
  if (!row) return false;

  const requestedEditor = {
    e: defaultEditor,
    i: 'builtin',
    o: 'typora',
  }[key.name];
  if (!requestedEditor) return false;

  await openConfiguredEditor(row, requestedEditor);
  return true;
}

async function openBuiltinEditor(row) {
  try {
    const rawContent = await readFile(row.filePath, 'utf8');
    const newline = rawContent.includes('\r\n') ? '\r\n' : '\n';
    const returnView = view === 'editor' && editor?.returnView ? editor.returnView : view;
    editor = {
      commandInput: '',
      cursor: { column: 0, line: 0 },
      filePath: row.filePath,
      assistant: createAssistantState(),
      history: [],
      keymap: editorKeymap,
      lines: rawContent.replace(/\r\n/g, '\n').split('\n'),
      newline,
      originalContent: rawContent,
      promptMode: '',
      redo: [],
      returnView,
      row,
      scroll: 0,
      searchQuery: '',
      status: '',
      vimMode: editorKeymap === 'vim' ? 'normal' : 'insert',
      vimPending: '',
    };
    view = 'editor';
    render();
  } catch (error) {
    log(`Could not edit ${row.path}: ${error?.message ?? error}`);
    render();
  }
}

function createAssistantState() {
  return {
    actionIndex: 0,
    enabled: true,
    focused: false,
	    input: '',
	    loading: false,
	    requestAbortController: null,
	    requestId: 0,
	    result: null,
	    resultExpectedContent: '',
	    resultLines: [],
	    resultTargetRange: null,
	    resultWidth: 0,
	    scroll: 0,
	    streamingText: '',
	    telemetry: null,
    status: assistantConnectionStatus({
      cliDefaultModel: grokCliDefaultModel,
      connection: aiConnection,
      model: aiModel,
    }),
  };
}

async function executeAssistantLocalAction(actionId) {
  if (!editor?.assistant) return;

  if (actionId === 'save') {
    await saveEditor();
    return;
  }

  editor.assistant.result = {
    actionId: 'help',
    insertText: null,
    notes: [],
    replacementBody: null,
    reply: [
      '写作命令',
      '',
      ...writingAssistantActions.map((action) => `${action.command.padEnd(10, ' ')} ${action.help}`),
      '',
      '快捷键：Ctrl+K 命令面板，Ctrl+Enter/Enter 发送，Ctrl+R 应用结果，Ctrl+S 保存。',
    ].join('\n'),
    titleSuggestions: [],
  };
  editor.assistant.resultLines = [];
  editor.assistant.resultWidth = 0;
  editor.assistant.status = 'Help ready.';
  render();
}

function currentAssistantTarget(action) {
  if (!editor) return { range: null, text: '' };

  if (['rewrite', 'polish', 'expand', 'compress'].includes(action.id)) {
    const range = currentParagraphRange();
    return {
      range,
      text: editor.lines.slice(range.startLine, range.endLine + 1).join(editor.newline),
    };
  }

  return {
    range: null,
    text: editorContent(),
  };
}

function currentParagraphRange() {
  if (!editor) return { endLine: 0, startLine: 0 };

  const isBlank = (line) => !String(line ?? '').trim();
  let startLine = editor.cursor.line;
  let endLine = editor.cursor.line;

  while (startLine > 0 && !isBlank(editor.lines[startLine - 1])) startLine -= 1;
  while (endLine < editor.lines.length - 1 && !isBlank(editor.lines[endLine + 1])) endLine += 1;

  return { endLine, startLine };
}

function isAssistantEnabled() {
  return Boolean(editor?.assistant?.enabled);
}

function isAssistantFocused() {
  return Boolean(editor?.assistant?.enabled && editor.assistant.focused);
}

function toggleAssistantFocus() {
  if (!isAssistantEnabled()) return;

  editor.assistant.focused = !editor.assistant.focused;
  editor.assistant.status = '';
  render();
}

function currentAssistantAction() {
  if (!editor?.assistant) return writingAssistantActions[0];

  return writingAssistantActions[
    clamp(editor.assistant.actionIndex, 0, writingAssistantActions.length - 1)
  ];
}

function moveAssistantAction(offset) {
  if (!isAssistantEnabled()) return;

  const total = writingAssistantActions.length;
  editor.assistant.actionIndex = (editor.assistant.actionIndex + offset + total) % total;
  editor.assistant.status = `${currentAssistantAction().label}: ${currentAssistantAction().help}`;
  render();
}

function scrollAssistantResult(offset) {
  if (!isAssistantEnabled()) return;

  const assistant = editor.assistant;
  assistant.scroll = Math.max(0, assistant.scroll + offset);
  render();
}

async function submitAssistantRequest() {
  if (!isAssistantEnabled()) return;

  const assistant = editor.assistant;
  if (assistant.loading) {
    cancelAssistantRequest();
    return;
  }

  const parsedCommand = parseAssistantCommandInput(assistant.input);
  const action = parsedCommand.action ?? currentAssistantAction();
  if (parsedCommand.action) {
    const index = writingAssistantActions.findIndex((item) => item.id === action.id);
    if (index >= 0) assistant.actionIndex = index;
  }
  if (action.local) {
    await executeAssistantLocalAction(action.id);
    return;
  }
  const prompt = parsedCommand.prompt;

  if (isEditorDirty()) {
    assistant.status = 'Save the file with Ctrl+S before asking AI.';
    render();
    return;
  }

  await repairAiModelPreference({ persist: true });
  if (aiConnection === aiConnectionModes.grokCli) {
    await refreshGrokCliDiagnostics({ notify: false });
  }
  if (
    [aiConnectionModes.openai, aiConnectionModes.xai].includes(aiConnection) &&
    !hasApiKeyConnection(aiConnection)
  ) {
    assistant.status =
      aiConnection === aiConnectionModes.openai
        ? 'OpenAI requires OPENAI_API_KEY. Use /connect and choose Mock for local tests.'
        : 'grok-4.3 requires XAI_API_KEY. Use /connect and choose Mock for local tests.';
    assistant.loading = false;
    busy = false;
    render();
    return;
  }

  const target = currentAssistantTarget(action);
  const requestId = assistantRequestSeq + 1;
  assistantRequestSeq = requestId;
  const abortController = new AbortController();
  assistant.loading = true;
  assistant.requestAbortController = abortController;
  assistant.requestId = requestId;
  assistant.status = `Connecting to ${currentAiModelLabel()}... Ctrl+X stops.`;
  assistant.result = null;
  assistant.resultExpectedContent = editor.originalContent;
  assistant.resultTargetRange = target.range;
  assistant.resultLines = [];
  assistant.resultWidth = 0;
  assistant.scroll = 0;
  assistant.streamingText = '';
  assistant.telemetry = null;
  busy = true;
  render();

  try {
    for await (const event of requestWritingAssistanceStream({
      actionId: action.id,
      connection: aiConnection,
      draftContent: editor.originalContent,
      model: aiModel,
      projectRoot,
      prompt,
      signal: abortController.signal,
      targetText: target.text,
    })) {
      if (assistant.requestId !== requestId) break;
      if (event.telemetry) assistant.telemetry = event.telemetry;

      if (event.type === 'start') {
        assistant.status = `Generating with ${event.model || currentAiModelLabel()}... Ctrl+X stops.`;
        invalidateAssistantResultCache();
        render();
        continue;
      }

      if (event.type === 'first_token') {
        assistant.status = formatAssistantTelemetryStatus('First token received.', assistant.telemetry);
        invalidateAssistantResultCache();
        render();
        continue;
      }

      if (event.type === 'delta') {
        assistant.streamingText += event.text ?? '';
        assistant.status = formatAssistantTelemetryStatus('Streaming response...', assistant.telemetry);
        assistant.scroll = Math.max(0, getAssistantResultLines(assistant.resultWidth || 40).length - 1);
        invalidateAssistantResultCache();
        render();
        continue;
      }

      if (event.type === 'usage') {
        assistant.status = formatAssistantTelemetryStatus('Streaming response...', assistant.telemetry);
        render();
        continue;
      }

      if (event.type === 'result') {
        assistant.input = '';
        assistant.result = event.result;
        assistant.streamingText = '';
        assistant.status = event.result.replacementBody
          ? formatAssistantTelemetryStatus('Result ready. Ctrl+R applies replacement.', assistant.telemetry)
          : event.result.insertText
            ? formatAssistantTelemetryStatus('Result ready. Ctrl+R inserts it.', assistant.telemetry)
            : formatAssistantTelemetryStatus('Result ready.', assistant.telemetry);
        logAssistantTelemetry(assistant.telemetry);
        invalidateAssistantResultCache();
        render();
      }
    }
  } catch (error) {
    const message = String(error?.message ?? error);
    if (abortController.signal.aborted || /cancelled|canceled|aborted/i.test(message)) {
      assistant.status = 'Generation stopped.';
      assistant.streamingText = '';
      invalidateAssistantResultCache();
    } else if (message.includes('当前模型不是 Grok CLI 可用模型')) {
      await refreshGrokCliDiagnostics({ notify: false });
      aiModel = '';
      await savePreferences();
      updateActiveAssistantConnectionStatus();
      assistant.status = 'Current model is not available in Grok CLI. Switched to CLI default; try again.';
    } else {
      assistant.status = message;
      if (assistant.telemetry) {
        assistant.telemetry.error_message = message;
        logAssistantTelemetry(assistant.telemetry);
      }
    }
  } finally {
    if (assistant.requestId === requestId) {
      assistant.loading = false;
      assistant.requestAbortController = null;
      busy = false;
      invalidateAssistantResultCache();
      render();
    }
  }
}

function cancelAssistantRequest() {
  if (!editor?.assistant?.loading) return;
  editor.assistant.status = 'Stopping generation...';
  editor.assistant.requestAbortController?.abort();
  render();
}

function invalidateAssistantResultCache() {
  if (!editor?.assistant) return;
  editor.assistant.resultLines = [];
  editor.assistant.resultWidth = 0;
}

function formatAssistantTelemetryStatus(prefix, telemetry) {
  if (!telemetry) return prefix;
  const parts = [];
  if (Number.isFinite(telemetry.ttft)) parts.push(`TTFT ${telemetry.ttft}ms`);
  if (Number.isFinite(telemetry.total_duration)) parts.push(`Total ${telemetry.total_duration}ms`);
  const outputTokens = telemetry.output_tokens;
  if (Number.isFinite(outputTokens)) parts.push(`Out ${outputTokens}`);
  return parts.length ? `${prefix} ${parts.join(' · ')}` : prefix;
}

function logAssistantTelemetry(telemetry) {
  if (!telemetry) return;
  const total =
    Number.isFinite(telemetry.total_duration) && telemetry.total_duration >= 0
      ? `${telemetry.total_duration}ms`
      : 'n/a';
  const ttft = Number.isFinite(telemetry.ttft) && telemetry.ttft >= 0 ? `${telemetry.ttft}ms` : 'n/a';
  const usage = [
    Number.isFinite(telemetry.input_tokens) ? `input ${telemetry.input_tokens}` : '',
    Number.isFinite(telemetry.output_tokens) ? `output ${telemetry.output_tokens}` : '',
  ]
    .filter(Boolean)
    .join(', ');
  log(
    `AI telemetry: ${telemetry.provider}/${telemetry.model_name} TTFT ${ttft}, total ${total}, prompt ${telemetry.prompt_length} chars${usage ? `, ${usage}` : ''}.`,
  );
}

function parseAssistantCommandInput(value) {
  const text = String(value ?? '').trim();
  if (!text.startsWith('/')) return { action: null, prompt: text };

  const [command, ...rest] = text.split(/\s+/);
  const action = getWritingAssistantActionByCommand(command);
  return action
    ? { action, prompt: rest.join(' ').trim() }
    : { action: null, prompt: text };
}

async function requestAssistantReplacement() {
  if (!isAssistantEnabled()) return;

  const assistant = editor.assistant;
  const result = assistant.result;
  if (!result?.replacementBody && !result?.insertText) {
    assistant.status = 'Current result has nothing to apply.';
    render();
    return;
  }

  if (isEditorDirty()) {
    assistant.status = 'Save or reload local edits before applying AI replacement.';
    render();
    return;
  }

  openOptionSelector({
    title: result.replacementBody ? 'Apply AI replacement' : 'Insert AI result',
    options: [
      {
        id: 'apply',
        label: result.replacementBody ? 'Apply replacement' : 'Insert at document end',
        searchText: 'apply replace insert body result',
        onSelect: () => applyAssistantReplacement(),
      },
      {
        id: 'cancel',
        label: 'Cancel',
        searchText: 'cancel',
        onSelect: () => render(),
      },
    ],
  });
}

async function applyAssistantReplacement() {
  if (!isAssistantEnabled()) return;

  await runTask(async () => {
    const assistant = editor.assistant;
    const result = assistant.result;
    if (!result?.replacementBody && !result?.insertText) {
      assistant.status = 'No applicable AI output available.';
      return;
    }

    if (!result.replacementBody && result.insertText) {
      insertEditorTextAtEnd(result.insertText);
      assistant.status = 'Inserted AI result. Save when ready.';
      return;
    }

    const isDocumentReplacement = result.target === 'document' || !assistant.resultTargetRange;
    const applied = isDocumentReplacement
      ? await backupAndReplaceMarkdownBody(
          editor.filePath,
          assistant.resultExpectedContent,
          result.replacementBody,
        )
      : await backupAndWriteMarkdownContent(
          editor.filePath,
          assistant.resultExpectedContent,
          replaceEditorRangeInContent(
            assistant.resultExpectedContent,
            assistant.resultTargetRange,
            result.replacementBody,
          ),
        );
    const nextContent = applied.content;
    recordEditorHistory();
    editor.lines = nextContent.replace(/\r\n/g, '\n').split('\n');
    editor.newline = nextContent.includes('\r\n') ? '\r\n' : '\n';
    editor.originalContent = nextContent;
    editor.cursor = { column: 0, line: 0 };
    editor.scroll = 0;
    assistant.resultExpectedContent = nextContent;
    assistant.status = `Applied. Backup: ${path.relative(projectRoot, applied.backupPath)}`;
    await refreshRows();
    const refreshedRow = rows.find((row) => row.filePath === editor.filePath);
    if (refreshedRow) editor.row = refreshedRow;
    refreshReaderAfterEditorSave(nextContent, editor.row);
  });
}

function insertEditorTextAtEnd(text) {
  if (!editor) return;

  recordEditorHistory();
  const insertion = String(text ?? '').trim();
  if (!insertion) return;

  const needsBlankLine = editor.lines.some((line) => line.trim()) && editor.lines.at(-1)?.trim();
  if (needsBlankLine) {
    editor.lines.push('', ...insertion.split(/\r?\n/));
  } else {
    editor.lines.push(...insertion.split(/\r?\n/));
  }
  editor.cursor = {
    column: Array.from(editor.lines.at(-1) ?? '').length,
    line: editor.lines.length - 1,
  };
  scheduleEditorAutosave();
  render();
}

function replaceEditorRangeInContent(content, range, replacement) {
  const newline = String(content).includes('\r\n') ? '\r\n' : '\n';
  const lines = String(content).replace(/\r\n/g, '\n').split('\n');
  const startLine = clamp(range?.startLine ?? 0, 0, Math.max(0, lines.length - 1));
  const endLine = clamp(range?.endLine ?? startLine, startLine, Math.max(0, lines.length - 1));
  lines.splice(startLine, endLine - startLine + 1, ...String(replacement ?? '').split(/\r?\n/));
  return lines.join(newline);
}

function editorContent() {
  return editor ? editor.lines.join(editor.newline) : '';
}

function isEditorDirty() {
  return Boolean(editor && editorContent() !== editor.originalContent);
}

async function requestEditorClose({ exitApplication = false } = {}) {
  if (!editor) {
    if (exitApplication) await exitAdmin();
    return;
  }

  if (!isEditorDirty()) {
    await finishEditorClose({ exitApplication });
    return;
  }

  openOptionSelector({
    title: 'Unsaved changes',
    options: [
      {
        id: 'save',
        label: 'Save',
        searchText: 'save',
        onSelect: () =>
          saveEditor({
            onSaved: () => finishEditorClose({ exitApplication }),
          }),
      },
      {
        id: 'discard',
        label: 'Discard',
        searchText: 'discard',
        onSelect: () => finishEditorClose({ exitApplication }),
      },
      {
        id: 'cancel',
        label: 'Cancel',
        searchText: 'cancel',
        onSelect: () => render(),
      },
    ],
  });
}

async function finishEditorClose({ exitApplication = false } = {}) {
  const closingEditor = editor;
  if (!closingEditor) return;

  if (editorAutosaveTimer) {
    clearTimeout(editorAutosaveTimer);
    editorAutosaveTimer = null;
  }
  editor = null;
  await refreshRows();
  if (exitApplication) {
    await exitAdmin();
    return;
  }

  if (closingEditor.returnView === 'reader') {
    const row =
      rows.find((item) => item.filePath === closingEditor.filePath) ??
      closingEditor.row;
    await openReader(row);
    return;
  }

  view = closingEditor.returnView === 'posts' ? 'posts' : 'home';
  render();
}

async function saveEditor({ force = false, onSaved = null } = {}) {
  if (!editor) return false;

  try {
    const diskContent = await readFile(editor.filePath, 'utf8');
    if (!force && diskContent !== editor.originalContent) {
      openOptionSelector({
        title: 'File changed on disk',
        options: [
          {
            id: 'overwrite',
            label: 'Overwrite',
            searchText: 'overwrite',
            onSelect: () => saveEditor({ force: true, onSaved }),
          },
          {
            id: 'reload',
            label: 'Reload',
            searchText: 'reload',
            onSelect: () => reloadEditorFromDisk(),
          },
          {
            id: 'cancel',
            label: 'Cancel',
            searchText: 'cancel',
            onSelect: () => render(),
          },
        ],
      });
      return false;
    }

    const content = editorContent();
    await writeFile(editor.filePath, content, 'utf8');
    editor.originalContent = content;
    editor.status = 'Saved.';
    await refreshRows();
    const refreshedRow = rows.find((row) => row.filePath === editor.filePath);
    if (refreshedRow) editor.row = refreshedRow;
    refreshReaderAfterEditorSave(content, editor.row);
    if (onSaved) {
      await onSaved();
    } else {
      render();
    }
    return true;
  } catch (error) {
    editor.status = `Save failed: ${error?.message ?? error}`;
    render();
    return false;
  }
}

async function exportCurrentMarkdown() {
  if (!editor) return;

  await runTask(async () => {
    const exportDir = path.join(projectRoot, 'exports');
    const exportPath = exportPathFor({ filePath: editor.filePath, projectRoot });
    await mkdir(exportDir, { recursive: true });
    await writeFile(exportPath, editorContent(), 'utf8');
    editor.status = `Exported: ${path.relative(projectRoot, exportPath)}`;
    log(editor.status);
  });
}

function scheduleEditorAutosave() {
  if (!editor || !autoSaveEnabled) return;

  if (editorAutosaveTimer) clearTimeout(editorAutosaveTimer);
  editorAutosaveTimer = setTimeout(() => {
    editorAutosaveTimer = null;
    void writeEditorAutosave();
  }, 800);
}

async function writeEditorAutosave() {
  if (!editor || !autoSaveEnabled) return;

  try {
    const autosavePath = autosavePathFor({ filePath: editor.filePath, projectRoot });
    await mkdir(path.dirname(autosavePath), { recursive: true });
    await writeFile(autosavePath, editorContent(), 'utf8');
  } catch {
    // Autosave should never interrupt typing.
  }
}

async function reloadEditorFromDisk() {
  if (!editor) return;

  try {
    const rawContent = await readFile(editor.filePath, 'utf8');
    editor.lines = rawContent.replace(/\r\n/g, '\n').split('\n');
    editor.newline = rawContent.includes('\r\n') ? '\r\n' : '\n';
    editor.originalContent = rawContent;
    editor.cursor = { column: 0, line: 0 };
    editor.history = [];
    editor.redo = [];
    editor.scroll = 0;
    editor.status = 'Reloaded from disk.';
    render();
  } catch (error) {
    editor.status = `Reload failed: ${error?.message ?? error}`;
    render();
  }
}

function refreshReaderAfterEditorSave(content, row) {
  if (!reader || reader.row.filePath !== row.filePath) return;

  reader.row = row;
  reader.document = parseReaderDocument(content, row);
  reader.layoutWidth = 0;
  reader.lines = [];
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
    if (terminalReady) {
      process.stdout.write(cursorColorSequence());
    }
    try {
      await savePreferences();
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

async function openModelSelector() {
  if (aiConnection === aiConnectionModes.grokCli) {
    await refreshGrokCliDiagnostics({ notify: false });
  }
  await repairAiModelPreference({ persist: true });
  const models =
    aiConnection === aiConnectionModes.grokCli && grokCliModels.length
      ? grokCliModels
      : await listKnownGrokModels({
          connection: aiConnection,
          selectedModel: aiModel,
        });
  const defaultLabel =
    aiConnection === aiConnectionModes.grokCli
      ? `Grok CLI default${grokCliDefaultModel ? `  ${grokCliDefaultModel}` : ''}`
      : aiConnection === aiConnectionModes.mock
        ? defaultMockModel
        : aiConnection === aiConnectionModes.openai
          ? defaultOpenAiModel
          : defaultApiModel;

  openOptionSelector({
    title: 'AI model',
    options: [
      {
        active: !aiModel,
        id: '__default__',
        label: `Default  ${defaultLabel}`,
        searchText: `default ${defaultLabel}`,
        onSelect: () => saveAiModel(''),
      },
      ...models.map((model) => ({
        active: model.id === aiModel,
        id: model.id,
        label: `${model.id}${model.name && model.name !== model.id ? `  ${model.name}` : ''}`,
        searchText: `${model.id} ${model.name} ${model.description}`,
        onSelect: () => saveAiModel(model.id),
      })),
    ],
    selectedId: aiModel || '__default__',
  });
}

function openConnectSelector() {
  const hasOpenAiKey = hasOpenAiApiKey();
  const hasXaiKey = hasXaiApiKey();
  openOptionSelector({
    title: 'AI provider',
    options: [
      {
        active: aiConnection === aiConnectionModes.mock,
        id: aiConnectionModes.mock,
        label: 'Mock provider  local',
        searchText: 'mock provider local offline test',
        onSelect: () => connectMockProvider(),
      },
      {
        active: aiConnection === aiConnectionModes.openai,
        id: aiConnectionModes.openai,
        label: `OpenAI API key  ${hasOpenAiKey ? 'connected' : 'missing'}`,
        searchText: `openai api key gpt-5.5 ${hasOpenAiKey ? 'connected' : 'missing'}`,
        onSelect: () => connectOpenAiApiKey(),
      },
      {
        active: aiConnection === aiConnectionModes.apiKey,
        id: aiConnectionModes.apiKey,
        label: `XAI_API_KEY  ${hasXaiKey ? 'connected' : 'missing'}`,
        searchText: `xai api key grok-4.3 ${hasXaiKey ? 'connected' : 'missing'}`,
        onSelect: () => connectXaiApiKey(),
      },
      {
        active: aiConnection === aiConnectionModes.grokCli,
        id: 'grok-oauth',
        label: 'Grok browser login',
        searchText: 'grok browser login oauth',
        onSelect: () => connectGrokCli({ deviceAuth: false }),
      },
      {
        id: 'grok-device',
        label: 'Grok device code',
        searchText: 'grok device code auth headless',
        onSelect: () => connectGrokCli({ deviceAuth: true }),
      },
    ],
    selectedId: aiConnection === aiConnectionModes.grokCli ? 'grok-oauth' : aiConnection,
  });
}

function openSettingsSelector() {
  openOptionSelector({
    title: 'Settings',
    options: [
      {
        id: 'editor',
        label: `Default editor  ${defaultEditor}`,
        searchText: `default editor ${defaultEditor}`,
        onSelect: () => openSettingValueSelector('editor'),
      },
      {
        id: 'keymap',
        label: `Editor keymap   ${editorKeymap}`,
        searchText: `editor keymap ${editorKeymap}`,
        onSelect: () => openSettingValueSelector('keymap'),
      },
      {
        id: 'line-numbers',
        label: `Line numbers    ${editorLineNumbers ? 'on' : 'off'}`,
        searchText: `line numbers ${editorLineNumbers ? 'on' : 'off'}`,
        onSelect: () => openSettingValueSelector('line-numbers'),
      },
      {
        id: 'ai-model',
        label: `AI model        ${currentAiModelLabel()}`,
        searchText: `ai model ${currentAiModelLabel()}`,
        onSelect: () => openModelSelector(),
      },
      {
        id: 'ai-connection',
        label: `AI provider     ${aiConnectionLabel(aiConnection)}`,
        searchText: `ai provider connection ${aiConnectionLabel(aiConnection)}`,
        onSelect: () => openConnectSelector(),
      },
      {
        id: 'auto-save',
        label: `Auto save       ${autoSaveEnabled ? 'on' : 'off'}`,
        searchText: `auto save ${autoSaveEnabled ? 'on' : 'off'}`,
        onSelect: () => openSettingValueSelector('auto-save'),
      },
    ],
  });
}

function openSettingValueSelector(setting) {
  const definitions = {
    editor: {
      selected: defaultEditor,
      title: 'Default editor',
      values: ['builtin', 'typora'],
    },
    keymap: {
      selected: editorKeymap,
      title: 'Editor keymap',
      values: ['simple', 'vim'],
    },
    'line-numbers': {
      selected: editorLineNumbers ? 'on' : 'off',
      title: 'Line numbers',
      values: ['off', 'on'],
    },
    'auto-save': {
      selected: autoSaveEnabled ? 'on' : 'off',
      title: 'Auto save',
      values: ['on', 'off'],
    },
  };
  const definition = definitions[setting];
  if (!definition) return;

  openOptionSelector({
    title: definition.title,
    options: definition.values.map((value) => ({
      active: value === definition.selected,
      id: value,
      label: value,
      searchText: value,
      onSelect: () => changeSetting(setting, value),
    })),
    selectedId: definition.selected,
  });
}

async function changeSetting(setting, requestedValue) {
  await runTask(async () => {
    const normalizedSetting = String(setting ?? '').toLowerCase();
    const rawValue = String(requestedValue ?? '').trim();
    const value = rawValue.toLowerCase();
    if (normalizedSetting === 'editor' && ['builtin', 'typora'].includes(value)) {
      defaultEditor = value;
    } else if (normalizedSetting === 'keymap' && ['simple', 'vim'].includes(value)) {
      editorKeymap = value;
    } else if (normalizedSetting === 'line-numbers' && ['on', 'off'].includes(value)) {
      editorLineNumbers = value === 'on';
    } else if (normalizedSetting === 'auto-save' && ['on', 'off'].includes(value)) {
      autoSaveEnabled = value === 'on';
    } else if (['model', 'ai-model'].includes(normalizedSetting) && rawValue) {
      const allowed = await validateRequestedAiModel(rawValue);
      if (!allowed) return;
      aiModel = rawValue;
    } else if (['connection', 'ai-connection'].includes(normalizedSetting)) {
      if (!['mock', 'openai', 'xai', 'api-key', 'grok-cli'].includes(value)) {
        throw new BlogError('AI provider must be mock, openai, xai/api-key, or grok-cli.');
      }
      aiConnection = normalizeAiConnection(value);
      if (aiConnection === aiConnectionModes.grokCli) {
        await refreshGrokCliDiagnostics({ notify: true });
      }
    } else {
      throw new BlogError(
        '设置格式：/settings editor builtin|typora、/settings keymap simple|vim、/settings line-numbers on|off、/settings auto-save on|off、/settings model <id>、/settings connection mock|openai|xai|grok-cli',
      );
    }

    await repairAiModelPreference({ notify: true });
    await savePreferences();
    updateActiveAssistantConnectionStatus();
    log(`Setting ${normalizedSetting} changed to ${rawValue || value}.`);
  });
}

async function changeAiModel(requestedModel) {
  const model = String(requestedModel ?? '').trim();
  if (!model) {
    log('Use /models <model-id>, or run /models to choose from the list.');
    render();
    return;
  }

  await saveAiModel(model);
}

async function saveAiModel(model) {
  await runTask(async () => {
    const nextModel = String(model ?? '').trim();
    const allowed = await validateRequestedAiModel(nextModel);
    if (!allowed) return;

    aiModel = nextModel;
    await repairAiModelPreference({ notify: true });
    await savePreferences();
    updateActiveAssistantConnectionStatus();
    log(`AI model set to ${currentAiModelLabel()}.`);
  });
}

async function validateRequestedAiModel(model) {
  const requestedModel = String(model ?? '').trim();
  if (!requestedModel) return true;

  if (aiConnection === aiConnectionModes.openai && requestedModel === defaultApiModel) {
    log(`${defaultApiModel} can only be used with XAI_API_KEY. OpenAI provider uses ${defaultOpenAiModel} by default.`);
    return false;
  }

  if (aiConnection === aiConnectionModes.xai && requestedModel === defaultOpenAiModel) {
    log(`${defaultOpenAiModel} can only be used with OpenAI API key. xAI provider uses ${defaultApiModel} by default.`);
    return false;
  }

  if (aiConnection !== aiConnectionModes.grokCli) return true;

  await refreshGrokCliDiagnostics({ notify: false });
  const models = grokCliModels.length
    ? grokCliModels
    : await listKnownGrokModels({
        connection: aiConnection,
        selectedModel: '',
      });
  const availableIds = new Set(models.map((item) => item.id));
  if (availableIds.has(requestedModel)) return true;

  if (requestedModel === defaultApiModel || requestedModel === defaultOpenAiModel) {
    log(`${requestedModel} can only be used with an API key provider. Grok CLI login cannot use it.`);
    return false;
  }

  log(`${requestedModel} is not available through Grok CLI login. Run /models to choose one.`);
  return false;
}

async function refreshGrokCliDiagnostics({ notify = false } = {}) {
  try {
    const result = await refreshGrokCliModels();
    grokCliDefaultModel = result.defaultModel;
    grokCliModels = result.models;
    updateActiveAssistantConnectionStatus();
    if (notify) {
      const modelList = result.models.map((model) => model.id).join(', ') || 'none';
      log(`Grok CLI models: ${modelList}. ${defaultApiModel} requires XAI_API_KEY.`);
    }
    return result;
  } catch (error) {
    if (notify) {
      log(`Could not refresh Grok CLI models: ${error?.message ?? error}`);
    }
    return {
      defaultModel: grokCliDefaultModel,
      models: grokCliModels,
      raw: '',
    };
  }
}

async function connectXaiApiKey() {
  await runTask(async () => {
    aiConnection = aiConnectionModes.apiKey;
    await repairAiModelPreference({ notify: true });
    await savePreferences();
    updateActiveAssistantConnectionStatus();
    log(
      process.env.XAI_API_KEY
        ? 'AI connection set to XAI_API_KEY.'
        : 'AI connection set to XAI_API_KEY, but the environment variable is missing.',
    );
  });
}

async function connectOpenAiApiKey() {
  await runTask(async () => {
    aiConnection = aiConnectionModes.openai;
    await repairAiModelPreference({ notify: true });
    await savePreferences();
    updateActiveAssistantConnectionStatus();
    log(
      process.env.OPENAI_API_KEY
        ? 'AI connection set to OpenAI API key.'
        : 'AI connection set to OpenAI, but OPENAI_API_KEY is missing. Create one at https://platform.openai.com/api-keys.',
    );
  });
}

async function connectMockProvider() {
  await runTask(async () => {
    aiConnection = aiConnectionModes.mock;
    if (!aiModel || aiModel === defaultApiModel) {
      aiModel = defaultMockModel;
    }
    await savePreferences();
    updateActiveAssistantConnectionStatus();
    log('AI provider set to Mock. Writing Agent can run offline.');
  });
}

async function connectGrokCli({ deviceAuth = false } = {}) {
  busy = true;
  render();
  suspendTerminalForInteractiveProcess();

  try {
    console.log(deviceAuth ? 'Starting Grok device-code login...' : 'Starting Grok browser login...');
    const code = await waitForChildProcess(runGrokLogin({ deviceAuth }));
    if (code !== 0) {
      log(`Grok login exited with code ${code}.`);
      return;
    }

    aiConnection = aiConnectionModes.grokCli;
    await refreshGrokCliDiagnostics({ notify: true });
    await repairAiModelPreference({ notify: true });
    await savePreferences();
    updateActiveAssistantConnectionStatus();
    log('AI connection set to Grok CLI login.');
  } catch (error) {
    log(`Grok login failed: ${error?.message ?? error}`);
  } finally {
    busy = false;
    resumeTerminalAfterInteractiveProcess();
  }
}

function waitForChildProcess(child) {
  return new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve(code ?? 0));
  });
}

function currentAiModelLabel() {
  if (aiConnection === aiConnectionModes.mock && !aiModel) {
    return defaultMockModel;
  }
  if (aiConnection === aiConnectionModes.grokCli && !aiModel) {
    return grokCliDefaultModel || 'CLI default';
  }
  const model = normalizeAiModel(aiModel, aiConnection);
  return model || 'CLI default';
}

function updateActiveAssistantConnectionStatus() {
  if (!editor?.assistant) return;
  editor.assistant.status = assistantConnectionStatus({
    cliDefaultModel: grokCliDefaultModel,
    connection: aiConnection,
    model: aiModel,
  });
}

function openOptionSelector({ title, options, selectedId = '' }) {
  setCommandInput('');
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

async function loadPreferences() {
  try {
    const config = JSON.parse(await readFile(configPath, 'utf8'));
    if (Object.hasOwn(themes, config.theme)) {
      themeName = config.theme;
    }
    if (['builtin', 'typora'].includes(config.defaultEditor)) {
      defaultEditor = config.defaultEditor;
    }
    if (['simple', 'vim'].includes(config.editorKeymap)) {
      editorKeymap = config.editorKeymap;
    }
    if (typeof config.editorLineNumbers === 'boolean') {
      editorLineNumbers = config.editorLineNumbers;
    }
    if (typeof config.autoSaveEnabled === 'boolean') {
      autoSaveEnabled = config.autoSaveEnabled;
    }
    aiConnection = normalizeAiConnection(config.aiProvider ?? config.aiConnection);
    if (typeof config.aiModel === 'string') {
      aiModel = config.aiModel.trim();
    }
    if (process.env.AI_PROVIDER || process.env.DANTE_PROVIDER) {
      aiConnection = normalizeAiConnection(process.env.AI_PROVIDER || process.env.DANTE_PROVIDER);
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      log('Settings could not be read. Using defaults.');
    }
    themeName = 'light';
    defaultEditor = 'builtin';
    editorKeymap = 'simple';
    editorLineNumbers = false;
    autoSaveEnabled = true;
    aiConnection = normalizeAiConnection(process.env.AI_PROVIDER);
    aiModel = '';
  }
}

async function repairAiModelPreference({ persist = false, notify = false } = {}) {
  const previousModel = aiModel;
  const repaired = await repairAiModelForConnection({
    connection: aiConnection,
    model: aiModel,
  });
  if (!repaired.changed) return false;

  aiModel = repaired.model;
  if (persist) {
    await savePreferences();
  }
  updateActiveAssistantConnectionStatus();
  if (notify && previousModel) {
    if (previousModel === defaultApiModel) {
      log(`${defaultApiModel} requires XAI_API_KEY and was cleared for the current provider.`);
    } else if (previousModel === defaultOpenAiModel) {
      log(`${defaultOpenAiModel} requires OpenAI API key and was cleared for the current provider.`);
    } else {
      log(`Current provider does not support ${previousModel}. Using provider default.`);
    }
  }
  return true;
}

async function savePreferences() {
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(
    configPath,
    `${JSON.stringify(
      {
        theme: themeName,
        defaultEditor,
        editorKeymap,
        editorLineNumbers,
        autoSaveEnabled,
        aiProvider: aiConnection,
        aiConnection,
        aiModel,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
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
  process.stdout.write(`\x1b[?1049h\x1b[?7h\x1b[?25h${cursorColorSequence()}`);
  process.once('exit', restoreTerminal);
  process.once('SIGTERM', () => void exitAdmin());
  process.once('SIGHUP', () => void exitAdmin());
}

function suspendTerminalForInteractiveProcess() {
  if (process.stdin.isTTY) {
    process.stdin.setRawMode(false);
    process.stdin.pause();
  }
  restoreTerminal();
}

function resumeTerminalAfterInteractiveProcess() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  terminalReady = true;
  process.stdout.write(`\x1b[?1049h\x1b[?7h\x1b[?25h${cursorColorSequence()}`);
  render();
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
  homeCommandInputRect = null;

  if (
    isTinyLayout(width, height) ||
    (view === 'home' && height < 11) ||
    (view === 'reader' && height < 12)
  ) {
    if (view === 'editor') {
      renderEditorTiny(lines, styles, width, height);
    } else {
      renderTiny(lines, styles, width, height);
    }
  } else {
    renderCurrentView(lines, styles, width, height);
    if (view !== 'home' && view !== 'editor') {
      renderFooter(lines, styles, width, height);
    }
    if (optionSelector || input.startsWith('/')) {
      const renderHomeSuggestions =
        view === 'home' && !optionSelector && input.startsWith('/');
      if (!renderHomeSuggestions) {
        dimStyles(styles);
      }
      if (view !== 'home' && view !== 'editor') {
        renderPaletteFooter(lines, styles, width, height);
      }
      if (optionSelector) {
        renderOptionSelector(lines, styles, width, height);
      } else if (renderHomeSuggestions) {
        renderHomeCommandSuggestions(lines, styles, height);
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
  } else if (view === 'editor') {
    renderEditor(lines, styles, width, height);
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

  renderHomeContent(lines, styles, width, height, brandLogo);
}

function renderCompactHome(lines, styles, width, height) {
  renderHomeContent(lines, styles, width, height, compactBrandLogo);
}

function renderHomeContent(lines, styles, width, height, logo) {
  const fieldWidth = Math.min(64, Math.max(24, width - 4));
  const displayInput = startEllipsis(input, Math.max(1, fieldWidth - 5));
  let logoRows = logo.map((text) => ({ style: 'logo', text }));
  let wordmarkRows = [{ style: 'muted', text: 'myblog' }];
  const summaryRows = [{ style: 'muted', text: dashboardSummary() }];
  const inputRows = [
    { style: 'surface:border', text: `┌${'─'.repeat(fieldWidth - 2)}┐` },
    { input: true },
    { style: 'surface:border', text: `└${'─'.repeat(fieldWidth - 2)}┘` },
  ];
  const contentHeight = () =>
    logoRows.length + wordmarkRows.length + summaryRows.length + inputRows.length;

  if (contentHeight() > height) {
    wordmarkRows = [];
  }
  if (contentHeight() > height) {
    logoRows = logoRows.slice(0, Math.max(0, height - summaryRows.length - inputRows.length));
  }

  const groups = [logoRows, wordmarkRows, summaryRows, inputRows].filter((group) => group.length);
  let spacerBudget = Math.max(0, height - contentHeight());
  const visibleContent = groups.flatMap((group, index) => {
    if (index === groups.length - 1 || spacerBudget === 0) {
      return group;
    }
    spacerBudget -= 1;
    return [...group, { style: 'normal', text: '' }];
  });
  const start = Math.max(1, Math.floor((height - visibleContent.length) / 2) + 1);

  for (const [index, row] of visibleContent.entries()) {
    const currentRow = start + index;
    if (!row.input) {
      centerBlock(lines, styles, [row.text], currentRow, width, row.style);
      continue;
    }

    const fieldColumn = Math.max(1, Math.floor((width - fieldWidth) / 2));
    fillRect(lines, styles, currentRow, fieldColumn, fieldWidth, 1, 'surface:normal');
    put(lines, styles, currentRow, fieldColumn, '│', 'surface:border');
    put(lines, styles, currentRow, fieldColumn + 2, '› ', 'surface:muted');
    put(
      lines,
      styles,
      currentRow,
      fieldColumn + 4,
      displayInput || '/',
      displayInput ? 'surface:normal' : 'surface:muted',
    );
    put(lines, styles, currentRow, fieldColumn + fieldWidth - 1, '│', 'surface:border');
    homeCommandInputRect = { column: fieldColumn, row: currentRow, width: fieldWidth };
  }

  cursorTarget = {
    column: clamp((homeCommandInputRect?.column ?? 1) + 4 + displayWidth(displayInput), 1, width),
    row: clamp(homeCommandInputRect?.row ?? height, 1, height),
  };
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

function isCompactLayout(width, height) {
  return width < 72 || height < 22;
}

function isTinyLayout(width, height) {
  return width < 40 || height < 8;
}

function renderHomeCommandSuggestions(lines, styles, height) {
  if (!homeCommandInputRect) return;

  const suggestions = getCommandSuggestions();
  selectedCommandIndex = clamp(
    selectedCommandIndex,
    0,
    Math.max(0, suggestions.length - 1),
  );

  const inputTop = homeCommandInputRect.row - 1;
  const inputBottom = homeCommandInputRect.row + 1;
  const rowsBelow = Math.max(0, height - inputBottom);
  const rowsAbove = Math.max(0, inputTop - 1);
  const availableRows = Math.max(rowsBelow, rowsAbove);
  const visibleCount = Math.max(
    1,
    Math.min(suggestions.length || 1, 5, Math.max(1, availableRows - 2)),
  );
  const panelHeight = visibleCount + 2;
  const startRow =
    rowsBelow >= panelHeight
      ? inputBottom + 1
      : Math.max(1, inputTop - panelHeight);
  const startCol = homeCommandInputRect.column;
  const panelWidth = homeCommandInputRect.width;
  const innerWidth = panelWidth - 2;

  commandScroll = visibleSelectionScroll(
    selectedCommandIndex,
    commandScroll,
    suggestions.length,
    visibleCount,
  );

  fillRect(lines, styles, startRow, startCol, panelWidth, panelHeight, 'surface:normal');
  put(
    lines,
    styles,
    startRow,
    startCol,
    `┌${'─'.repeat(Math.max(0, innerWidth))}┐`,
    'surface:border',
  );

  const pageCommands = suggestions.slice(commandScroll, commandScroll + visibleCount);
  for (let pageIndex = 0; pageIndex < visibleCount; pageIndex += 1) {
    const row = startRow + pageIndex + 1;
    const commandIndex = commandScroll + pageIndex;
    const command = pageCommands[pageIndex];
    const selected = command && commandIndex === selectedCommandIndex;
    const styleName = selected ? 'surface:selected' : 'surface:normal';
    const text = command
      ? `${selected ? '›' : ' '} ${command.name.padEnd(12, ' ')} ${command.label}`
      : '  No matching command.';

    fillRect(lines, styles, row, startCol + 1, innerWidth, 1, styleName);
    put(lines, styles, row, startCol, '│', 'surface:border');
    put(lines, styles, row, startCol + 1, padDisplayWidth(text, innerWidth), styleName);
    put(lines, styles, row, startCol + panelWidth - 1, '│', 'surface:border');
  }

  const footerText = clipDisplayWidth(` ${commandSelectionHelp} `, innerWidth);
  put(
    lines,
    styles,
    startRow + panelHeight - 1,
    startCol,
    `└${footerText}${'─'.repeat(Math.max(0, innerWidth - displayWidth(footerText)))}┘`,
    'surface:muted',
  );
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

  commandScroll = visibleSelectionScroll(
    selectedCommandIndex,
    commandScroll,
    suggestions.length,
    visibleCount,
  );

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
    `│ ${padDisplayWidth(commandSelectionHelp, innerWidth - 2)} │`,
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

  optionSelector.scroll = visibleSelectionScroll(
    optionSelector.selectedIndex,
    optionSelector.scroll,
    options.length,
    visibleCount,
  );

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
  const blocks = layoutPostBlocks(visibleRows, contentWidth);
  const visibleCount = Math.max(1, height - 7);
  const totalLines = blocks.at(-1)?.end ?? 0;
  postsScroll = clamp(postsScroll, 0, Math.max(0, totalLines - visibleCount));
  ensureSelectedPostVisible(blocks[postsIndex], visibleCount, totalLines);

  put(lines, styles, 3, col, 'Posts', 'accent');

  if (!visibleRows.length) {
    put(lines, styles, 5, col, 'No drafts or posts yet.', 'normal');
    return;
  }

  const pageLines = blocks
    .flatMap((block) =>
      block.lines.map((text) => ({
        selected: block.rowIndex === postsIndex,
        text,
      })),
    )
    .slice(postsScroll, postsScroll + visibleCount);
  for (const [pageIndex, line] of pageLines.entries()) {
    const style = line.selected ? 'selected' : 'normal';
    if (line.selected) {
      fillRect(lines, styles, pageIndex + 5, col, contentWidth, 1, style);
    }
    put(lines, styles, pageIndex + 5, col, line.text, style);
  }
}

function layoutPostBlocks(noteRows, width) {
  const titleColumn = 20;
  const titleWidth = Math.max(1, width - titleColumn);
  let offset = 0;

  return noteRows.map((row, rowIndex) => {
    const titleLines = wrapLine(row.title, titleWidth);
    const prefix = rowIndex === postsIndex ? '> ' : '  ';
    const indent = ' '.repeat(titleColumn);
    const lines = titleLines.map((title, index) =>
      index === 0
        ? `${prefix}${padDisplayWidth(row.status, 6)} ${padDisplayWidth(row.date, 10)} ${title}`
        : `${indent}${title}`,
    );
    const block = {
      end: offset + lines.length,
      lines,
      rowIndex,
      start: offset,
    };
    offset = block.end;
    return block;
  });
}

function ensureSelectedPostVisible(block, visibleCount, totalLines) {
  if (!block) {
    postsScroll = 0;
    return;
  }

  if (block.start < postsScroll) {
    postsScroll = block.start;
  } else if (block.end > postsScroll + visibleCount) {
    postsScroll =
      block.lines.length > visibleCount
        ? block.start
        : block.end - visibleCount;
  }

  postsScroll = clamp(postsScroll, 0, Math.max(0, totalLines - visibleCount));
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

function renderEditor(lines, styles, width, height) {
  if (!editor) {
    put(lines, styles, 2, 2, 'Could not open editor.', 'accent');
    return;
  }

  const showFilePanel = width >= editorThreeColumnMinTerminalWidth && height >= 12;
  const filePanelWidth = showFilePanel
    ? clamp(Math.floor(width * 0.2), editorFilePanelMinWidth, editorFilePanelMaxWidth)
    : 0;
  const fileGapWidth = showFilePanel ? 2 : 0;
  const contentCol = showFilePanel ? filePanelWidth + fileGapWidth + 1 : 2;
  const showAssistantSidePanel =
    isAssistantEnabled() &&
    width >= assistantSidePanelMinTerminalWidth &&
    height >= 12;
  const assistantWidth = showAssistantSidePanel
    ? clamp(Math.floor(width * 0.34), assistantPanelMinWidth, assistantPanelMaxWidth)
    : 0;
  const gapWidth = showAssistantSidePanel ? 2 : 0;
  const contentWidth = Math.max(1, width - contentCol - assistantWidth - gapWidth);
  const assistantColumn = Math.max(1, width - assistantWidth + 1);

  if (showFilePanel) {
    renderEditorFilePanel(lines, styles, 1, 1, filePanelWidth, height);
  }

  const header = `Edit ${editor.row.path}  ${editor.keymap}${isEditorDirty() ? '  [+]' : ''}`;
  put(lines, styles, 1, contentCol, clipDisplayWidth(header, contentWidth), 'accent');
  put(lines, styles, 2, contentCol, '─'.repeat(contentWidth), 'border');

  const layout = layoutEditorBuffer(contentWidth);
  const bodyRows = getEditorPageRows(height);
  const cursorVisualIndex = findEditorCursorVisualIndex(layout);
  editor.scroll = clamp(editor.scroll, 0, Math.max(0, layout.length - bodyRows));
  if (cursorVisualIndex < editor.scroll) {
    editor.scroll = cursorVisualIndex;
  } else if (cursorVisualIndex >= editor.scroll + bodyRows) {
    editor.scroll = cursorVisualIndex - bodyRows + 1;
  }

  const visibleLines = layout.slice(editor.scroll, editor.scroll + bodyRows);
  for (const [index, line] of visibleLines.entries()) {
    const row = index + 3;
    if (line.prefix) put(lines, styles, row, contentCol, line.prefix, 'muted');
    put(lines, styles, row, contentCol + displayWidth(line.prefix), line.text, line.style);
  }

  const footer = editorFooterStatus();
  put(lines, styles, height - 1, 1, clipDisplayWidth(footer, width), 'muted');
  const prompt = editorPromptText();
  put(lines, styles, height, 1, clipDisplayWidth(prompt, width), 'normal');

  if (showAssistantSidePanel) {
    renderAssistantPanel(lines, styles, assistantColumn, 1, assistantWidth, height);
    if (isAssistantFocused()) return;
  } else if (isAssistantFocused()) {
    dimStyles(styles);
    renderAssistantOverlay(lines, styles, width, height);
    return;
  }

  if (editor.promptMode) {
    cursorTarget = {
      column: clamp(displayWidth(prompt) + 1, 1, width),
      row: height,
    };
    return;
  }

  const cursorLine = layout[cursorVisualIndex] ?? layout.at(-1);
  const cursorRow = cursorVisualIndex - editor.scroll + 3;
  const beforeCursor = Array.from(editor.lines[editor.cursor.line] ?? '')
    .slice(cursorLine?.start ?? 0, editor.cursor.column)
    .join('');
  cursorTarget = {
    column: clamp(
      contentCol + displayWidth(cursorLine?.prefix ?? '') + displayWidth(beforeCursor),
      1,
      Math.max(1, contentWidth + contentCol - 1),
    ),
    row: clamp(cursorRow, 3, Math.max(3, height - 2)),
  };
}

function renderEditorTiny(lines, styles, width, height) {
  if (height > 1) {
    put(lines, styles, 1, 1, `myblog editor · ${width}x${height} · enlarge window`, 'muted');
  }
  if (height > 2 && editor) {
    put(
      lines,
      styles,
      2,
      1,
      clipDisplayWidth(`${editor.row.path}${isEditorDirty() ? '  [+]' : ''}`, width),
      'normal',
    );
  }
  put(lines, styles, height, 1, 'buffer preserved', 'muted');
  cursorTarget = { column: 1, row: height };
}

function renderEditorFilePanel(lines, styles, startCol, startRow, panelWidth, panelHeight) {
  const innerWidth = Math.max(1, panelWidth - 3);
  fillRect(lines, styles, startRow, startCol, panelWidth, panelHeight, 'surface:normal');
  put(lines, styles, startRow, startCol + 1, 'Files', 'surface:accent');
  put(lines, styles, startRow + 1, startCol + 1, '^N new  ^O open', 'surface:faint');

  const draftRows = rows.filter((row) => row.status === 'draft');
  const postRows = rows.filter((row) => row.status === 'post' || row.status === 'draft?');
  const visibleRows = [
    { header: 'Drafts' },
    ...draftRows.slice(0, 8).map((row) => ({ row })),
    { header: 'Posts' },
    ...postRows.slice(0, Math.max(0, panelHeight - draftRows.length - 8)).map((row) => ({ row })),
  ];

  let rowNumber = startRow + 3;
  for (const item of visibleRows) {
    if (rowNumber >= startRow + panelHeight - 2) break;
    if (item.header) {
      put(lines, styles, rowNumber, startCol + 1, clipDisplayWidth(item.header, innerWidth), 'surface:muted');
      rowNumber += 1;
      continue;
    }

    const selected = item.row.filePath === editor.filePath;
    const styleName = selected ? 'surface:selected' : 'surface:normal';
    if (selected) fillRect(lines, styles, rowNumber, startCol, panelWidth, 1, styleName);
    const label = `${item.row.status === 'draft' ? 'D' : 'P'} ${item.row.title}`;
    put(lines, styles, rowNumber, startCol + 1, clipDisplayWidth(label, innerWidth), styleName);
    rowNumber += 1;
  }

  put(lines, styles, startRow + panelHeight - 2, startCol + 1, '^K commands', 'surface:faint');
}

function renderAssistantOverlay(lines, styles, width, height) {
  const panelWidth =
    width <= 82 ? width : Math.min(78, Math.max(assistantPanelMinWidth, width - 4));
  const panelHeight = Math.max(6, height - 2);
  const startCol = Math.max(1, Math.floor((width - panelWidth) / 2) + 1);
  renderAssistantPanel(lines, styles, startCol, 2, panelWidth, panelHeight);
}

function renderAssistantPanel(lines, styles, startCol, startRow, panelWidth, panelHeight) {
  if (!editor?.assistant) return;

  const assistant = editor.assistant;
  const textCol = startCol + 3;
  const innerWidth = Math.max(1, panelWidth - 4);
  const rightLabel = assistant.focused ? 'Esc' : '^A';
  const top = startRow;
  const bottom = startRow + panelHeight - 1;
  const statusRow = bottom - 2;
  const inputRow = bottom - 1;
  const controlsRow = bottom;
  const contentTop = top + 3;
  const contentRows = Math.max(0, statusRow - contentTop - 1);

  fillRect(lines, styles, startRow, startCol, panelWidth, panelHeight, 'surface:normal');
  for (let row = top; row <= bottom; row += 1) {
    put(lines, styles, row, startCol, '▌', 'surface:accent');
  }

  const action = currentAssistantAction();
  put(
    lines,
    styles,
    top,
    textCol,
    clipDisplayWidth(`${action.label} · ${currentAiModelLabel()}`, innerWidth),
    'surface:accent',
  );
  put(
    lines,
    styles,
    top,
    Math.max(textCol, startCol + panelWidth - displayWidth(rightLabel) - 1),
    rightLabel,
    'surface:muted',
  );

  let actionCol = textCol;
  for (const [index, item] of writingAssistantActions.entries()) {
    const label = index === assistant.actionIndex ? item.command : item.command;
    if (actionCol + displayWidth(label) >= startCol + panelWidth - 1) break;
    put(
      lines,
      styles,
      top + 1,
      actionCol,
      label,
      index === assistant.actionIndex ? 'surface:accent' : 'surface:muted',
    );
    actionCol += displayWidth(label) + 2;
  }

  const resultLines = getAssistantResultLines(innerWidth);
  const maxScroll = Math.max(0, resultLines.length - contentRows);
  assistant.scroll = clamp(assistant.scroll, 0, maxScroll);
  const visibleLines = resultLines.slice(assistant.scroll, assistant.scroll + contentRows);
  for (let index = 0; index < contentRows; index += 1) {
    const item = visibleLines[index];
    if (!item) continue;
    put(lines, styles, contentTop + index, textCol, item.text, `surface:${item.style}`);
  }

  const status =
    assistant.status ||
    assistantConnectionStatus({
      cliDefaultModel: grokCliDefaultModel,
      connection: aiConnection,
      model: aiModel,
    });
  put(
    lines,
    styles,
    statusRow,
    textCol,
    clipDisplayWidth(status, innerWidth),
    assistant.status ? 'surface:muted' : 'surface:faint',
  );

  const inputWidth = Math.max(1, innerWidth - 2);
  const visibleInput = startEllipsis(assistant.input, inputWidth);
  const prompt = `› ${visibleInput}`;
  put(
    lines,
    styles,
    inputRow,
    textCol,
    clipDisplayWidth(prompt || '› ', innerWidth),
    assistant.focused ? 'surface:strong' : 'surface:muted',
  );

  const footer = assistant.loading
    ? '^X stop · waiting for stream'
    : assistant.focused
      ? 'Enter send · arrows move · ^R apply'
      : '^A focus · ^K commands';
  put(
    lines,
    styles,
    controlsRow,
    textCol,
    clipDisplayWidth(footer, innerWidth),
    'surface:faint',
  );

  if (assistant.focused) {
    cursorTarget = {
      column: clamp(textCol + 2 + displayWidth(visibleInput), textCol, startCol + panelWidth - 2),
      row: inputRow,
    };
  }
}

function getAssistantResultLines(width) {
  if (!editor?.assistant) return [];

  const assistant = editor.assistant;
  if (assistant.resultWidth === width && assistant.resultLines.length) {
    return assistant.resultLines;
  }

  const lines = [];
  const push = (text = '', style = 'normal') => {
    if (!text) {
      lines.push({ style, text: '' });
      return;
    }
    for (const chunk of wrapLine(text, width)) {
      lines.push({ style, text: chunk });
    }
  };
  const pushBlock = (text = '', style = 'normal') => {
    for (const line of String(text).split(/\r?\n/)) {
      push(line, style);
    }
  };

  if (assistant.loading) {
    push(currentAssistantAction().label, 'accent');
    push('', 'normal');
    if (assistant.streamingText) {
      pushBlock(assistant.streamingText, 'normal');
    } else {
      push('Connecting to writing agent...', 'muted');
      push('The first chunk will appear here.', 'faint');
    }
  } else if (!assistant.result) {
    push('/idea /outline /draft /rewrite /polish', 'muted');
    push('/expand /compress /title /tweet /summary /critic', 'muted');
    push('Type context, choose a command, press Enter.', 'faint');
  } else {
    const result = assistant.result;
    push(getWritingAssistantAction(result.actionId).label, 'accent');
    push('', 'normal');
    pushBlock(result.reply || 'No response text.', 'normal');

    if (result.notes.length) {
      push('', 'normal');
      push('Notes', 'accent');
      for (const note of result.notes) push(`- ${note}`, 'muted');
    }

    if (result.titleSuggestions.length) {
      push('', 'normal');
      push('Titles', 'accent');
      for (const title of result.titleSuggestions) push(`- ${title}`, 'muted');
    }

    if (result.descriptionSuggestion) {
      push('', 'normal');
      push('Description', 'accent');
      push(result.descriptionSuggestion, 'muted');
    }

    if (result.replacementBody) {
      push('', 'normal');
      push('Replacement Preview', 'accent');
      pushBlock(result.replacementBody, 'normal');
    }
  }

  assistant.resultWidth = width;
  assistant.resultLines = lines.length ? lines : [{ style: 'muted', text: 'No assistant output.' }];
  return assistant.resultLines;
}

function layoutEditorBuffer(width) {
  if (!editor) return [];

  const numberWidth = editorLineNumbers ? String(editor.lines.length).length + 1 : 0;
  const textWidth = Math.max(1, width - numberWidth);
  const styles = editorMarkdownStyles(editor.lines);
  const layout = [];

  for (const [lineIndex, logicalLine] of editor.lines.entries()) {
    const characters = Array.from(logicalLine);
    const segments = [];
    let start = 0;
    while (start < characters.length) {
      let end = start;
      let used = 0;
      while (end < characters.length) {
        const characterDisplayWidth = characterWidth(characters[end]);
        if (end > start && used + characterDisplayWidth > textWidth) break;
        used += characterDisplayWidth;
        end += 1;
      }
      segments.push({ end, start, text: characters.slice(start, end).join('') });
      start = end;
    }
    if (!segments.length) segments.push({ end: 0, start: 0, text: '' });

    for (const [segmentIndex, segment] of segments.entries()) {
      const prefix = editorLineNumbers
        ? segmentIndex === 0
          ? `${String(lineIndex + 1).padStart(numberWidth - 1, ' ')} `
          : ' '.repeat(numberWidth)
        : '';
      layout.push({
        ...segment,
        lineIndex,
        prefix,
        style: styles[lineIndex],
      });
    }
  }

  return layout;
}

function findEditorCursorVisualIndex(layout) {
  if (!editor) return 0;

  const matchingIndexes = [];
  for (const [index, line] of layout.entries()) {
    if (line.lineIndex === editor.cursor.line) matchingIndexes.push(index);
  }
  for (const index of matchingIndexes) {
    const line = layout[index];
    if (editor.cursor.column < line.end || index === matchingIndexes.at(-1)) {
      return index;
    }
  }
  return matchingIndexes.at(-1) ?? 0;
}

function editorMarkdownStyles(logicalLines) {
  const styles = [];
  let inCodeBlock = false;
  let inFrontmatter = false;

  for (const [index, line] of logicalLines.entries()) {
    if (index === 0 && line.trim() === '---') {
      inFrontmatter = true;
      styles.push('border');
      continue;
    }
    if (inFrontmatter && line.trim() === '---') {
      inFrontmatter = false;
      styles.push('border');
      continue;
    }
    if (inFrontmatter) {
      styles.push('faint');
      continue;
    }
    if (/^\s*(```|~~~)/.test(line)) {
      inCodeBlock = !inCodeBlock;
      styles.push('muted');
    } else if (inCodeBlock) {
      styles.push('faint');
    } else if (/^\s*#{1,6}\s+/.test(line)) {
      styles.push('accent');
    } else if (/^\s*>/.test(line)) {
      styles.push('muted');
    } else if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      styles.push('accent');
    } else {
      styles.push('normal');
    }
  }

  return styles;
}

function editorFooterStatus() {
  if (!editor) return '';

  const dirty = isEditorDirty() ? 'modified' : 'saved';
  const position = `${editor.cursor.line + 1}:${editor.cursor.column + 1}`;
  const assistantHint = isAssistantEnabled()
    ? isAssistantFocused()
      ? '  AI focused'
      : '  ^A AI'
    : '';
  if (editor.keymap === 'vim') {
    return `${editor.vimMode.toUpperCase()}  ${dirty}  ${position}${assistantHint}  i/a/o/O insert  :w save  :q exit  / find`;
  }
  return `${dirty}  ${position}${assistantHint}  ^S save  ^F find  ^Z undo  ^Y redo  Esc exit`;
}

function editorPromptText() {
  if (!editor) return '';

  if (editor.promptMode === 'command') return `:${editor.commandInput}`;
  if (editor.promptMode === 'search') return `/${editor.commandInput}`;
  if (editor.promptMode === 'find') return `Find: ${editor.commandInput}`;
  if (editor.status) return editor.status;
  if (editor.keymap === 'vim' && editor.vimPending) return `${editor.vimPending}…`;
  return '';
}

function getEditorPageRows(height = process.stdout.rows || 32) {
  return Math.max(1, height - 4);
}

function currentEditorContentWidth() {
  const width = Math.max(1, process.stdout.columns || 100);
  const height = Math.max(1, process.stdout.rows || 32);
  const showFilePanel = width >= editorThreeColumnMinTerminalWidth && height >= 12;
  const filePanelWidth = showFilePanel
    ? clamp(Math.floor(width * 0.2), editorFilePanelMinWidth, editorFilePanelMaxWidth)
    : 0;
  const fileGapWidth = showFilePanel ? 2 : 0;
  const contentCol = showFilePanel ? filePanelWidth + fileGapWidth + 1 : 2;
  const showAssistantSidePanel =
    isAssistantEnabled() &&
    width >= assistantSidePanelMinTerminalWidth &&
    height >= 12;
  const assistantWidth = showAssistantSidePanel
    ? clamp(Math.floor(width * 0.34), assistantPanelMinWidth, assistantPanelMaxWidth)
    : 0;
  const gapWidth = showAssistantSidePanel ? 2 : 0;
  return Math.max(1, width - contentCol - assistantWidth - gapWidth);
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
  if (view === 'posts') {
    return 'Enter read  e default edit  i builtin  o Typora  d d trash  t trash  Esc home  / commands';
  }
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
      ? 'j/k scroll  ^F/^B page  gg top  G end  n/p next  e edit  i builtin  o Typora  Esc posts  / commands'
      : 'j/k  ^F/^B  gg/G  n/p  e/i/o  Esc  /';
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

function setCommandInput(value) {
  input = value;
  resetCommandSelection();
}

function resetCommandSelection() {
  selectedCommandIndex = 0;
  commandScroll = 0;
}

function visibleSelectionScroll(selectedIndex, scroll, totalItems, visibleCount) {
  const maxScroll = Math.max(0, totalItems - visibleCount);
  const boundedScroll = clamp(scroll, 0, maxScroll);
  if (selectedIndex < boundedScroll) return selectedIndex;
  if (selectedIndex >= boundedScroll + visibleCount) {
    return selectedIndex - visibleCount + 1;
  }
  return boundedScroll;
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
  process.stdout.write(`${ansi.reset}\x1b]112\x07\x1b[?7h\x1b[?25h\x1b[?1049l`);
}

function cursorColorSequence() {
  return `\x1b]12;${themes[themeName].cursorColor}\x07`;
}
