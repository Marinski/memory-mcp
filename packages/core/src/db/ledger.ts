import type { Pool } from 'pg';

export interface LedgerEntry {
  id: string;
  source_path: string;
  source_kind: string;
  content_hash: string;
  sessions: number;
  chunks: number;
  secrets_found: number;
  status: 'ingested' | 'quarantined';
  distilled_at: Date | null;
  ingested_at: Date;
}

export async function ledgerHasHash(pool: Pool, contentHash: string): Promise<boolean> {
  const res = await pool.query('SELECT 1 FROM ingest_ledger WHERE content_hash = $1', [contentHash]);
  return (res.rowCount ?? 0) > 0;
}

export async function recordIngest(
  pool: Pool,
  e: Omit<LedgerEntry, 'id' | 'ingested_at' | 'distilled_at'> & { sessionIds?: string[] },
): Promise<string> {
  const res = await pool.query(
    `INSERT INTO ingest_ledger (source_path, source_kind, content_hash, sessions, chunks, secrets_found, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [e.source_path, e.source_kind, e.content_hash, e.sessions, e.chunks, e.secrets_found, e.status],
  );
  const id = res.rows[0].id as string;
  for (const sid of e.sessionIds ?? []) {
    await pool.query(
      'INSERT INTO ledger_sessions (ledger_id, session_id) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [id, sid],
    );
  }
  return id;
}

export async function undistilledLedgerEntries(pool: Pool): Promise<LedgerEntry[]> {
  const res = await pool.query(
    `SELECT * FROM ingest_ledger WHERE status = 'ingested' AND distilled_at IS NULL ORDER BY ingested_at`,
  );
  return res.rows as LedgerEntry[];
}

export async function markDistilled(pool: Pool, ledgerId: string): Promise<void> {
  await pool.query('UPDATE ingest_ledger SET distilled_at = now() WHERE id = $1', [ledgerId]);
}

export async function ledgerSessionIds(pool: Pool, ledgerId: string): Promise<string[]> {
  const res = await pool.query('SELECT session_id FROM ledger_sessions WHERE ledger_id = $1', [ledgerId]);
  return res.rows.map((r) => r.session_id as string);
}

export async function ledgerStats(pool: Pool): Promise<{
  files: number; sessions: number; chunks: number; secrets_found: number; last_ingest: Date | null;
}> {
  const res = await pool.query(
    `SELECT count(*)::int AS files, coalesce(sum(sessions),0)::int AS sessions,
            coalesce(sum(chunks),0)::int AS chunks, coalesce(sum(secrets_found),0)::int AS secrets_found,
            max(ingested_at) AS last_ingest
     FROM ingest_ledger WHERE status = 'ingested'`,
  );
  return res.rows[0];
}
