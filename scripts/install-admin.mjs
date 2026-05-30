#!/usr/bin/env node
import { constants } from 'node:fs';
import { access, chmod, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const adminPath = path.join(projectRoot, 'scripts/admin.mjs');
const commandName = 'myblog';
const oldCommandName = 'blog-admin';
const installDir = await chooseInstallDir();
const commandPath = path.join(installDir, commandName);
const oldCommandPath = path.join(installDir, oldCommandName);
const wrapper = `#!/bin/sh
exec /usr/bin/env node "${adminPath}" "$@"
`;

await mkdir(installDir, { recursive: true });
await writeFile(commandPath, wrapper, 'utf8');
await chmod(commandPath, 0o755);
await removeOldCommand();

console.log(`已安装：${commandPath}`);
console.log('现在可以在任意目录运行：myblog');

if (!isOnPath(installDir)) {
  console.log(`注意：${installDir} 当前不在 PATH 中，需要加入 shell 配置后才能直接运行。`);
}

async function chooseInstallDir() {
  if (process.env.BLOG_ADMIN_INSTALL_DIR) {
    return process.env.BLOG_ADMIN_INSTALL_DIR;
  }

  const commonCandidates = [
    '/opt/homebrew/bin',
    '/usr/local/bin',
    path.join(os.homedir(), '.local/bin'),
    path.join(os.homedir(), 'bin'),
  ];

  for (const candidate of commonCandidates) {
    if (await isWritable(candidate)) {
      return candidate;
    }
  }

  for (const candidate of process.env.PATH.split(path.delimiter)) {
    if (!candidate) continue;
    const normalized = path.resolve(candidate);
    if (normalized.includes(`${path.sep}node_modules${path.sep}`)) continue;
    if (['/bin', '/sbin', '/usr/bin', '/usr/sbin'].includes(normalized)) continue;

    if (await isWritable(candidate)) {
      return candidate;
    }
  }

  return path.join(os.homedir(), '.local/bin');
}

async function isWritable(directory) {
  try {
    await access(directory, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function isOnPath(directory) {
  return process.env.PATH.split(path.delimiter).includes(directory);
}

async function removeOldCommand() {
  try {
    const current = await readFile(oldCommandPath, 'utf8');
    if (current.includes(adminPath)) {
      await unlink(oldCommandPath);
      console.log(`已移除旧命令：${oldCommandPath}`);
    }
  } catch {
    // Old command does not exist or is not readable. Nothing to clean up.
  }
}
