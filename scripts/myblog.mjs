#!/usr/bin/env node
// myblog：在终端里写博客文章，一键发布到网站。用法见 README「写文章」。
import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SITE_URL } from '../site.config.mjs';
import { AI_ACTIONS, NO_KEY_MESSAGE, aiConfig, buildMessages, parseTitles, streamReply } from './myblog/ai.mjs';
import {
  BlogError,
  FEATURED,
  PUBLISH_STEPS,
  ROOT,
  TOPICS,
  createDraft,
  droppedImagePath,
  headingTitle,
  isBlankDraft,
  joinDocument,
  listDocs,
  liveVersion,
  nextPostId,
  postUrl,
  preparePost,
  publish,
  pushPending,
  readFields,
  splitDocument,
  trashDraft,
  unpushedCount,
  waitUntilLive,
  writeFields,
  zonedTime,
} from './myblog/blog.mjs';
import { TextBuffer, cursorRow, layout, widthOf, wordCount } from './myblog/editor.mjs';
import { Screen, clip, graphemes, paint, textWidth, wrap } from './myblog/terminal.mjs';

const USAGE = `用法：
  myblog           打开写作界面
  myblog install   把 myblog 命令装到 PATH 里，之后在任何目录都能打开`;

const command = process.argv[2];
if (command === 'install') {
  await install();
  process.exit(0);
}
if (command) {
  console.log(USAGE);
  process.exit(command === '-h' || command === '--help' ? 0 : 1);
}
if (!process.stdin.isTTY || !process.stdout.isTTY) {
  console.error('myblog 要在终端里直接运行。');
  process.exit(1);
}

// AI 的 API key 可以写在博客目录的 .env 里。
try {
  process.loadEnvFile(path.join(ROOT, '.env'));
} catch {
  // 没有 .env 也没关系，可以用 shell 里 export 的变量。
}

const HOST = new URL(SITE_URL).host;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const STEPS = [...PUBLISH_STEPS, ['live', '等待网站更新']];

// 发布页上的几项：名字、提示和没填时显示的灰字。
const FORM_FIELDS = {
  title: { label: '标题', hint: '一句话说出这篇的观点，读标题就知道在说什么。', placeholder: '还没写' },
  description: { label: '导语', hint: '一句话，显示在标题下面，也是首页和 RSS 的摘要。', placeholder: '还没写' },
  tags: { label: '主题', hint: `←→ 挑，空格选中或取消，也可以直接按数字。选「${FEATURED}」会放进首页精选。` },
  slug: { label: '网址', hint: '可选：小写英文、数字和连字符，比如 compound 就是 /posts/compound/。' },
  date: { label: '时间', hint: '发布时间，写成 2026-10-14 或 2026-10-14 21:30；删掉就用发布那一刻。', placeholder: '发布那一刻' },
  submit: { hint: '会先检查一遍，有问题列在下面，不会发出去。' },
};
const CHIPS = [...TOPICS, FEATURED];
const LABEL_WIDTH = 9;

const screen = new Screen();
const state = {
  view: 'list',
  docs: { drafts: [], posts: [] },
  selected: 0,
  listScroll: 0,
  confirmDelete: null,
  message: null,
  unpushed: 0,
  deploy: null,
  editor: null,
  form: null,
  publishing: null,
  frame: 0,
};
let renderPending = false;
let ticker = null;
let messageTimer = null;
let quitting = false;
let hungUp = false;

/* ---------- 启动和退出 ---------- */

process.on('uncaughtException', crash);
process.on('unhandledRejection', crash);
process.on('SIGTERM', () => quit());
process.on('SIGHUP', () => {
  // 终端窗口被关掉了：不再往屏幕上写。
  hungUp = true;
  quit();
});
process.stdout.on('error', () => {});
process.stdin.on('error', () => {});

await refresh();
let keyQueue = Promise.resolve();
screen.start(
  (key) => {
    keyQueue = keyQueue.then(() => handleKey(key)).catch(crash);
  },
  () => render(),
);
render();

function crash(error) {
  saveDraftNow();
  screen.stop();
  console.error('myblog 出错退出了，草稿已经保存。错误信息：');
  console.error(error);
  process.exit(1);
}

function quit() {
  // 正在发布时等它做完再退出，免得留下写了一半、没提交的文章。
  if (state.publishing?.phase === 'running') {
    quitting = true;
    return;
  }
  saveDraftNow();
  if (!hungUp) screen.stop();
  process.exit(0);
}

/** 退出前把没来得及自动保存的草稿（包括发布页上填了一半的）写进文件。 */
function saveDraftNow() {
  try {
    if (state.form) applyForm(state.form);
    for (const session of new Set([state.editor, state.form?.session])) {
      if (session?.doc.kind !== 'draft') continue;
      const text = documentText(session);
      if (text !== session.savedText) writeFileSync(session.doc.file, text, 'utf8');
    }
  } catch {
    // 尽力而为。
  }
}

async function refresh() {
  state.docs = await listDocs();
  state.selected = clamp(state.selected, 0, Math.max(0, items().length - 1));
  unpushedCount().then((count) => {
    state.unpushed = count;
    render();
  });
}

function items() {
  return [...state.docs.drafts, ...state.docs.posts];
}

/* ---------- 绘制 ---------- */

/** 流式输出时一帧只画一次。 */
function requestRender() {
  if (renderPending) return;
  renderPending = true;
  setTimeout(() => {
    renderPending = false;
    render();
  }, 30);
}

function render() {
  if (!screen.active || hungUp) return;
  const width = screen.width;
  const height = screen.height;
  const views = { editor: renderEditor, form: renderForm, publish: renderPublish, list: renderList };
  const view = views[state.view](width, height);
  screen.draw(view.rows, view.cursor ?? null);
  keepTicking();
}

/** 发布、等上线、等 AI 时让转圈动画动起来。 */
function keepTicking() {
  const busy =
    state.publishing?.phase === 'running' ||
    state.deploy?.status === 'waiting' ||
    ['thinking', 'writing'].includes(state.editor?.ai?.status);
  if (busy && !ticker) {
    ticker = setInterval(() => {
      state.frame += 1;
      render();
    }, 120);
  } else if (!busy && ticker) {
    clearInterval(ticker);
    ticker = null;
  }
}

function spinner() {
  return SPINNER[state.frame % SPINNER.length];
}

function say(text, tone = 'plain', sticky = false) {
  state.message = { text, tone };
  clearTimeout(messageTimer);
  if (!sticky) {
    messageTimer = setTimeout(() => {
      state.message = null;
      render();
    }, 6000);
  }
  render();
}

