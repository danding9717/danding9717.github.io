#!/usr/bin/env node
import {
  BlogError,
  compactDateForToday,
  createDraft,
  formatNoteRows,
  listNotes,
  normalizeCompactDate,
  publishDraft,
} from './blog-core.mjs';

const [, , command, ...rawArgs] = process.argv;
const args = rawArgs.filter((arg) => !arg.startsWith('--'));
const flags = new Set(rawArgs.filter((arg) => arg.startsWith('--')));

async function main() {
  switch (command) {
    case 'today': {
      const result = await createDraft(compactDateForToday(), { open: !shouldSkipOpen() });
      printMessages(result.messages);
      break;
    }
    case 'new': {
      const result = await createDraft(normalizeCompactDate(args[0]), {
        open: !shouldSkipOpen(),
      });
      printMessages(result.messages);
      break;
    }
    case 'list':
      console.log(formatNoteRows(await listNotes()));
      break;
    case 'publish': {
      const result = await publishDraft(normalizeCompactDate(args[0]));
      printMessages(result.messages);
      break;
    }
    default:
      printHelp();
      process.exitCode = command ? 1 : 0;
  }
}

function shouldSkipOpen() {
  return flags.has('--no-open') || process.env.BLOG_NO_OPEN === '1' || Boolean(process.env.CI);
}

function printMessages(messages) {
  for (const message of messages) {
    console.log(message);
  }
}

function printHelp() {
  console.log(`用法：
  npm run note:today
  npm run note:new -- 20260529
  npm run note:list
  npm run note:publish -- 20260529

环境变量：
  BLOG_NO_OPEN=1       创建草稿后不自动打开
  BLOG_EDITOR=Typora   指定打开草稿的编辑器
  BLOG_TIMEZONE=Asia/Shanghai
`);
}

main().catch((error) => {
  if (error instanceof BlogError) {
    console.error(error.message);
    if (error.details) {
      console.error(error.details);
    }
    process.exit(error.status);
  }

  console.error(error);
  process.exit(1);
});
