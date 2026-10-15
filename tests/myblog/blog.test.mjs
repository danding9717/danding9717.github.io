import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  BlogError,
  buildErrors,
  dateName,
  defaultTitle,
  describe,
  droppedImagePath,
  formatPost,
  headingTitle,
  isBlankDraft,
  joinDocument,
  mapProse,
  normalizeDate,
  outsideEditor,
  parseTags,
  planImages,
  preparePost,
  readFields,
  rewriteLinks,
  splitDocument,
  splitFrontmatter,
  tagSlug,
  unquote,
  writeFields,
  zonedTime,
} from '../../scripts/myblog/blog.mjs';

// 北京时间 2026-10-14 21:30:00
const NOW = new Date('2026-10-14T13:30:00Z');

function post(id, title, extra = {}) {
  return {
    file: `/blog/src/content/posts/${id}.md`,
    kind: 'post',
    id,
    title,
    description: '导语',
    tags: ['AI'],
    slug: '',
    date: '2026-10-01T10:00:00+08:00',
    ...extra,
  };
}

function draft(fields, body = '正文。') {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return ['---', ...lines, '---', '', body, ''].join('\n');
}

function problemsOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof BlogError, `应该是 BlogError：${error}`);
    return error.problems;
  }
  assert.fail('应该抛出 BlogError');
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'myblog-blog-'));
after(() => rm(temp, { recursive: true, force: true }));

test('frontmatter 宽松读取：中文冒号、注释、一行一个的列表、空值', () => {
  const { data, body } = splitFrontmatter('---\ntitle: 复利\ndescription：一句话\n# 注释\ntags:\n  - AI\n  - 财富\nslug: \n---\n\n正文');
  assert.deepEqual(data, { title: '复利', description: '一句话', tags: ['AI', '财富'] });
  assert.equal(body, '\n正文');

  assert.deepEqual(splitFrontmatter('﻿---\r\ntitle: "a"\r\n---\r\nbody'), { data: { title: '"a"' }, body: 'body' });
  assert.deepEqual(splitFrontmatter('没有 frontmatter'), { data: {}, body: '没有 frontmatter' });
  // 空的 frontmatter 到第一个 --- 就结束，后面的 --- 是正文里的分隔线。
  assert.deepEqual(splitFrontmatter('---\n---\n\n---\n正文'), { data: {}, body: '\n---\n正文' });
});

test('编辑器里只有正文：frontmatter 拆出来原样保留，拼回去不变', () => {
  const text = '---\ntitle: 复利\nfeatured: true\n---\n\n\n正文第一段。\n';
  const { head, body } = splitDocument(text);
  assert.equal(head, '---\ntitle: 复利\nfeatured: true\n---\n');
  assert.equal(body, '正文第一段。\n');
  assert.equal(joinDocument(head, body), '---\ntitle: 复利\nfeatured: true\n---\n\n正文第一段。\n');

  assert.deepEqual(splitDocument(''), { head: '', body: '' });
  assert.equal(joinDocument('', ''), '');
  assert.deepEqual(splitDocument('只有正文'), { head: '', body: '只有正文' });
  assert.deepEqual(splitDocument('\uFEFF---\r\ntitle: a\r\n---\r\n正文\r\n'), { head: '---\ntitle: a\n---\n', body: '正文\n' });

  // 正文以分隔线开头时，先放一个空的 frontmatter，下次打开正文还在。
  const saved = joinDocument('', '---\n分隔线后面\n---\n再一条');
  assert.equal(saved, '---\n---\n\n---\n分隔线后面\n---\n再一条');
  assert.deepEqual(splitDocument(saved), { head: '---\n---\n', body: '---\n分隔线后面\n---\n再一条' });
});

