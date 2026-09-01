import type { Pool } from 'pg';
import { createFact, findSupersedeCandidates, markSuperseded, type Fact } from '../db/facts.js';
import { checkSupersedes } from '../remember.js';
import type { LlmClient } from './llm.js';
import type { ProposedFact } from './extract.js';

/**
 * Review queue operations. Approval is the only path by which a distilled
 * candidate becomes an active fact (source: 'distilled'). Same
 * supersede-on-approve check as the live `remember` tool — otherwise a fact
 * re-mentioned across sessions (common: distillation runs per-session)
 * would pile up as separate near-duplicate active facts forever, since
 * nothing else in this path ever compares a proposal to what's already
 * active.
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

export interface ApproveResult {
  fact: Fact;
  superseded: string[];
}

export async function approveReview(
  pool: Pool,
  llm: LlmClient,
  reviewId: string,
  edited?: Partial<ProposedFact>,
): Promise<ApproveResult | null> {
  const res = await pool.query(
    `SELECT proposed_fact, session_ref FROM review_queue WHERE id = $1 AND resolved IS NULL`,
    [reviewId],
  );
  if (res.rowCount === 0) return null;
  const proposed = res.rows[0].proposed_fact as ProposedFact;
  const sessionRef = res.rows[0].session_ref as string;
  const statement = edited?.statement ?? proposed.statement;
  const category = edited?.category ?? proposed.category;
  const entities = edited?.entities ?? proposed.entities;
  const candidates = await findSupersedeCandidates(pool, category, entities);
  const stale = await checkSupersedes(llm, statement, candidates);
  // Fact creation and queue resolution are one transaction — a crash
  // between them must not leave a re-approvable item that would duplicate.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const fact = await createFact(client, {
      statement,
      category,
      entities,
      confidence: edited?.confidence ?? proposed.confidence,
      source: 'distilled',
      provenance: [{ session_id: sessionRef }],
      project: edited?.project ?? proposed.project,
    });
    for (const oldId of stale) {
      await markSuperseded(client, oldId, fact.id);
    }
    await client.query(`UPDATE review_queue SET resolved = 'approved' WHERE id = $1`, [reviewId]);
    await client.query('COMMIT');
    return { fact, superseded: stale };
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
