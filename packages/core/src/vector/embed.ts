import type { MemoryConfig } from '../config.js';

/**
 * Embeddings via aigate's OpenAI-compatible /embeddings endpoint.
 * EMBED_MODEL/EMBED_DIMS are pinned config; a dims mismatch is a hard error
 * because silently storing wrong-size vectors would poison the collection.
 */
export interface Embedder {
  embed(texts: string[]): Promise<number[][]>;
  dims: number;
  model: string;
}

const BATCH = 64;
// litellm's embedding route caps total request size (observed: 20000 chars
// combined across all `input` texts); stay well under that regardless of
// the backend's exact limit.
const MAX_BATCH_CHARS = 16000;

/** Split into count- and char-budget-bounded batches (a single oversized text goes out alone). */
function batchTexts(texts: string[]): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentChars = 0;
  for (const text of texts) {
    const wouldExceed =
      current.length > 0 && (current.length >= BATCH || currentChars + text.length > MAX_BATCH_CHARS);
    if (wouldExceed) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(text);
    currentChars += text.length;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

export function createEmbedder(
  cfg: Pick<MemoryConfig, 'aigateBaseUrl' | 'aigateApiKey' | 'embedModel' | 'embedDims'>,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return {
    dims: cfg.embedDims,
    model: cfg.embedModel,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (const batch of batchTexts(texts)) {
        const res = await fetchImpl(`${cfg.aigateBaseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${cfg.aigateApiKey}`,
          },
          body: JSON.stringify({ model: cfg.embedModel, input: batch }),
        });
        if (!res.ok) {
          throw new Error(`embeddings request failed: ${res.status} ${await res.text()}`);
        }
        const body = (await res.json()) as { data: { index: number; embedding: number[] }[] };
        const sorted = [...body.data].sort((a, b) => a.index - b.index);
        for (const d of sorted) {
          if (d.embedding.length !== cfg.embedDims) {
            throw new Error(
              `embedding dims mismatch: got ${d.embedding.length}, expected ${cfg.embedDims} — check EMBED_MODEL/EMBED_DIMS`,
            );
          }
          out.push(d.embedding);
        }
      }
      return out;
    },
  };
}
