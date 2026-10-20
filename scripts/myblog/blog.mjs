// 草稿和文章：读写、发布前检查、[[ ]] 链接、图片，以及发布（同步 GitHub → 构建 → 提交推送）。
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_URL } from '../../site.config.mjs';

export const ROOT = path.resolve(fileURLToPath(new URL('../../', import.meta.url)));
/** 发布页上默认列出的标签；别的标签在发布页上直接新建，用过的以后也会列出来。 */
export const TAGS = ['AI', '财富', '生意', '读书', '产品'];
/** 挂上这个标签的文章会出现在首页「精选」里（和 src/utils/posts.ts 的 FEATURED_TAG 一致）。 */
export const FEATURED = '精选';
const TIME_ZONE = 'Asia/Shanghai';
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const IMAGE_EXTENSIONS = /\.(avif|gif|jpe?g|png|svg|webp)$/i;

export class BlogError extends Error {
  /** problems 是逐条的原因，界面会一条一行列出来。 */
  constructor(message, problems = []) {
    super(message);
    this.name = 'BlogError';
    this.problems = Array.isArray(problems) ? problems : [problems].filter(Boolean);
  }
}

export function blogPaths(root = ROOT) {
  return {
    root,
    drafts: path.join(root, 'src/content/drafts'),
    posts: path.join(root, 'src/content/posts'),
    images: path.join(root, 'public/images'),
  };
}

export function postUrl(id) {
  return `${SITE_URL}/posts/${id}/`;
}

/* ---------- frontmatter ---------- */

// 到第一个 --- 为止；`---\n---` 是空的 frontmatter。
const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)??---[ \t]*(?:\r?\n|$)/;

/**
 * 宽松地读 frontmatter：`键: 值`（中文冒号也行）、`[a, b]` 和一行一个 `- a` 的列表、整行 # 注释。
 * 值保留原样，用 unquote 去掉引号。空值当作没写。
 */
export function splitFrontmatter(text) {
  const match = text.match(FRONTMATTER);
  if (!match) return { data: {}, body: text };

  const data = {};
  let listKey = null;
  for (const line of (match[1] ?? '').split(/\r?\n/)) {
    if (!line.trim() || /^\s*#/.test(line)) continue;

    const item = listKey && line.match(/^\s*-\s+(.*)$/);
    if (item) {
      data[listKey].push(unquote(item[1]));
      continue;
    }

    listKey = null;
    const field = line.match(/^([A-Za-z_][\w-]*)\s*[:：]\s*(.*)$/);
    if (!field) continue;
    const value = field[2].trim();
    if (value) {
      data[field[1]] = value;
    } else {
      data[field[1]] = [];
      listKey = field[1];
    }
  }

  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value) && !value.length) delete data[key];
  }
  return { data, body: text.slice(match[0].length) };
}

export function unquote(value) {
  if (Array.isArray(value)) return '';
  const text = String(value ?? '').trim();
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text).trim();
    } catch {
      return text.slice(1, -1).trim();
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'").trim();
  }
  return text;
}

/** 标签支持 `[AI, 财富]`、`AI, 财富`、`AI，财富`、`AI、财富` 和一行一个的写法。 */
export function parseTags(value) {
  if (!value) return [];
  const items = Array.isArray(value)
    ? value
    : (String(value).trim().match(/^\[([\s\S]*)\]$/)?.[1] ?? String(value)).split(/[,，、]/);
  return [...new Set(items.map(unquote).filter(Boolean))];
}

