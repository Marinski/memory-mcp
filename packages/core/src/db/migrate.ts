import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type { Pool } from 'pg';

/**
 * Minimal idempotent migration runner. schema.sql is written entirely with
 * IF NOT EXISTS / ON CONFLICT guards, so applying it repeatedly is a no-op.
 * Future migrations append numbered files (002_*.sql, ...) applied in order
 * and recorded in schema_migrations.
 */
export async function migrate(pool: Pool): Promise<number> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const sql = await readFile(path.join(dir, 'schema.sql'), 'utf8');
  await pool.query(sql);
  const res = await pool.query('SELECT max(version) AS v FROM schema_migrations');
  return res.rows[0].v as number;
}
