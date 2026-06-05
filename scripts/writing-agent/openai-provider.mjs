import { collectProviderStream, providerEventTypes, streamSseResponse } from './streaming.mjs';

export const defaultOpenAiModel = 'gpt-5.5';

const openAiResponsesUrl = 'https://api.openai.com/v1/responses';

export function hasOpenAiApiKey() {
  return Boolean(process.env.OPENAI_API_KEY);
}

export class OpenAiProvider {
  async generate(request) {
    return collectProviderStream(this.stream(request));
  }

  async *stream({
    maxOutputTokens,
    model = process.env.OPENAI_MODEL || defaultOpenAiModel,
    schema,
    signal,
    systemPrompt,
    userPrompt,
  }) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing OPENAI_API_KEY. Export it or choose Mock in /connect.');
    }

    yield { type: providerEventTypes.start };

    const response = await fetch(openAiResponsesUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      signal,
      body: JSON.stringify({
        input: [
          { content: systemPrompt, role: 'system' },
          { content: userPrompt, role: 'user' },
        ],
        max_output_tokens: maxOutputTokens,
        model,
        store: false,
        stream: true,
        text: {
          format: {
            name: 'writing_agent_response',
            schema,
            strict: true,
            type: 'json_schema',
          },
        },
      }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(formatOpenAiError(response.status, text));
    }

    yield* streamSseResponse({
      label: 'OpenAI',
      response,
      signal,
      textExtractor: extractResponseText,
    });
  }
}

export function formatOpenAiError(status, body) {
  const text = String(body ?? '').trim();
  if (!text) return `OpenAI request failed with HTTP ${status}.`;
  try {
    const payload = JSON.parse(text);
    const message = payload?.error?.message || payload?.message;
    return message ? `OpenAI request failed (${status}): ${message}` : `OpenAI request failed (${status}).`;
  } catch {
    return `OpenAI request failed (${status}): ${text.slice(0, 600)}`;
  }
}

function extractResponseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const output = Array.isArray(payload?.output) ? payload.output : [];
  const textParts = [];
  for (const item of output) {
    const content = Array.isArray(item?.content) ? item.content : [];
    for (const part of content) {
      if (typeof part?.text === 'string') textParts.push(part.text);
      if (typeof part?.output_text === 'string') textParts.push(part.output_text);
      if (typeof part?.json === 'object') return JSON.stringify(part.json);
    }
  }
  return textParts.join('\n').trim() || JSON.stringify(payload);
}
