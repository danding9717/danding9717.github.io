import {
  agentDefinitionForCommand,
  buildSystemPrompt,
  buildUserPrompt,
  getWritingAssistantAction,
  responseSchema,
} from './prompts.mjs';
import { createModelProvider, normalizeAiProvider, resolveModelForAction } from './providers.mjs';
import { isAbortError } from './streaming.mjs';

export async function runWritingAgent({
  command,
  documentText,
  model,
  projectRoot,
  provider,
  signal,
  styleSamples,
  targetText,
  userInput,
}) {
  let result = null;
  for await (const event of streamWritingAgent({
    command,
    documentText,
    model,
    projectRoot,
    provider,
    signal,
    styleSamples,
    targetText,
    userInput,
  })) {
    if (event.type === 'result') result = event.result;
  }
  if (!result) throw new Error('Writing agent did not return a result.');
  return result;
}

export async function* streamWritingAgent({
  command,
  documentText,
  model,
  projectRoot,
  provider,
  signal,
  styleSamples,
  targetText,
  userInput,
}) {
  const action = getWritingAssistantAction(command);
  const normalizedProvider = normalizeAiProvider(provider);
  const providerInstance = createModelProvider(normalizedProvider);
  const request = trimAgentRequest({
    command: action.id,
    documentText,
    styleSamples,
    targetText,
    userInput,
  });
  const systemPrompt = buildSystemPrompt(action.id);
  const userPrompt = buildUserPrompt(request);
  const resolvedModel = resolveModelForAction({
    actionId: action.id,
    model,
    provider: normalizedProvider,
  });
  const maxOutputTokens = maxOutputTokensForCommand(action.id);
  const telemetry = createTelemetry({
    actionId: action.id,
    model: resolvedModel,
    promptLength: systemPrompt.length + userPrompt.length,
    provider: normalizedProvider,
  });
  const context = {
    agent: agentDefinitionForCommand(action.id).agentName,
    projectRoot,
    request,
  };

  yield { telemetry: publicTelemetry(telemetry), type: 'telemetry' };
  yield { actionId: action.id, model: resolvedModel, provider: normalizedProvider, type: 'start' };

  let providerRaw = null;
  let providerText = '';
  let usage = null;

  try {
    const stream =
      typeof providerInstance.stream === 'function'
        ? providerInstance.stream({
            context,
            maxOutputTokens,
            model: resolvedModel,
            schema: responseSchema,
            signal,
            systemPrompt,
            userPrompt,
          })
        : fallbackProviderStream(
            providerInstance.generate({
              context,
              maxOutputTokens,
              model: resolvedModel,
              schema: responseSchema,
              signal,
              systemPrompt,
              userPrompt,
            }),
          );

    for await (const event of stream) {
      if (event.type === 'first_token') {
        telemetry.firstTokenTime = telemetry.firstTokenTime ?? Date.now();
        yield { telemetry: publicTelemetry(telemetry), type: 'first_token' };
        continue;
      }

      if (event.type === 'delta') {
        if (!telemetry.firstTokenTime && (event.text || event.displayText)) {
          telemetry.firstTokenTime = Date.now();
          yield { telemetry: publicTelemetry(telemetry), type: 'first_token' };
        }
        providerText += event.text ?? '';
        yield {
          text: event.displayText ?? event.text ?? '',
          telemetry: publicTelemetry(telemetry),
          type: 'delta',
        };
        continue;
      }

      if (event.type === 'usage') {
        usage = event.usage ?? usage;
        telemetry.usage = usage;
        yield { telemetry: publicTelemetry(telemetry), type: 'usage', usage };
        continue;
      }

      if (event.type === 'done') {
        providerText = event.text ?? providerText;
        providerRaw = event.raw ?? providerRaw;
        usage = event.usage ?? usage;
        telemetry.usage = usage;
      }
    }
  } catch (error) {
    telemetry.errorMessage = isAbortError(error) ? 'AI request was cancelled.' : String(error?.message ?? error);
    telemetry.totalDuration = Date.now() - telemetry.requestStartTime;
    yield { error: telemetry.errorMessage, telemetry: publicTelemetry(telemetry), type: 'error' };
    throw error;
  }

  const result = normalizeAgentResult(action.id, parseProviderResult(providerText, providerRaw));
  telemetry.totalDuration = Date.now() - telemetry.requestStartTime;
  telemetry.usage = usage;
  yield { result, telemetry: publicTelemetry(telemetry), type: 'result' };
}

function fallbackProviderStream(responsePromise) {
  return (async function* fallback() {
    const response = await responsePromise;
    yield { raw: response.raw, text: response.text, type: 'done', usage: response.usage };
  })();
}

export function maxOutputTokensForCommand(command) {
  const action = getWritingAssistantAction(command);
  return (
    {
      compress: 800,
      critic: 1200,
      draft: 3000,
      expand: 1200,
      idea: 700,
      outline: 1000,
      polish: 800,
      rewrite: 800,
      summary: 500,
      title: 300,
      tweet: 500,
    }[action.id] ?? 800
  );
}