/** 标签在网站上的地址名（和 src/utils/posts.ts 的 toSlug 一致）。只差大小写、空格的算同一个标签。 */
export function tagSlug(name) {
  return String(name).trim().toLowerCase().replace(/[\s/?#%]+/g, '-');
}

/** 正文第一行是「# 标题」时返回标题。 */
export function headingTitle(body) {
  const firstLine = body.replace(/^(?:[ \t]*\r?\n)+/, '').split(/\r?\n/, 1)[0];
  return firstLine.match(/^#[ \t]+(.+?)[ \t]*#*[ \t]*$/)?.[1] ?? '';
}

function dropFirstHeading(body) {
  return body.replace(/^(?:[ \t]*\r?\n)*#[ \t][^\r\n]*(?:\r?\n)*/, '');
}

/* ---------- 编辑器里只放正文 ---------- */

/**
 * 编辑器里只显示正文，标题、导语这些在发布页里填。
 * 把一篇拆成 head（frontmatter 原样，含前后两行 ---；没有时是空字符串）和正文，正文开头的空行去掉。
 */
export function splitDocument(text) {
  const clean = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const match = clean.match(FRONTMATTER);
  const head = match ? `${match[0].replace(/\n$/, '')}\n` : '';
  const body = (match ? clean.slice(match[0].length) : clean).replace(/^(?:[ \t]*\n)+/, '');
  return { head, body };
}

/** splitDocument 反过来：frontmatter、空一行、正文。正文第一行是 --- 时先放一个空的 frontmatter，免得被当成 frontmatter。 */
export function joinDocument(head, body) {
  const top = head || (/^---[ \t]*(?:\n|$)/.test(body) ? '---\n---\n' : '');
  return top ? `${top}\n${body}` : body;
}

/** 发布页要填的几项。没写标题时用正文第一行的「# 标题」。 */
export function readFields(head, body = '') {
  const { data } = splitFrontmatter(head);
  return {
    title: unquote(data.title) || headingTitle(body),
    description: unquote(data.description),
    tags: parseTags(data.tags),
    slug: unquote(data.slug),
    date: unquote(data.date),
  };
}

/**
 * 把发布页填的几项写进 frontmatter：替换原来那一项（连同一行一个的列表），没有就加在最后，值为空就删掉。
 * 别的项和顺序不动。返回新的 head，什么都不剩时返回空字符串。
 */
export function writeFields(head, fields) {
  const lines = head ? head.replace(/\n$/, '').split('\n') : ['---', '---'];
  for (const [key, value] of Object.entries(fields)) {
    // 同一项写了好几次时全删掉，新值放在第一次出现的位置。
    let at = -1;
    for (let index = lines.length - 2; index > 0; index -= 1) {
      if (lines[index].match(/^([A-Za-z_][\w-]*)\s*[:：]/)?.[1] !== key) continue;
      let end = index + 1;
      while (end < lines.length - 1 && /^(?:\s+\S|\s*-(?:\s|$))/.test(lines[end])) end += 1;
      lines.splice(index, end - index);
      at = index;
    }
    const line = fieldLine(key, value);
    if (line) lines.splice(at > 0 ? at : lines.length - 1, 0, line);
  }
  return lines.length > 2 ? `${lines.join('\n')}\n` : '';
}

function fieldLine(key, value) {
  if (Array.isArray(value)) return value.length ? `${key}: [${value.map((item) => JSON.stringify(item)).join(', ')}]` : '';
  const text = String(value ?? '').trim();
  return text ? `${key}: ${JSON.stringify(text)}` : '';
}

/* ---------- 草稿和文章 ---------- */

/** 读一篇草稿或文章，取出列表和检查要用的信息。 */
export function describe(text, { file, kind, mtime = 0 }) {
  const { data, body } = splitFrontmatter(text);
  const baseName = path.basename(file).replace(/\.mdx?$/i, '');
  const slug = unquote(data.slug);
  return {
    file,
    kind,
    mtime,
    // 网站上的地址：有 slug 用 slug，没有就用文件名（和 Astro 的规则一致）。
    id: kind === 'post' ? slug || slugify(baseName) : '',
    title: unquote(data.title) || headingTitle(body),
    // 还没有标题的草稿，列表里显示正文的第一句。
    excerpt: excerptOf(body),
    description: unquote(data.description),
    tags: parseTags(data.tags),
    slug,
    date: unquote(data.date),
  };
}

function excerptOf(body) {
  const line = body.split(/\r?\n/).map((text) => text.trim()).find(Boolean) ?? '';
  return Array.from(line.replace(/^(?:#{1,6}|>|[-*+]|\d+[.)])\s+/, '')).slice(0, 80).join('');
}

export async function listDocs(root = ROOT) {
  const dirs = blogPaths(root);
  await mkdir(dirs.drafts, { recursive: true });
  const [drafts, posts] = await Promise.all([
    loadDocs(dirs.drafts, 'draft'),
    loadDocs(dirs.posts, 'post'),
  ]);
  drafts.sort((a, b) => b.mtime - a.mtime);
  posts.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0) || b.id.localeCompare(a.id));
  return { drafts, posts };
}

async function loadDocs(directory, kind) {
  let names = [];
  try {
    names = await readdir(directory);
  } catch {
    return [];
  }
  const files = names
    .filter((name) => /\.mdx?$/i.test(name) && !name.startsWith('.'))
    .map((name) => path.join(directory, name));
  return Promise.all(
    files.map(async (file) => {
      const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)]);
      return describe(text, { file, kind, mtime: info.mtimeMs });
    }),
  );
}

/** 新草稿是个空文件：打开就写正文，标题、导语和标签发布时再填。 */
export async function createDraft(root = ROOT, now = new Date()) {
  const { drafts } = blogPaths(root);
  await mkdir(drafts, { recursive: true });
  const stamp = zonedTime(now).stamp;
  let file = path.join(drafts, `${stamp}.md`);
  for (let n = 2; existsSync(file); n += 1) file = path.join(drafts, `${stamp}-${n}.md`);
  await writeFile(file, '', 'utf8');
  return file;
}

/** 一个字都没写的草稿（空文件，或者只有没填的 frontmatter），退出编辑器时直接删掉。 */
export function isBlankDraft(text) {
  const { data, body } = splitFrontmatter(text);
  return !Object.keys(data).length && !body.trim();
}

/** 草稿不进 git，删的时候先挪到 drafts/.trash/，万一删错还能从文件夹里找回来。 */
export async function trashDraft(file) {
  const trash = path.join(path.dirname(file), '.trash');
  await mkdir(trash, { recursive: true });
  const name = path.basename(file);
  let target = path.join(trash, name);
  for (let n = 2; existsSync(target); n += 1) {
    target = path.join(trash, name.replace(/(\.mdx?)$/i, `-${n}$1`));
  }
  await rename(file, target);
}

/** 按博客所在时区取当前时间：day 用作文章地址，stamp 用作草稿文件名，iso 写进 date。 */
export function zonedTime(date = new Date(), timeZone = TIME_ZONE) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((part) => [part.type, part.value]),
  );
  const { year, month, day, hour, minute, second } = parts;
  const wallClock = Date.UTC(+year, +month - 1, +day, +hour, +minute, +second);
  const offset = Math.round((wallClock - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  const sign = offset < 0 ? '-' : '+';
  const hours = String(Math.floor(Math.abs(offset) / 60)).padStart(2, '0');
  const minutes = String(Math.abs(offset) % 60).padStart(2, '0');
  return {
    day: `${year}${month}${day}`,
    stamp: `${year}${month}${day}-${hour}${minute}${second}`,
    iso: `${year}-${month}-${day}T${hour}:${minute}:${second}${sign}${hours}:${minutes}`,
  };
}

/* ---------- 发布前检查 ---------- */

/**
 * 把草稿（或改过的文章）整理成要发布的样子。纯函数，不碰文件。
 * existing 是正在修改的已发布文章，新草稿传 null。
 * 有任何问题都一次列全，抛出 BlogError。
 */
export function preparePost(text, { posts, existing = null, now = new Date() }) {
  const { data, body } = splitFrontmatter(text);
  const problems = [];

  // 没写 title 时用正文第一行的「# 标题」；标题会单独显示，所以这一行从正文里去掉。
  let title = unquote(data.title);
  let content = body;
  const heading = headingTitle(body);
  if (heading && (!title || heading === title)) {
    title = heading;
    content = dropFirstHeading(body);
  }
  const description = unquote(data.description);
  const tags = parseTags(data.tags);
  const slug = unquote(data.slug);
  // date 一般不写，发布时用当前时间；改已发布文章时沿用原来的。手写了就用手写的。
  const typedDate = unquote(data.date);
  const date = typedDate ? normalizeDate(typedDate) : existing?.date || zonedTime(now).iso;
  const others = posts.filter((post) => post.file !== existing?.file);

  // 标题和导语可以不写：没有标题时用日期编号，比如 20261015，同一天第二篇是 20261015-2。
  if (!title) title = defaultTitle({ posts, existing, now });
  if (!tags.length) problems.push(`缺标签：至少选一个，比如 ${TAGS.join('、')}。`);
  if (!content.trim()) problems.push('正文还是空的。');
  if (!date) problems.push(`发布时间的格式不对：「${typedDate}」。写成 2026-10-14 或 2026-10-14 21:30，或者删掉，发布时会自动写上。`);
  if (others.some((post) => sameText(post.title, title))) {
    problems.push(`已经有一篇文章叫「${title}」，换个标题，不然 [[ ]] 链接分不清是哪篇。`);
  }

  let id = existing?.id;
  if (existing) {
    if (slug && slug !== existing.id) problems.push(`已发布的文章不能改网址，它现在是 /posts/${existing.id}/。`);
  } else if (slug) {
    if (!SLUG.test(slug)) problems.push(`网址只能用小写英文、数字和连字符，现在是「${slug}」。`);
    else if (isTaken(slug, posts)) problems.push(`网址「${slug}」已经被别的文章用了，换一个。`);
    id = slug;
  } else {
    id = dateName(zonedTime(now).day, posts);
  }

  const linked = rewriteLinks(content, posts);
  problems.push(...linked.problems);
  if (problems.length) throw new BlogError('还不能发布：', problems);

  return {
    id,
    title,
    description,
    tags,
    date,
    slug: existing && existing.id !== slugify(path.basename(existing.file).replace(/\.mdx?$/i, '')) ? existing.id : '',
    body: linked.body,
  };
}

const DATE = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(:\d{2})?(?:\.\d+)?\s*(Z|[+-]\d{2}:?\d{2})?)?$/;

/** 手写的日期整理成网站认的格式；只写到分钟、没写时区的按北京时间算。看不懂时返回 null。 */
export function normalizeDate(value) {
  const match = String(value).trim().match(DATE);
  if (!match) return null;
  const [, day, minutes, seconds = ':00', zone = '+08:00'] = match;
  const date = minutes ? `${day}T${minutes}${seconds}${zone.replace(/^([+-]\d{2})(\d{2})$/, '$1:$2')}` : day;
  return Number.isNaN(Date.parse(date)) ? null : date;
}

/**
 * 日期编号：20261015，同一天第二篇起是 20261015-2、20261015-3。
 * 没写网址时用作文章地址，没写标题时用作标题；跳过别的文章已经用掉的地址和标题，所以两者对得上。
 */
export function dateName(day, posts) {
  const used = (name) => isTaken(name, posts) || posts.some((post) => sameText(post.title, name));
  if (!used(day)) return day;
  for (let n = 2; ; n += 1) if (!used(`${day}-${n}`)) return `${day}-${n}`;
}

/** 没写标题时用的标题：新文章按发布那天编号，改已发布的文章按它原来的发布日期。 */
export function defaultTitle({ posts, existing = null, now = new Date() }) {
  const others = posts.filter((post) => post.file !== existing?.file);
  const published = existing && Date.parse(existing.date);
  return dateName(zonedTime(published ? new Date(published) : now).day, others);
}

function isTaken(id, posts) {
  return posts.some((post) => post.id === id || path.basename(post.file).replace(/\.mdx?$/i, '') === id);
}

export function formatPost({ title, date, description, tags, slug }, body) {
  return [
    '---',
    `title: ${JSON.stringify(title)}`,
    `date: ${date}`,
    ...(description ? [`description: ${JSON.stringify(description)}`] : []),
    `tags: [${tags.map((tag) => JSON.stringify(tag)).join(', ')}]`,
    ...(slug ? [`slug: ${JSON.stringify(slug)}`] : []),
    '---',
    '',
    body.replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd(),
    '',
  ].join('\n');
}

/* ---------- [[ ]] 链接 ---------- */

const WIKILINK = /(?<!!)\[\[([^[\]\n]+?)\]\]/g;
const POST_LINK = /\]\(\s*<?\/posts\/([^/)\s#?>]+)/g;

/**
 * 把 [[标题]]、[[标题|显示文字]]、[[标题#小标题]] 换成 [文字](/posts/<地址>/)。
 * 标题不区分大小写和空格，也可以直接写文章地址，比如 [[compound]]。
 * 代码里的内容不动。找不到的链接收集到 problems 里，顺便检查已有的 /posts/<地址>/ 链接。
 */
export function rewriteLinks(body, posts) {
  const problems = [];
  const output = mapProse(body, (prose) => {
    for (const match of prose.matchAll(POST_LINK)) {
      if (!posts.some((post) => post.id === match[1])) {
        problems.push(`链接 /posts/${match[1]}/ 指向的文章不存在。`);
      }
    }
    return prose.replace(WIKILINK, (link, inner) => {
      const [ref, label] = splitOnce(inner, '|');
      const [target, heading] = splitOnce(ref, '#');
      const post = findPost(target.trim(), posts);
      if (!post) {
        problems.push(linkProblem(target.trim(), posts));
        return link;
      }
      const text = (label ?? '').trim() || post.title;
      const anchor = heading?.trim() ? `#${slugify(heading.trim())}` : '';
      return `[${text.replace(/([[\]])/g, '\\$1')}](/posts/${post.id}/${anchor})`;
    });
  });
  return { body: output, problems };
}

export function findPost(target, posts) {
  if (!target) return null;
  const byId = posts.find((post) => post.id === target);
  if (byId) return byId;
  const matches = posts.filter((post) => sameText(post.title, target));
  return matches.length === 1 ? matches[0] : null;
}

function linkProblem(target, posts) {
  // 和写错的标题有一段相同（至少两个字，占四成以上）的文章，按相同的长度排。
  const key = textKey(target);
  const close = posts
    .map((post) => ({ post, shared: sharedLength(key, textKey(post.title)) }))
    .filter(({ shared }) => shared >= 2 && shared >= key.length * 0.4)
    .sort((a, b) => b.shared - a.shared)
    .map(({ post }) => post);
  return close.length
    ? `[[${target}]] 找不到，是不是想链接：${close.slice(0, 3).map((post) => `「${post.title}」`).join('、')}？`
    : `[[${target}]] 找不到这篇文章。只能链接已经发布的文章。`;
}

/** 两段文字最长的相同部分有几个字。 */
function sharedLength(a, b) {
  let best = 0;
  for (let i = 0; i < a.length; i += 1) {
    for (let j = 0; j < b.length; j += 1) {
      let n = 0;
      while (a[i + n] && a[i + n] === b[j + n]) n += 1;
      best = Math.max(best, n);
    }
  }
  return best;
}

function sameText(a, b) {
  return textKey(a) === textKey(b);
}

function textKey(value) {
  return String(value ?? '').toLowerCase().replace(/\s+/g, '');
}

function splitOnce(value, separator) {
  const index = value.indexOf(separator);
  return index < 0 ? [value, undefined] : [value.slice(0, index), value.slice(index + 1)];
}

/** 和网站生成小标题 id 的规则一致：小写，去掉标点，空格换成连字符。 */
export function slugify(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** 只对正文里不是代码的部分调用 transform：跳过 ``` 代码块和 `行内代码`。 */
export function mapProse(text, transform) {
  const output = [];
  let prose = [];
  let fence = '';
  const flush = () => {
    if (!prose.length) return;
    output.push(
      prose
        .join('\n')
        .split(/(`[^`\n]*`)/)
        .map((part, index) => (index % 2 ? part : transform(part)))
        .join(''),
    );
    prose = [];
  };

  for (const line of text.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      output.push(line);
      if (marker && marker[0] === fence[0] && marker.length >= fence.length && !line.trim().slice(marker.length).trim()) {
        fence = '';
      }
    } else if (marker) {
      flush();
      fence = marker;
      output.push(line);
    } else {
      prose.push(line);
    }
  }
  flush();
  return output.join('\n');
}

