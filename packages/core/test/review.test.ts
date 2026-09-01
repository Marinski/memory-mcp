import { describe, it, expect, vi } from 'vitest';
import { approveReview } from '../src/distill/review.js';
import type { Pool } from 'pg';
import type { LlmClient } from '../src/distill/llm.js';
import type { ProposedFact } from '../src/distill/extract.js';
import type { Fact } from '../src/db/facts.js';

function fakeOldFact(id: string, statement: string, entities: string[]): Fact {
  return {
    id,
    statement,
    category: 'fact',
    entities,
    confidence: 0.8,
    source: 'distilled',
    provenance: [],
    project: null,
    status: 'active',
    superseded_by: null,
    created_at: new Date(),
    updated_at: new Date(),
  };
}

function fakePool(opts: {
  reviewRow: { proposed_fact: ProposedFact; session_ref: string } | null;
  candidateRows?: Fact[];
}) {
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.startsWith('BEGIN') || sql.startsWith('COMMIT') || sql.startsWith('ROLLBACK')) return { rows: [] };
      if (sql.startsWith('INSERT INTO facts')) {
        const p = params!;
        return {
          rows: [
            {
              id: 'new-fact',
              statement: p[0],
              category: p[1],
              entities: p[2],
              confidence: p[3],
              source: p[4],
              provenance: JSON.parse(p[5] as string),
              project: (p[6] as string | null) ?? null,
              status: 'active',
              superseded_by: null,
              created_at: new Date(),
              updated_at: new Date(),
            },
          ],
        };
      }
      if (sql.startsWith('UPDATE facts SET status')) return { rows: [] };
      if (sql.includes("UPDATE review_queue SET resolved = 'approved'")) return { rows: [] };
      throw new Error(`unexpected client query: ${sql}`);
    }),
    release: vi.fn(),
  };
  const pool = {
    query: vi.fn(async (sql: string) => {
      if (sql.includes('FROM review_queue WHERE id')) {
        return opts.reviewRow ? { rows: [opts.reviewRow], rowCount: 1 } : { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM facts') && sql.includes('entities &&')) {
        return { rows: opts.candidateRows ?? [] };
      }
      throw new Error(`unexpected pool query: ${sql}`);
    }),
    connect: vi.fn(async () => client),
  } as unknown as Pool;
  return { pool, client };
}

describe('approveReview', () => {
  it('returns null when the review item is already resolved or missing', async () => {
    const { pool } = fakePool({ reviewRow: null });
    const llm: LlmClient = { complete: async () => '[]' };
    const result = await approveReview(pool, llm, 'missing-id');
    expect(result).toBeNull();
  });

  it('creates the fact with no supersedes when nothing overlaps', async () => {
    const { pool } = fakePool({
      reviewRow: {
        proposed_fact: { statement: 'uses pnpm', category: 'fact', entities: [], confidence: 0.8 },
        session_ref: 's1',
      },
    });
    const llm: LlmClient = { complete: async () => { throw new Error('must not be called with no candidates'); } };
    const result = await approveReview(pool, llm, 'r1');
    expect(result?.fact.id).toBe('new-fact');
    expect(result?.superseded).toEqual([]);
  });

  it('marks a near-duplicate active fact superseded by the newly approved one', async () => {
    const old = fakeOldFact('old-1', 'The user has a directory of models located at ~/models/.', ['~-models-']);
    const { pool, client } = fakePool({
      reviewRow: {
        proposed_fact: {
          statement: 'The user has a directory of models located at ~/models/ containing various LLM weights.',
          category: 'fact',
          entities: ['~-models-'],
          confidence: 0.9,
        },
        session_ref: 's2',
      },
      candidateRows: [old],
    });
    const llm: LlmClient = { complete: async () => '["old-1"]' };

    const result = await approveReview(pool, llm, 'r2');

    expect(result?.superseded).toEqual(['old-1']);
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining('UPDATE facts SET status'), ['old-1', 'new-fact']);
  });

  it('applies edits before checking for supersedes', async () => {
    const old = fakeOldFact('old-2', 'The user prefers dark mode.', ['dark-mode']);
    const { pool } = fakePool({
      reviewRow: {
        proposed_fact: { statement: 'unedited', category: 'fact', entities: [], confidence: 0.5 },
        session_ref: 's3',
      },
      candidateRows: [old],
    });
    const llm: LlmClient = { complete: async () => '["old-2"]' };

    const result = await approveReview(pool, llm, 'r3', {
      statement: 'The user prefers light mode now.',
      category: 'preference',
      entities: ['dark-mode'],
    });

    expect(result?.fact.statement).toBe('The user prefers light mode now.');
    expect(result?.superseded).toEqual(['old-2']);
  });
});
