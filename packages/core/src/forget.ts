import type { Pool } from 'pg';
import type { Embedder } from './vector/embed.js';
import type { QdrantClient } from './vector/qdrant.js';
import { getFact, hardDeleteFact } from './db/facts.js';
import { searchMemory, searchArchive } from './search.js';

/**
 * Hard-delete semantics across both stores. This is personal data:
 * deletion must mean deletion, not a soft flag. By-query forgetting is
 * two-phase — the first call reports what would be deleted, the second
 * (confirm: true) deletes facts AND the matching archive chunks.
 */

export interface ForgetPreview {
  facts: { id: string; statement: string }[];
  archive_chunks: { chunk_id: string; session_id: string; excerpt: string }[];
}

export interface ForgetOutcome {
  deleted_facts: number;
  deleted_chunks: number;
}

export async function forgetByFactId(pool: Pool, factId: string): Promise<boolean> {
  const fact = await getFact(pool, factId);
  if (!fact) return false;
  return hardDeleteFact(pool, factId);
}

export async function previewForgetByQuery(
  pool: Pool,
  qdrant: QdrantClient,
  embedder: Embedder,
  query: string,
): Promise<ForgetPreview> {
  const memHits = await searchMemory(pool, embedder, query, { limit: 20 });
  const archHits = await searchArchive(qdrant, embedder, query, { limit: 10 });
  return {
    facts: memHits.map((h) => ({ id: h.fact.id, statement: h.fact.statement })),
    archive_chunks: archHits.map((h) => ({
      chunk_id: h.chunk_id,
      session_id: h.session_id,
      excerpt: h.text.slice(0, 160),
    })),
  };
}

export async function executeForgetByQuery(
  pool: Pool,
  qdrant: QdrantClient,
  embedder: Embedder,
  query: string,
): Promise<ForgetOutcome> {
  const preview = await previewForgetByQuery(pool, qdrant, embedder, query);
  let deletedFacts = 0;
  for (const f of preview.facts) {
    if (await hardDeleteFact(pool, f.id)) deletedFacts += 1;
  }
  const chunkIds = preview.archive_chunks.map((c) => c.chunk_id);
  await qdrant.deletePoints(chunkIds);
  return { deleted_facts: deletedFacts, deleted_chunks: chunkIds.length };
}
