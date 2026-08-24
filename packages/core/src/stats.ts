import type { Pool } from 'pg';
import type { QdrantClient } from './vector/qdrant.js';
import { factCounts } from './db/facts.js';
import { ledgerStats } from './db/ledger.js';
import { reviewQueueCount } from './distill/review.js';

export interface MemoryStats {
  facts: Record<string, number>;
  archive_points: number;
  ingest: { files: number; sessions: number; chunks: number; secrets_found: number; last_ingest: string | null };
  review_pending: number;
}

export async function memoryStats(pool: Pool, qdrant: QdrantClient): Promise<MemoryStats> {
  const [facts, points, ingest, pending] = await Promise.all([
    factCounts(pool),
    qdrant.count().catch(() => -1),
    ledgerStats(pool),
    reviewQueueCount(pool),
  ]);
  return {
    facts,
    archive_points: points,
    ingest: {
      files: ingest.files,
      sessions: ingest.sessions,
      chunks: ingest.chunks,
      secrets_found: ingest.secrets_found,
      last_ingest: ingest.last_ingest ? new Date(ingest.last_ingest).toISOString() : null,
    },
    review_pending: pending,
  };
}
