// 发布流程里的纯函数。不要在这里调用 publishDraft：它会写进真实的 src/content/posts，还会跑构建。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BlogError,
  extractHeadingTitle,
  formatFrontmatter,
  parseFrontmatter,
  parseTags,
  removeDuplicateTitle,
  rewritePostLinks,
  validateDraftMetadata,
} from '../scripts/blog-core.mjs';

test('parseFrontmatter collects block-style tags into a list', () => {
  const metadata = parseFrontmatter(['title: 复利', 'tags:', '  - 投资', '  - "长期主义"', 'slug: compound'].join('\n'));

  assert.deepEqual(metadata.tags, ['投资', '"长期主义"']);
  assert.equal(metadata.slug, 'compound');
  assert.deepEqual(parseTags(metadata.tags), ['投资', '长期主义']);
});

test('parseFrontmatter treats empty values as missing', () => {
  const metadata = parseFrontmatter(['title:', 'description:', 'tags: []', 'slug:'].join('\n'));

  assert.deepEqual(metadata, { tags: '[]' });
  assert.deepEqual(parseTags(metadata.tags), []);
});

test('parseTags reads inline lists and plain comma-separated values', () => {
  assert.deepEqual(parseTags('["写作", "精选"]'), ['写作', '精选']);
  assert.deepEqual(parseTags('写作, 精选, 写作'), ['写作', '精选']);
  assert.deepEqual(parseTags(undefined), []);
});

test('formatFrontmatter keeps slug and omits it when empty', () => {
  const base = {
    category: 'Daily',
    date: '2026-10-14',
    description: '一句导语',
    draft: false,
    tags: ['投资'],
    title: '复利只发生在长期游戏里',
  };

  assert.match(formatFrontmatter({ ...base, slug: 'compound' }), /^slug: "compound"$/m);
  assert.doesNotMatch(formatFrontmatter({ ...base, slug: '' }), /^slug:/m);

  const roundTrip = parseFrontmatter(formatFrontmatter({ ...base, slug: 'compound' }).replace(/^---\n|\n---$/g, ''));
  assert.equal(roundTrip.slug, '"compound"');
  assert.deepEqual(parseTags(roundTrip.tags), ['投资']);
});

test('title falls back to the first "# heading" and is removed from the body', () => {
  const body = '\n# 想清楚之前，先写下来\n\n第一段。\n';

  assert.equal(extractHeadingTitle(body), '想清楚之前，先写下来');
  assert.equal(extractHeadingTitle('第一段。\n\n# 不是第一行'), '');

  const { title } = validateDraftMetadata({ description: '一句导语' }, body);
  assert.equal(title, '想清楚之前，先写下来');
  assert.equal(removeDuplicateTitle(body, title), '第一段。\n');
});

test('publishing is rejected without a title or description', () => {
  assert.throws(() => validateDraftMetadata({ description: '一句导语' }, '只有正文。'), BlogError);
  assert.throws(() => validateDraftMetadata({ title: '标题' }, '正文。'), /description/);
  assert.throws(() => validateDraftMetadata({ title: '标题', description: '""' }, '正文。'), /description/);
});

test('slug must be lowercase letters, numbers and hyphens', () => {
  assert.equal(validateDraftMetadata({ title: 'a', description: 'b', slug: '"long-game"' }, '').slug, 'long-game');
  assert.throws(() => validateDraftMetadata({ title: 'a', description: 'b', slug: 'Long Game' }, ''), /slug/);
});

test('rewritePostLinks turns YYYYMMDD.md and [[YYYYMMDD]] links into site URLs', () => {
  const targets = new Map([
    ['20261014', { id: 'compound', title: '复利只发生在长期游戏里' }],
    ['20261009', { id: '20261009', title: '想清楚之前，先写下来' }],
  ]);
  const content = [
    '见[复利](20261014.md)和[写作](../posts/20261009.md#第二步)。',
    '还有[[20261014]]、[[20261009|这篇]]、[[20261009#第一步：写下结论]]。',
    '外链[不改](https://example.com/20261014.md)，图片![[20261014.png]]也不改。',
    '```md',
    '[[20261014]]',
    '```',
  ].join('\n');

  assert.equal(
    rewritePostLinks(content, targets),
    [
      '见[复利](/posts/compound/)和[写作](/posts/20261009/#第二步)。',
      '还有[复利只发生在长期游戏里](/posts/compound/)、[这篇](/posts/20261009/)、[想清楚之前，先写下来](/posts/20261009/#第一步写下结论)。',
      '外链[不改](https://example.com/20261014.md)，图片![[20261014.png]]也不改。',
      '```md',
      '[[20261014]]',
      '```',
    ].join('\n'),
  );
});

test('rewritePostLinks stops when the linked post does not exist', () => {
  assert.throws(() => rewritePostLinks('见[[20200101]]。', new Map()), /20200101/);
  assert.throws(() => rewritePostLinks('见[旧文](./20200101.md)。', new Map()), BlogError);
});
