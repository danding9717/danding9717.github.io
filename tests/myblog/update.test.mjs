// 自动更新的测试：临时目录里一个本地的「GitHub」（裸仓库）、用户的博客，和另一个往 GitHub 合并 PR 的副本。
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { BlogError, applyUpdate, checkUpdate, codeVersion } from '../../scripts/myblog/blog.mjs';

const temp = await mkdtemp(path.join(os.tmpdir(), 'myblog-update-'));
after(() => rm(temp, { recursive: true, force: true }));

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function configure(root) {
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'commit.gpgsign', 'false');
}

let count = 0;

/** 用户的博客 root，和在 GitHub 上合并 PR 用的另一个副本 upstream。 */
async function makeBlogs() {
  const dir = path.join(temp, `case-${(count += 1)}`);
  const remote = path.join(dir, 'github.git');
  const root = path.join(dir, 'blog');
  await mkdir(path.join(root, 'scripts/myblog'), { recursive: true });
  git(dir, 'init', '-q', '--bare', '-b', 'main', remote);
  git(root, 'init', '-q', '-b', 'main');
  configure(root);
  git(root, 'remote', 'add', 'origin', remote);
  await writeFile(path.join(root, '.gitignore'), 'src/content/drafts/\n');
  await writeFile(path.join(root, 'scripts/myblog.mjs'), '// v1\n');
  await writeFile(path.join(root, 'scripts/myblog/blog.mjs'), '// v1\n');
  await writeFile(path.join(root, 'package-lock.json'), '{}\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'init');
  git(root, 'push', '-q', '-u', 'origin', 'main');
  const upstream = path.join(dir, 'upstream');
  git(dir, 'clone', '-q', remote, upstream);
  configure(upstream);
  return { root, upstream };
}

/** 在 upstream 上像 GitHub 那样合并一个 PR：分支上一个提交，再用 --no-ff 合并，合并提交的正文是 PR 标题。 */
async function mergePr(upstream, number, title, files) {
  git(upstream, 'checkout', '-q', '-b', `pr-${number}`);
  for (const [file, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(upstream, file)), { recursive: true });
    await writeFile(path.join(upstream, file), text);
  }
  git(upstream, 'add', '.');
  git(upstream, 'commit', '-q', '-m', title);
  git(upstream, 'checkout', '-q', 'main');
  git(upstream, 'merge', '-q', '--no-ff', `pr-${number}`, '-m', `Merge pull request #${number} from someone/pr-${number}`, '-m', title);
  git(upstream, 'push', '-q', 'origin', 'main');
}

test('检查更新：没有新的返回 null；合并了 PR 后返回 PR 的标题，本地文件不动', async () => {
  const { root, upstream } = await makeBlogs();
  assert.equal(await checkUpdate(root), null);

  await mergePr(upstream, 22, 'myblog：列表里标题后面直接显示时间', { 'scripts/myblog.mjs': '// v2\n' });
  await mergePr(upstream, 23, 'myblog：自动更新', { 'scripts/myblog/blog.mjs': '// v2\n' });
  const update = await checkUpdate(root);
  assert.deepEqual(update, { count: 2, titles: ['myblog：列表里标题后面直接显示时间', 'myblog：自动更新'] });
  assert.equal(await readFile(path.join(root, 'scripts/myblog.mjs'), 'utf8'), '// v1\n');
});

test('更新：拉下新版本，代码指纹变了，草稿还在；依赖没变就不装', async () => {
  const { root, upstream } = await makeBlogs();
  await mkdir(path.join(root, 'src/content/drafts'), { recursive: true });
  await writeFile(path.join(root, 'src/content/drafts/a.md'), '写到一半');
  const before = codeVersion(root);

  await mergePr(upstream, 22, '列表显示时间', { 'scripts/myblog.mjs': '// v2\n' });
  let installs = 0;
  const titles = await applyUpdate(root, { install: async () => (installs += 1) });
  assert.deepEqual(titles, ['列表显示时间']);
  assert.equal(await readFile(path.join(root, 'scripts/myblog.mjs'), 'utf8'), '// v2\n');
  assert.equal(await readFile(path.join(root, 'src/content/drafts/a.md'), 'utf8'), '写到一半');
  assert.notEqual(codeVersion(root), before);
  assert.equal(installs, 0);

  // 已经是最新的：什么都不做。
  assert.deepEqual(await applyUpdate(root, { install: async () => (installs += 1) }), []);

  // 只换了网址（比如以后用自己的域名）也算，myblog 要重启才会用新网址。
  const beforeDomain = codeVersion(root);
  await mergePr(upstream, 27, '换成自己的域名', { 'site.config.mjs': "export const SITE_URL = 'https://example.com';\n" });
  await applyUpdate(root, { install: async () => (installs += 1) });
  assert.notEqual(codeVersion(root), beforeDomain);
});

test('更新：package-lock.json 变了就重新装依赖；本地没推送的提交留着', async () => {
  const { root, upstream } = await makeBlogs();
  await writeFile(path.join(root, 'local.md'), '本地的提交\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', '发布：本地的');

  await mergePr(upstream, 24, '升级依赖', { 'package-lock.json': '{"v":2}\n' });
  const installed = [];
  assert.deepEqual(await applyUpdate(root, { install: async (dir) => installed.push(dir) }), ['升级依赖']);
  assert.deepEqual(installed, [root]);
  assert.equal(git(root, 'log', '-1', '--format=%s'), '发布：本地的');
});

test('更新：有改过、还没提交的文件时不更新，说清楚是哪个文件', async () => {
  const { root, upstream } = await makeBlogs();
  await writeFile(path.join(root, 'scripts/myblog.mjs'), '// 自己改的\n');
  await mergePr(upstream, 25, '新功能', { 'scripts/myblog/blog.mjs': '// v2\n' });

  await assert.rejects(applyUpdate(root, { install: async () => {} }), (error) => {
    assert.ok(error instanceof BlogError);
    assert.match(error.message, /scripts\/myblog\.mjs/);
    return true;
  });
  assert.equal(await readFile(path.join(root, 'scripts/myblog/blog.mjs'), 'utf8'), '// v1\n');
});

test('检查更新：不在 main 分支、或者连不上 GitHub 时当作没有', async () => {
  const { root, upstream } = await makeBlogs();
  await mergePr(upstream, 26, '新功能', { 'scripts/myblog.mjs': '// v2\n' });
  git(root, 'checkout', '-q', '-b', 'other');
  assert.equal(await checkUpdate(root), null);

  git(root, 'checkout', '-q', 'main');
  git(root, 'remote', 'set-url', 'origin', path.join(temp, 'missing.git'));
  assert.equal(await checkUpdate(root), null);
});