/* ---------- 图片 ---------- */

const IMAGE = /!\[([^\]\n]*)\]\(\s*(<[^>\n]+>|[^)\s]+)((?:\s+"[^"\n]*")?)\s*\)/g;

/**
 * 找出正文里引用的本地图片（绝对路径、~/ 开头，或相对草稿文件夹的路径），
 * 计划复制到 public/images/<地址>/，返回替换后的正文。网络图片和 /images/ 开头的不动。
 */
export async function planImages(body, { id, baseDir, imagesDir }) {
  const targets = [];
  mapProse(body, (prose) => {
    for (const match of prose.matchAll(IMAGE)) targets.push(match[2]);
    return prose;
  });

  const problems = [];
  const copies = [];
  const replacements = new Map();
  const usedNames = new Set();
  for (const raw of targets) {
    const target = raw.replace(/^<(.*)>$/, '$1');
    if (replacements.has(raw) || /^(?:[a-z][a-z0-9+.-]*:|\/\/|\/images\/)/i.test(target)) continue;

    const source = await findImageFile(target, baseDir);
    if (!source) {
      problems.push(`找不到图片：${target}`);
      continue;
    }
    const existing = copies.find((copy) => copy.from === source);
    const name = existing ? path.basename(existing.to) : uniqueImageName(source, imagesDir, usedNames);
    usedNames.add(name);
    if (!existing) copies.push({ from: source, to: path.join(imagesDir, name) });
    replacements.set(raw, `/images/${id}/${name}`);
  }

  const output = mapProse(body, (prose) =>
    prose.replace(IMAGE, (image, alt, raw, title) =>
      replacements.has(raw) ? `![${alt}](${replacements.get(raw)}${title})` : image,
    ),
  );
  return { body: output, copies, problems };
}

async function findImageFile(target, baseDir) {
  const candidates = new Set([target]);
  try {
    candidates.add(decodeURI(target));
  } catch {
    // 不是合法的 URL 编码，按原样找。
  }
  for (const candidate of candidates) {
    const expanded = candidate.replace(/^~(?=\/)/, os.homedir());
    const file = path.isAbsolute(expanded) ? expanded : path.resolve(baseDir, expanded);
    if (!IMAGE_EXTENSIONS.test(file)) continue;
    try {
      if ((await stat(file)).isFile()) return file;
    } catch {
      // 换下一个写法试试。
    }
  }
  return null;
}

function uniqueImageName(source, imagesDir, usedNames) {
  const extension = path.extname(source).toLowerCase();
  const base =
    path
      .basename(source, path.extname(source))
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-zA-Z0-9._-]+/g, '-')
      .replace(/^[-.]+|[-.]+$/g, '')
      .toLowerCase() || 'image';
  let name = `${base}${extension}`;
  for (let n = 2; usedNames.has(name) || existsSync(path.join(imagesDir, name)); n += 1) {
    name = `${base}-${n}${extension}`;
  }
  return name;
}