function clearMessage() {
  clearTimeout(messageTimer);
  state.message = null;
}

function messageSegments() {
  return state.message ? [[` ${state.message.text}`, state.message.tone]] : null;
}

/* ---------- 按键 ---------- */

async function handleKey(key) {
  if (state.view === 'editor') {
    await editorKey(key);
  } else if (state.view === 'form') {
    await formKey(key);
  } else if (key.name === 'text') {
    // 列表和发布页上的字母是快捷键，一个一个处理。
    for (const letter of key.text) await (state.view === 'list' ? listKey : publishKey)({ name: letter });
  } else {
    await (state.view === 'list' ? listKey : publishKey)(key);
  }
  render();
}

/* ---------- 列表 ---------- */

async function listKey(key) {
  const list = items();
  const doc = list[state.selected];
  const name = key.name;
  if (name !== 'd') state.confirmDelete = null;
  if (state.message?.tone !== 'error' || name !== 'u') clearMessage();

  if (key.ctrl && name === 'c') quit();
  else if (name === 'up' || name === 'k') state.selected = Math.max(0, state.selected - 1);
  else if (name === 'down' || name === 'j') state.selected = Math.min(list.length - 1, state.selected + 1);
  else if (name === 'enter' && doc) await openEditor(doc);
  else if (name === 'n') await openEditor(null);
  else if (name === 'p' && doc?.kind === 'draft') openForm(await openSession(doc));
  else if (name === 'p' && doc) say('已发布的文章按 Enter 打开修改，改完在编辑器里按 Ctrl+P 更新。');
  else if (name === 'd' && doc?.kind === 'draft') await deleteDraft(doc);
  else if (name === 'o' && doc?.kind === 'post') openUrl(postUrl(doc.id));
  else if (name === 'u' && state.unpushed) await pushNow();
  else if (name === 'q' || name === 'escape') quit();
}

async function deleteDraft(doc) {
  if (state.confirmDelete !== doc.file) {
    state.confirmDelete = doc.file;
    return;
  }
  state.confirmDelete = null;
  await trashDraft(doc.file);
  await refresh();
  say('草稿删掉了。删错了可以去 src/content/drafts/.trash/ 里找回来。');
}

async function pushNow() {
  say('正在推送到 GitHub…', 'plain', true);
  try {
    await pushPending();
    state.unpushed = 0;
    say('推送好了，网站几分钟后更新。', 'ok');
  } catch (error) {
    say(`${error.message} ${error.problems?.at(-1) ?? ''}`, 'error', true);
  }
}

function renderList(width, height) {
  const { drafts, posts } = state.docs;
  const lines = [{ segments: [['  草稿', 'dim']] }];
  if (!drafts.length) lines.push({ segments: [['    还没有草稿，按 n 写一篇。', 'dim']] });
  drafts.forEach((doc, index) => lines.push({ doc, index }));
  lines.push({ segments: [] }, { segments: [['  已发布', 'dim']] });
  if (!posts.length) lines.push({ segments: [['    还没有发布过文章。', 'dim']] });
  posts.forEach((doc, index) => lines.push({ doc, index: drafts.length + index }));

  const visible = height - 4;
  const selectedLine = lines.findIndex((line) => line.index === state.selected);
  if (selectedLine < state.listScroll + 1) state.listScroll = Math.max(0, selectedLine - 1);
  if (selectedLine >= state.listScroll + visible) state.listScroll = selectedLine - visible + 1;
  state.listScroll = clamp(state.listScroll, 0, Math.max(0, lines.length - visible));

  const rows = [
    paint(spread([[' myblog', 'strong']], [[`${HOST} `, 'dim']], width), width),
    paint([], width),
  ];
  for (const line of lines.slice(state.listScroll, state.listScroll + visible)) {
    rows.push(line.doc ? listRow(line.doc, line.index === state.selected, width) : paint(line.segments, width));
  }
  while (rows.length < height - 2) rows.push(paint([], width));

  const doc = items()[state.selected];
  const keys =
    doc?.kind === 'post'
      ? ' Enter 修改 · o 打开网页 · n 新建 · q 退出'
      : ' Enter 写 · p 发布 · d 删除 · n 新建 · q 退出';
  rows.push(paint(messageSegments() ?? listStatus(), width));
  rows.push(paint([[keys, 'dim']], width));
  return { rows };
}

function listRow(doc, selected, width) {
  const meta =
    state.confirmDelete === doc.file
      ? [['再按一次 d 删除这篇草稿', 'error']]
      : [[doc.kind === 'draft' ? timeAgo(doc.mtime) : shortDate(doc.date), 'dim']];
  // 还没起标题的草稿显示正文的第一句。
  const title = doc.title || doc.excerpt || '（空白）';
  const titleStyle = selected ? 'bold' : doc.title ? 'plain' : 'dim';
  return paint(spread([[selected ? '  › ' : '    ', 'accent'], [title, titleStyle]], [...meta, [' ']], width), width);
}

function listStatus() {
  const deploy = state.deploy;
  if (deploy?.status === 'waiting') {
    const seconds = Math.round((Date.now() - deploy.since) / 1000);
    return [[` ${spinner()} 「${deploy.title}」已推送，等网站更新（${seconds} 秒）…`, 'accent']];
  }
  if (deploy?.status === 'live') return [[' ✓ ', 'ok'], [`「${deploy.title}」已上线：${deploy.url}`]];
  if (deploy?.status === 'timeout') {
    return [[` 「${deploy.title}」等了 10 分钟网站还没更新，去 GitHub 仓库的 Actions 页面看看。`, 'error']];
  }
  if (state.unpushed) return [[` 有 ${state.unpushed} 个提交还没推送到 GitHub，按 u 推送。`, 'error']];
  return [];
}

/* ---------- 编辑器 ---------- */

async function openEditor(doc) {
  if (!doc) {
    const file = await createDraft();
    await refresh();
    doc = state.docs.drafts.find((draft) => draft.file === file);
  }
  const session = await openSession(doc);
  placeCursor(session.buffer, doc);
  state.editor = Object.assign(session, { scroll: 0, popup: null, popupClosed: false, prompt: null, ai: null, leaving: false });
  state.view = 'editor';
  clearMessage();
}

/**
 * 打开一篇：标题、导语这些（frontmatter）原样存在 head 里不显示，buffer 里只有正文。
 * 编辑器和从列表直接打开的发布页都用它。
 */