test('发布页读出要填的几项，没写标题时用正文第一行的「# 标题」', () => {
  const head = '---\ntitle: \ndescription: "一句导语"\ntags: [AI, 财富]\nslug: compound\n---\n';
  assert.deepEqual(readFields(head, '# 正文里的标题\n\n正文'), {
    title: '正文里的标题',
    description: '一句导语',
    tags: ['AI', '财富'],
    slug: 'compound',
    date: '',
  });
  assert.equal(readFields('---\ntitle: 写在上面\n---\n', '# 正文里的标题').title, '写在上面');
  assert.deepEqual(readFields('', ''), { title: '', description: '', tags: [], slug: '', date: '' });
});

test('发布页填的写回 frontmatter：改原来那项，加没有的，删空的，别的不动', () => {
  assert.equal(
    writeFields('', { title: '复利', description: '', tags: ['AI', '财富'], slug: '' }),
    '---\ntitle: "复利"\ntags: ["AI", "财富"]\n---\n',
  );

  const head = '---\ntitle: 旧标题\n# 注释\ntags:\n  - AI\n  - 生意\nfeatured: true\n---\n';
  assert.equal(
    writeFields(head, { title: '新标题', description: '导语', tags: ['财富'], slug: '' }),
    '---\ntitle: "新标题"\n# 注释\ntags: ["财富"]\nfeatured: true\ndescription: "导语"\n---\n',
  );

  // 上一版新建的空骨架。
  assert.equal(
    writeFields('---\ntitle: \ndescription: \ntags: \nslug: \n---\n', { title: 'T', description: 'D', tags: ['AI'], slug: '' }),
    '---\ntitle: "T"\ndescription: "D"\ntags: ["AI"]\n---\n',
  );

  assert.equal(writeFields('---\ntitle: a\ntitle: b\n---\n', { title: 'c' }), '---\ntitle: "c"\n---\n');
  assert.equal(writeFields('---\ntitle: a\n---\n', { title: '' }), '');

  // 引号、冒号原样读得回来。
  const fields = { title: '他说"复利": 不只是钱', description: "a: b # c", tags: ['AI'], slug: 'x', date: '2026-10-14 21:30' };
  assert.deepEqual(readFields(writeFields('', fields)), fields);
});

test('引号、标签的各种写法', () => {
  assert.equal(unquote('"他说\\"好\\""'), '他说"好"');
  assert.equal(unquote("'it''s'"), "it's");
  assert.equal(unquote('  不带引号  '), '不带引号');
  assert.equal(unquote(undefined), '');

  for (const value of ['[AI, 财富]', 'AI, 财富', 'AI，财富', 'AI、财富', '["AI", "财富", "AI"]', ['AI', '财富']]) {
    assert.deepEqual(parseTags(value), ['AI', '财富'], String(value));
  }
  assert.deepEqual(parseTags(''), []);

  // 和网站上标签的地址一致：只差大小写、空格的是同一个标签。
  assert.equal(tagSlug(' Daily Notes '), 'daily-notes');
  assert.equal(tagSlug('AI'), tagSlug('ai'));
  assert.equal(tagSlug('读书'), '读书');
});

test('正文第一行的「# 标题」', () => {
  assert.equal(headingTitle('\n\n# 复利不只是钱的事\n\n正文'), '复利不只是钱的事');
  assert.equal(headingTitle('## 二级标题'), '');
  assert.equal(headingTitle('正文'), '');
});

test('文章地址：有 slug 用 slug，没有就用文件名', () => {
  assert.equal(describe('---\ntitle: a\n---\n', { file: '/p/20261014-2.md', kind: 'post' }).id, '20261014-2');
  assert.equal(describe('---\ntitle: a\nslug: compound\n---\n', { file: '/p/x.md', kind: 'post' }).id, 'compound');
  assert.equal(describe('---\ntitle: a\n---\n', { file: '/d/20261014-213000.md', kind: 'draft' }).id, '');
});