/** 拖进终端的文件路径：去掉引号和反斜杠转义，是图片就返回路径。 */
export function droppedImagePath(text) {
  const value = text.trim();
  if (!value || value.includes('\n')) return null;
  const unquoted = value.match(/^(['"])(.*)\1$/)?.[2] ?? value.replace(/\\(.)/g, '$1');
  const file = unquoted.replace(/^file:\/\//, '').replace(/^~(?=\/)/, os.homedir());
  return path.isAbsolute(file) && IMAGE_EXTENSIONS.test(file) && existsSync(file) ? file : null;
}

/* ---------- 发布 ---------- */

export const PUBLISH_STEPS = [
  ['sync', '同步 GitHub'],
  ['check', '检查标签、链接和图片'],
  ['build', '构建网站'],
  ['push', '提交并推送到 GitHub'],
];

/**
 * 发布一篇草稿，或者更新一篇已发布的文章：
 * 先检查 → 同步 GitHub → 再检查 → 写文件、复制图片 → 本地构建 → 提交推送 → 删掉草稿。
 * 构建或提交失败时撤回写过的文件，草稿原样保留。
 *
 * doc 是 listDocs 返回的条目；更新已发布文章时再带上 text（编辑器里的内容）。
 * build 可以换掉（测试里用），默认运行 astro build。
 * 只有推送失败时不抛错：文章已经提交到本地，返回 pushed: false，之后用 pushPending 补推。
 */
export async function publish(doc, { root = ROOT, build = buildSite, onStep = () => {}, now = new Date() } = {}) {
  const dirs = blogPaths(root);
  const text = doc.text ?? (await readFile(doc.file, 'utf8'));
  const existing = doc.kind === 'post' ? doc : null;

  // 先用本地的文章列表查一遍，缺东西马上就能看到，不用等网络。
  preparePost(text, { posts: (await listDocs(root)).posts, existing, now });

  onStep('sync');
  await syncWithGitHub(root);

  onStep('check');
  const { posts } = await listDocs(root);
  const current = existing && posts.find((post) => post.file === existing.file);
  if (existing && !current) throw new BlogError('这篇文章在 GitHub 上已经被删掉了，没法更新。');
  const post = preparePost(text, { posts, existing: current, now });
  const target = current?.file ?? path.join(dirs.posts, `${post.id}${path.extname(doc.file) || '.md'}`);
  const images = await planImages(post.body, {
    id: post.id,
    baseDir: path.dirname(doc.file),
    imagesDir: path.join(dirs.images, post.id),
  });
  if (images.problems.length) throw new BlogError('还不能发布：', images.problems);

  const original = current ? await readFile(target, 'utf8') : null;
  const files = [target, ...images.copies.map((copy) => copy.to)];
  const written = [];
  const undo = async () => {
    for (const file of written.reverse()) await rm(file, { force: true });
    if (original !== null) await writeFile(target, original, 'utf8');
    await run('git', ['reset', '-q', '--', ...files], root);
  };

  try {
    for (const copy of images.copies) {
      await mkdir(path.dirname(copy.to), { recursive: true });
      await copyFile(copy.from, copy.to);
      written.push(copy.to);
    }
    await mkdir(dirs.posts, { recursive: true });
    await writeFile(target, formatPost(post, images.body), 'utf8');
    if (original === null) written.push(target);
    if (current && !(await git(['status', '--porcelain', '--', ...files], root, '查看文章的改动失败。'))) {
      throw new BlogError('这篇和网站上的一模一样，没有要更新的地方。');
    }

    onStep('build');
    await build(root);

    onStep('push');
    await git(['add', '--', ...files], root, '把文章加入 git 失败。');
    await git(['commit', '-m', `${current ? '更新' : '发布'}：${post.title}`, '--', ...files], root, '提交失败。');
  } catch (error) {
    await undo();
    throw error;
  }

  // 内容已经在提交里了，草稿可以删掉。
  if (doc.kind === 'draft') await rm(doc.file, { force: true });
  const result = { id: post.id, title: post.title, url: postUrl(post.id), updated: Boolean(current), pushed: true };
  try {
    await git(['push', 'origin', 'main'], root, '推送到 GitHub 失败');
  } catch (error) {
    return { ...result, pushed: false, problems: error.problems };
  }
  return result;
}

async function syncWithGitHub(root) {
  const branch = await git(['rev-parse', '--abbrev-ref', 'HEAD'], root, '这里不是博客的 git 仓库。');
  if (branch !== 'main') {
    throw new BlogError(`现在在 ${branch} 分支上，网站只从 main 发布。先切回 main 再发布。`);
  }
  try {
    await git(['pull', '--rebase', '--autostash', 'origin', 'main'], root, '同步 GitHub 失败，检查网络后再试。');
  } catch (error) {
    // 万一停在变基中途，退回原样。
    const gitDir = path.join(root, '.git');
    if (existsSync(path.join(gitDir, 'rebase-merge')) || existsSync(path.join(gitDir, 'rebase-apply'))) {
      await run('git', ['rebase', '--abort'], root);
    }
    throw error;
  }
}

/** 本地构建一次，链接写错、两篇文章撞了地址、格式不对都会在这里拦下。 */
export async function buildSite(root = ROOT) {
  const astro = path.join(root, 'node_modules/.bin/astro');
  if (!existsSync(astro)) throw new BlogError('还没安装依赖：先在博客目录运行 npm install。');
  const result = await run(astro, ['build'], root);
  if (result.code !== 0) throw new BlogError('本地构建没通过，文章没有发出去：', buildErrors(result.output));
}

/** 从 astro build 的输出里挑出出错原因：[ERROR] 或 Location: 前面那几行，不要调用栈和库里的路径。 */
export function buildErrors(output) {
  let lines = stripAnsi(output).split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const stack = lines.findIndex((line) => /^Stack trace:?$/i.test(line));
  if (stack >= 0) lines = lines.slice(0, stack);
  const error = lines.findIndex((line) => line.includes('[ERROR]'));
  const location = lines.findIndex((line) => /^Location:?$/i.test(line));
  const start = error >= 0 ? error : location > 0 ? location - 1 : Math.max(0, lines.length - 8);
  const reasons = lines
    .slice(start)
    .filter((line) => !/^Location:?$|^at |node_modules|Build failed in|^\/\S+:\d+:\d+$/i.test(line))
    .map((line) => line.replace(/^\d{1,2}:\d{2}:\d{2}\s+/, ''));
  return (reasons.length ? reasons : lines.slice(-3)).slice(0, 8);
}

/** 上次推送失败、还留在本地的提交数。 */
export async function unpushedCount(root = ROOT) {
  const result = await run('git', ['rev-list', '--count', 'origin/main..main'], root);
  return result.code === 0 ? Number(result.output.trim()) || 0 : 0;
}

export async function pushPending(root = ROOT) {
  await syncWithGitHub(root);
  await git(['push', 'origin', 'main'], root, '推送失败，检查网络后再试。');
}

/** 改过、还没提交的文章文件（比如用其他软件改了，还没更新上线）。 */
export async function changedPosts(root = ROOT) {
  const posts = path.relative(root, blogPaths(root).posts);
  const result = await run('git', ['status', '--porcelain', '-z', '--', posts], root);
  const files = new Set();
  if (result.code !== 0) return files;
  const entries = result.output.split('\0');
  for (let index = 0; index < entries.length; index += 1) {
    const status = entries[index].slice(0, 2);
    if (status.includes('M')) files.add(path.join(root, entries[index].slice(3)));
    // 改名的记录后面还跟着一项旧名字。
    if (/[RC]/.test(status)) index += 1;
  }
  return files;
}

/* ---------- 更新 myblog ---------- */

/**
 * 去 GitHub 看一眼 main 上有没有本地还没有的提交，不动本地文件。
 * 不在 main 分支、没网、等太久都当作没有，返回 null；有的话返回 { count, titles }。
 */
export async function checkUpdate(root = ROOT, { timeoutMs = 60_000 } = {}) {
  const branch = await run('git', ['rev-parse', '--abbrev-ref', 'HEAD'], root);
  if (branch.code !== 0 || branch.output.trim() !== 'main') return null;
  if ((await run('git', ['fetch', '-q', 'origin', 'main'], root, { timeoutMs })).code !== 0) return null;
  const titles = await updateTitles(root, 'HEAD');
  return titles.length ? { count: titles.length, titles } : null;
}

/**
 * 更新到 GitHub 上最新的版本：和发布时一样同步（草稿不进 git，不受影响），依赖变了就重新安装。
 * 有改过、还没提交的文件时不更新，免得和拉下来的改动搅在一起。返回更新了哪些（PR 的标题），已经是最新时是空的。
 */
export async function applyUpdate(root = ROOT, { install = installDependencies, onStep = () => {} } = {}) {
  // 不用 git()：它会去掉开头的空格，而 porcelain 每行前两个字符是状态。
  const status = await run('git', ['status', '--porcelain', '--untracked-files=no'], root);
  if (status.code !== 0) throw new BlogError('这里不是博客的 git 仓库。');
  const files = status.output.split('\n').filter(Boolean).map((line) => line.slice(3));
  if (files.length) {
    throw new BlogError(`有改过、还没提交的文件（${files.slice(0, 2).join('、')}${files.length > 2 ? ' 等' : ''}），先把改动更新上线或者撤销。`, files);
  }
  const before = await git(['rev-parse', 'HEAD'], root, '这里不是博客的 git 仓库。');
  onStep('sync');
  await syncWithGitHub(root);
  const titles = await updateTitles(root, before);
  // 三个点：只看 GitHub 那边改了什么，本地还没推送的提交不算。
  const changed = (await git(['diff', '--name-only', `${before}...origin/main`], root, '查看更新的内容失败。')).split('\n');
  if (changed.some((file) => file === 'package.json' || file === 'package-lock.json')) {
    onStep('install');
    await install(root);
  }
  return titles;
}

/** from 之后 GitHub 上多出来的提交，合并 PR 的提交用 PR 的标题，旧的在前。 */
async function updateTitles(root, from) {
  const log = await run('git', ['log', '--first-parent', '--reverse', '--format=%s%x1f%b%x1e', `${from}..origin/main`], root);
  if (log.code !== 0) return [];
  return log.output
    .split('\x1e')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [subject, body = ''] = entry.split('\x1f');
      const title = /^Merge pull request #\d+/.test(subject) ? body.trim().split('\n')[0].trim() : '';
      return title || subject.trim();
    });
}

/** 依赖按 package-lock.json 装好（npm ci 不会改 package-lock.json，免得留下没提交的改动）。 */
export async function installDependencies(root = ROOT) {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await run(npm, ['ci', '--no-audit', '--no-fund'], root);
  if (result.code !== 0) {
    throw new BlogError('安装依赖失败，检查网络后在博客目录运行 npm ci：', stripAnsi(result.output).trim().split(/\r?\n/).slice(-4));
  }
}

/** myblog 自己的代码（连同它读的网址设置 site.config.mjs）的指纹：和打开时不一样，说明被更新了，要重启才用上新的。 */
export function codeVersion(root = ROOT) {
  const hash = createHash('sha1');
  const dir = path.join(root, 'scripts/myblog');
  let names = [];
  try {
    names = readdirSync(dir).filter((name) => name.endsWith('.mjs')).sort();
  } catch {
    // 没有这个目录就只看主文件。
  }
  const files = [path.join(root, 'site.config.mjs'), path.join(root, 'scripts/myblog.mjs'), ...names.map((name) => path.join(dir, name))];
  for (const file of files) {
    try {
      hash.update(file).update(readFileSync(file));
    } catch {
      hash.update(`${file} missing`);
    }
  }
  return hash.digest('hex');
}

/* ---------- 用其他软件写 ---------- */

/**
 * 用其他软件打开文章的命令。设置了 MYBLOG_EDITOR 就用它，文件路径加在最后，
 * 比如 `open -a Typora`、`code`、`vim`；没设置就交给系统，用默认打开 .md 文件的软件。
 */
export function outsideEditor(file, { env = process.env, platform = process.platform } = {}) {
  const custom = env.MYBLOG_EDITOR?.trim();
  if (custom) {
    const quoted = platform === 'win32' ? `"${file}"` : `'${file.replaceAll("'", "'\\''")}'`;
    return { custom, command: `${custom} ${quoted}` };
  }
  if (platform === 'darwin') return { command: 'open', args: [file] };
  if (platform === 'win32') return { command: 'explorer', args: [file] };
  return { command: 'xdg-open', args: [file] };
}

/* ---------- 等待上线 ---------- */

/** 网页现在的版本（ETag），打不开时返回 null。加时间戳绕过 CDN 缓存。 */
export async function liveVersion(url) {
  try {
    const response = await fetch(`${url}?myblog=${Date.now()}`, {
      method: 'HEAD',
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) return null;
    return response.headers.get('etag') || response.headers.get('last-modified') || 'live';
  } catch {
    return null;
  }
}

/** 推送后等 GitHub Pages 部署完：网页能打开、而且版本和推送前不一样。 */
export async function waitUntilLive(url, { before = null, timeoutMs = 10 * 60_000, intervalMs = 10_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const version = await liveVersion(url);
    if (version && version !== before) return true;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return false;
}

/* ---------- 命令 ---------- */

async function git(args, root, message) {
  const result = await run('git', args, root);
  if (result.code !== 0) throw new BlogError(message, stripAnsi(result.output).trim().split(/\r?\n/).slice(-6));
  return result.output.trim();
}

/** timeoutMs：超时就停掉，当作失败（比如网络卡住的 git fetch）。 */
function run(command, args, cwd, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      // git、ssh 要密码时不在终端里问（会把界面弄乱、一直卡住），直接报错。
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', FORCE_COLOR: '0', NO_COLOR: '1' },
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => (output += chunk));
    child.stderr.on('data', (chunk) => (output += chunk));
    const timer = timeoutMs
      ? setTimeout(() => {
          try {
            process.kill(-child.pid, 'SIGKILL');
          } catch {
            // 已经结束了。
          }
        }, timeoutMs)
      : null;
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, output: error.message });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, output });
    });
  });
}

function stripAnsi(text) {
  return String(text).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '');
}