async function openSession(doc) {
  const { head, body } = splitDocument(await readFile(doc.file, 'utf8'));
  return { doc, head, buffer: new TextBuffer(body), savedText: joinDocument(head, body), saving: Promise.resolve(), saveTimer: null };
}

/** 存进文件的样子：frontmatter 加正文。 */
function documentText(session) {
  return joinDocument(session.head, session.buffer.text);
}

/** 草稿停在最后一个字后面，已发布的文章停在开头。 */
function placeCursor(buffer, doc) {
  if (doc.kind === 'post') return buffer.setCursor(0, 0);
  let last = buffer.lines.length - 1;
  while (last > 0 && !buffer.lines[last].trim()) last -= 1;
  buffer.setCursor(last, Infinity);
}

async function editorKey(key) {
  const editor = state.editor;
  const buffer = editor.buffer;
  if (editor.ai) return aiPanelKey(key);
  if (editor.prompt) return promptKey(key);
  if (editor.popup && popupKey(key)) return;

  const { name, ctrl, alt } = key;
  if (name === 'escape' || (ctrl && name === 'c')) return leaveEditor();
  if (editor.leaving) {
    editor.leaving = false;
    clearMessage();
  }
  if (ctrl && name === 's') return saveDraft(editor, true);
  if (ctrl && name === 'p') return publishFromEditor();
  if (ctrl && name === 'k') return openPrompt();

  const before = buffer.version;
  const columns = editorColumns(screen.width).columns;
  if (name === 'text') buffer.insert(key.text);
  else if (name === 'paste') insertPaste(key.text);
  else if (name === 'enter') buffer.insert('\n');
  else if (name === 'tab') buffer.insert('  ');
  else if (name === 'backspace') alt || ctrl ? buffer.deleteWordBackward() : buffer.backspace();
  else if (name === 'delete') buffer.deleteForward();
  else if (name === 'left') alt || ctrl ? buffer.wordLeft() : buffer.left();
  else if (name === 'right') alt || ctrl ? buffer.wordRight() : buffer.right();
  else if (name === 'up') buffer.vertical(-1, columns);
  else if (name === 'down') buffer.vertical(1, columns);
  else if (name === 'pageup') buffer.vertical(-(screen.height - 5), columns);
  else if (name === 'pagedown') buffer.vertical(screen.height - 5, columns);
  else if (name === 'home' || (ctrl && name === 'a')) buffer.home();
  else if (name === 'end' || (ctrl && name === 'e')) buffer.end();
  else if (ctrl && name === 'w') buffer.deleteWordBackward();
  else if (ctrl && name === 'z') buffer.undo();
  else if (ctrl && name === 'y') buffer.redo();

  if (buffer.version !== before) scheduleSave();
  updatePopup();
}

/** 拖进来的图片文件变成 ![](路径)，发布时会复制到网站上；其他内容原样粘贴。 */
function insertPaste(text) {
  const image = droppedImagePath(text);
  state.editor.buffer.insert(image ? `![](${/\s/.test(image) ? `<${image}>` : image})` : text);
}

function scheduleSave() {
  const editor = state.editor;
  if (editor.doc.kind !== 'draft') return;
  clearTimeout(editor.saveTimer);
  editor.saveTimer = setTimeout(() => saveDraft(editor), 500);
}

/** 草稿自动保存；已发布的文章只在 Ctrl+P 更新时写回。 */
async function saveDraft(session, explicit = false) {
  if (!session) return;
  if (session.doc.kind !== 'draft') {
    if (explicit) say('已发布的文章不会自动保存，改完按 Ctrl+P 更新上线。');
    return;
  }
  clearTimeout(session.saveTimer);
  session.saving = session.saving.then(async () => {
    const text = documentText(session);
    if (text === session.savedText) return;
    try {
      await writeFile(session.doc.file, text, 'utf8');
      session.savedText = text;
    } catch (error) {
      say(`保存失败：${error.message}`, 'error', true);
    }
  });
  await session.saving;
  if (explicit) say('已保存。', 'ok');
  render();
}

async function leaveEditor() {
  const editor = state.editor;
  if (editor.doc.kind === 'post' && documentText(editor) !== editor.savedText && !editor.leaving) {
    editor.leaving = true;
    say('这篇有还没发布的修改。按 Ctrl+P 更新上线，或者再按一次 Esc 放弃修改。', 'error', true);
    return;
  }
  await saveDraft(editor);
  closeEditor();
  // 什么都没写的新草稿直接删掉，不留空壳。
  if (editor.doc.kind === 'draft' && isBlankDraft(documentText(editor))) await rm(editor.doc.file, { force: true });
  await refresh();
  const index = items().findIndex((doc) => doc.file === editor.doc.file);
  if (index >= 0) state.selected = index;
}

function closeEditor() {
  const editor = state.editor;
  if (!editor) return;
  clearTimeout(editor.saveTimer);
  editor.ai?.controller.abort();
  state.editor = null;
  state.view = 'list';
  clearMessage();
}

async function publishFromEditor() {
  await saveDraft(state.editor);
  openForm(state.editor);
}

/** 计算正文这一栏的位置：最宽 76 格，居中；开着 AI 面板时让出右边。 */
function editorColumns(width) {
  const side = Boolean(state.editor?.ai) && width >= 100;
  const panel = side ? clamp(Math.floor(width * 0.4), 36, 64) : 0;
  const area = width - panel - (side ? 1 : 0);
  const columns = Math.max(10, Math.min(76, area - 4));
  return { side, panel, area, columns, margin: Math.max(1, Math.floor((area - columns) / 2)) };
}

