import { describe, it, expect } from 'vitest';
import { validateProposals, distillPending } from '../src/distill/extract.js';
import { extractJson, createLlmClient, TruncatedLlmResponseError } from '../src/distill/llm.js';
import { checkSupersedes } from '../src/remember.js';
import type { Fact } from '../src/db/facts.js';
import type { LlmClient } from '../src/distill/llm.js';
import type { Pool } from 'pg';

describe('extractJson', () => {
  it('parses plain and fenced JSON', () => {
    expect(extractJson('[1,2]')).toEqual([1, 2]);
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson('no json here')).toThrow();
  });

  it('tolerates trailing prose and strings containing brackets', () => {
    expect(extractJson('Sure! [1,2] hope that helps')).toEqual([1, 2]);
    expect(extractJson('{"a":"has ] and } inside"} trailing words')).toEqual({ a: 'has ] and } inside' });
  });

  it('repairs raw control characters the model emits inside string literals', () => {
    // gemma4 occasionally emits a literal newline mid-string; JSON.parse
    // rejects that ("Bad control character in string literal")
    expect(extractJson('{"a":"line one\nline two\ttabbed"}')).toEqual({ a: 'line one\nline two\ttabbed' });
    expect(extractJson('[{"s":"xy"}]')).toEqual([{ s: 'xy' }]);
    // escape sequences and structure outside strings stay untouched
    expect(extractJson('{"a":"already\\nescaped"}')).toEqual({ a: 'already\nescaped' });
  });
});

describe('createLlmClient', () => {
  it('throws TruncatedLlmResponseError when finish_reason is length', async () => {
    const fetchImpl = (async () => ({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: '[{"statement":"cut off' }, finish_reason: 'length' }],
      }),
    })) as unknown as typeof fetch;
    const llm = createLlmClient(
      { aigateBaseUrl: 'http://x/v1', aigateApiKey: 'k', distillModel: 'm' },
      fetchImpl,
    );
    await expect(llm.complete('s', 'u')).rejects.toBeInstanceOf(TruncatedLlmResponseError);
  });
});

