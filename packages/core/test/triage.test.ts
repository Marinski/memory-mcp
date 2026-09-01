import { describe, it, expect, vi } from 'vitest';
import { triagePending } from '../src/distill/triage.js';
import type { Pool } from 'pg';
import type { LlmClient } from '../src/distill/llm.js';
import type { ProposedFact } from '../src/distill/extract.js';

function candidate(id: string, statement: string, confidence = 0.9): {
  id: string;
  proposed_fact: ProposedFact;
  session_ref: string;
  created_at: Date;
} {
  return {
    id,
    proposed_fact: { statement, category: 'fact', entities: [], confidence },
    session_ref: 'claude-code:s1',
    created_at: new Date(),
  };
}

function fakePool(pending: ReturnType<typeof candidate>[], activeStatements: string[]) {
  const rejected: string[] = [];
  const approvedFacts: string[] = [];
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
      if (sql.startsWith('INSERT INTO facts')) {
        approvedFacts.push(params![0] as string);
        return {
          rows: [{
            id: `fact-${approvedFacts.length}`, statement: params![0], category: params![1],
            entities: params![2], confidence: params![3], source: params![4],
            provenance: [], project: (params![6] as string | null) ?? null, status: 'active', superseded_by: null,
            created_at: new Date(), updated_at: new Date(),
          }],
        };
      }
      if (sql.includes("UPDATE review_queue SET resolved = 'approved'")) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes('FROM review_queue WHERE resolved IS NULL ORDER BY')) {
        return { rows: pending.filter((p) => !rejected.includes(p.id)) };
      }
      if (sql.includes("SELECT statement FROM facts WHERE status = 'active'")) {
        return { rows: activeStatements.map((statement) => ({ statement })) };
      }
      if (sql.includes("UPDATE review_queue SET resolved = 'rejected'")) {
        rejected.push((params as string[])[0]);
        return { rowCount: 1 };
      }
      if (sql.includes('FROM review_queue WHERE id')) {
        const item = pending.find((p) => p.id === (params as string[])[0]);
        return item
          ? { rows: [{ proposed_fact: item.proposed_fact, session_ref: item.session_ref }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM facts') && sql.includes('entities &&')) return { rows: [] };
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, rejected, approvedFacts };
}

const keepAll: LlmClient = {
  complete: async (_s, user) => {
    const n = user.split('\n').length;
    return JSON.stringify(Array.from({ length: n }, (_, i) => ({ i, v: 'keep' })));
  },
};

describe('triagePending', () => {
  it('rejects exact duplicates against active facts and within the queue, approves the rest', async () => {
    const { pool, rejected, approvedFacts } = fakePool(
      [
        candidate('c1', 'Uses pnpm for all workspaces.'),
        candidate('c2', 'uses pnpm for all workspaces'), // dup of c1 modulo case/period
        candidate('c3', 'The GX10 already knows this'), // dup of active fact
        candidate('c4', 'Deploys with rsync'),
      ],
      ['the gx10 already knows this'],
    );
    const report = await triagePending(pool, keepAll);
    expect(rejected.sort()).toEqual(['c2', 'c3']);
    expect(report.rejectedDuplicates).toBe(2);
    expect(report.approved).toBe(2);
    expect(approvedFacts).toEqual(['Uses pnpm for all workspaces.', 'Deploys with rsync']);
  });

  it('rejects candidates the judge marks drop and keeps unruled ones', async () => {
    const judge: LlmClient = {
      // drops index 0, rules nothing about index 1
      complete: async () => '[{"i":0,"v":"drop"}]',
    };
    const { pool, rejected } = fakePool(
      [candidate('c1', 'Fixed a 401 error in the tracker'), candidate('c2', 'Tracker auth uses signed keys')],
      [],
    );
    const report = await triagePending(pool, judge);
    expect(rejected).toEqual(['c1']);
    expect(report.rejectedByJudge).toBe(1);
    expect(report.approved).toBe(1);
  });

  it('leaves a batch pending when the judge response is unparseable twice', async () => {
    const judge: LlmClient = { complete: async () => 'not json at all' };
    const { pool, rejected } = fakePool([candidate('c1', 'Something'), candidate('c2', 'Else')], []);
    const report = await triagePending(pool, judge);
    expect(rejected).toEqual([]);
    expect(report.leftPending).toBe(2);
    expect(report.approved).toBe(0);
  });
});