function renderEditor(width, height) {
  const editor = state.editor;
  const buffer = editor.buffer;
  const { side, panel, area, columns, margin } = editorColumns(width);
  const top = 2;
  const visible = height - 4;
  // 窗口窄的时候 AI 面板盖住下半屏，光标要留在上半屏。
  const overlayTop = Math.floor(visible / 2);
  const textRows = editor.ai && !side ? overlayTop - 1 : visible;

  const rows = layout(buffer.lines, columns);
  const current = cursorRow(rows, buffer);
  if (current < editor.scroll) editor.scroll = current;
  if (current >= editor.scroll + textRows) editor.scroll = current - textRows + 1;
  // 内容变短（比如撤销了一大段粘贴）时不留着空白往上滚。
  editor.scroll = clamp(editor.scroll, 0, Math.max(0, rows.length - textRows));

  const styles = lineStyles(buffer.lines);
  // AI 在改的那一段，左边画一条竖线。
  const marked = ['polish', 'ask'].includes(editor.ai?.action) ? editor.ai.paragraph : null;
  const body = [];
  for (let index = 0; index < visible; index += 1) {
    const row = rows[editor.scroll + index];
    if (!row) {
      body.push(paint([], area));
      continue;
    }
    const parts = graphemes(buffer.lines[row.line]).slice(row.start, row.end);
    const gutter =
      marked && row.line >= marked.start && row.line <= marked.end && margin >= 2
        ? [[' '.repeat(margin - 2)], ['▎ ', 'accent']]
        : [[' '.repeat(margin)]];
    body.push(paint([...gutter, ...group(parts, styles[row.line].slice(row.start, row.end))], area));
  }

  const cursorScreenRow = top + current - editor.scroll;
  const cursorCol = margin + widthOf(buffer.parts().slice(rows[current].start, buffer.col));
  if (editor.popup) drawPopup(body, current - editor.scroll, area, margin, visible);

  // 顶部：草稿还是已发布、标题（起了才有）、保存状态、字数。
  const doc = editor.doc;
  const title = readFields(editor.head, buffer.text).title;
  const label = [[doc.kind === 'draft' ? ' 草稿' : ' 已发布', 'dim'], ...(title ? [[' · ', 'dim'], [title, 'bold']] : [])];
  const dirty = documentText(editor) !== editor.savedText;
  const status = doc.kind === 'draft' ? (dirty ? '保存中' : '已保存') : dirty ? '有修改，还没发布' : `/posts/${doc.id}/`;
  const header = paint(spread(label, [[`${status} · ${wordCount(buffer.text)} 字 `, 'dim']], width), width);

  let screenRows = [header, paint([], width)];
  if (side) {
    const aiRows = renderAiPanel(panel, height - 2);
    screenRows[0] = paint(spread(label, [], area), area) + paint([['│', 'dim']], 1) + aiRows[0];
    screenRows[1] = paint([], area) + paint([['│', 'dim']], 1) + aiRows[1];
    body.forEach((row, index) => screenRows.push(row + paint([['│', 'dim']], 1) + aiRows[index + 2]));
  } else if (editor.ai) {
    const aiRows = renderAiPanel(width, visible - overlayTop + 1);
    screenRows.push(...body.slice(0, textRows), paint([['─'.repeat(width), 'dim']], width), aiRows[0], ...aiRows.slice(2));
  } else {
    screenRows.push(...body);
  }

  const bottom = editorBottom(width);
  screenRows.push(...bottom.rows);

  let cursor = null;
  if (editor.prompt) cursor = { row: height - 1, col: Math.min(width - 1, 3 + textWidth(editor.prompt.input)) };
  else if (!editor.ai) cursor = { row: cursorScreenRow, col: Math.min(area - 1, cursorCol) };
  return { rows: screenRows, cursor };
}

/** 最下面两行：提示和快捷键。打开 AI 输入框时变成输入框。 */
function editorBottom(width) {
  const editor = state.editor;
  const doc = editor.doc;
  if (editor.prompt) {
    const presets = AI_ACTIONS.map((action) => `${action.key} ${action.label}`).join(' · ');
    return {
      rows: [
        paint([[' AI ', 'strong'], [`${presets} · 或者直接写要求，Enter 发送 · Esc 取消`, 'dim']], width),
        paint([[' › ', 'accent'], [editor.prompt.input]], width),
      ],
    };
  }
  if (editor.ai) return { rows: [paint(messageSegments() ?? [], width), paint([[` ${aiKeys(editor.ai)}`, 'dim']], width)] };

  const hint = messageSegments() ?? (editor.popup
    ? [[' ↑↓ 选文章 · Tab 插入链接 · Esc 关掉', 'dim']]
    : editor.buffer.linkQuery() !== null && !state.docs.posts.length
      ? [[' 还没有发布的文章可以链接。', 'dim']]
      : doc.kind === 'draft' && !editor.buffer.text.trim()
        ? [[' 直接写正文。标题、导语和主题，发布时再填。', 'dim']]
        : []);
  const keys =
    doc.kind === 'draft'
      ? ' Ctrl+P 发布 · Ctrl+K AI 助手 · Ctrl+Z 撤销 · Esc 回到列表'
      : ' Ctrl+P 更新上线 · Ctrl+K AI 助手 · Ctrl+Z 撤销 · Esc 回到列表';
  return { rows: [paint(hint, width), paint([[keys, 'dim']], width)] };
}

/** 每一行每个字的样式：代码是灰的，标题加粗，[[链接]] 和图片用强调色。 */
function lineStyles(lines) {
  let fence = '';
  return lines.map((line) => {
    const parts = graphemes(line);
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence || marker) {
      if (!fence) fence = marker;
      else if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length)) fence = '';
      return parts.map(() => 'dim');
    }
    if (/^#{1,6}\s/.test(line)) return parts.map(() => 'bold');
    const styles = parts.map(() => 'plain');
    const offsets = [];
    let offset = 0;
    for (const part of parts) {
      offsets.push(offset);
      offset += part.length;
    }
    for (const match of line.matchAll(/\[\[[^\]\n]*\]\]|!?\[[^\]\n]*\]\([^)\n]*\)/g)) {
      const end = match.index + match[0].length;
      offsets.forEach((start, i) => {
        if (start >= match.index && start < end) styles[i] = 'accent';
      });
    }
    return styles;
  });
}

/** 把相邻同样式的字合成一段。 */
function group(parts, styles) {
  const segments = [];
  parts.forEach((part, index) => {
    const last = segments.at(-1);
    if (last && last[1] === styles[index]) last[0] += part;
    else segments.push([part, styles[index]]);
  });
  return segments;
}

/* ---------- [[ 链接提示 ---------- */

function updatePopup() {
  const editor = state.editor;
  const query = editor.buffer.linkQuery();
  if (query === null) {
    editor.popup = null;
    editor.popupClosed = false;
    return;
  }
  if (editor.popupClosed) return;
  const key = query.toLowerCase().replace(/\s+/g, '');
  const matches = state.docs.posts
    .filter((post) => !key || post.title.toLowerCase().replace(/\s+/g, '').includes(key) || post.id.startsWith(key))
    .slice(0, 6);
  editor.popup = matches.length ? { matches, selected: Math.min(editor.popup?.selected ?? 0, matches.length - 1) } : null;
}

