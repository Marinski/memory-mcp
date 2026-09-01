import { describe, it, expect, vi } from 'vitest';
import { listStaleFacts } from '../src/staleness.js';
import type { Pool } from 'pg';

const FACT_ROW = {
  id: 'fact-1',
  statement: 'a fact',
  category: 'fact',
  entities: [],
  confidence: 1.0,
  source: 'user',
  provenance: [],
  project: null,
  status: 'active',
  superseded_by: null,
  created_at: new Date('2025-01-01T00:00:00Z'),
  updated_at: new Date('2025-01-01T00:00:00Z'),
};

function fakePool(activeRows: unknown[], supersededRows: unknown[]) {
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    if (sql.includes("status = 'active'")) return { rows: activeRows };
    if (sql.includes("status = 'superseded'")) return { rows: supersededRows };
    throw new Error(`unexpected query: ${sql}`);
  });
  return { pool: { query } as unknown as Pool, query };
}

describe('listStaleFacts', () => {
  it('queries active facts older than N months and recent superseded facts', async () => {
    const { pool, query } = fakePool(
      [FACT_ROW],
      [{ ...FACT_ROW, id: 'sup-1', status: 'superseded', superseded_by: 'new-1' }],
    );
    const report = await listStaleFacts(pool, { olderThanMonths: 6, recentLimit: 10 });

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("status = 'active' AND updated_at < now() - interval '1 month' * $1"),
      [6],
    );
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $1'), [10]);
    expect(report.active_stale).toHaveLength(1);
    expect(report.superseded_recent).toHaveLength(1);
    expect(report.superseded_recent[0].superseded_by).toBe('new-1');
  });

  it('orders stale active facts oldest-first and superseded newest-first in SQL', async () => {
    const old1 = { ...FACT_ROW, id: 'a', updated_at: new Date('2024-01-01T00:00:00Z') };
    const old2 = { ...FACT_ROW, id: 'b', updated_at: new Date('2023-01-01T00:00:00Z') };
    const sup1 = { ...FACT_ROW, id: 's1', status: 'superseded', updated_at: new Date('2025-03-01T00:00:00Z') };
    const sup2 = { ...FACT_ROW, id: 's2', status: 'superseded', updated_at: new Date('2025-02-01T00:00:00Z') };
    const { pool, query } = fakePool([old1, old2], [sup1, sup2]);

    await listStaleFacts(pool, {});
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY updated_at ASC'), [3]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('ORDER BY updated_at DESC'), [20]);
  });

  it('defaults to 3 months and 20 recent', async () => {
    const { pool, query } = fakePool([], []);
    await listStaleFacts(pool);
    expect(query).toHaveBeenCalledWith(expect.stringContaining("interval '1 month' * $1"), [3]);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('LIMIT $1'), [20]);
  });
});
