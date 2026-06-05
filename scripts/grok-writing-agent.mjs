import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { runWritingAgent, streamWritingAgent } from './writing-agent/agents.mjs';
import {
  canReplaceWithAction,
  getWritingAssistantAction,
  getWritingAssistantActionByCommand,
  writingAssistantActions,
} from './writing-agent/prompts.mjs';
import {
  aiConnectionLabel,
  aiConnectionModes,
  aiProviderLabel,
  aiProviderModes,
  assistantConnectionStatus,
  defaultApiModel,
  defaultCliModel,
  defaultMockModel,
  defaultOpenAiModel,
  hasApiKeyConnection,
  hasOpenAiApiKey,
  hasXaiApiKey,
  listKnownModels,
  normalizeAiConnection,
  normalizeAiModel,
  normalizeAiProvider,
} from './writing-agent/providers.mjs';
import {
  isKnownGrokCliModel,
  refreshGrokCliModels,
  runGrokLogin,
} from './writing-agent/grok-cli-provider.mjs';

const maxStyleSampleCharacters = 12000;

export {
  aiConnectionLabel,
  aiConnectionModes,
  aiProviderLabel,
  aiProviderModes,
  assistantConnectionStatus,
  canReplaceWithAction,
  defaultApiModel,
  defaultCliModel,
  defaultMockModel,
  defaultOpenAiModel,
  getWritingAssistantAction,
  getWritingAssistantActionByCommand,
  hasApiKeyConnection,
  hasOpenAiApiKey,
  hasXaiApiKey,
  isKnownGrokCliModel,
  normalizeAiConnection,
  normalizeAiModel,
  normalizeAiProvider,
  refreshGrokCliModels,
  runGrokLogin,
  writingAssistantActions,
};

export async function listKnownGrokModels({ connection, provider, selectedModel } = {}) {
  return listKnownModels({ connection, provider, selectedModel });
}

export async function repairAiModelForConnection({ connection, provider, model } = {}) {
  const normalizedProvider = normalizeAiProvider(provider ?? connection);
  const selectedModel = String(model ?? '').trim();
  if (!selectedModel) {
    return { changed: false, model: selectedModel };
  }

  if (normalizedProvider === aiProviderModes.openai) {
    if (selectedModel === defaultApiModel || selectedModel === defaultMockModel) {
      return { changed: true, model: '' };
    }
    return { changed: false, model: selectedModel };
  }

  if (normalizedProvider === aiProviderModes.xai) {
    if (selectedModel === defaultOpenAiModel || selectedModel === defaultMockModel) {
      return { changed: true, model: '' };
    }
    return { changed: false, model: selectedModel };
  }

  if (normalizedProvider !== aiProviderModes.grokCli) {
    return { changed: false, model: selectedModel };
  }

  if (selectedModel === defaultApiModel || selectedModel === defaultOpenAiModel) {
    return { changed: true, model: '' };
  }

  if (await isKnownGrokCliModel(selectedModel)) {
    return { changed: false, model: selectedModel };
  }

  return { changed: true, model: '' };
}

export async function loadWritingStyleSamples(projectRoot) {
  const postsDir = path.join(projectRoot, 'src/content/posts');
  let files = [];

  try {
    files = (await readdir(postsDir))
      .filter((file) => /\.(md|mdx)$/i.test(file))
      .sort((a, b) => b.localeCompare(a));
  } catch {
    return '';
  }

  const samples = [];
  let totalCharacters = 0;

  for (const file of files) {
    if (totalCharacters >= maxStyleSampleCharacters) break;

    const filePath = path.join(postsDir, file);
    const rawContent = await readFile(filePath, 'utf8');
    const { body, frontmatter } = splitMarkdownFrontmatter(rawContent);
    const content = [`File: ${file}`, frontmatter ? `Frontmatter:\n${frontmatter}` : '', body.trim()]
      .filter(Boolean)
      .join('\n\n');
    const remaining = maxStyleSampleCharacters - totalCharacters;
    const sample = content.slice(0, remaining);
    samples.push(sample);
    totalCharacters += sample.length;
  }

  return samples.join('\n\n---\n\n');
}

export async function requestWritingAssistance({
  actionId,
  connection = aiProviderModes.mock,
  draftContent,
  model,
  projectRoot,
  prompt,
  provider,
  targetText = '',
  signal,
}) {
  const normalizedProvider = normalizeAiProvider(provider ?? connection);
  const styleSamples = await loadWritingStyleSamples(projectRoot);

  return runWritingAgent({
    command: actionId,
    documentText: draftContent,
    model,
    projectRoot,
    provider: normalizedProvider,
    signal,
    styleSamples,
    targetText,
    userInput: prompt,
  });
}

export async function* requestWritingAssistanceStream({
  actionId,
  connection = aiProviderModes.mock,
  draftContent,
  model,
  projectRoot,
  prompt,
  provider,
  signal,
  targetText = '',
}) {
  const normalizedProvider = normalizeAiProvider(provider ?? connection);
  const styleSamples = await loadWritingStyleSamples(projectRoot);

  yield* streamWritingAgent({
    command: actionId,
    documentText: draftContent,
    model,
    projectRoot,
    provider: normalizedProvider,
    signal,
    styleSamples,
    targetText,
    userInput: prompt,
  });
}

export function splitMarkdownFrontmatter(content) {
  const value = String(content ?? '');
  const match = value.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!match) return { body: value, frontmatter: '', opening: '' };

  return {
    body: value.slice(match[0].length),
    frontmatter: match[1],
    opening: match[0],
  };
}

export function replaceMarkdownBody(content, nextBody) {
  const { opening } = splitMarkdownFrontmatter(content);
  const normalizedBody = `${String(nextBody ?? '').trim()}\n`;
  return opening ? `${opening}${normalizedBody}` : normalizedBody;
}

export async function backupAndReplaceMarkdownBody(filePath, expectedContent, nextBody) {
  const nextContent = replaceMarkdownBody(expectedContent, nextBody);
  return backupAndWriteMarkdownContent(filePath, expectedContent, nextContent);
}

export async function backupAndWriteMarkdownContent(filePath, expectedContent, nextContent) {
  const currentContent = await readFile(filePath, 'utf8');
  if (currentContent !== expectedContent) {
    throw new Error('Draft changed on disk. Reload the draft before applying the AI result.');
  }

  const backupPath = backupFilePath(filePath);
  await mkdir(path.dirname(backupPath), { recursive: true });
  await copyFile(filePath, backupPath);
  await writeFile(filePath, String(nextContent ?? ''), 'utf8');

  return {
    backupPath,
    content: String(nextContent ?? ''),
  };
}

function backupFilePath(filePath) {
  const directory = path.dirname(filePath);
  const extension = path.extname(filePath);
  const baseName = path.basename(filePath, extension);
  return path.join(directory, `${baseName}.agent-backup-${formatLocalTimestamp(new Date())}${extension}`);
}

function formatLocalTimestamp(date) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}
