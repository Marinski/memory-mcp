import type { Pool } from 'pg';
import type { Fact } from './db/facts.js';

/**
 * Active facts whose `updated_at` is older than `olderThanMonths` months,
 * plus the `recentLimit` most recently superseded facts. The nightly pass
 * calls this and exposes it through the CLI and MCP resource.
 */
export interface StalenessReport {
  active_stale: Fact[];
  superseded_recent: Fact[];
}

export interface StalenessOpts {
  olderThanMonths?: number;
  recentLimit?: number;
}

export async function listRecentSuperseded(pool: Pool, limit = 20): Promise<Fact[]> {
  const res = await pool.query(
    `SELECT id, statement, category, entities, confidence, source, provenance, project,
            status, superseded_by, created_at, updated_at
     FROM facts
     WHERE status = 'superseded'
     ORDER BY updated_at DESC
     LIMIT $1`,
    [limit],
  );
  return res.rows as Fact[];
}

export async function listStaleFacts(
  pool: Pool,
  opts: StalenessOpts = {},
): Promise<StalenessReport> {
  const months = opts.olderThanMonths ?? 3;
  const recentLimit = opts.recentLimit ?? 20;

  const [activeStale, supersededRecent] = await Promise.all([
    pool.query(
      `SELECT id, statement, category, entities, confidence, source, provenance, project,
              status, superseded_by, created_at, updated_at
       FROM facts
       WHERE status = 'active' AND updated_at < now() - interval '1 month' * $1
       ORDER BY updated_at ASC`,
      [months],
    ),
    listRecentSuperseded(pool, recentLimit),
  ]);

  return {
    active_stale: activeStale.rows as Fact[],
    superseded_recent: supersededRecent,
  };
}
