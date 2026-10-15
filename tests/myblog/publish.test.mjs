// 发布流程的测试：每个测试在临时目录里建一个博客仓库和一个本地的「GitHub」（裸仓库），
// 构建换成假的，不碰真实的文章目录，也不会推送到 GitHub。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import {
  BlogError,
  createDraft,
  joinDocument,
  listDocs,
  publish,
  pushPending,
  splitDocument,
  unpushedCount,
  writeFields,
} from '../../scripts/myblog/blog.mjs';

// 北京时间 2026-10-14 21:30:00
const NOW = new Date('2026-10-14T13:30:00Z');
const temp = await mkdtemp(path.join(os.tmpdir(), 'myblog-publish-'));
after(() => rm(temp, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

let blogCount = 0;

/** 一个推送到本地裸仓库的博客，main 上有一个初始提交。 */
async function makeBlog() {
  const dir = path.join(temp, `blog-${(blogCount += 1)}`);
  const remote = path.join(dir, 'github.git');
  const root = path.join(dir, 'blog');
  await mkdir(root, { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main');
  configure(root);
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, '.gitignore'), 'src/content/drafts/\n');
  await writeFile(path.join(root, 'README.md'), 'blog\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  return { dir, remote, root };
}

function configure(root) {
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
}

function draftText(title, body, extra = '') {
  return `---\ntitle: ${title}\ndescription: ${title}的导语\ntags: AI, 生意\n${extra}---\n\n${body}\n`;
}

async function writeDraft(root, text, now = NOW) {
  const file = await createDraft(root, now);
  await writeFile(file, text, 'utf8');
  const { drafts } = await listDocs(root);
  return drafts.find((doc) => doc.file === file);
}

const okBuild = async () => {};

test('连发 3 篇：每篇都推送到 GitHub，草稿删掉，链接和顺序都对', async () => {
  const blog = await makeBlog();
  const titles = ['复利不只是钱的事', '第二篇的观点', '第三篇的观点'];
  const bodies = ['第一篇。', `接着 [[${titles[0]}]] 往下说。`, `同时提到 [[${titles[0]}]] 和 [[${titles[1]}|上一篇]]。`];
  const built = [];

  for (let index = 0; index < 3; index += 1) {
    const now = new Date(NOW.getTime() + index * 60_000);
    const doc = await writeDraft(blog.root, draftText(titles[index], bodies[index]), now);
    const steps = [];
    const result = await publish(doc, {
      root: blog.root,
      now,
      build: async (root) => built.push(root),
      onStep: (step) => steps.push(step),
    });
    assert.deepEqual(steps, ['sync', 'check', 'build', 'push']);
    assert.equal(result.pushed, true);
    assert.equal(result.updated, false);
    assert.equal(result.title, titles[index]);
    assert.equal(existsSync(doc.file), false, '草稿应该删掉了');
  }

  assert.deepEqual(built, [blog.root, blog.root, blog.root]);
  const { drafts, posts } = await listDocs(blog.root);
  assert.equal(drafts.length, 0);
  assert.deepEqual(
    posts.map((post) => [post.id, post.title]),
    [
      ['20261014-3', '第三篇的观点'],
      ['20261014-2', '第二篇的观点'],
      ['20261014', '复利不只是钱的事'],
    ],
  );

  const second = await readFile(path.join(blog.root, 'src/content/posts/20261014-2.md'), 'utf8');
  assert.equal(
    second,
    [
      '---',
      'title: "第二篇的观点"',
      'date: 2026-10-14T21:31:00+08:00',
      'description: "第二篇的观点的导语"',
      'tags: ["AI", "生意"]',
      '---',
      '',
      '接着 [复利不只是钱的事](/posts/20261014/) 往下说。',
      '',
    ].join('\n'),
  );
  const third = await readFile(path.join(blog.root, 'src/content/posts/20261014-3.md'), 'utf8');
  assert.match(third, /同时提到 \[复利不只是钱的事\]\(\/posts\/20261014\/\) 和 \[上一篇\]\(\/posts\/20261014-2\/\)。/);

  // GitHub 上多了 3 个提交，本地没有留下没提交、没推送的东西。
  assert.equal(git(blog.remote, 'log', '--format=%s', 'main'), ['发布：第三篇的观点', '发布：第二篇的观点', '发布：复利不只是钱的事', 'init'].join('\n'));
  assert.equal(git(blog.root, 'status', '--porcelain'), '');
  assert.equal(await unpushedCount(blog.root), 0);
});

test('只写了正文的草稿：发布页填的标题、导语、主题写进去就能发布', async () => {
  const blog = await makeBlog();
  const file = await createDraft(blog.root, NOW);
  assert.equal(await readFile(file, 'utf8'), '', '新草稿是空文件');
  await writeFile(file, '正文第一段。\n\n第二段。\n', 'utf8');

  // 发布页做的事：拆开，写进填的几项，拼回去存好。
  const { head, body } = splitDocument(await readFile(file, 'utf8'));
  const fields = { title: '只写正文', description: '一句导语', tags: ['AI', '精选'], slug: '' };
  await writeFile(file, joinDocument(writeFields(head, fields), body), 'utf8');

  const doc = (await listDocs(blog.root)).drafts.find((draft) => draft.file === file);
  const result = await publish(doc, { root: blog.root, now: NOW, build: okBuild });
  assert.equal(result.title, '只写正文');
  assert.equal(
    await readFile(path.join(blog.root, 'src/content/posts/20261014.md'), 'utf8'),
    '---\ntitle: "只写正文"\ndate: 2026-10-14T21:30:00+08:00\ndescription: "一句导语"\ntags: ["AI", "精选"]\n---\n\n正文第一段。\n\n第二段。\n',
  );
  assert.equal(existsSync(file), false);
});

test('缺东西时一条条列出来，不同步、不构建、不提交', async () => {
  const blog = await makeBlog();
  const doc = await writeDraft(blog.root, '---\ntitle: 只有标题\ndescription: \ntags: \n---\n\n看 [[不存在的文章]]\n');
  let built = false;
  const steps = [];
  await assert.rejects(
    publish(doc, { root: blog.root, now: NOW, build: async () => (built = true), onStep: (step) => steps.push(step) }),
    (error) => {
      assert.ok(error instanceof BlogError);
      assert.equal(error.message, '还不能发布：');
      assert.equal(error.problems.length, 3);
      assert.match(error.problems[0], /^缺导语/);
      assert.match(error.problems[1], /^缺主题/);
      assert.match(error.problems[2], /\[\[不存在的文章\]\] 找不到/);
      return true;
    },
  );
  assert.deepEqual(steps, []);
  assert.equal(built, false);
  assert.equal(existsSync(doc.file), true);
  assert.equal(git(blog.root, 'rev-list', '--count', 'HEAD'), '1');
});

test('构建失败时撤回文章和图片，草稿原样保留', async () => {
  const blog = await makeBlog();
  const drafts = path.join(blog.root, 'src/content/drafts');
  const doc = await writeDraft(blog.root, draftText('带图片的文章', '![图](pic.png)'));
  await writeFile(path.join(drafts, 'pic.png'), 'png');
  const before = await readFile(doc.file, 'utf8');

  await assert.rejects(
    publish(doc, {
      root: blog.root,
      now: NOW,
      build: async (root) => {
        // 构建的时候文章和图片都已经写好了。
        assert.equal(existsSync(path.join(root, 'src/content/posts/20261014.md')), true);
        assert.equal(existsSync(path.join(root, 'public/images/20261014/pic.png')), true);
        throw new BlogError('本地构建没通过，文章没有发出去：', ['some error']);
      },
    }),
    /本地构建没通过/,
  );

  assert.equal(await readFile(doc.file, 'utf8'), before);
  assert.equal(existsSync(path.join(blog.root, 'src/content/posts/20261014.md')), false);
  assert.equal(existsSync(path.join(blog.root, 'public/images/20261014/pic.png')), false);
  assert.equal(git(blog.root, 'status', '--porcelain'), '');
  assert.equal(git(blog.root, 'rev-list', '--count', 'HEAD'), '1');
});

test('图片随文章一起提交', async () => {
  const blog = await makeBlog();
  const drafts = path.join(blog.root, 'src/content/drafts');
  const doc = await writeDraft(blog.root, draftText('带图片的文章', '![图](pic.png)'));
  await writeFile(path.join(drafts, 'pic.png'), 'png');
  await publish(doc, { root: blog.root, now: NOW, build: okBuild });
  assert.equal(
    git(blog.remote, 'show', '--name-only', '--format=', 'main'),
    'public/images/20261014/pic.png\nsrc/content/posts/20261014.md',
  );
  assert.match(await readFile(path.join(blog.root, 'src/content/posts/20261014.md'), 'utf8'), /!\[图\]\(\/images\/20261014\/pic\.png\)/);
});

test('发布前先拿到 GitHub 上别处推送的提交', async () => {
  const blog = await makeBlog();
  const elsewhere = path.join(blog.dir, 'elsewhere');
  git(blog.dir, 'clone', '-q', blog.remote, elsewhere);
  configure(elsewhere);
  await writeFile(path.join(elsewhere, 'README.md'), 'changed on GitHub\n');
  git(elsewhere, 'commit', '-q', '-am', '在 GitHub 上改的');
  git(elsewhere, 'push', '-q', 'origin', 'main');

  // 本地还有一处没提交的改动，同步时不能丢。
  await writeFile(path.join(blog.root, 'notes.txt'), 'local\n');
  const doc = await writeDraft(blog.root, draftText('新文章', '正文。'));
  const result = await publish(doc, { root: blog.root, now: NOW, build: okBuild });

  assert.equal(result.pushed, true);
  assert.equal(await readFile(path.join(blog.root, 'README.md'), 'utf8'), 'changed on GitHub\n');
  assert.equal(git(blog.remote, 'log', '--format=%s', 'main'), '发布：新文章\n在 GitHub 上改的\ninit');
  assert.equal(git(blog.root, 'status', '--porcelain'), '?? notes.txt');
});

test('推送失败时文章留在本地的提交里，之后能补推', async () => {
  const blog = await makeBlog();
  const hook = path.join(blog.remote, 'hooks', 'pre-receive');
  await writeFile(hook, '#!/bin/sh\necho "rejected for test" >&2\nexit 1\n');
  await chmod(hook, 0o755);

  const doc = await writeDraft(blog.root, draftText('推不上去的文章', '正文。'));
  const result = await publish(doc, { root: blog.root, now: NOW, build: okBuild });
  assert.equal(result.pushed, false);
  assert.ok(result.problems.some((line) => line.includes('rejected for test')));
  assert.equal(existsSync(doc.file), false);
  assert.equal(await unpushedCount(blog.root), 1);

  await rm(hook);
  await pushPending(blog.root);
  assert.equal(await unpushedCount(blog.root), 0);
  assert.equal(git(blog.remote, 'log', '-1', '--format=%s', 'main'), '发布：推不上去的文章');
});

test('修改已发布的文章：原地更新，地址和日期不变', async () => {
  const blog = await makeBlog();
  const doc = await writeDraft(blog.root, draftText('复利', '旧正文。', 'slug: compound\n'));
  const first = await publish(doc, { root: blog.root, now: NOW, build: okBuild });
  assert.equal(first.id, 'compound');
  assert.equal(first.url.endsWith('/posts/compound/'), true);

  const [post] = (await listDocs(blog.root)).posts;
  assert.equal(path.basename(post.file), 'compound.md');
  const text = (await readFile(post.file, 'utf8')).replace('旧正文。', '新正文。');
  const later = new Date(NOW.getTime() + 86_400_000);
  const second = await publish({ ...post, text }, { root: blog.root, now: later, build: okBuild });
  assert.equal(second.updated, true);
  assert.equal(second.id, 'compound');

  const saved = await readFile(post.file, 'utf8');
  assert.match(saved, /\ndate: 2026-10-14T21:30:00\+08:00\n/);
  assert.match(saved, /新正文。/);
  assert.equal(git(blog.remote, 'log', '-1', '--format=%s', 'main'), '更新：复利');
  assert.equal((await listDocs(blog.root)).posts.length, 1);

  await assert.rejects(
    publish({ ...post, text: text.replace('---\n\n', 'slug: new-name\n---\n\n') }, { root: blog.root, now: later, build: okBuild }),
    /还不能发布/,
  );
});

test('不在 main 分支上时不发布', async () => {
  const blog = await makeBlog();
  git(blog.root, 'checkout', '-q', '-b', 'other');
  const doc = await writeDraft(blog.root, draftText('文章', '正文。'));
  await assert.rejects(publish(doc, { root: blog.root, now: NOW, build: okBuild }), /只从 main 发布/);
  assert.equal(existsSync(doc.file), true);
});
