import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  BlogError,
  buildErrors,
  describe,
  droppedImagePath,
  formatPost,
  headingTitle,
  isBlankDraft,
  mapProse,
  missingFields,
  nextPostId,
  normalizeDate,
  parseTags,
  planImages,
  preparePost,
  rewriteLinks,
  splitFrontmatter,
  unquote,
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
});

test('引号、主题的各种写法', () => {
  assert.equal(unquote('"他说\\"好\\""'), '他说"好"');
  assert.equal(unquote("'it''s'"), "it's");
  assert.equal(unquote('  不带引号  '), '不带引号');
  assert.equal(unquote(undefined), '');

  for (const value of ['[AI, 财富]', 'AI, 财富', 'AI，财富', 'AI、财富', '["AI", "财富", "AI"]', ['AI', '财富']]) {
    assert.deepEqual(parseTags(value), ['AI', '财富'], String(value));
  }
  assert.deepEqual(parseTags(''), []);
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

test('列表里提示草稿缺什么', () => {
  const doc = describe('---\ntitle: \ndescription: 有\ntags: \n---\n\n', { file: '/d/a.md', kind: 'draft' });
  assert.deepEqual(missingFields(doc), ['标题', '主题']);
  assert.deepEqual(missingFields(describe('# 标题\n', { file: '/d/b.md', kind: 'draft' })), ['导语', '主题']);
});

test('空骨架草稿算没写', () => {
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

test('同一天第二篇起加 -2、-3', () => {
  assert.equal(nextPostId('20261014', []), '20261014');
  assert.equal(nextPostId('20261014', [post('20261014', 'a'), post('20261014-2', 'b')]), '20261014-3');
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
  assert.equal(problems.length, 4);
  assert.match(problems[0], /^缺标题/);
  assert.match(problems[1], /^缺导语/);
  assert.match(problems[2], /^缺主题/);
  assert.match(problems[3], /正文还是空的/);
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
  assert.match(problemsOf(() => preparePost(renamed, { posts: [existing], existing, now: NOW }))[0], /不能改地址/);
});

test('看不懂的日期不发布', () => {
  const problems = problemsOf(() => preparePost(draft({ title: 't', date: '十月十四', description: 'd', tags: 'AI' }), { posts: [], now: NOW }));
  assert.match(problems[0], /date 的格式不对/);
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
