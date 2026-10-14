import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const draftsDir = path.join(projectRoot, 'src/content/drafts');
const postsDir = path.join(projectRoot, 'src/content/posts');
const publicImagesDir = path.join(projectRoot, 'public/images');
const trashDir = path.join(projectRoot, '.blog-trash');

const blogTimezone = process.env.BLOG_TIMEZONE || 'Asia/Shanghai';
const imageExtensions = new Set([
  '.avif',
  '.gif',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
]);

// 新草稿的骨架：动笔前先想好标题（一句观点）和一句导语。
const DRAFT_TEMPLATE = ['---', 'title:', 'description:', 'tags: []', 'slug:', '---', '', ''].join('\n');

export class BlogError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BlogError';
    this.status = options.status ?? 1;
    this.details = options.details ?? '';
  }
}

async function ensureBaseDirs() {
  await mkdir(draftsDir, { recursive: true });
  await mkdir(postsDir, { recursive: true });
  await mkdir(publicImagesDir, { recursive: true });
}

export function compactDateForToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: blogTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function normalizeCompactDate(value) {
  if (!value) {
    throw new BlogError('请提供日期，例如：20260529');
  }

  const compact = String(value).replace(/\.(md|mdx)$/i, '');
  if (!/^\d{8}$/.test(compact) || !toIsoDate(compact)) {
    throw new BlogError(`日期必须是有效的 YYYYMMDD 格式：${value}`);
  }

  return compact;
}

function toIsoDate(compactDate) {
  const year = Number(compactDate.slice(0, 4));
  const month = Number(compactDate.slice(4, 6));
  const day = Number(compactDate.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));

  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }

  return `${compactDate.slice(0, 4)}-${compactDate.slice(4, 6)}-${compactDate.slice(6, 8)}`;
}

export async function createDraft(compactDate, options = {}) {
  await ensureBaseDirs();

  const normalizedDate = normalizeCompactDate(compactDate);
  const assetsDir = path.join(draftsDir, `${normalizedDate}.assets`);
  const existingDraftPath = findExistingDraft(normalizedDate);
  const publishedMatches = await findPublishedNotesByDate(toIsoDate(normalizedDate));
  const messages = [];

  if (existingDraftPath) {
    await mkdir(assetsDir, { recursive: true });
    messages.push(`当天草稿已存在：${relative(existingDraftPath)}`);
    messages.push(`图片目录：${relative(assetsDir)}`);
    if (options.open) {
      openFile(existingDraftPath, options);
    }
    return {
      assetsDir,
      filePath: existingDraftPath,
      messages,
      status: 'draft',
    };
  }

  if (publishedMatches.length) {
    const published = publishedMatches[0];
    if (publishedMatches.length > 1) {
      messages.push(
        `当天已有 ${publishedMatches.length} 篇文章，按每天一篇规则不会再创建新草稿。`,
      );
    }
    messages.push(`当天文章已发布：${relative(published.filePath)}`);
    if (options.open) {
      openFile(published.filePath, options);
    }
    return {
      assetsDir,
      filePath: published.filePath,
      messages,
      status: 'published',
    };
  }

  const draftPath = path.join(draftsDir, `${normalizedDate}.md`);
  await mkdir(assetsDir, { recursive: true });

  await writeFile(draftPath, DRAFT_TEMPLATE, 'utf8');
  messages.push(`已创建草稿：${relative(draftPath)}`);

  messages.push(`图片目录：${relative(assetsDir)}`);

  if (options.open) {
    openFile(draftPath, options);
  }

  return {
    assetsDir,
    filePath: draftPath,
    messages,
    status: 'draft',
  };
}