function popupKey(key) {
  const editor = state.editor;
  const popup = editor.popup;
  if (key.name === 'up') popup.selected = Math.max(0, popup.selected - 1);
  else if (key.name === 'down') popup.selected = Math.min(popup.matches.length - 1, popup.selected + 1);
  else if (key.name === 'tab' || key.name === 'enter') {
    editor.buffer.completeLink(popup.matches[popup.selected].title);
    editor.popup = null;
    scheduleSave();
  } else if (key.name === 'escape') {
    editor.popup = null;
    editor.popupClosed = true;
  } else {
    return false;
  }
  return true;
}

/** 链接提示画在光标下面一行（放不下就画在上面）。 */
function drawPopup(body, cursorLine, area, margin, visible) {
  const { matches, selected } = state.editor.popup;
  const below = cursorLine + 1 + matches.length <= visible;
  const start = below ? cursorLine + 1 : Math.max(0, cursorLine - matches.length);
  matches.forEach((post, index) => {
    const active = index === selected;
    body[start + index] = paint(
      [[' '.repeat(margin)], [active ? ' › ' : '   ', 'accent'], [post.title, active ? 'inverse' : 'plain'], [`  ${shortDate(post.date)}`, 'dim']],
      area,
    );
  });
}

/* ---------- AI 助手 ---------- */

function openPrompt() {
  if (!aiConfig()) return say(NO_KEY_MESSAGE, 'error', true);
  state.editor.popup = null;
  state.editor.prompt = { input: '' };
}

function promptKey(key) {
  const prompt = state.editor.prompt;
  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    state.editor.prompt = null;
  } else if (key.name === 'enter') {
    if (prompt.input.trim()) runAi('ask', prompt.input.trim());
  } else if (key.name === 'backspace') {
    prompt.input = graphemes(prompt.input).slice(0, -1).join('');
  } else if (key.name === 'text' || key.name === 'paste') {
    const preset = !prompt.input && AI_ACTIONS.find((action) => action.key === key.text);
    if (preset) runAi(preset.id);
    else prompt.input += key.text.replace(/\s+/g, ' ');
  }
}

async function runAi(action, request = '') {
  const editor = state.editor;
  editor.prompt = null;
  const paragraph = editor.buffer.paragraph();
  if (action === 'polish' && !paragraph) return say('先把光标放到要润色的那一段里。', 'error');

  const config = aiConfig();
  const label = action === 'ask' ? request : AI_ACTIONS.find((item) => item.id === action).label;
  const ai = { action, label, paragraph, model: config.label, text: '', status: 'thinking', error: '', scroll: 0, follow: true, controller: new AbortController() };
  editor.ai = ai;
  render();
  try {
    const messages = buildMessages(action, { article: aiArticle(editor), paragraph: paragraph?.text, request });
    for await (const part of streamReply(config, messages, ai.controller.signal)) {
      if (part.text) {
        ai.text += part.text;
        ai.status = 'writing';
      }
      requestRender();
    }
    if (!ai.text.trim()) throw new Error('AI 没有返回内容，再试一次。');
    ai.status = 'done';
    if (action === 'titles') ai.titles = parseTitles(ai.text);
  } catch (error) {
    if (ai.controller.signal.aborted) return;
    ai.status = 'error';
    ai.error = error.message;
  }
  render();
}

function aiKeys(ai) {
  if (ai.status === 'thinking' || ai.status === 'writing') return 'Esc 停止';
  if (ai.status === 'error') return 'Esc 关掉';
  if (ai.action === 'polish') return 'Enter 替换这一段 · ↑↓ 滚动 · Esc 不用了';
  if (ai.action === 'titles') return ai.titles?.length ? `1-${ai.titles.length} 用作标题 · Esc 关掉` : 'Esc 关掉';
  if (ai.action === 'ask') return `Enter 插到${ai.paragraph ? '这一段后面 · r 替换这一段' : '光标处'} · ↑↓ 滚动 · Esc 关掉`;
  return '↑↓ 滚动 · Esc 关掉';
}

function aiPanelKey(key) {
  const editor = state.editor;
  const ai = editor.ai;
  const buffer = editor.buffer;
  const text = ai.text.trim();
  const close = (message) => {
    editor.ai = null;
    if (message) say(message, 'ok');
    scheduleSave();
  };

  if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
    ai.controller.abort();
    editor.ai = null;
  } else if (key.name === 'up' || key.name === 'pageup') {
    ai.follow = false;
    ai.scroll = Math.max(0, ai.scroll - (key.name === 'up' ? 1 : 10));
  } else if (key.name === 'down' || key.name === 'pagedown') {
    ai.scroll += key.name === 'down' ? 1 : 10;
  } else if (ai.status !== 'done') {
    // 生成中只能停止或滚动。
  } else if (ai.action === 'polish' && key.name === 'enter') {
    buffer.replaceLines(ai.paragraph.start, ai.paragraph.end, text);
    close('这一段换好了，不满意按 Ctrl+Z 撤回。');
  } else if (ai.action === 'titles' && key.name === 'text' && ai.titles?.[Number(key.text) - 1]) {
    const title = ai.titles[Number(key.text) - 1];
    retitle(editor, title);
    close(`标题定为「${title}」，发布时还能改。`);
  } else if (ai.action === 'ask' && key.name === 'enter') {
    if (ai.paragraph) {
      buffer.setCursor(ai.paragraph.end, Infinity);
      buffer.insert(`\n\n${text}`);
    } else {
      buffer.insert(text);
    }
    close('插进去了，不满意按 Ctrl+Z 撤回。');
  } else if (ai.action === 'ask' && ai.paragraph && key.name === 'text' && key.text === 'r') {
    buffer.replaceLines(ai.paragraph.start, ai.paragraph.end, text);
    close('这一段换好了，不满意按 Ctrl+Z 撤回。');
  }
}

/** 发给 AI 的全文：填过的标题、导语放在正文前面。 */
function aiArticle(session) {
  const { title, description } = readFields(session.head);
  return [title && `标题：${title}`, description && `导语：${description}`, session.buffer.text].filter(Boolean).join('\n\n');
}

/**
 * 换标题：写进不显示的 frontmatter。正文第一行的「# 标题」原来就是标题时，那一行也一起换，
 * 不然发布出去会多一个旧标题。
 */
function retitle(session, title) {
  const buffer = session.buffer;
  const old = readFields(session.head, buffer.text).title;
  const first = buffer.lines.findIndex((line) => line.trim());
  if (title && old && title !== old && headingTitle(buffer.lines[first] ?? '') === old) {
    const { line, col } = buffer;
    buffer.replaceLines(first, first, `# ${title}`);
    buffer.setCursor(line, col);
  }
  session.head = writeFields(session.head, { title });
}