test('还没有标题的草稿，列表里显示正文的第一句', () => {
  const untitled = describe('\n\n> 今天想清楚了一件事。\n\n第二段', { file: '/d/a.md', kind: 'draft' });
  assert.equal(untitled.title, '');
  assert.equal(untitled.excerpt, '今天想清楚了一件事。');
  assert.equal(describe('', { file: '/d/b.md', kind: 'draft' }).excerpt, '');
  assert.equal(describe('# 标题\n', { file: '/d/c.md', kind: 'draft' }).title, '标题');
});

test('什么都没写的草稿算空白', () => {
  assert.equal(isBlankDraft(''), true);
  assert.equal(isBlankDraft('---\ntitle: \ndescription: \ntags: \nslug: \n---\n\n'), true);
  assert.equal(isBlankDraft('---\ntitle: 有标题\n---\n'), false);
  assert.equal(isBlankDraft('---\ntitle: \n---\n\n写了一句'), false);
});

test('按北京时间取日期，跨过零点也对', () => {
  assert.deepEqual(zonedTime(NOW), {
    day: '20261014',
    stamp: '20261014-213000',
    iso: '2026-10-14T21:30:00+08:00',
  });
  assert.equal(zonedTime(new Date('2026-10-14T16:30:00Z')).day, '20261015');
});

test('日期编号：同一天第二篇起加 -2、-3，别的文章用掉的地址和标题都跳过', () => {
  assert.equal(dateName('20261014', []), '20261014');
  assert.equal(dateName('20261014', [post('20261014', 'a'), post('20261014-2', 'b')]), '20261014-3');
  // 有一篇用了自己的网址、标题是日期编号：下一篇的地址和标题都往后排，两者对得上。
  assert.equal(dateName('20261014', [post('compound', '20261014')]), '20261014-2');
});

test('没写标题时的标题：新文章按今天编号，改已发布的文章按它的发布日期', () => {
  const posts = [post('20261014', '复利'), post('20261001', '20261001', { date: '2026-10-01T10:00:00+08:00' })];
  assert.equal(defaultTitle({ posts, now: NOW }), '20261014-2');
  assert.equal(defaultTitle({ posts: [], now: NOW }), '20261014');
  // 改的就是那篇自己，不算撞了。
  assert.equal(defaultTitle({ posts, existing: posts[1], now: NOW }), '20261001');
  assert.equal(defaultTitle({ posts, existing: posts[0], now: NOW }), '20261001-2');
});

test('手写的日期整理成网站认的格式', () => {
  assert.equal(normalizeDate('2026-10-14'), '2026-10-14');
  assert.equal(normalizeDate('2026-10-14 21:30'), '2026-10-14T21:30:00+08:00');
  assert.equal(normalizeDate('2026-10-14T21:30:05+0800'), '2026-10-14T21:30:05+08:00');
  assert.equal(normalizeDate('2026-10-14T13:30:00Z'), '2026-10-14T13:30:00Z');
  assert.equal(normalizeDate('2026/10/14'), null);
  assert.equal(normalizeDate('2026-13-01'), null);
});

test('整理一篇能发布的草稿', () => {
  const text = draft({ title: '复利不只是钱的事', description: '"一句导语"', tags: '财富，精选', slug: '' }, '正文第一段。');
  const result = preparePost(text, { posts: [], now: NOW });
  assert.equal(result.id, '20261014');
  assert.equal(result.title, '复利不只是钱的事');
  assert.equal(result.description, '一句导语');
  assert.deepEqual(result.tags, ['财富', '精选']);
  assert.equal(result.date, '2026-10-14T21:30:00+08:00');
  assert.equal(result.slug, '');
  assert.equal(result.body.trim(), '正文第一段。');
});

test('缺的东西一次全部列出来', () => {
  const problems = problemsOf(() => preparePost(draft({ title: '', description: '', tags: '' }, ''), { posts: [], now: NOW }));
  assert.equal(problems.length, 2);
  assert.match(problems[0], /^缺标签/);
  assert.match(problems[1], /正文还是空的/);
});

