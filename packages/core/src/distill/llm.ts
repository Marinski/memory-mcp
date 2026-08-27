import type { MemoryConfig } from '../config.js';

/** Chat-completion call against aigate (OpenAI-compatible). */
export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
}

/**
 * The model ran out of context window mid-answer (finish_reason: length).
 * The content is unusable — for JSON outputs it's cut off mid-structure —
 * and only a shorter prompt can help, so callers that can shrink their
 * input catch this specifically.
 */
export class TruncatedLlmResponseError extends Error {
  constructor() {
    super('LLM response truncated (finish_reason: length)');
    this.name = 'TruncatedLlmResponseError';
  }
}

/**
 * The response's JSON never reached its matching close bracket. In practice
 * this is also truncation — output cut off at the context-window edge — even
 * when the gateway reports finish_reason 'stop' (observed from vllm-gemma4),
 * so callers treat it like TruncatedLlmResponseError.
 */
export class UnbalancedJsonError extends Error {
  constructor() {
    super('unbalanced JSON in LLM response');
    this.name = 'UnbalancedJsonError';
  }
}

export function createLlmClient(
  cfg: Pick<MemoryConfig, 'aigateBaseUrl' | 'aigateApiKey' | 'distillModel'>,
  fetchImpl: typeof fetch = fetch,
): LlmClient {
  return {
    async complete(system, user) {
      const res = await fetchImpl(`${cfg.aigateBaseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${cfg.aigateApiKey}`,
        },
        body: JSON.stringify({
          model: cfg.distillModel,
          temperature: 0,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
        }),
      });
      if (!res.ok) {
        throw new Error(`chat completion failed: ${res.status} ${await res.text()}`);
      }
      const body = (await res.json()) as {
        choices: { message: { content: string }; finish_reason?: string }[];
      };
      if (body.choices[0]?.finish_reason === 'length') throw new TruncatedLlmResponseError();
      return body.choices[0]?.message?.content ?? '';
    },
  };
}

/**
 * Extract the first JSON value from an LLM response. Tolerates code fences
 * and trailing prose by scanning to the matching close bracket, and repairs
 * raw control characters the model emits inside string literals (a literal
 * newline/tab mid-string) by escaping them, since JSON.parse rejects them.
 */
export function extractJson<T>(text: string): T {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenced ? fenced[1] : text;
  const start = candidate.search(/[[{]/);
  if (start === -1) throw new Error('no JSON found in LLM response');
  const open = candidate[start];
  const close = open === '[' ? ']' : '}';
  let depth = 0;
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (inString && !escaped && ch.charCodeAt(0) < 0x20) {
      out += ch === '\n' ? '\\n' : ch === '\r' ? '\\r' : ch === '\t' ? '\\t'
        : `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`;
      continue;
    }
    out += ch;
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(out) as T;
    }
  }
  throw new UnbalancedJsonError();
}