function renderAiPanel(width, height) {
  const ai = state.editor.ai;
  const inner = width - 2;
  const rows = [paint([[' AI · ', 'strong'], [ai.label, 'strong'], [`  ${ai.model}`, 'dim']], width), paint([], width)];

  let lines;
  if (ai.status === 'error') lines = wrap(ai.error, inner).map((line) => [[` ${line}`, 'error']]);
  else if (!ai.text) lines = [[[` ${spinner()} 思考中…`, 'dim']]];
  else if (ai.action === 'titles' && ai.status === 'done' && ai.titles?.length) {
    lines = ai.titles.flatMap((title, index) => wrap(`${index + 1}. ${title}`, inner).map((line) => [[` ${line}`]]));
  } else {
    lines = wrap(ai.text.trim(), inner).map((line) => [[` ${line}`]]);
    if (ai.status === 'writing') lines.push([[` ${spinner()}`, 'accent']]);
  }

  const visible = height - 2;
  const maxScroll = Math.max(0, lines.length - visible);
  ai.scroll = ai.follow ? maxScroll : clamp(ai.scroll, 0, maxScroll);
  // 往上翻过之后再翻回底部，继续跟着新出来的字走。
  if (ai.scroll === maxScroll) ai.follow = true;
  for (const line of lines.slice(ai.scroll, ai.scroll + visible)) rows.push(paint(line, width));
  while (rows.length < height) rows.push(paint([], width));
  return rows;
}

/* ---------- 发布页：标题、导语、主题、网址 ---------- */

/** 打开发布页。session 是编辑器里的这一篇，或者从列表直接打开的草稿。 */
function openForm(session) {
  const fields = readFields(session.head, session.buffer.text);
  const draft = session.doc.kind === 'draft';
  const input = (text) => {
    const buffer = new TextBuffer(text);
    buffer.setCursor(0, Infinity);
    return buffer;
  };
  const form = {
    session,
    inputs: {
      title: input(fields.title),
      description: input(fields.description),
      // 已发布的文章不能改网址；发布时间只有草稿里手写过才显示。
      slug: draft ? input(fields.slug) : null,
      date: draft && fields.date ? input(fields.date) : null,
    },
    tags: fields.tags,
    chips: [...CHIPS, ...fields.tags.filter((tag) => !CHIPS.includes(tag))],
    chip: 0,
    focus: 'title',
    error: '',
    problems: [],
  };
  // 光标停在第一个没填的地方；都填好了就停在「发布」上，按 Enter 就发。
  form.focus = firstEmpty(form) ?? 'submit';
  state.form = form;
  state.view = 'form';
  clearMessage();
}

function focusOrder(form) {
  return ['title', 'description', 'tags', 'slug', 'date', 'submit'].filter(
    (name) => name === 'tags' || name === 'submit' || form.inputs[name],
  );
}

function firstEmpty(form) {
  if (!form.inputs.title.text.trim()) return 'title';
  if (!form.inputs.description.text.trim()) return 'description';
  if (!form.tags.length) return 'tags';
  return null;
}

/** 检查没过时，光标跳到第一个要改的那一项。 */
function fieldWithProblem(form, problems) {
  const text = problems.join('\n');
  if (/^(?:缺标题|已经有一篇文章叫)/m.test(text)) return 'title';
  if (/^缺导语/m.test(text)) return 'description';
  if (/^缺主题/m.test(text)) return 'tags';
  if (form.inputs.slug && /^网址/m.test(text)) return 'slug';
  if (form.inputs.date && /^发布时间/m.test(text)) return 'date';
  return null;
}

/** 发布页上现在填的值，主题按固定的顺序排。 */
function formValues(form) {
  const text = (name) => form.inputs[name].text.replace(/\s+/g, ' ').trim();
  return {
    title: text('title'),
    description: text('description'),
    tags: form.chips.filter((chip) => form.tags.includes(chip)),
    ...(form.inputs.slug && { slug: text('slug') }),
    ...(form.inputs.date && { date: text('date') }),
  };
}

/** 把填的写回这一篇（草稿随后存进文件）。 */
function applyForm(form) {
  const values = formValues(form);
  retitle(form.session, values.title);
  form.session.head = writeFields(form.session.head, values);
}

async function formKey(key) {
  const form = state.form;
  const { name, ctrl, alt } = key;
  if (name === 'escape' || (ctrl && name === 'c')) return leaveForm();
  if (ctrl && name === 'p') return submitForm();

  const order = focusOrder(form);
  const step = (delta) => {
    form.focus = order[clamp(order.indexOf(form.focus) + delta, 0, order.length - 1)];
  };
  if (name === 'up' || name === 'backtab') return step(-1);
  if (name === 'down' || name === 'tab') return step(1);
  if (name === 'enter') return form.focus === 'submit' ? submitForm() : step(1);
  if (form.focus === 'tags') return tagKey(form, key);

  const input = form.inputs[form.focus];
  if (!input) return;
  if (name === 'text' || name === 'paste') input.insert(key.text.replace(/\s*\n\s*/g, ' '));
  else if (name === 'backspace') alt || ctrl ? input.deleteWordBackward() : input.backspace();
  else if (name === 'delete') input.deleteForward();
  else if (name === 'left') alt || ctrl ? input.wordLeft() : input.left();
  else if (name === 'right') alt || ctrl ? input.wordRight() : input.right();
  else if (name === 'home' || (ctrl && name === 'a')) input.home();
  else if (name === 'end' || (ctrl && name === 'e')) input.end();
  else if (ctrl && name === 'w') input.deleteWordBackward();
  else if (ctrl && name === 'z') input.undo();
  else if (ctrl && name === 'y') input.redo();
}

/** 主题：←→ 挑，空格选中或取消，数字键直接选第几个。 */
function tagKey(form, key) {
  const count = form.chips.length;
  if (key.name === 'left') form.chip = (form.chip + count - 1) % count;
  else if (key.name === 'right') form.chip = (form.chip + 1) % count;
  else if (key.name === 'text') {
    // 输入法打出的全角空格、全角数字也算。
    for (const char of key.text.normalize('NFKC')) {
      const number = Number(char);
      if (char === ' ') toggleTag(form, form.chip);
      else if (number >= 1 && number <= count) toggleTag(form, (form.chip = number - 1));
    }
  }
}

function toggleTag(form, index) {
  const chip = form.chips[index];
  form.tags = form.tags.includes(chip) ? form.tags.filter((tag) => tag !== chip) : [...form.tags, chip];
}