test('标题、导语都可以不写：标题用日期编号，和网址一样', () => {
  const untitled = draft({ tags: 'AI' }, '只写了正文。');
  const first = preparePost(untitled, { posts: [], now: NOW });
  assert.equal(first.title, '20261014');
  assert.equal(first.id, '20261014');
  assert.equal(first.description, '');

  // 同一天第二篇。前一篇起了标题也一样，编号跟着网址走。
  const second = preparePost(untitled, { posts: [post('20261014', '复利')], now: NOW });
  assert.equal(second.title, '20261014-2');
  assert.equal(second.id, '20261014-2');

  // 写了网址没写标题：标题还是日期编号。
  const named = preparePost(draft({ tags: 'AI', slug: 'compound' }, '正文。'), { posts: [], now: NOW });
  assert.equal(named.title, '20261014');
  assert.equal(named.id, 'compound');
});

test('没写 title 时用正文第一行的「# 标题」，并从正文里去掉', () => {
  const result = preparePost(draft({ description: '导语', tags: 'AI' }, '# 标题写在正文里\n\n正文。'), { posts: [], now: NOW });
  assert.equal(result.title, '标题写在正文里');
  assert.equal(result.body.trim(), '正文。');
});

test('标题和已有文章重复时不发布', () => {
  const problems = problemsOf(() =>
    preparePost(draft({ title: 'Compound  Interest', description: '导语', tags: 'AI' }), {
      posts: [post('20261001', 'compound interest')],
      now: NOW,
    }),
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /已经有一篇文章叫/);
});

test('slug 的规则', () => {
  const posts = [post('compound', '复利')];
  const prepare = (slug) => () => preparePost(draft({ title: '新文章', description: '导语', tags: 'AI', slug }), { posts, now: NOW });
  assert.match(problemsOf(prepare('Hello World'))[0], /只能用小写英文、数字和连字符/);
  assert.match(problemsOf(prepare('compound'))[0], /已经被别的文章用了/);
  assert.equal(prepare('first-principles')().id, 'first-principles');
});

test('修改已发布的文章：地址和日期不变，不能改 slug', () => {
  const existing = post('20261001', '复利', { date: '2026-10-01T10:00:00+08:00' });
  const edited = draft({ title: '复利', date: '2026-10-01T10:00:00+08:00', description: '新导语', tags: '[AI]' }, '改过的正文。');
  const result = preparePost(edited, { posts: [existing], existing, now: NOW });
  assert.equal(result.id, '20261001');
  assert.equal(result.date, '2026-10-01T10:00:00+08:00');
  assert.equal(result.description, '新导语');

  const withoutDate = draft({ title: '复利', description: '导语', tags: 'AI' });
  assert.equal(preparePost(withoutDate, { posts: [existing], existing, now: NOW }).date, '2026-10-01T10:00:00+08:00');

  const backdated = draft({ title: '复利', date: '2026-09-30 08:00', description: '导语', tags: 'AI' });
  assert.equal(preparePost(backdated, { posts: [existing], existing, now: NOW }).date, '2026-09-30T08:00:00+08:00');

  const renamed = draft({ title: '复利', description: '导语', tags: 'AI', slug: 'compound' });
  assert.match(problemsOf(() => preparePost(renamed, { posts: [existing], existing, now: NOW }))[0], /不能改网址/);
});

test('看不懂的日期不发布', () => {
  const problems = problemsOf(() => preparePost(draft({ title: 't', date: '十月十四', description: 'd', tags: 'AI' }), { posts: [], now: NOW }));
  assert.match(problems[0], /发布时间的格式不对/);
});

test('[[ ]] 链接换成站内地址，代码里的不动', () => {
  const posts = [post('20261001', '复利'), post('compound', 'Compound Interest')];
  const body = [
    '看 [[复利]]、[[compound|这篇]] 和 [[compound interest#为什么 重要？]]。`[[复利]]`',
    '',
    '```',
    '[[复利]]',
    '```',
  ].join('\n');
  const result = rewriteLinks(body, posts);
  assert.deepEqual(result.problems, []);
  assert.equal(
    result.body,
    [
      '看 [复利](/posts/20261001/)、[这篇](/posts/compound/) 和 [Compound Interest](/posts/compound/#为什么-重要)。`[[复利]]`',
      '',
      '```',
      '[[复利]]',
      '```',
    ].join('\n'),
  );
});

