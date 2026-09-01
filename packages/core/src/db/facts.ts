import type { Pool, PoolClient } from 'pg';

/** Pool or a checked-out client inside a transaction. */
export type Queryable = Pick<Pool | PoolClient, 'query'>;

export type FactCategory = 'preference' | 'decision' | 'fact' | 'project' | 'person';
export type FactSource = 'user' | 'distilled' | 'imported';
export type FactStatus = 'active' | 'superseded' | 'deleted';

export interface ProvenanceRef {
  session_id: string;
  chunk_id?: string;
}

export interface Fact {
  id: string;
  statement: string;
  category: FactCategory;
  entities: string[];
  confidence: number;
  source: FactSource;
  provenance: ProvenanceRef[];
  project: string | null;
  status: FactStatus;
  superseded_by: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface NewFact {
  statement: string;
  category: FactCategory;
  entities?: string[];
  confidence?: number;
  source: FactSource;
  provenance?: ProvenanceRef[];
  /** Optional project scope, mirroring the archive's session-level project. */
  project?: string | null;
}

const FACT_COLS =
  'id, statement, category, entities, confidence, source, provenance, project, status, superseded_by, created_at, updated_at';

export async function createFact(pool: Queryable, f: NewFact): Promise<Fact> {
  const res = await pool.query(
    `INSERT INTO facts (statement, category, entities, confidence, source, provenance, project)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING ${FACT_COLS}`,
    [
      f.statement,
      f.category,
      f.entities ?? [],
      f.confidence ?? 1.0,
      f.source,
      JSON.stringify(f.provenance ?? []),
      f.project ?? null,
    ],
  );
  return res.rows[0] as Fact;
}

export async function getFact(pool: Queryable, id: string): Promise<Fact | null> {
  const res = await pool.query(`SELECT ${FACT_COLS} FROM facts WHERE id = $1`, [id]);
  return (res.rows[0] as Fact | undefined) ?? null;
}

export async function listRecentFacts(pool: Queryable, limit = 50): Promise<Fact[]> {
  const res = await pool.query(
    `SELECT ${FACT_COLS} FROM facts WHERE status = 'active'
     ORDER BY updated_at DESC LIMIT $1`,
    [limit],
  );
  return res.rows as Fact[];
}

/**
 * Every fact regardless of status, oldest first. Unlike listRecentFacts
 * (active only — "current truth" for category/entity pages and the
 * memory://facts/recent resource), the vault's daily log is a historical
 * event log: it needs superseded facts too, to record the day something
 * went stale.
 */
export async function allFacts(pool: Queryable, limit = 10_000): Promise<Fact[]> {
  const res = await pool.query(`SELECT ${FACT_COLS} FROM facts ORDER BY created_at LIMIT $1`, [limit]);
  return res.rows as Fact[];
}

/**
 * Candidate facts a new statement could contradict: active, same category,
 * sharing at least one entity. The actual contradiction decision is made by
 * the LLM check in supersede.ts.
 */
export async function findSupersedeCandidates(
  pool: Pool,
  category: FactCategory,
  entities: string[],
): Promise<Fact[]> {
  if (entities.length === 0) return [];
  const res = await pool.query(
    `SELECT ${FACT_COLS} FROM facts
     WHERE status = 'active' AND category = $1 AND entities && $2
     ORDER BY updated_at DESC LIMIT 20`,
    [category, entities],
  );
  return res.rows as Fact[];
}

export async function markSuperseded(pool: Queryable, oldId: string, byId: string): Promise<void> {
  await pool.query(
    `UPDATE facts SET status = 'superseded', superseded_by = $2, updated_at = now()
     WHERE id = $1 AND status = 'active'`,
    [oldId, byId],
  );
}

/** Hard delete — this is personal data; deletion must mean deletion. */
export async function hardDeleteFact(pool: Queryable, id: string): Promise<boolean> {
  await pool.query('UPDATE facts SET superseded_by = NULL WHERE superseded_by = $1', [id]);
  const res = await pool.query('DELETE FROM facts WHERE id = $1', [id]);
  return (res.rowCount ?? 0) > 0;
}

/** Full-text candidates for search_memory; reranked by embedding upstream. */
export async function fullTextFacts(
  pool: Pool,
  query: string,
  category: FactCategory | undefined,
  limit: number,
  project?: string,
): Promise<Fact[]> {
  const res = await pool.query(
    `SELECT ${FACT_COLS}, ts_rank(tsv, q) AS rank
     FROM facts, websearch_to_tsquery('simple', $1) q
     WHERE status = 'active' AND tsv @@ q AND ($2::text IS NULL OR category = $2)
       AND ($3::text IS NULL OR project = $3)
     ORDER BY rank DESC LIMIT $4`,
    [query, category ?? null, project ?? null, limit],
  );
  return res.rows as Fact[];
}

export async function factCounts(pool: Pool): Promise<Record<string, number>> {
  const res = await pool.query(
    `SELECT status, count(*)::int AS n FROM facts GROUP BY status`,
  );
  const out: Record<string, number> = { active: 0, superseded: 0, deleted: 0 };
  for (const r of res.rows) out[r.status] = r.n;
  return out;
}