export function openFile(filePath, options = {}) {
  const editor = options.editor || process.env.BLOG_EDITOR || 'Typora';

  if (process.platform === 'darwin') {
    spawn('open', ['-a', editor, filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  const fallbackEditor = process.env.EDITOR;
  if (fallbackEditor) {
    spawn(fallbackEditor, [filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
  }
}

export async function listNotes() {
  await ensureBaseDirs();

  const drafts = await listMarkdownFiles(draftsDir);
  const posts = await listMarkdownFiles(postsDir);
  const rows = [];

  for (const file of drafts) {
    const compact = path.basename(file).replace(/\.(md|mdx)$/i, '');
    rows.push({
      compact,
      date: toIsoDate(compact) ?? '-',
      filePath: path.join(draftsDir, file),
      path: relative(path.join(draftsDir, file)),
      status: 'draft',
      title: compact,
    });
  }

  for (const file of posts) {
    const absolutePath = path.join(postsDir, file);
    const { frontmatter } = splitFrontmatter(await readFile(absolutePath, 'utf8'));
    const metadata = parseFrontmatter(frontmatter);
    rows.push(createPostRow(file, absolutePath, metadata));
  }

  return rows.sort((a, b) => `${b.date} ${b.title}`.localeCompare(`${a.date} ${a.title}`));
}

export function formatNoteRows(rows) {
  if (!rows.length) {
    return '还没有草稿或文章。';
  }

  const widths = {
    status: Math.max(...rows.map((row) => row.status.length), 6),
    date: Math.max(...rows.map((row) => row.date.length), 4),
    title: Math.max(...rows.map((row) => row.title.length), 5),
  };
  const lines = [
    `${pad('状态', widths.status)}  ${pad('日期', widths.date)}  ${pad('标题', widths.title)}  路径`,
    `${'-'.repeat(widths.status)}  ${'-'.repeat(widths.date)}  ${'-'.repeat(widths.title)}  ----`,
  ];

  for (const row of rows) {
    lines.push(
      `${pad(row.status, widths.status)}  ${pad(row.date, widths.date)}  ${pad(
        row.title,
        widths.title,
      )}  ${row.path}`,
    );
  }

  return lines.join('\n');
}

export async function publishDraft(compactDate, options = {}) {
  await ensureBaseDirs();

  const normalizedDate = normalizeCompactDate(compactDate);
  const sourcePath = findExistingDraft(normalizedDate);
  if (!sourcePath) {
    throw new BlogError(`没有找到草稿：src/content/drafts/${normalizedDate}.md`);
  }

  const destinationPath = path.join(postsDir, `${normalizedDate}${path.extname(sourcePath)}`);
  if (existsSync(destinationPath)) {
    throw new BlogError(`发布文章已存在：${relative(destinationPath)}`);
  }

  const existingPosts = await findPublishedNotesByDate(toIsoDate(normalizedDate));
  if (existingPosts.length) {
    throw new BlogError(
      `当天已有已发布文章：${existingPosts.map((post) => relative(post.filePath)).join(', ')}`,
    );
  }

  const rawContent = await readFile(sourcePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(rawContent);
  const existingMetadata = parseFrontmatter(frontmatter);
  const assetsDir = path.join(draftsDir, `${normalizedDate}.assets`);

  // 先检查标题、导语、slug 和站内链接，都没问题再动图片和文件。
  const { title, description, slug } = validateDraftMetadata(existingMetadata, body);
  const publishedPosts = await listPublishedPostLinks();
  const taken = slug && publishedPosts.find((post) => post.id === slug);
  if (taken) {
    throw new BlogError(`slug「${slug}」已经被 ${taken.path} 用了，换一个吧。`);
  }

  const linkTargets = new Map(publishedPosts.map((post) => [post.compact, post]));
  linkTargets.set(normalizedDate, { id: slug || normalizedDate, title });
  const linkedBody = rewritePostLinks(removeDuplicateTitle(body, title), linkTargets);

  const processedBody = await processImages(linkedBody, {
    assetsDir,
    compactDate: normalizedDate,
    draftDir: draftsDir,
  });
  const metadata = {
    category: stripQuotes(existingMetadata.category) || 'Daily',
    date: existingMetadata.date || toIsoDate(normalizedDate),
    description,
    draft: false,
    slug,
    tags: parseTags(existingMetadata.tags),
    title,
  };
  const finalContent = `${formatFrontmatter(metadata)}\n${processedBody.trim()}\n`;

  await writeFile(destinationPath, finalContent, 'utf8');

  let buildOutput = '';
  if (options.runBuild !== false) {
    const buildResult = spawnSync('npm', ['run', 'build'], {
      cwd: projectRoot,
      encoding: options.stdio === 'pipe' ? 'utf8' : undefined,
      stdio: options.stdio ?? 'inherit',
    });

    if (options.stdio === 'pipe') {
      buildOutput = `${buildResult.stdout ?? ''}${buildResult.stderr ?? ''}`.trim();
    }

    if (buildResult.status !== 0) {
      throw new BlogError('构建失败。草稿和生成的文章都已保留，方便你检查。', {
        details: buildOutput,
        status: buildResult.status ?? 1,
      });
    }
  }

  await unlink(sourcePath);
  if (existsSync(assetsDir)) {
    await rm(assetsDir, { recursive: true, force: true });
  }

  return {
    buildOutput,
    compactDate: normalizedDate,
    destinationPath,
    messages: [
      `已生成发布文章：${relative(destinationPath)}`,
      '发布准备完成。确认无误后执行：',
      'git add .',
      `git commit -m "Add note ${normalizedDate}"`,
      'git push',
    ],
    sourcePath,
  };
}

export async function moveNoteToTrash(target) {
  await ensureBaseDirs();

  const row = typeof target === 'string' ? await findNote(target) : target;
  if (!row) {
    throw new BlogError(`没有找到要删除的文章或草稿：${target}`);
  }

  if (!['draft', 'post'].includes(row.status)) {
    throw new BlogError(`不支持删除该状态：${row.status}`);
  }

  const sessionDir = await createTrashSessionDir();
  const moved = [await movePathToTrash(row.filePath, sessionDir)];

  if (row.status === 'draft') {
    const assetsPath = path.join(
      draftsDir,
      `${path.basename(row.filePath, path.extname(row.filePath))}.assets`,
    );
    if (existsSync(assetsPath)) {
      moved.push(await movePathToTrash(assetsPath, sessionDir));
    }
  }

  return {
    messages: [
      `已移入回收站：${relative(sessionDir)}`,
      ...moved.map((item) => `- ${item}`),
    ],
    moved,
    sessionDir,
  };
}

async function findNote(identifier) {
  const key = normalizeIdentifier(identifier);
  const rows = await listNotes();
  const matches = rows.filter((row) => {
    const basename = path.basename(row.filePath, path.extname(row.filePath));
    return (
      row.compact === key ||
      basename === key ||
      row.date === key ||
      row.title === key ||
      row.path === key ||
      row.path.endsWith(`/${key}`) ||
      row.path.endsWith(`/${key}.md`) ||
      row.path.endsWith(`/${key}.mdx`)
    );
  });

  if (matches.length > 1) {
    throw new BlogError(
      `匹配到多篇内容，请使用更完整的文件名：${matches.map((row) => row.compact).join(', ')}`,
    );
  }

  return matches[0] ?? null;
}

export async function listTrashItems() {
  if (!existsSync(trashDir)) return [];

  const entries = await readdir(trashDir, { withFileTypes: true });
  const sessions = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => b.localeCompare(a));
  const items = [];

  for (const session of sessions) {
    const sessionDir = path.join(trashDir, session);
    const files = await listRelativeFiles(sessionDir);
    items.push({
      files,
      path: relative(sessionDir),
      session,
    });
  }

  return items;
}

export function formatTrashItems(items) {
  if (!items.length) {
    return '回收站为空。';
  }

  return items
    .flatMap((item) => [
      item.session,
      ...item.files.map((file) => `  ${file}`),
    ])
    .join('\n');
}

function getGitStatus() {
  const result = runCommand('git', ['status', '--porcelain'], {
    allowFailure: true,
  });
  return result.stdout.trim();
}

export function commitAndPush(message, options = {}) {
  const commitMessage = String(message || 'Update blog').trim() || 'Update blog';
  const statusBefore = getGitStatus();

  if (!statusBefore) {
    return {
      messages: ['没有需要提交的改动。'],
      noChanges: true,
    };
  }

  const buildResult = runCommand('npm', ['run', 'build'], {
    allowFailure: true,
    stdio: options.stdio,
  });
  if (buildResult.status !== 0) {
    throw new BlogError('构建失败，已停止提交。', {
      details: buildResult.output,
      status: buildResult.status ?? 1,
    });
  }

  const addResult = runCommand('git', ['add', '.'], {
    allowFailure: true,
  });
  if (addResult.status !== 0) {
    throw new BlogError('Git add 失败。', {
      details: addResult.output,
      status: addResult.status ?? 1,
    });
  }

  const statusAfterAdd = getGitStatus();
  if (!statusAfterAdd) {
    return {
      buildOutput: buildResult.output,
      messages: ['没有需要提交的改动。'],
      noChanges: true,
    };
  }

  const commitResult = runCommand('git', ['commit', '-m', commitMessage], {
    allowFailure: true,
  });
  if (commitResult.status !== 0) {
    throw new BlogError('Git commit 失败。', {
      details: commitResult.output,
      status: commitResult.status ?? 1,
    });
  }

  const pushResult = runCommand('git', ['push'], {
    allowFailure: true,
  });
  if (pushResult.status !== 0) {
    throw new BlogError('Git push 失败。本地提交已完成，请稍后手动 push。', {
      details: pushResult.output,
      status: pushResult.status ?? 1,
    });
  }

  return {
    buildOutput: buildResult.output,
    messages: [
      `已提交：${commitMessage}`,
      '已推送到 GitHub。',
    ],
    statusBefore,
  };
}

function findExistingDraft(compactDate) {
  const mdPath = path.join(draftsDir, `${compactDate}.md`);
  const mdxPath = path.join(draftsDir, `${compactDate}.mdx`);
  if (existsSync(mdPath)) return mdPath;
  if (existsSync(mdxPath)) return mdxPath;
  return null;
}

async function findPublishedNotesByDate(isoDate) {
  if (!isoDate) return [];

  const posts = await listMarkdownFiles(postsDir);
  const matches = [];

  for (const file of posts) {
    const absolutePath = path.join(postsDir, file);
    const { frontmatter } = splitFrontmatter(await readFile(absolutePath, 'utf8'));
    const metadata = parseFrontmatter(frontmatter);

    if (metadata.draft === 'true') continue;
    if (metadata.date === isoDate) {
      matches.push(createPostRow(file, absolutePath, metadata));
    }
  }

  return matches.sort((a, b) => a.path.localeCompare(b.path));
}

function relative(filePath) {
  return path.relative(projectRoot, filePath);
}

function createPostRow(file, filePath, metadata) {
  return {
    compact: path.basename(file).replace(/\.(md|mdx)$/i, ''),
    date: metadata.date || '-',
    filePath,
    path: relative(filePath),
    status: metadata.draft === 'true' ? 'draft?' : 'post',
    title: stripQuotes(metadata.title) || path.basename(file, path.extname(file)),
  };
}

async function createTrashSessionDir() {
  await mkdir(trashDir, { recursive: true });

  const baseName = formatLocalTimestamp(new Date());
  let candidate = path.join(trashDir, baseName);
  let suffix = 2;

  while (existsSync(candidate)) {
    candidate = path.join(trashDir, `${baseName}-${suffix}`);
    suffix += 1;
  }

  await mkdir(candidate, { recursive: true });
  return candidate;
}

async function movePathToTrash(sourcePath, sessionDir) {
  const destinationPath = path.join(sessionDir, relative(sourcePath));
  await mkdir(path.dirname(destinationPath), { recursive: true });
  await rename(sourcePath, destinationPath);
  return relative(destinationPath);
}

function normalizeIdentifier(identifier) {
  return String(identifier ?? '')
    .trim()
    .replace(/^['"]|['"]$/g, '')
    .replace(/\.(md|mdx)$/i, '');
}

function formatLocalTimestamp(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: blogTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(date);
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}-${values.hour}${values.minute}${values.second}`;
}

async function listRelativeFiles(directory, prefix = '') {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const entryPath = path.join(directory, entry.name);
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await listRelativeFiles(entryPath, relativePath)));
    } else {
      files.push(relativePath);
    }
  }

  return files;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: projectRoot,
    encoding: 'utf8',
    stdio: options.stdio === 'inherit' ? 'inherit' : 'pipe',
  });
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();

  if (!options.allowFailure && result.status !== 0) {
    throw new BlogError(`${command} ${args.join(' ')} 执行失败。`, {
      details: output,
      status: result.status ?? 1,
    });
  }

  return {
    output,
    status: result.status ?? 0,
    stderr: result.stderr ?? '',
    stdout: result.stdout ?? '',
  };
}

async function processImages(content, context) {
  let imageIndex = 0;
  const copiedSources = new Map();

  async function copyImage(rawTarget) {
    const sourcePath = await resolveImagePath(rawTarget, context);
    if (!sourcePath) return null;

    if (copiedSources.has(sourcePath)) {
      return copiedSources.get(sourcePath);
    }

    const destinationDir = path.join(publicImagesDir, context.compactDate);
    await mkdir(destinationDir, { recursive: true });

    imageIndex += 1;
    const destinationName = await uniqueImageName(
      destinationDir,
      sanitizeImageName(path.basename(sourcePath), imageIndex),
    );
    const destinationPath = path.join(destinationDir, destinationName);
    await copyFile(sourcePath, destinationPath);

    const publicPath = `/images/${context.compactDate}/${destinationName}`;
    copiedSources.set(sourcePath, publicPath);
    return publicPath;
  }

  let transformed = content;

  transformed = await replaceAsync(
    transformed,
    /!\[([^\]]*)\]\(([^)]+)\)/g,
    async (match, alt, rawTarget) => {
      const target = stripMarkdownImageTarget(rawTarget);
      if (isExternalOrPublicImage(target)) return match;

      const publicPath = await copyImage(target);
      return publicPath ? `![${alt}](${publicPath})` : match;
    },
  );

  transformed = await replaceAsync(
    transformed,
    /!\[\[([^\]]+)\]\]/g,
    async (match, rawTarget) => {
      const [target, label] = rawTarget.split('|').map((value) => value.trim());
      if (!target || isExternalOrPublicImage(target)) return match;

      const publicPath = await copyImage(target);
      const alt = label || path.basename(target, path.extname(target));
      return publicPath ? `![${alt}](${publicPath})` : match;
    },
  );

  return transformed;
}

async function resolveImagePath(rawTarget, context) {
  const cleanTarget = decodeMarkdownPath(rawTarget);
  const candidates = [];

  if (path.isAbsolute(cleanTarget)) {
    candidates.push(cleanTarget);
  } else {
    candidates.push(path.resolve(context.draftDir, cleanTarget));
    candidates.push(path.resolve(context.assetsDir, cleanTarget));
    candidates.push(path.resolve(context.assetsDir, path.basename(cleanTarget)));
  }

  for (const candidate of candidates) {
    if (await isImageFile(candidate)) return candidate;
  }

  return null;
}

async function isImageFile(filePath) {
  if (!imageExtensions.has(path.extname(filePath).toLowerCase())) return false;

  try {
    const fileStats = await stat(filePath);
    return fileStats.isFile();
  } catch {
    return false;
  }
}

function stripMarkdownImageTarget(rawTarget) {
  const trimmed = rawTarget.trim().replace(/^<(.+)>$/, '$1');
  const quotedTitleMatch = trimmed.match(/^(.+?)\s+["'][^"']+["']$/);
  return quotedTitleMatch ? quotedTitleMatch[1].trim() : trimmed;
}

function isExternalOrPublicImage(target) {
  return /^(https?:|data:|\/images\/)/i.test(target);
}

function decodeMarkdownPath(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function sanitizeImageName(fileName, index) {
  const extension = path.extname(fileName).toLowerCase();
  const baseName = path
    .basename(fileName, path.extname(fileName))
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();

  return `${baseName || `image-${index}`}${extension}`;
}

async function uniqueImageName(directory, fileName) {
  const extension = path.extname(fileName);
  const baseName = path.basename(fileName, extension);
  let candidate = fileName;
  let suffix = 2;

  while (existsSync(path.join(directory, candidate))) {
    candidate = `${baseName}-${suffix}${extension}`;
    suffix += 1;
  }

  return candidate;
}

async function replaceAsync(input, regex, replacer) {
  const replacements = [];
  input.replace(regex, (...match) => {
    replacements.push(replacer(...match));
    return match[0];
  });

  const resolved = await Promise.all(replacements);
  let index = 0;
  return input.replace(regex, () => resolved[index++]);
}

function splitFrontmatter(content) {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return { body: content, frontmatter: '' };
  }

  return {
    body: content.slice(match[0].length),
    frontmatter: match[1],
  };
}

/**
 * 读 frontmatter 的简单键值。空值当作没写；空值后面缩进的「- x」行收集成数组
 * （Obsidian 的块状 tags 就是这种写法）。值保留原样，引号由 stripQuotes 去掉。
 */
export function parseFrontmatter(frontmatter) {
  const metadata = {};
  let listKey = null;

  for (const line of frontmatter.split(/\r?\n/)) {
    const item = listKey && line.match(/^\s*-\s+(.*)$/);
    if (item) {
      metadata[listKey].push(item[1].trim());
      continue;
    }

    listKey = null;
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!match) continue;

    const value = match[2].trim();
    if (value) {
      metadata[match[1]] = value;
    } else {
      metadata[match[1]] = [];
      listKey = match[1];
    }
  }

  for (const [key, value] of Object.entries(metadata)) {
    if (Array.isArray(value) && !value.length) delete metadata[key];
  }

  return metadata;
}

/** 支持 ["a", "b"]、块状列表和「a, b」三种写法。 */
export function parseTags(value) {
  if (!value || value === '[]') return [];

  const items = Array.isArray(value)
    ? value
    : (value.match(/^\[(.*)\]$/)?.[1] ?? value).split(',');

  return [...new Set(items.map((tag) => stripQuotes(tag.trim())).filter(Boolean))];
}

function stripQuotes(value = '') {
  return String(value).replace(/^["']|["']$/g, '').trim();
}

export function formatFrontmatter(metadata) {
  return [
    '---',
    `title: "${escapeYamlString(metadata.title)}"`,
    `date: ${metadata.date}`,
    `category: "${escapeYamlString(metadata.category)}"`,
    `tags: ${formatTags(metadata.tags)}`,
    `description: "${escapeYamlString(metadata.description)}"`,
    ...(metadata.slug ? [`slug: "${escapeYamlString(metadata.slug)}"`] : []),
    `draft: ${metadata.draft}`,
    '---',
  ].join('\n');
}

function formatTags(tags) {
  if (!tags.length) return '[]';
  return `[${tags.map((tag) => `"${escapeYamlString(tag)}"`).join(', ')}]`;
}

function escapeYamlString(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

/** 正文第一行是「# 标题」时返回标题。 */
export function extractHeadingTitle(content) {
  const firstLine = content.trimStart().split(/\r?\n/, 1)[0];
  return firstLine.match(/^#\s+(.+?)\s*#*\s*$/)?.[1] ?? '';
}

export function removeDuplicateTitle(content, title) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`^\\s*#\\s+${escapedTitle}\\s*#*[ \\t]*(?:\\r?\\n+|$)`), '');
}

const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * 发布前检查草稿的标题、导语和 slug。
 * 没写 title 时取正文第一行的「# 标题」；两处都没有、或者没写 description，就拒绝发布。
 */
export function validateDraftMetadata(metadata, body) {
  const title = stripQuotes(metadata.title) || extractHeadingTitle(body);
  if (!title) {
    throw new BlogError('草稿缺少标题：在 frontmatter 里写 title，或者在正文第一行写「# 标题」。');
  }

  const description = stripQuotes(metadata.description);
  if (!description) {
    throw new BlogError(
      '草稿缺少 description：在 frontmatter 里手写一句导语（建议 40 字以内），它会用作副标题和首页摘要。',
    );
  }

  const slug = stripQuotes(metadata.slug);
  if (slug && !SLUG_PATTERN.test(slug)) {
    throw new BlogError(`slug 只能用小写英文、数字和连字符：${slug}`);
  }

  return { description, slug, title };
}

/**
 * 把指向其他文章的链接改写成站内地址 /posts/<id>/：
 * - Markdown 链接里的 YYYYMMDD.md（前面是什么相对路径都行，可以带 #小标题）；
 * - Obsidian 的 [[YYYYMMDD]]、[[YYYYMMDD|显示文字]]、[[YYYYMMDD#小标题]]。
 * targets 是「YYYYMMDD → { id, title }」，找不到对应文章时报错。代码块里的内容不改。
 */
export function rewritePostLinks(content, targets) {
  const resolve = (compact) => {
    const target = targets.get(compact);
    if (!target) {
      throw new BlogError(`正文链接到了 ${compact}，但没有找到这篇已发布的文章。`);
    }
    return target;
  };
  const anchor = (heading = '') => (heading ? `#${slugifyHeading(heading)}` : '');

  return content
    .split(/(^(?:```|~~~)[\s\S]*?^(?:```|~~~)[^\S\r\n]*$)/m)
    .map((part, index) => {
      if (index % 2 === 1) return part;

      return part
        .replace(
          /(?<!!)\[([^\]\n]*)\]\(<?((?![a-z][a-z0-9+.-]*:)[^)\s>]*?)(\d{8})\.mdx?(#[^)\s>]*)?>?((?:\s+"[^"]*")?)\)/gi,
          (match, text, prefix, compact, hash = '', title) => {
            if (prefix && !/[\\/]$/.test(prefix)) return match;
            return `[${text}](/posts/${resolve(compact).id}/${hash}${title})`;
          },
        )
        .replace(/(?<!!)\[\[(\d{8})(?:\.mdx?)?(?:#([^|\]]*))?(?:\|([^\]]*))?\]\]/g, (match, compact, heading, label) => {
          const target = resolve(compact);
          return `[${label?.trim() || target.title}](/posts/${target.id}/${anchor(heading?.trim())})`;
        });
    })
    .join('');
}

/** 和站点生成小标题 id 的规则一致：小写，去掉标点，空格换成连字符。 */
function slugifyHeading(heading) {
  return heading
    .toLowerCase()
    .trim()
    .replace(/[^\p{L}\p{N}\p{M}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/** 已发布文章的日期和站内 id（有 slug 用 slug，没有就用文件名）。 */
async function listPublishedPostLinks() {
  const files = await listMarkdownFiles(postsDir);
  const posts = [];

  for (const file of files) {
    const filePath = path.join(postsDir, file);
    const { frontmatter } = splitFrontmatter(await readFile(filePath, 'utf8'));
    const metadata = parseFrontmatter(frontmatter);
    const name = file.replace(/\.(md|mdx)$/i, '');

    posts.push({
      compact: name,
      id: stripQuotes(metadata.slug) || name,
      path: relative(filePath),
      title: stripQuotes(metadata.title) || name,
    });
  }

  return posts;
}

async function listMarkdownFiles(directory) {
  try {
    const files = await readdir(directory);
    return files
      .filter((file) => /\.(md|mdx)$/i.test(file))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return [];
  }
}

function pad(value, width) {
  return String(value).padEnd(width, ' ');
}
