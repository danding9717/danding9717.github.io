import { GrokCliProvider, listGrokCliModels } from './grok-cli-provider.mjs';
import { MockProvider } from './mock-provider.mjs';
import { OpenAiProvider, defaultOpenAiModel, hasOpenAiApiKey } from './openai-provider.mjs';
import { XaiProvider, defaultApiModel, hasXaiApiKey } from './xai-provider.mjs';

export { defaultApiModel, defaultOpenAiModel, hasOpenAiApiKey, hasXaiApiKey };

export const defaultMockModel = 'mock-writer';
export const defaultCliModel = '';
export const aiProviderModes = {
  mock: 'mock',
  openai: 'openai',
  xai: 'xai',
  apiKey: 'xai',
  grokCli: 'grok-cli',
};

export const aiConnectionModes = aiProviderModes;

export function normalizeAiProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (provider === 'mock') return aiProviderModes.mock;
  if (provider === 'openai' || provider === 'openai-api-key') return aiProviderModes.openai;
  if (provider === 'grok-cli' || provider === 'grok') return aiProviderModes.grokCli;
  if (provider === 'api-key' || provider === 'xai' || provider === 'xai-api-key') {
    return aiProviderModes.xai;
  }
  return normalizeEnvProvider();
}

export function normalizeAiConnection(value) {
  return normalizeAiProvider(value);
}

export function normalizeEnvProvider() {
  return normalizeExplicitProvider(process.env.AI_PROVIDER || process.env.DANTE_PROVIDER);
}

function normalizeExplicitProvider(value) {
  const provider = String(value ?? '').trim().toLowerCase();
  if (provider === 'mock') return aiProviderModes.mock;
  if (provider === 'openai' || provider === 'openai-api-key') return aiProviderModes.openai;
  if (provider === 'grok-cli' || provider === 'grok') return aiProviderModes.grokCli;
  if (provider === 'api-key' || provider === 'xai' || provider === 'xai-api-key') {
    return aiProviderModes.xai;
  }
  return aiProviderModes.mock;
}

export function normalizeAiModel(value, provider = aiProviderModes.mock) {
  const model = String(value ?? '').trim();
  if (model) return model;

  const normalizedProvider = normalizeAiProvider(provider);
  if (normalizedProvider === aiProviderModes.openai) return process.env.OPENAI_MODEL || defaultOpenAiModel;
  if (normalizedProvider === aiProviderModes.xai) return process.env.XAI_MODEL || defaultApiModel;
  if (normalizedProvider === aiProviderModes.mock) return defaultMockModel;
  return defaultCliModel;
}

export function resolveModelForAction({ actionId, model, provider } = {}) {
  const explicitModel = String(model ?? '').trim();
  if (explicitModel) return explicitModel;

  const normalizedProvider = normalizeAiProvider(provider);
  if (normalizedProvider === aiProviderModes.openai) return openAiModelForAction(actionId);
  if (normalizedProvider === aiProviderModes.xai) return xaiModelForAction(actionId);
  return normalizeAiModel('', normalizedProvider);
}

export function aiProviderLabel(provider) {
  const normalizedProvider = normalizeAiProvider(provider);
  if (normalizedProvider === aiProviderModes.grokCli) return 'Grok CLI login';
  if (normalizedProvider === aiProviderModes.openai) return 'OpenAI API key';
  if (normalizedProvider === aiProviderModes.xai) return 'XAI_API_KEY';
  return 'Mock provider';
}

export function aiConnectionLabel(provider) {
  return aiProviderLabel(provider);
}

export function assistantConnectionStatus({ cliDefaultModel = '', connection, model, provider } = {}) {
  const normalizedProvider = normalizeAiProvider(provider ?? connection);
  const resolvedModel = normalizeAiModel(model, normalizedProvider);
  if (normalizedProvider === aiProviderModes.mock) return `Mock · ${resolvedModel}`;
  if (normalizedProvider === aiProviderModes.grokCli) {
    return `Grok CLI · ${resolvedModel || cliDefaultModel || 'default'}`;
  }
  if (normalizedProvider === aiProviderModes.openai) {
    return hasOpenAiApiKey() ? `OpenAI · ${resolvedModel}` : 'OpenAI API key missing.';
  }
  if (hasXaiApiKey()) return `xAI · ${resolvedModel}`;
  return 'XAI_API_KEY missing. Run /connect or choose Mock.';
}

