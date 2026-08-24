import type { Pool } from 'pg';
import { createFact, type Fact } from '../db/facts.js';
import type { ProposedFact } from './extract.js';

/**
 * Review queue operations. Approval is the only path by which a distilled
 * candidate becomes an active fact (source: 'distilled').
 */

export interface ReviewItem {
  id: string;
  proposed_fact: ProposedFact;
  session_ref: string;
  created_at: Date;
}

export async function pendingReviews(pool: Pool, limit = 100): Promise<ReviewItem[]> {
  const res = await pool.query(
    `SELECT id, proposed_fact, session_ref, created_at
     FROM review_queue WHERE resolved IS NULL ORDER BY created_at LIMIT $1`,
    [limit],
  );
  return res.rows as ReviewItem[];
}

export async function approveReview(
  pool: Pool,
  reviewId: string,
  edited?: Partial<ProposedFact>,
): Promise<Fact | null> {
  const res = await pool.query(
    `SELECT proposed_fact, session_ref FROM review_queue WHERE id = $1 AND resolved IS NULL`,
    [reviewId],
  );
  if (res.rowCount === 0) return null;
  const proposed = res.rows[0].proposed_fact as ProposedFact;
  const sessionRef = res.rows[0].session_ref as string;
  // Fact creation and queue resolution are one transaction — a crash
  // between them must not leave a re-approvable item that would duplicate.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fact = await createFact(client, {
      statement: edited?.statement ?? proposed.statement,
      category: edited?.category ?? proposed.category,
      entities: edited?.entities ?? proposed.entities,
      confidence: edited?.confidence ?? proposed.confidence,
      source: 'distilled',
      provenance: [{ session_id: sessionRef }],
    });
    await client.query(`UPDATE review_queue SET resolved = 'approved' WHERE id = $1`, [reviewId]);
    await client.query('COMMIT');
    return fact;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export async function rejectReview(pool: Pool, reviewId: string): Promise<boolean> {
  const res = await pool.query(
    `UPDATE review_queue SET resolved = 'rejected' WHERE id = $1 AND resolved IS NULL`,
    [reviewId],
  );
  return (res.rowCount ?? 0) > 0;
}

export async function reviewQueueCount(pool: Pool): Promise<number> {
  const res = await pool.query(`SELECT count(*)::int AS n FROM review_queue WHERE resolved IS NULL`);
  return res.rows[0].n as number;
}
