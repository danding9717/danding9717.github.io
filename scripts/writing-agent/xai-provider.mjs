import { collectProviderStream, providerEventTypes, streamSseResponse } from './streaming.mjs';

export const defaultApiModel = 'grok-4.3';

const xaiResponsesUrl = 'https://api.x.ai/v1/responses';

export function hasXaiApiKey() {
  return Boolean(process.env.XAI_API_KEY);
}

export class XaiProvider {
  async generate(request) {
    return collectProviderStream(this.stream(request));
  }

  async *stream({
    maxOutputTokens,
    model = process.env.XAI_MODEL || defaultApiModel,
    schema,
    signal,
    systemPrompt,
    userPrompt,
  }) {
    const apiKey = process.env.XAI_API_KEY;
    if (!apiKey) {
      throw new Error('Missing XAI_API_KEY. Run /connect, choose Mock, or export XAI_API_KEY.');
    }

    yield { type: providerEventTypes.start };

    const response = await fetch(xaiResponsesUrl, {
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
      throw new Error(formatXaiError(response.status, text));
    }

    yield* streamSseResponse({
      label: 'xAI',
      response,
      signal,
      textExtractor: extractResponseText,
    });
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

export function formatXaiError(status, body) {
  const text = String(body ?? '').trim();
  if (!text) return `xAI request failed with HTTP ${status}.`;
  try {
    const payload = JSON.parse(text);
    const message = payload?.error?.message || payload?.message;
    return message ? `xAI request failed (${status}): ${message}` : `xAI request failed (${status}).`;
  } catch {
    return `xAI request failed (${status}): ${text.slice(0, 600)}`;
  }
}