describe('validateProposals', () => {
  it('keeps valid proposals, drops junk, clamps confidence', () => {
    const out = validateProposals([
      { statement: 'Alex prefers Klaro for cookie consent', category: 'preference', entities: ['Klaro'], confidence: 1.7 },
      { statement: '', category: 'fact', entities: [], confidence: 0.5 },
      { statement: 'x', category: 'nonsense', entities: [], confidence: 0.5 },
      'not an object',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(1);
  });

  it('strips filename/path-like entities the LLM extracted despite the prompt rule', () => {
    const out = validateProposals([
      {
        statement: 'auth.ts overwrites an existing role on invite',
        category: 'fact',
        entities: ['auth.ts', 'auth.config.ts', 'translate_platform.py', 'src/app/api/admin/route.ts', 'EA-CONTENT-BRIEF.md', 'GX10'],
        confidence: 0.8,
      },
    ]);
    expect(out[0].entities).toEqual(['GX10']);
  });

  it('keeps capitalized .js/.ts brand names, which are real entities not files', () => {
    const out = validateProposals([
      {
        statement: 'Uses Next.js with PM2',
        category: 'fact',
        entities: ['Next.js', 'Node.js', 'Vue.js', 'D3.js', 'next.config.js'],
        confidence: 0.8,
      },
    ]);
    expect(out[0].entities).toEqual(['Next.js', 'Node.js', 'Vue.js', 'D3.js']);
  });
});

describe('distillPending', () => {
  function fakePool(): Pool {
    const entries = [
      { id: 'e1', status: 'ingested', distilled_at: null },
      { id: 'e2', status: 'ingested', distilled_at: null },
    ];
    const sessionsByEntry: Record<string, string[]> = { e1: ['bad-session'], e2: ['good-session'] };
    const distilledIds: string[] = [];
    const proposedRows: unknown[] = [];
    return {
      query: async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM ingest_ledger WHERE status')) return { rows: entries };
        if (sql.includes('FROM ledger_sessions WHERE ledger_id')) {
          const id = (params as string[])[0];
          return { rows: sessionsByEntry[id].map((session_id) => ({ session_id })) };
        }
        if (sql.startsWith('UPDATE ingest_ledger')) {
          distilledIds.push((params as string[])[0]);
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO review_queue')) {
          proposedRows.push(params);
          return { rows: [] };
        }
        throw new Error(`unexpected query: ${sql}`);
      },
      // exposed for assertions
      _distilledIds: distilledIds,
      _proposedRows: proposedRows,
    } as unknown as Pool;
  }

  it('isolates a session whose LLM response fails to parse instead of aborting the run', async () => {
    const pool = fakePool();
    const llm: LlmClient = {
      complete: async (_system, user) =>
        user.includes('bad content')
          ? 'not json at all {'
          : '[{"statement":"uses pnpm","category":"fact","entities":[],"confidence":0.9}]',
    };
    const chunksBySession: Record<string, string[]> = {
      'bad-session': ['bad content'],
      'good-session': ['good content'],
    };
    const report = await distillPending({
      pool,
      llm,
      getSessionChunks: async (sid) => chunksBySession[sid],
    });

    expect(report.sessionsProcessed).toBe(1);
    expect(report.proposals).toBe(1);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].sessionId).toBe('bad-session');
    // both ledger entries still get marked distilled — a retry at temperature:0
    // would reproduce the same unparseable response
    expect((pool as unknown as { _distilledIds: string[] })._distilledIds).toEqual(['e1', 'e2']);
  });

  it('retries a truncated response with a halved transcript', async () => {
    const pool = fakePool();
    const seenLengths: number[] = [];
    const llm: LlmClient = {
      complete: async (_system, user) => {
        seenLengths.push(user.length);
        // a token-dense transcript overflows the context window until halved
        if (user.length > 30_000) throw new TruncatedLlmResponseError();
        return '[{"statement":"uses pnpm","category":"fact","entities":[],"confidence":0.9}]';
      },
    };
    const chunksBySession: Record<string, string[]> = {
      'bad-session': ['x'.repeat(60_000)],
      'good-session': ['good content'],
    };
    const report = await distillPending({
      pool,
      llm,
      getSessionChunks: async (sid) => chunksBySession[sid],
    });

    expect(report.sessionsProcessed).toBe(2);
    expect(report.proposals).toBe(2);
    expect(report.failures).toHaveLength(0);
    // 48k cap first, then halved to 24k, which fits
    expect(seenLengths.filter((l) => l > 30_000)).toHaveLength(1);
  });

  it('retries an unbalanced-JSON response the same way — truncation the gateway mislabeled as stop', async () => {
    const pool = fakePool();
    const llm: LlmClient = {
      complete: async (_system, user) =>
        user.length > 30_000
          ? '[{"statement":"cut off mid-arr'
          : '[{"statement":"uses pnpm","category":"fact","entities":[],"confidence":0.9}]',
    };
    const report = await distillPending({
      pool,
      llm,
      getSessionChunks: async () => ['x'.repeat(60_000)],
    });
    expect(report.failures).toHaveLength(0);
    expect(report.sessionsProcessed).toBe(2);
  });
});

describe('checkSupersedes', () => {
  const fact = (id: string, statement: string): Fact =>
    ({ id, statement, category: 'preference', entities: [], confidence: 1, source: 'user', provenance: [], status: 'active', superseded_by: null, created_at: new Date(), updated_at: new Date() });

  it('returns only ids the LLM names that exist among candidates', async () => {
    const llm: LlmClient = { complete: async () => '["f1","bogus"]' };
    const out = await checkSupersedes(llm, 'new', [fact('f1', 'old')]);
    expect(out).toEqual(['f1']);
  });

  it('is best-effort: LLM failure yields no supersedes', async () => {
    const llm: LlmClient = { complete: async () => { throw new Error('down'); } };
    const out = await checkSupersedes(llm, 'new', [fact('f1', 'old')]);
    expect(out).toEqual([]);
  });
});
