#!/usr/bin/env node
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

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const draftsDir = path.join(projectRoot, 'src/content/drafts');
const postsDir = path.join(projectRoot, 'src/content/posts');
const publicImagesDir = path.join(projectRoot, 'public/images');
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

const [, , command, ...rawArgs] = process.argv;
const args = rawArgs.filter((arg) => !arg.startsWith('--'));
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')));

async function main() {
  await ensureBaseDirs();

  switch (command) {
    case 'today':
      await createDraft(compactDateForToday(), { open: !shouldSkipOpen() });
      break;
    case 'new':
      await createDraft(requireDateArg(args[0]), { open: !shouldSkipOpen() });
      break;
    case 'list':
      await listNotes();
      break;
    case 'publish':
      await publishDraft(requireDateArg(args[0]));
      break;
    default:
      printHelp();
      process.exitCode = command ? 1 : 0;
  }
}

function shouldSkipOpen() {
  return flags.has('--no-open') || process.env.BLOG_NO_OPEN === '1' || Boolean(process.env.CI);
}

async function ensureBaseDirs() {
  await mkdir(draftsDir, { recursive: true });
  await mkdir(postsDir, { recursive: true });
  await mkdir(publicImagesDir, { recursive: true });
}

function compactDateForToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: blogTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}${values.month}${values.day}`;
}

function requireDateArg(value) {
  if (!value) {
    fail('请提供日期，例如：npm run note:new -- 20260529');
  }

  const compact = value.replace(/\.(md|mdx)$/i, '');
  if (!/^\d{8}$/.test(compact) || !toIsoDate(compact)) {
    fail(`日期必须是有效的 YYYYMMDD 格式：${value}`);
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

async function createDraft(compactDate, options = { open: true }) {
  const draftPath = path.join(draftsDir, `${compactDate}.md`);
  const assetsDir = path.join(draftsDir, `${compactDate}.assets`);
  const publishedPath = path.join(postsDir, `${compactDate}.md`);

  if (existsSync(publishedPath)) {
    console.log(`当天文章已发布：${relative(publishedPath)}`);
    if (options.open) {
      openFile(publishedPath);
    }
    return;
  }

  await mkdir(assetsDir, { recursive: true });

  if (!existsSync(draftPath)) {
    await writeFile(draftPath, '', 'utf8');
    console.log(`已创建草稿：${relative(draftPath)}`);
  } else {
    console.log(`草稿已存在：${relative(draftPath)}`);
  }

  console.log(`图片目录：${relative(assetsDir)}`);

  if (options.open) {
    openFile(draftPath);
  }
}

function openFile(filePath) {
  const customEditor = process.env.BLOG_EDITOR;

  if (customEditor) {
    spawn(customEditor, [filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  const editor = process.env.EDITOR;
  if (editor) {
    spawn(editor, [filePath], {
      detached: true,
      stdio: 'ignore',
    }).unref();
    return;
  }

  console.log('未找到可自动打开的编辑器，请手动打开上面的草稿路径。');
}

async function listNotes() {
  const drafts = await listMarkdownFiles(draftsDir);
  const posts = await listMarkdownFiles(postsDir);
  const rows = [];

  for (const file of drafts) {
    const compact = path.basename(file).replace(/\.(md|mdx)$/i, '');
    rows.push({
      status: 'draft',
      date: toIsoDate(compact) ?? '-',
      title: compact,
      path: relative(path.join(draftsDir, file)),
    });
  }

  for (const file of posts) {
    const absolutePath = path.join(postsDir, file);
    const { frontmatter } = splitFrontmatter(await readFile(absolutePath, 'utf8'));
    const metadata = parseFrontmatter(frontmatter);
    rows.push({
      status: metadata.draft === 'true' ? 'draft?' : 'post',
      date: metadata.date || '-',
      title: stripQuotes(metadata.title) || path.basename(file, path.extname(file)),
      path: relative(absolutePath),
    });
  }

  rows.sort((a, b) => `${b.date} ${b.title}`.localeCompare(`${a.date} ${a.title}`));

  if (!rows.length) {
    console.log('还没有草稿或文章。');
    return;
  }

  const widths = {
    status: Math.max(...rows.map((row) => row.status.length), 6),
    date: Math.max(...rows.map((row) => row.date.length), 4),
    title: Math.max(...rows.map((row) => row.title.length), 5),
  };

  console.log(
    `${pad('状态', widths.status)}  ${pad('日期', widths.date)}  ${pad('标题', widths.title)}  路径`,
  );
  console.log(
    `${'-'.repeat(widths.status)}  ${'-'.repeat(widths.date)}  ${'-'.repeat(widths.title)}  ----`,
  );

  for (const row of rows) {
    console.log(
      `${pad(row.status, widths.status)}  ${pad(row.date, widths.date)}  ${pad(
        row.title,
        widths.title,
      )}  ${row.path}`,
    );
  }
}

async function publishDraft(compactDate) {
  const sourcePath = findExistingDraft(compactDate);
  if (!sourcePath) {
    fail(`没有找到草稿：src/content/drafts/${compactDate}.md`);
  }

  const destinationPath = path.join(postsDir, `${compactDate}${path.extname(sourcePath)}`);
  if (existsSync(destinationPath)) {
    fail(`发布文章已存在：${relative(destinationPath)}`);
  }

  const rawContent = await readFile(sourcePath, 'utf8');
  const { frontmatter, body } = splitFrontmatter(rawContent);
  const existingMetadata = parseFrontmatter(frontmatter);
  const assetsDir = path.join(draftsDir, `${compactDate}.assets`);

  const processedBody = await processImages(body, {
    compactDate,
    draftDir: draftsDir,
    assetsDir,
  });
  const title = stripQuotes(existingMetadata.title) || compactDate;
  const cleanedBody = removeDuplicateTitle(processedBody, title);
  const metadata = {
    title,
    date: existingMetadata.date || toIsoDate(compactDate),
    category: stripQuotes(existingMetadata.category) || 'Daily',
    tags: parseTags(existingMetadata.tags),
    description:
      stripQuotes(existingMetadata.description) || createDescription(cleanedBody, title),
    draft: false,
  };
  const finalContent = `${formatFrontmatter(metadata)}\n${cleanedBody.trim()}\n`;

  await writeFile(destinationPath, finalContent, 'utf8');
  console.log(`已生成发布文章：${relative(destinationPath)}`);

  const buildResult = spawnSync('npm', ['run', 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });

  if (buildResult.status !== 0) {
    console.error('\n构建失败。草稿和生成的文章都已保留，方便你检查。');
    process.exit(buildResult.status ?? 1);
  }

  await unlink(sourcePath);
  if (existsSync(assetsDir)) {
    await rm(assetsDir, { recursive: true, force: true });
  }

  console.log('\n发布准备完成。确认无误后执行：');
  console.log('git add .');
  console.log(`git commit -m "Add note ${compactDate}"`);
  console.log('git push');
}

function findExistingDraft(compactDate) {
  const mdPath = path.join(draftsDir, `${compactDate}.md`);
  const mdxPath = path.join(draftsDir, `${compactDate}.mdx`);
  if (existsSync(mdPath)) return mdPath;
  if (existsSync(mdxPath)) return mdxPath;
  return null;
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
    return { frontmatter: '', body: content };
  }

  return {
    frontmatter: match[1],
    body: content.slice(match[0].length),
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

function relative(filePath) {
  return path.relative(projectRoot, filePath);
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function printHelp() {
  console.log(`用法：
  npm run note:today
  npm run note:new -- 20260529
  npm run note:list
  npm run note:publish -- 20260529

环境变量：
  BLOG_NO_OPEN=1       创建草稿后不自动打开
  BLOG_EDITOR=typora   指定打开草稿的编辑器
  BLOG_TIMEZONE=Asia/Shanghai
`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