test('链接写错时说清楚，能猜到就提示最接近的标题', () => {
  const posts = [post('20261001', '复利')];
  const { problems } = rewriteLinks('[[复利的力量]] [[完全不相干]] [旧链接](/posts/nope/)', posts);
  assert.equal(problems.length, 3);
  assert.match(problems[0], /链接 \/posts\/nope\/ 指向的文章不存在/);
  assert.match(problems[1], /\[\[复利的力量\]\] 找不到，是不是想链接：「复利」/);
  assert.match(problems[2], /\[\[完全不相干\]\] 找不到这篇文章/);
  assert.deepEqual(problemsOf(() => preparePost(draft({ title: 't', description: 'd', tags: 'AI' }, '[[完全不相干]]'), { posts, now: NOW })).length, 1);
});

test('写出的 frontmatter 读回来一样', () => {
  const text = formatPost(
    { title: '他说"复利"', date: '2026-10-14T21:30:00+08:00', description: 'a: b', tags: ['AI', '财富'], slug: '' },
    '\n\n正文\n\n',
  );
  assert.equal(
    text,
    '---\ntitle: "他说\\"复利\\""\ndate: 2026-10-14T21:30:00+08:00\ndescription: "a: b"\ntags: ["AI", "财富"]\n---\n\n正文\n',
  );
  const doc = describe(text, { file: '/p/20261014.md', kind: 'post' });
  assert.equal(doc.title, '他说"复利"');
  assert.equal(doc.description, 'a: b');
  assert.deepEqual(doc.tags, ['AI', '财富']);
  assert.equal(doc.date, '2026-10-14T21:30:00+08:00');

  assert.match(formatPost({ title: 't', date: 'd', description: 'd', tags: ['AI'], slug: 'old-name' }, 'x'), /\nslug: "old-name"\n/);
  // 没写导语就不写这一行。
  assert.equal(
    formatPost({ title: '20261014', date: '2026-10-14T21:30:00+08:00', description: '', tags: ['AI'], slug: '' }, '正文'),
    '---\ntitle: "20261014"\ndate: 2026-10-14T21:30:00+08:00\ntags: ["AI"]\n---\n\n正文\n',
  );
});

test('只改正文，跳过代码块和行内代码', () => {
  const text = 'a\n```js\na\n```\n`a` a\n~~~\na\n~~~';
  assert.equal(mapProse(text, (prose) => prose.replaceAll('a', 'b')), 'b\n```js\na\n```\n`a` b\n~~~\na\n~~~');
});

test('本地图片复制到 public/images/<地址>/，路径改好', async () => {
  const drafts = path.join(temp, 'drafts');
  const images = path.join(temp, 'images', '20261014');
  await mkdir(drafts, { recursive: true });
  await writeFile(path.join(drafts, 'pic.png'), 'png');
  await writeFile(path.join(drafts, 'My Pic.JPG'), 'jpg');
  const body = [
    '![a](pic.png)',
    '![b](<My Pic.JPG> "说明")',
    '![c](https://example.com/c.png)',
    '![d](/images/old/d.png)',
    '![e](missing.png)',
    '![f](./pic.png)',
    '`![g](pic.png)`',
  ].join('\n');
  const result = await planImages(body, { id: '20261014', baseDir: drafts, imagesDir: images });
  assert.deepEqual(result.problems, ['找不到图片：missing.png']);
  assert.deepEqual(
    result.copies.map((copy) => [path.basename(copy.from), path.relative(temp, copy.to)]),
    [
      ['pic.png', 'images/20261014/pic.png'],
      ['My Pic.JPG', 'images/20261014/my-pic.jpg'],
    ],
  );
  assert.equal(
    result.body,
    [
      '![a](/images/20261014/pic.png)',
      '![b](/images/20261014/my-pic.jpg "说明")',
      '![c](https://example.com/c.png)',
      '![d](/images/old/d.png)',
      '![e](missing.png)',
      '![f](/images/20261014/pic.png)',
      '`![g](pic.png)`',
    ].join('\n'),
  );
});

