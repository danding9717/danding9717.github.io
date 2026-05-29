import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import {
  copyFile,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  unlink,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
export const draftsDir = path.join(projectRoot, 'src/content/drafts');
export const postsDir = path.join(projectRoot, 'src/content/posts');
export const publicImagesDir = path.join(projectRoot, 'public/images');
export const previewUrl = 'http://127.0.0.1:4321/';

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

export class BlogError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = 'BlogError';
    this.status = options.status ?? 1;
    this.details = options.details ?? '';
  }
}

export async function ensureBaseDirs() {
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

export function normalizeCompactDate(value) {
  if (!value) {
    throw new BlogError('请提供日期，例如：20260529');
  }

  const compact = String(value).replace(/\.(md|mdx)$/i, '');
  if (!/^\d{8}$/.test(compact) || !toIsoDate(compact)) {
    throw new BlogError(`日期必须是有效的 YYYYMMDD 格式：${value}`);
  }

  return compact;
}

export function toIsoDate(compactDate) {
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
  const draftPath = path.join(draftsDir, `${normalizedDate}.md`);
  const assetsDir = path.join(draftsDir, `${normalizedDate}.assets`);
  const publishedPath = path.join(postsDir, `${normalizedDate}.md`);
  const messages = [];

  if (existsSync(publishedPath)) {
    messages.push(`当天文章已发布：${relative(publishedPath)}`);
    if (options.open) {
      openFile(publishedPath, options);
    }
    return {
      assetsDir,
      filePath: publishedPath,
      messages,
      status: 'published',
    };
  }

  await mkdir(assetsDir, { recursive: true });

  if (!existsSync(draftPath)) {
    await writeFile(draftPath, '', 'utf8');
    messages.push(`已创建草稿：${relative(draftPath)}`);
  } else {
    messages.push(`草稿已存在：${relative(draftPath)}`);
  }

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
    rows.push({
      compact: path.basename(file).replace(/\.(md|mdx)$/i, ''),
      date: metadata.date || '-',
      filePath: absolutePath,
      path: relative(absolutePath),
      status: metadata.draft === 'true' ? 'draft?' : 'post',
      title: stripQuotes(metadata.title) || path.basename(file, path.extname(file)),
    });
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

  const rawContent = await readFile(sourcePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(rawContent);
  const existingMetadata = parseFrontmatter(frontmatter);
  const assetsDir = path.join(draftsDir, `${normalizedDate}.assets`);

  const processedBody = await processImages(body, {
    assetsDir,
    compactDate: normalizedDate,
    draftDir: draftsDir,
  });
  const title = stripQuotes(existingMetadata.title) || normalizedDate;
  const cleanedBody = removeDuplicateTitle(processedBody, title);
  const metadata = {
    category: stripQuotes(existingMetadata.category) || 'Daily',
    date: existingMetadata.date || toIsoDate(normalizedDate),
    description:
      stripQuotes(existingMetadata.description) || createDescription(cleanedBody, title),
    draft: false,
    tags: parseTags(existingMetadata.tags),
    title,
  };
  const finalContent = `${formatFrontmatter(metadata)}\n${cleanedBody.trim()}\n`;

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

export function findExistingDraft(compactDate) {
  const mdPath = path.join(draftsDir, `${compactDate}.md`);
  const mdxPath = path.join(draftsDir, `${compactDate}.mdx`);
  if (existsSync(mdPath)) return mdPath;
  if (existsSync(mdxPath)) return mdxPath;
  return null;
}

export function relative(filePath) {
  return path.relative(projectRoot, filePath);
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

function parseFrontmatter(frontmatter) {
  const metadata = {};

  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      metadata[match[1]] = match[2].trim();
    }
  }

  return metadata;
}

function parseTags(value) {
  if (!value || value === '[]') return [];

  const inlineTags = value.match(/^\[(.*)\]$/);
  if (!inlineTags) return [];

  return inlineTags[1]
    .split(',')
    .map((tag) => stripQuotes(tag.trim()))
    .filter(Boolean);
}

function stripQuotes(value = '') {
  return value.replace(/^["']|["']$/g, '').trim();
}

function formatFrontmatter(metadata) {
  return [
    '---',
    `title: "${escapeYamlString(metadata.title)}"`,
    `date: ${metadata.date}`,
    `category: "${escapeYamlString(metadata.category)}"`,
    `tags: ${formatTags(metadata.tags)}`,
    `description: "${escapeYamlString(metadata.description)}"`,
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

function removeDuplicateTitle(content, title) {
  const escapedTitle = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return content.replace(new RegExp(`^#\\s+${escapedTitle}\\s*\\r?\\n+`), '');
}

function createDescription(content, fallback) {
  const text = content
    .replace(/```[\s\S]*?```/g, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, '')
    .replace(/!\[\[[^\]]+\]\]/g, '')
    .replace(/\[[^\]]+\]\([^)]+\)/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/<[^>]+>/g, '')
    .replace(/[*_`~]/g, '')
    .trim();

  const firstParagraph = text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\s+/g, ' ').trim())
    .find(Boolean);

  const description = firstParagraph || fallback;
  return description.length > 160 ? `${description.slice(0, 160).trim()}...` : description;
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
