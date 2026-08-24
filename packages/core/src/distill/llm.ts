import type { MemoryConfig } from '../config.js';

/** Chat-completion call against aigate (OpenAI-compatible). */
export interface LlmClient {
  complete(system: string, user: string): Promise<string>;
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
      const body = (await res.json()) as { choices: { message: { content: string } }[] };
      return body.choices[0]?.message?.content ?? '';
    },
  };
}

/**
 * Extract the first JSON value from an LLM response. Tolerates code fences
 * and trailing prose by scanning to the matching close bracket.
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
  for (let i = start; i < candidate.length; i++) {
    const ch = candidate[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === open) depth += 1;
    else if (ch === close) {
      depth -= 1;
      if (depth === 0) return JSON.parse(candidate.slice(start, i + 1)) as T;
    }
  }
  throw new Error('unbalanced JSON in LLM response');
}