export function createModelProvider(provider) {
  const normalizedProvider = normalizeAiProvider(provider);
  if (normalizedProvider === aiProviderModes.grokCli) return new GrokCliProvider();
  if (normalizedProvider === aiProviderModes.openai) return new OpenAiProvider();
  if (normalizedProvider === aiProviderModes.xai) return new XaiProvider();
  return new MockProvider();
}

export function hasApiKeyConnection(provider) {
  const normalizedProvider = normalizeAiProvider(provider);
  if (normalizedProvider === aiProviderModes.openai) return hasOpenAiApiKey();
  if (normalizedProvider === aiProviderModes.xai) return hasXaiApiKey();
  return hasOpenAiApiKey() || hasXaiApiKey();
}

export async function listKnownModels({ connection, provider, selectedModel } = {}) {
  const normalizedProvider = normalizeAiProvider(provider ?? connection);
  const selected = String(selectedModel ?? '').trim();
  if (normalizedProvider === aiProviderModes.mock) {
    return [
      {
        description: 'Local deterministic provider for offline tests',
        id: defaultMockModel,
        name: 'Mock Writer',
      },
    ];
  }

  if (normalizedProvider === aiProviderModes.grokCli) {
    const cliModels = await listGrokCliModels();
    const filteredCliModels = cliModels.filter((model) => model.id !== defaultApiModel);
    return filteredCliModels.length
      ? filteredCliModels
      : cliModels.length
        ? []
        : [{ description: 'Grok CLI default', id: 'grok-build', name: 'Grok Build' }];
  }

  if (normalizedProvider === aiProviderModes.openai) {
    return uniqueModels([
      {
        description: 'OpenAI Responses API default model (requires OPENAI_API_KEY)',
        id: process.env.OPENAI_MODEL || defaultOpenAiModel,
        name: process.env.OPENAI_MODEL || 'GPT-5.5',
      },
      {
        description: 'Fast OpenAI model for title, summary, and light editing',
        id: process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel,
        name: process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel,
      },
      {
        description: 'Deep OpenAI model for long drafts and critique',
        id: process.env.OPENAI_DEEP_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel,
        name: process.env.OPENAI_DEEP_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel,
      },
      selected && { description: 'Custom OpenAI model', id: selected, name: selected },
    ]);
  }

  const models = uniqueModels([
    {
      description: 'xAI Responses API (requires XAI_API_KEY)',
      id: defaultApiModel,
      name: 'Grok 4.3',
    },
    {
      description: 'Fast xAI model for title, summary, and light editing',
      id: process.env.XAI_FAST_MODEL || process.env.XAI_MODEL || defaultApiModel,
      name: process.env.XAI_FAST_MODEL || process.env.XAI_MODEL || defaultApiModel,
    },
    {
      description: 'Deep xAI model for long drafts and critique',
      id: process.env.XAI_DEEP_MODEL || process.env.XAI_MODEL || defaultApiModel,
      name: process.env.XAI_DEEP_MODEL || process.env.XAI_MODEL || defaultApiModel,
    },
    selected && { description: 'Custom xAI model', id: selected, name: selected },
  ]);
  return models;
}

function openAiModelForAction(actionId) {
  if (isFastAction(actionId)) {
    return process.env.OPENAI_FAST_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel;
  }
  if (isDeepAction(actionId)) {
    return process.env.OPENAI_DEEP_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel;
  }
  return process.env.OPENAI_DEFAULT_MODEL || process.env.OPENAI_MODEL || defaultOpenAiModel;
}

function xaiModelForAction(actionId) {
  if (isFastAction(actionId)) {
    return process.env.XAI_FAST_MODEL || process.env.XAI_MODEL || defaultApiModel;
  }
  if (isDeepAction(actionId)) {
    return process.env.XAI_DEEP_MODEL || process.env.XAI_MODEL || defaultApiModel;
  }
  return process.env.XAI_DEFAULT_MODEL || process.env.XAI_MODEL || defaultApiModel;
}

function isFastAction(actionId) {
  return ['compress', 'polish', 'rewrite', 'summary', 'title', 'tweet'].includes(String(actionId));
}

function isDeepAction(actionId) {
  return ['critic', 'draft'].includes(String(actionId));
}

function uniqueModels(models) {
  return models
    .filter(Boolean)
    .filter((model, index, list) => list.findIndex((item) => item.id === model.id) === index);
}
