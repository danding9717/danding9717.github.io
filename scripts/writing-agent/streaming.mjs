export const providerEventTypes = {
  delta: 'delta',
  done: 'done',
  error: 'error',
  firstToken: 'first_token',
  start: 'start',
  usage: 'usage',
};

export class ProviderAbortError extends Error {
  constructor(message = 'AI request was cancelled.') {
    super(message);
    this.name = 'ProviderAbortError';
  }
}

export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw new ProviderAbortError();
  }
}

export function isAbortError(error) {
  return (
    error?.name === 'AbortError' ||
    error?.name === 'ProviderAbortError' ||
    /aborted|cancelled|canceled/i.test(String(error?.message ?? error))
  );
}

export async function collectProviderStream(stream) {
  let raw = null;
  let text = '';
  let usage = null;

  for await (const event of stream) {
    if (event.type === providerEventTypes.delta && event.text) {
      text += event.text;
    } else if (event.type === providerEventTypes.done) {
      raw = event.raw ?? raw;
      text = event.text ?? text;
      usage = event.usage ?? usage;
    } else if (event.type === providerEventTypes.usage) {
      usage = event.usage ?? usage;
    }
  }

  return { raw, text, usage };
}

export async function* streamSseResponse({ label, response, signal, textExtractor }) {
  if (!response.body) throw new Error(`${label} response did not include a stream body.`);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let raw = null;
  let usage = null;
  let firstTokenSent = false;

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const events = buffer.split(/\r?\n\r?\n/);
      buffer = events.pop() ?? '';

      for (const eventBlock of events) {
        const dataLines = eventBlock
          .split(/\r?\n/)
          .filter((line) => line.startsWith('data:'))
          .map((line) => line.slice(5).trimStart());
        if (!dataLines.length) continue;

        const data = dataLines.join('\n').trim();
        if (!data || data === '[DONE]') continue;

        let payload;
        try {
          payload = JSON.parse(data);
        } catch {
          continue;
        }

        const delta = extractStreamDelta(payload);
        if (delta) {
          if (!firstTokenSent) {
            firstTokenSent = true;
            yield { type: providerEventTypes.firstToken };
          }
          text += delta;
          yield { text: delta, type: providerEventTypes.delta };
        }

        const nextUsage = extractStreamUsage(payload);
        if (nextUsage) {
          usage = nextUsage;
          yield { type: providerEventTypes.usage, usage };
        }

        const completed = extractCompletedResponse(payload);
        if (completed) {
          raw = completed;
          const completedText = textExtractor(completed);
          if (completedText) text = completedText;
        }
      }
    }
  } catch (error) {
    if (isAbortError(error)) throw new ProviderAbortError();
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // Stream may already be closed.
    }
  }

  yield { raw, text, type: providerEventTypes.done, usage };
}

function extractStreamDelta(payload) {
  if (typeof payload?.delta === 'string') return payload.delta;
  if (typeof payload?.text === 'string' && /delta/i.test(String(payload?.type ?? ''))) {
    return payload.text;
  }
  if (typeof payload?.output_text_delta === 'string') return payload.output_text_delta;
  if (typeof payload?.content_delta === 'string') return payload.content_delta;

  const content = payload?.item?.content ?? payload?.content;
  if (Array.isArray(content)) {
    for (const part of content) {
      if (typeof part?.delta === 'string') return part.delta;
      if (typeof part?.text === 'string' && /delta/i.test(String(payload?.type ?? ''))) return part.text;
    }
  }

  return '';
}

function extractStreamUsage(payload) {
  return payload?.response?.usage ?? payload?.usage ?? null;
}

function extractCompletedResponse(payload) {
  if (payload?.type === 'response.completed' && payload?.response) return payload.response;
  if (payload?.response?.status === 'completed') return payload.response;
  if (payload?.type === 'completed' && payload?.response) return payload.response;
  return null;
}