export function trimAgentRequest({ command, documentText, styleSamples, targetText, userInput }) {
  const action = getWritingAssistantAction(command);
  const limits = contextLimitsForCommand(action.id);
  return {
    command: action.id,
    documentText: clipContext(documentText, limits.documentText),
    styleSamples: clipContext(styleSamples, limits.styleSamples),
    targetText: clipContext(targetText, limits.targetText),
    userInput: clipContext(userInput, limits.userInput),
  };
}

function contextLimitsForCommand(command) {
  if (['rewrite', 'polish', 'compress'].includes(command)) {
    return { documentText: 3000, styleSamples: 2500, targetText: 6000, userInput: 1200 };
  }
  if (command === 'expand') {
    return { documentText: 5000, styleSamples: 3000, targetText: 8000, userInput: 1500 };
  }
  if (command === 'draft') {
    return { documentText: 16000, styleSamples: 4000, targetText: 12000, userInput: 3000 };
  }
  if (['critic', 'summary'].includes(command)) {
    return { documentText: 12000, styleSamples: 2500, targetText: 8000, userInput: 1500 };
  }
  if (command === 'title') {
    return { documentText: 7000, styleSamples: 2500, targetText: 6000, userInput: 1200 };
  }
  return { documentText: 9000, styleSamples: 3000, targetText: 8000, userInput: 2000 };
}

function clipContext(value, maxCharacters) {
  const text = String(value ?? '').trim();
  if (!text || text.length <= maxCharacters) return text;

  const marker = `\n\n...[已截断 ${text.length - maxCharacters} 字，保留开头和结尾]...\n\n`;
  const headLength = Math.max(0, Math.floor((maxCharacters - marker.length) * 0.62));
  const tailLength = Math.max(0, maxCharacters - marker.length - headLength);
  return `${text.slice(0, headLength)}${marker}${text.slice(text.length - tailLength)}`;
}

function createTelemetry({ actionId, model, promptLength, provider }) {
  return {
    actionId,
    errorMessage: '',
    firstTokenTime: null,
    model,
    promptLength,
    provider,
    requestStartTime: Date.now(),
    routeName: 'terminal-writing-agent',
    totalDuration: null,
    usage: null,
  };
}

function publicTelemetry(telemetry) {
  return {
    error_message: telemetry.errorMessage,
    first_token_time: telemetry.firstTokenTime,
    input_tokens: telemetry.usage?.input_tokens ?? telemetry.usage?.prompt_tokens ?? null,
    model_name: telemetry.model,
    output_tokens: telemetry.usage?.output_tokens ?? telemetry.usage?.completion_tokens ?? null,
    prompt_length: telemetry.promptLength,
    provider: telemetry.provider,
    request_start_time: telemetry.requestStartTime,
    route_name: telemetry.routeName,
    total_duration: telemetry.totalDuration,
    ttft: telemetry.firstTokenTime ? telemetry.firstTokenTime - telemetry.requestStartTime : null,
  };
}

export function normalizeAgentResult(command, value) {
  const action = getWritingAssistantAction(command);
  const payload = value && typeof value === 'object' ? value : {};
  const titles = Array.isArray(payload.titles) ? payload.titles.filter(Boolean).map(String) : [];
  const notes = Array.isArray(payload.notes) ? payload.notes.filter(Boolean).map(String) : [];
  const target = ['document', 'paragraph', 'selection', 'append'].includes(payload.target)
    ? payload.target
    : action.target;

  return {
    actionId: action.id,
    descriptionSuggestion:
      typeof payload.summary === 'string' ? payload.summary.trim() : '',
    insertText: stringOrNull(payload.insertText),
    notes,
    raw: payload.raw ?? payload,
    replacementBody: stringOrNull(payload.replacementText),
    replacementText: stringOrNull(payload.replacementText),
    reply: String(payload.reply ?? '').trim(),
    summary: stringOrNull(payload.summary),
    target,
    titleSuggestions: titles,
    titles,
  };
}

function parseProviderResult(text, raw) {
  if (raw && isAgentResultShape(raw)) return raw;

  const source = String(text ?? '').trim();
  if (!source) throw new Error('Provider returned an empty response.');

  try {
    return JSON.parse(source);
  } catch {
    const fenced = source.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    if (fenced) return parseJson(fenced[1], 'provider JSON block');

    const start = source.indexOf('{');
    const end = source.lastIndexOf('}');
    if (start >= 0 && end > start) return parseJson(source.slice(start, end + 1), 'provider JSON');
    throw new Error('Could not parse provider response as JSON.');
  }
}

function parseJson(value, label) {
  try {
    return JSON.parse(String(value));
  } catch (error) {
    throw new Error(`Could not parse ${label}: ${error?.message ?? error}`);
  }
}

function isAgentResultShape(value) {
  return (
    value &&
    typeof value === 'object' &&
    ('reply' in value || 'insertText' in value || 'replacementText' in value)
  );
}

function stringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
