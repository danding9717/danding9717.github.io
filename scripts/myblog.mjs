#!/usr/bin/env node
// myblog：在终端里写博客文章，一键发布到网站。用法见 README「写文章」。
import { spawn } from 'node:child_process';
import { accessSync, constants, lstatSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { SITE_URL } from '../site.config.mjs';
import {
  BlogError,
  FEATURED,
  PUBLISH_STEPS,
  ROOT,
  TAGS,
  createDraft,
  defaultTitle,
  droppedImagePath,
  headingTitle,
  isBlankDraft,
  joinDocument,
  listDocs,
  liveVersion,
  postUrl,
  preparePost,
  publish,
  pushPending,
  readFields,
  splitDocument,
  tagSlug,
  trashDraft,
  unpushedCount,
  waitUntilLive,
  writeFields,
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

const HOST = new URL(SITE_URL).host;
const SPINNER = '⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏';
const STEPS = [...PUBLISH_STEPS, ['live', '等待网站更新']];

// 发布页上的几项：名字、提示和没填时显示的灰字。
const FORM_FIELDS = {
  title: { label: '标题', hint: '可选：一句话说出这篇的观点。不写就用日期，同一天第二篇加 -2。' },
  description: { label: '导语', hint: '可选：一句话，显示在标题下面，也是首页和 RSS 的摘要。', placeholder: '可以不写' },
  tags: { label: '标签', hint: `←→ 挑，空格选中或取消，直接打字新建。「${FEATURED}」会放进首页精选。` },
  slug: { label: '网址', hint: '可选：文章链接的最后一段，填 compound 就是 /posts/compound/，发布后不能改。' },
  date: { label: '时间', hint: '发布时间，写成 2026-10-14 或 2026-10-14 21:30；删掉就用发布那一刻。', placeholder: '发布那一刻' },
  submit: { hint: '会先检查一遍，有问题列在下面，不会发出去。' },
};
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

function render() {
  if (!screen.active || hungUp) return;
  const width = screen.width;
  const height = screen.height;
  const views = { editor: renderEditor, form: renderForm, publish: renderPublish, list: renderList };
  const view = views[state.view](width, height);
  screen.draw(view.rows, view.cursor ?? null);
  keepTicking();
}

/** 发布、等上线时让转圈动画动起来。 */
function keepTicking() {
  const busy = state.publishing?.phase === 'running' || state.deploy?.status === 'waiting';
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
  state.editor = Object.assign(session, { scroll: 0, popup: null, popupClosed: false, leaving: false });
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
  if (editor.popup && popupKey(key)) return;

  const { name, ctrl, alt } = key;
  if (name === 'escape' || (ctrl && name === 'c')) return leaveEditor();
  if (editor.leaving) {
    editor.leaving = false;
    clearMessage();
  }
  if (ctrl && name === 's') return saveDraft(editor, true);
  if (ctrl && name === 'p') return publishFromEditor();

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
  state.editor = null;
  state.view = 'list';
  clearMessage();
}

async function publishFromEditor() {
  await saveDraft(state.editor);
  openForm(state.editor);
}

/** 计算正文这一栏的位置：最宽 76 格，居中。 */
function editorColumns(width) {
  const columns = Math.max(10, Math.min(76, width - 4));
  return { columns, margin: Math.max(1, Math.floor((width - columns) / 2)) };
}

function renderEditor(width, height) {
  const editor = state.editor;
  const buffer = editor.buffer;
  const { columns, margin } = editorColumns(width);
  const top = 2;
  const visible = height - 4;

  const rows = layout(buffer.lines, columns);
  const current = cursorRow(rows, buffer);
  if (current < editor.scroll) editor.scroll = current;
  if (current >= editor.scroll + visible) editor.scroll = current - visible + 1;
  // 内容变短（比如撤销了一大段粘贴）时不留着空白往上滚。
  editor.scroll = clamp(editor.scroll, 0, Math.max(0, rows.length - visible));

  const styles = lineStyles(buffer.lines);
  const body = [];
  for (let index = 0; index < visible; index += 1) {
    const row = rows[editor.scroll + index];
    if (!row) {
      body.push(paint([], width));
      continue;
    }
    const parts = graphemes(buffer.lines[row.line]).slice(row.start, row.end);
    body.push(paint([[' '.repeat(margin)], ...group(parts, styles[row.line].slice(row.start, row.end))], width));
  }

  const cursorScreenRow = top + current - editor.scroll;
  const cursorCol = margin + widthOf(buffer.parts().slice(rows[current].start, buffer.col));
  if (editor.popup) drawPopup(body, current - editor.scroll, width, margin, visible);

  // 顶部：草稿还是已发布、标题（起了才有）、保存状态、字数。
  const doc = editor.doc;
  const title = readFields(editor.head, buffer.text).title;
  const label = [[doc.kind === 'draft' ? ' 草稿' : ' 已发布', 'dim'], ...(title ? [[' · ', 'dim'], [title, 'bold']] : [])];
  const dirty = documentText(editor) !== editor.savedText;
  const status = doc.kind === 'draft' ? (dirty ? '保存中' : '已保存') : dirty ? '有修改，还没发布' : `/posts/${doc.id}/`;
  const header = paint(spread(label, [[`${status} · ${wordCount(buffer.text)} 字 `, 'dim']], width), width);

  return {
    rows: [header, paint([], width), ...body, ...editorBottom(width)],
    cursor: { row: cursorScreenRow, col: Math.min(width - 1, cursorCol) },
  };
}

/** 最下面两行：提示和快捷键。 */
function editorBottom(width) {
  const editor = state.editor;
  const doc = editor.doc;
  const hint = messageSegments() ?? (editor.popup
    ? [[' ↑↓ 选文章 · Tab 插入链接 · Esc 关掉', 'dim']]
    : editor.buffer.linkQuery() !== null && !state.docs.posts.length
      ? [[' 还没有发布的文章可以链接。', 'dim']]
      : doc.kind === 'draft' && !editor.buffer.text.trim()
        ? [[' 直接写正文。标题、导语和标签，发布时再填。', 'dim']]
        : []);
  const keys =
    doc.kind === 'draft'
      ? ' Ctrl+P 发布 · Ctrl+Z 撤销 · Esc 回到列表'
      : ' Ctrl+P 更新上线 · Ctrl+Z 撤销 · Esc 回到列表';
  return [paint(hint, width), paint([[keys, 'dim']], width)];
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
function drawPopup(body, cursorLine, width, margin, visible) {
  const { matches, selected } = state.editor.popup;
  const below = cursorLine + 1 + matches.length <= visible;
  const start = below ? cursorLine + 1 : Math.max(0, cursorLine - matches.length);
  matches.forEach((post, index) => {
    const active = index === selected;
    body[start + index] = paint(
      [[' '.repeat(margin)], [active ? ' › ' : '   ', 'accent'], [post.title, active ? 'inverse' : 'plain'], [`  ${shortDate(post.date)}`, 'dim']],
      width,
    );
  });
}

/* ---------- 发布页：标题、导语、标签、网址 ---------- */

/** 打开发布页。session 是编辑器里的这一篇，或者从列表直接打开的草稿。 */
function openForm(session) {
  const fields = readFields(session.head, session.buffer.text);
  const draft = session.doc.kind === 'draft';
  const input = (text) => {
    const buffer = new TextBuffer(text);
    buffer.setCursor(0, Infinity);
    return buffer;
  };
  // 能挑的标签：默认的几个、「精选」、发过的文章用过的、这篇已经有的。只差大小写的算一个。
  const chips = [];
  for (const tag of [...TAGS, FEATURED, ...state.docs.posts.flatMap((post) => post.tags), ...fields.tags]) {
    if (!chips.some((chip) => tagSlug(chip) === tagSlug(tag))) chips.push(tag);
  }
  const form = {
    session,
    inputs: {
      title: input(fields.title),
      description: input(fields.description),
      // 已发布的文章不能改网址；发布时间只有草稿里手写过才显示。
      slug: draft ? input(fields.slug) : null,
      date: draft && fields.date ? input(fields.date) : null,
    },
    tags: [...new Set(fields.tags.map((tag) => chips.find((chip) => tagSlug(chip) === tagSlug(tag))))],
    chips,
    // 标签那一行选到第几个；等于 chips.length 时是最后的「＋ 新标签」。
    chip: 0,
    // 正在写的新标签（一个输入框），没在写时是 null。
    newTag: null,
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

/** 标题可以不写，但还是先停在那儿；导语不用提醒。 */
function firstEmpty(form) {
  if (!form.inputs.title.text.trim()) return 'title';
  if (!form.tags.length) return 'tags';
  return null;
}

/** 检查没过时，光标跳到第一个要改的那一项。 */
function fieldWithProblem(form, problems) {
  const text = problems.join('\n');
  if (/^已经有一篇文章叫/m.test(text)) return 'title';
  if (/^缺标签/m.test(text)) return 'tags';
  if (form.inputs.slug && /^网址/m.test(text)) return 'slug';
  if (form.inputs.date && /^发布时间/m.test(text)) return 'date';
  return null;
}

/** 发布页上现在填的值，标签按列出来的顺序排。 */
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

/** 没写标题时会用的标题：日期编号，和发布时算出来的一样。 */
function formDefaultTitle(form) {
  const existing = form.session.doc.kind === 'post' ? form.session.doc : null;
  return defaultTitle({ posts: state.docs.posts, existing });
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

/** 把填的写回这一篇（草稿随后存进文件）。 */
function applyForm(form) {
  const values = formValues(form);
  retitle(form.session, values.title);
  form.session.head = writeFields(form.session.head, values);
}

async function formKey(key) {
  const form = state.form;
  const { name, ctrl } = key;
  // 正在写新标签时，按键先给它的输入框。
  if (form.newTag && newTagKey(form, key)) return;
  if (name === 'escape' || (ctrl && name === 'c')) return leaveForm();
  if (ctrl && name === 'p') return submitForm();

  const order = focusOrder(form);
  const step = (delta) => {
    form.focus = order[clamp(order.indexOf(form.focus) + delta, 0, order.length - 1)];
  };
  if (name === 'up' || name === 'backtab') return step(-1);
  if (name === 'down' || name === 'tab') return step(1);
  if (name === 'enter') {
    if (form.focus === 'submit') return submitForm();
    if (form.focus === 'tags' && form.chip === form.chips.length) return openNewTag(form);
    return step(1);
  }
  if (form.focus === 'tags') return tagKey(form, key);
  if (form.inputs[form.focus]) editInput(form.inputs[form.focus], key);
}

/** 输入框里的编辑键：打字、删除、按字或按词移动、撤销。粘贴进来的换行变成空格。 */
function editInput(input, key) {
  const { name, ctrl, alt } = key;
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

/** 标签：←→ 挑，空格选中或取消，数字键直接选第几个；打别的字就是新建一个标签。 */
function tagKey(form, key) {
  const count = form.chips.length + 1;
  if (key.name === 'left') form.chip = (form.chip + count - 1) % count;
  else if (key.name === 'right') form.chip = (form.chip + 1) % count;
  else if (key.name === 'text' || key.name === 'paste') {
    // 输入法打出的全角空格、全角数字也算。
    const text = key.text.normalize('NFKC');
    if (!/^[\s\d]*$/.test(text)) return openNewTag(form, key.text);
    for (const char of text) {
      const number = Number(char);
      if (char === ' ') form.chip === form.chips.length ? openNewTag(form) : toggleTag(form, form.chip);
      else if (number >= 1 && number <= form.chips.length) toggleTag(form, (form.chip = number - 1));
    }
  }
}

function toggleTag(form, index) {
  const chip = form.chips[index];
  form.tags = form.tags.includes(chip) ? form.tags.filter((tag) => tag !== chip) : [...form.tags, chip];
}

/** 开始写一个新标签：标签那一行的最后变成输入框。 */
function openNewTag(form, text = '') {
  form.chip = form.chips.length;
  form.newTag = new TextBuffer('');
  if (text) form.newTag.insert(text.replace(/\s*\n\s*/g, ' '));
}

/** 写新标签时的按键，处理掉了返回 true。↑↓、Tab、Ctrl+P 先把写好的加上，再照常换一项或发布。 */
function newTagKey(form, key) {
  const { name, ctrl } = key;
  if (name === 'escape' || (ctrl && name === 'c')) {
    form.newTag = null;
  } else if (name === 'enter') {
    addNewTag(form);
  } else if (['up', 'down', 'tab', 'backtab'].includes(name) || (ctrl && name === 'p')) {
    addNewTag(form);
    return false;
  } else {
    editInput(form.newTag, key);
  }
  return true;
}

/** 把写好的新标签加进来并选中；和已有的只差大小写、空格时，用已有的那个。 */
function addNewTag(form) {
  // 逗号、顿号会把一个标签拆成两个，换成空格。
  const name = form.newTag.text.replace(/[,，、]/g, ' ').replace(/\s+/g, ' ').trim();
  form.newTag = null;
  if (!name) return;
  let index = form.chips.findIndex((chip) => tagSlug(chip) === tagSlug(name));
  if (index < 0) index = form.chips.push(name) - 1;
  if (!form.tags.includes(form.chips[index])) form.tags = [...form.tags, form.chips[index]];
  form.chip = index;
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
  let post;
  try {
    post = preparePost(text, { posts: state.docs.posts, existing });
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
    title: post.title,
    result: null,
  };
  state.view = 'publish';
  await runPublish();
}

function renderForm(width, height) {
  const form = state.form;
  const draft = form.session.doc.kind === 'draft';
  const verb = draft ? '发布' : '更新上线';
  const fallback = formDefaultTitle(form);
  const rows = [
    paint([[draft ? ' 发布新文章' : ` 更新「${formValues(form).title || fallback}」`, 'strong']], width),
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

  addInput('title', `留空就用 ${fallback}`);
  addInput('description');

  // 标签一个个排开，放不下就换行；最后是「＋ 新标签」，写新标签时变成输入框。
  let segments = label('tags');
  let used = LABEL_WIDTH;
  const place = (text, style) => {
    const size = textWidth(text) + 3;
    if (used + size > width && used > LABEL_WIDTH) {
      rows.push(paint(segments, width));
      segments = [...indent];
      used = LABEL_WIDTH;
    }
    segments.push([text, style], ['   ']);
    used += size;
    return used - size;
  };
  const picking = (index) => form.focus === 'tags' && !form.newTag && index === form.chip;
  form.chips.forEach((chip, index) => {
    const on = form.tags.includes(chip);
    place(`${on ? '●' : '○'} ${chip}`, picking(index) ? 'inverse' : on ? 'accent' : 'dim');
  });
  if (form.newTag) {
    const input = form.newTag;
    const at = place(`＋ ${input.text || '写个名字'}`, input.text ? 'plain' : 'dim');
    cursor = { row: rows.length, col: at + textWidth('＋ ') + widthOf(input.parts().slice(0, input.col)) };
  } else {
    place('＋ 新标签', picking(form.chips.length) ? 'inverse' : 'dim');
  }
  rows.push(paint(segments, width));

  if (draft) {
    addInput('slug', `留空就用 /posts/${fallback}/`);
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
  const hint = form.newTag ? '新标签的名字。加过一次，以后发文章时都能直接挑。' : FORM_FIELDS[form.focus].hint;
  const keys = form.newTag
    ? ' Enter 加上 · Esc 不加了'
    : form.focus === 'submit'
      ? ` Enter ${verb} · ↑ 回去改 · ${back}`
      : ` ↑↓ 换一项 · Enter 下一项 · Ctrl+P ${verb} · ${back}`;
  rows.push(paint(messageSegments() ?? [[` ${hint}`, 'dim']], width));
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
