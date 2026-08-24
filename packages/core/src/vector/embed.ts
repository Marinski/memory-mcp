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

export function createEmbedder(
  cfg: Pick<MemoryConfig, 'aigateBaseUrl' | 'aigateApiKey' | 'embedModel' | 'embedDims'>,
  fetchImpl: typeof fetch = fetch,
): Embedder {
  return {
    dims: cfg.embedDims,
    model: cfg.embedModel,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += BATCH) {
        const batch = texts.slice(i, i + BATCH);
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