/** Esc：填了的都留着（草稿存进文件），回到编辑器或列表。 */
async function leaveForm() {
  const form = state.form;
  const fromEditor = state.editor === form.session;
  applyForm(form);
  state.form = null;
  state.view = fromEditor ? 'editor' : 'list';
  await saveDraft(form.session);
  if (!fromEditor) await refresh();
}

/** 先在本地检查一遍：有问题列在发布页下面；没问题就开始发布。 */
async function submitForm() {
  const form = state.form;
  const { session } = form;
  applyForm(form);
  await saveDraft(session);
  const existing = session.doc.kind === 'post' ? session.doc : null;
  const text = documentText(session);
  try {
    preparePost(text, { posts: state.docs.posts, existing });
  } catch (error) {
    if (!(error instanceof BlogError)) throw error;
    form.error = error.message;
    form.problems = error.problems;
    form.focus = fieldWithProblem(form, error.problems) ?? form.focus;
    return;
  }
  form.error = '';
  form.problems = [];
  state.publishing = {
    doc: existing ? { ...existing, text } : session.doc,
    phase: 'running',
    step: '',
    done: [],
    problems: [],
    error: '',
    title: readFields(session.head, session.buffer.text).title,
    result: null,
  };
  state.view = 'publish';
  await runPublish();
}

function renderForm(width, height) {
  const form = state.form;
  const draft = form.session.doc.kind === 'draft';
  const verb = draft ? '发布' : '更新上线';
  const rows = [
    paint([[draft ? ' 发布新文章' : ` 更新「${formValues(form).title || '未命名'}」`, 'strong']], width),
    paint([], width),
  ];
  const columns = Math.max(10, Math.min(72, width - LABEL_WIDTH - 1));
  const indent = [[' '.repeat(LABEL_WIDTH)]];
  const label = (name) => {
    const active = form.focus === name;
    return [[active ? ' › ' : '   ', 'accent'], [FORM_FIELDS[name].label, active ? 'strong' : 'dim'], ['  ']];
  };
  let cursor = null;

  // 一行输入框，长了就折行；没填时显示灰字。
  const addInput = (name, placeholder = FORM_FIELDS[name].placeholder) => {
    const input = form.inputs[name];
    if (!input) return;
    const lines = layout(input.lines, columns);
    if (input.text) {
      lines.forEach((line, index) => {
        const text = input.parts(line.line).slice(line.start, line.end).join('');
        rows.push(paint([...(index ? indent : label(name)), [text]], width));
      });
    } else {
      rows.push(paint([...label(name), [placeholder, 'dim']], width));
    }
    if (form.focus === name) {
      const current = cursorRow(lines, input);
      const row = input.text ? rows.length - lines.length + current : rows.length - 1;
      cursor = { row, col: LABEL_WIDTH + widthOf(input.parts().slice(lines[current].start, input.col)) };
    }
  };

  addInput('title');
  addInput('description');

  // 主题一个个排开，放不下就换行。
  let segments = label('tags');
  let used = LABEL_WIDTH;
  form.chips.forEach((chip, index) => {
    const on = form.tags.includes(chip);
    const text = `${on ? '●' : '○'} ${chip}`;
    const size = textWidth(text) + 3;
    if (used + size > width && used > LABEL_WIDTH) {
      rows.push(paint(segments, width));
      segments = [...indent];
      used = LABEL_WIDTH;
    }
    const style = form.focus === 'tags' && index === form.chip ? 'inverse' : on ? 'accent' : 'dim';
    segments.push([text, style], ['   ']);
    used += size;
  });
  rows.push(paint(segments, width));

  if (draft) {
    addInput('slug', `留空就用 /posts/${nextPostId(zonedTime().day, state.docs.posts)}/`);
    addInput('date');
  } else {
    rows.push(paint([...label('slug'), [`/posts/${form.session.doc.id}/`], ['  已发布，不能改', 'dim']], width));
  }

  rows.push(paint([], width));
  rows.push(paint([['   '], [`[ ${verb}到 ${HOST} ]`, form.focus === 'submit' ? 'inverse' : 'dim']], width));

  if (form.error || form.problems.length) {
    rows.push(paint([], width));
    for (const line of wrap(form.error, width - 4)) rows.push(paint([[`   ${line}`, 'error']], width));
    for (const problem of form.problems) {
      wrap(`· ${problem}`, width - 6).forEach((line, index) => rows.push(paint([[index ? `     ${line}` : `   ${line}`]], width)));
    }
  }

  while (rows.length < height - 2) rows.push(paint([], width));
  rows.length = height - 2;
  const back = state.editor === form.session ? 'Esc 回去写正文' : 'Esc 回到列表';
  const keys =
    form.focus === 'submit'
      ? ` Enter ${verb} · ↑ 回去改 · ${back}`
      : ` ↑↓ 换一项 · Enter 下一项 · Ctrl+P ${verb} · ${back}`;
  rows.push(paint(messageSegments() ?? [[` ${FORM_FIELDS[form.focus].hint}`, 'dim']], width));
  rows.push(paint([[keys, 'dim']], width));
  if (cursor && cursor.row >= height - 2) cursor = null;
  return { rows, cursor };
}

/* ---------- 发布 ---------- */

async function publishKey(key) {
  const publishing = state.publishing;
  if (publishing.phase === 'running') return;
  if (key.name === 'o' && publishing.result) return openUrl(publishing.result.url);
  if (!['escape', 'enter', 'q'].includes(key.name) && !(key.ctrl && key.name === 'c')) return;
  state.publishing = null;
  if (state.form) {
    // 没发出去：回到发布页，原因列在下面。
    state.form.error = publishing.error;
    state.form.problems = publishing.problems;
    state.form.focus = fieldWithProblem(state.form, publishing.problems) ?? state.form.focus;
    state.view = 'form';
  } else {
    state.view = state.editor ? 'editor' : 'list';
  }
}

async function runPublish() {
  const publishing = state.publishing;
  const { doc } = publishing;
  publishing.phase = 'running';
  const before = doc.kind === 'post' ? liveVersion(postUrl(doc.id)) : Promise.resolve(null);
  render();
  try {
    const result = await publish(doc, {
      onStep(step) {
        if (publishing.step) publishing.done.push(publishing.step);
        publishing.step = step;
        render();
      },
    });
    publishing.done.push(publishing.step);
    publishing.result = result;
    // 草稿已经变成文章（或者文章已经更新），编辑器和发布页不用再开着。
    if (state.editor) closeEditor();
    state.form = null;
    state.view = 'publish';
    await refresh();
    if (result.pushed) {
      publishing.step = 'live';
      publishing.phase = 'waiting';
      watchDeploy(result, await before);
    } else {
      publishing.phase = 'failed';
      publishing.step = 'push';
      publishing.error = '文章已经提交到本地，但推送到 GitHub 失败了。检查网络后，在列表里按 u 重新推送。';
      publishing.problems = result.problems ?? [];
    }
  } catch (error) {
    publishing.phase = 'failed';
    publishing.error = error.message;
    publishing.problems = error.problems ?? (error instanceof BlogError ? [] : [String(error.stack ?? error)]);
  }
  if (quitting) quit();
  render();
}