test('拖进终端的图片路径', async () => {
  const file = path.join(temp, 'my photo.png');
  await writeFile(file, 'png');
  assert.equal(droppedImagePath(`'${file}'`), file);
  assert.equal(droppedImagePath(file.replace(/ /g, '\\ ')), file);
  assert.equal(droppedImagePath(`${file}\n`), file);
  assert.equal(droppedImagePath(path.join(temp, 'nope.png')), null);
  assert.equal(droppedImagePath('一段普通文字'), null);
  assert.equal(droppedImagePath(`${file}\n${file}`), null);
});

test('构建失败时只留下出错原因', () => {
  const mdx = [
    '\x1b[2m17:50:26\x1b[22m [build] Building static entrypoints...',
    '\x1b[31m\x1b[1m17:50:27\x1b[22m [ERROR] [vite]\x1b[39m \x1b[31m✗\x1b[39m Build failed in 491ms',
    '8:1: Expected a closing tag for `<div>` (8:1) before the end of `paragraph` (mdx-jsx:unexpected-character)',
    '  \x1b[1mLocation:\x1b[22m',
    '    \x1b[4m/tmp/blog/src/content/posts/broken.mdx:8:1\x1b[24m',
    '  \x1b[1mStack trace:\x1b[22m',
    '    at TransformPluginContextImpl.handler (file:///blog/node_modules/@astrojs/mdx/dist/vite-plugin-mdx.js:64:17)',
  ].join('\n');
  assert.deepEqual(buildErrors(mdx), [
    '8:1: Expected a closing tag for `<div>` (8:1) before the end of `paragraph` (mdx-jsx:unexpected-character)',
  ]);

  const link = [
    '17:50:46 [build] Rearranging server assets...',
    '',
    ' generating static routes ',
    '文章 20261015-3 链接到了不存在的文章 /posts/nope/',
    '  Location:',
    '    /blog/node_modules/astro/dist/core/render/route-cache.js:32:17',
    '  Stack trace:',
    '    at getBacklinks (file:///blog/dist/.prerender/chunks/posts.mjs:744:28)',
  ].join('\n');
  assert.deepEqual(buildErrors(link), ['文章 20261015-3 链接到了不存在的文章 /posts/nope/']);
});

test('用其他软件打开：设置了 MYBLOG_EDITOR 就用它，没设置就用系统里默认打开 .md 的软件', () => {
  const file = "/博客/草稿/it's 1.md";
  assert.deepEqual(outsideEditor(file, { env: {}, platform: 'darwin' }), { command: 'open', args: [file] });
  assert.deepEqual(outsideEditor(file, { env: {}, platform: 'linux' }), { command: 'xdg-open', args: [file] });
  assert.deepEqual(outsideEditor(file, { env: {}, platform: 'win32' }), { command: 'explorer', args: [file] });
  assert.equal(outsideEditor(file, { env: { MYBLOG_EDITOR: '  ' }, platform: 'darwin' }).command, 'open');

  const typora = outsideEditor(file, { env: { MYBLOG_EDITOR: ' open -a Typora ' }, platform: 'darwin' });
  assert.equal(typora.custom, 'open -a Typora');
  assert.equal(typora.command, `open -a Typora '/博客/草稿/it'\\''s 1.md'`);
  // 路径里有空格、引号也能原样交给命令。
  const echo = outsideEditor(file, { env: { MYBLOG_EDITOR: "printf '%s'" }, platform: 'linux' });
  assert.equal(execSync(echo.command, { encoding: 'utf8' }), file);
});