async function watchDeploy(result, before) {
  const deploy = { title: result.title, url: result.url, status: 'waiting', since: Date.now() };
  state.deploy = deploy;
  const live = await waitUntilLive(result.url, { before });
  if (state.deploy !== deploy) return;
  deploy.status = live ? 'live' : 'timeout';
  if (state.publishing?.result === result) {
    if (live) state.publishing.done.push('live');
    state.publishing.phase = live ? 'done' : 'timeout';
  }
  render();
}

function renderPublish(width, height) {
  const publishing = state.publishing;
  const verb = publishing.doc.kind === 'post' ? '更新' : '发布';
  const rows = [paint([[` ${verb}「${publishing.title || '未命名'}」`, 'strong']], width), paint([], width)];
  const add = (segments) => rows.push(paint(segments, width));
  const addWrapped = (text, style = 'plain', indent = '   ') => {
    for (const line of wrap(text, width - indent.length - 1)) add([[indent + line, style]]);
  };

  for (const [step, label] of STEPS) {
    const done = publishing.done.includes(step);
    const active = publishing.step === step && !done;
    const failed = active && publishing.phase === 'failed';
    const icon = done ? ['✓', 'ok'] : failed ? ['✗', 'error'] : active ? [spinner(), 'accent'] : ['·', 'dim'];
    const extra = step === 'live' && active && state.deploy?.status === 'waiting' ? `（${Math.round((Date.now() - state.deploy.since) / 1000)} 秒）` : '';
    add([[`   ${icon[0]} `, icon[1]], [label + extra, done || active ? 'plain' : 'dim']]);
  }
  add([]);
  if (publishing.phase === 'failed') {
    addWrapped(publishing.error, 'error');
    for (const problem of publishing.problems) addWrapped(`· ${problem}`, 'plain', '   ');
  } else if (publishing.phase === 'done') {
    add([['   已上线：', 'ok'], [publishing.result.url]]);
  } else if (publishing.phase === 'timeout') {
    addWrapped('已经推送到 GitHub，但等了 10 分钟网站还没更新。去 GitHub 仓库的 Actions 页面看看部署有没有出错。', 'error');
  } else if (publishing.phase === 'waiting') {
    addWrapped('已经推送到 GitHub，网站正在部署，一般一两分钟。可以先回去写别的，好了会在列表下面提示。', 'dim');
  }

  while (rows.length < height - 1) rows.push(paint([], width));
  const keys = {
    running: '正在发布，稍等…',
    waiting: 'Esc 先回去（会在后台继续等）',
    done: 'o 打开网页 · Esc 回到列表',
    timeout: 'Esc 回到列表',
    failed: state.form ? 'Esc 回去改' : 'Esc 回到列表',
  }[publishing.phase];
  rows.length = height - 1;
  rows.push(paint([[` ${keys}`, 'dim']], width));
  return { rows };
}

/* ---------- 小工具 ---------- */

/** 左边一段、右边一段，中间补空格。 */
function spread(left, right, width) {
  const used = textWidth(left.concat(right).map((segment) => segment[0]).join(''));
  if (used >= width) {
    const rightWidth = textWidth(right.map((segment) => segment[0]).join(''));
    const room = Math.max(0, width - rightWidth - 1);
    const clipped = [];
    let left_ = room;
    for (const [text, style] of left) {
      const piece = clip(text, left_);
      clipped.push([piece, style]);
      left_ -= textWidth(piece);
    }
    return [...clipped, [' '], ...right];
  }
  return [...left, [' '.repeat(width - used)], ...right];
}

function shortDate(value) {
  const time = Date.parse(value);
  if (!time) return '';
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(time);
  return day.startsWith(String(new Date().getFullYear())) ? day.slice(5) : day;
}

function timeAgo(time) {
  const seconds = (Date.now() - time) / 1000;
  if (seconds < 60) return '刚刚';
  if (seconds < 3600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} 小时前`;
  if (seconds < 86400 * 2) return '昨天';
  return shortDate(new Date(time).toISOString());
}

function openUrl(url) {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'explorer' : 'xdg-open';
  try {
    spawn(opener, [url], { detached: true, stdio: 'ignore' }).on('error', () => {}).unref();
  } catch {
    // 打不开浏览器就算了。
  }
  say(`在浏览器里打开：${url}`);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

/* ---------- 安装命令 ---------- */

async function install() {
  const directory = installDirectory();
  const file = path.join(directory, 'myblog');
  await mkdir(directory, { recursive: true });
  // 先删掉旧的（可能是指向旧脚本的链接），再写新的。
  await rm(file, { force: true });
  await writeFile(file, `#!/bin/sh\nexec node "${path.join(ROOT, 'scripts', 'myblog.mjs')}" "$@"\n`, 'utf8');
  await chmod(file, 0o755);
  console.log(`已安装：${file}\n以后在任何目录输入 myblog 就能打开。`);
  if (!pathDirectories().includes(directory)) {
    console.log(`注意：${directory} 不在 PATH 里，要先把它加到 shell 配置（比如 ~/.zshrc）里。`);
  }
}

/** 装过（包括旧版）就装回原处，否则找一个能写的 PATH 目录。 */
function installDirectory() {
  const writable = (directory) => {
    try {
      accessSync(directory, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  };
  const existing = pathDirectories().find(
    (directory) => !directory.includes('node_modules') && installed(path.join(directory, 'myblog')) && writable(directory),
  );
  const home = os.homedir();
  return (
    existing ??
    ['/opt/homebrew/bin', '/usr/local/bin', path.join(home, '.local/bin'), path.join(home, 'bin')].find(writable) ??
    path.join(home, '.local/bin')
  );
}

/** 旧版装的可能是指向已删除文件的链接，所以用 lstat 判断。 */
function installed(file) {
  try {
    lstatSync(file);
    return true;
  } catch {
    return false;
  }
}

function pathDirectories() {
  return (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
}
