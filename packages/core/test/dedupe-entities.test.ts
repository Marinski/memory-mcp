import { describe, it, expect } from 'vitest';
import { groupCandidates, validateMerges, findDuplicateEntities } from '../src/dedupe-entities.js';
import { LlmTimeoutError } from '../src/distill/llm.js';
import type { LlmClient } from '../src/distill/llm.js';
import type { Pool } from 'pg';

describe('groupCandidates', () => {
  it('groups pure case variants', () => {
    const groups = groupCandidates(['OpenCode', 'opencode', 'Opencode', 'unrelated']);
    expect(groups).toHaveLength(1);
    expect(groups[0].sort()).toEqual(['OpenCode', 'Opencode', 'opencode'].sort());
  });

  it('groups punctuation-only variants', () => {
    const groups = groupCandidates(['/data/mt5-shared', '/data/mt5-shared/']);
    expect(groups).toHaveLength(1);
  });

  it('groups a name with its fuller domain form', () => {
    const groups = groupCandidates(['algotradingspace', 'algotradingspace.com']);
    expect(groups).toHaveLength(1);
  });

  it('does not group different subdomains of the same domain', () => {
    // 'api.algotradingspace.com' does not start with 'algotradingspace' —
    // it starts with 'api', so the prefix relation correctly excludes it.
    const groups = groupCandidates(['algotradingspace', 'api.algotradingspace.com']);
    expect(groups).toHaveLength(0);
  });

  it('does not group a short shared prefix from a naming convention', () => {
    // 'ats' is a real entity elsewhere in the archive, but 'ats-design-system'
    // and 'ats-license-server' are different plugins, not the same as 'ats'
    // or each other — the length-ratio guard should reject all these pairs.
    const groups = groupCandidates(['ats', 'ats-design-system', 'ats-license-server']);
    expect(groups).toHaveLength(0);
  });

  it('does propose a candidate for a project vs. an unrelated same-word entity (LLM must reject it)', () => {
    // String similarity alone can't tell 'Tezgiah' (the project) from
    // 'Tezgiah Bread & Bakery' (the client's actual business) apart — that
    // requires reading the facts, which is the LLM judging step's job, not
    // this heuristic's. It's correct for this to surface as a candidate.
    const groups = groupCandidates(['Tezgiah', 'Tezgiah Bread & Bakery']);
    expect(groups).toHaveLength(1);
  });

  it('ignores entities with no related candidate', () => {
    const groups = groupCandidates(['Qdrant', 'Postgres', 'Nginx']);
    expect(groups).toHaveLength(0);
  });
});

describe('validateMerges', () => {
  const group = new Set(['MQL5', 'mql5-ea']);

  it('accepts a well-formed merge with plain reasoning', () => {
    const out = validateMerges(
      [{ canonical: 'MQL5', members: ['MQL5', 'mql5-ea'], reason: 'same MetaTrader scripting language' }],
      group,
    );
    expect(out).toHaveLength(1);
  });

  // Observed on a real run: the model's own reasoning argued against
  // merging, but the merge object was emitted anyway. This must never be
  // trusted over the model's own stated doubt.
  it.each([
    'they are distinct enough that a merge is risky... I will not merge them',
    'I will treat them as separate to avoid over-merging',
    'they are distinct entities',
    'They are distinct instances of the same service type, but represent different deployment targets/entities in this context',
  ])('drops a merge whose reasoning contradicts merging: %s', (reason) => {
    const out = validateMerges([{ canonical: 'MQL5', members: ['MQL5', 'mql5-ea'], reason }], group);
    expect(out).toHaveLength(0);
  });

  it('rejects a canonical not present in the candidate group', () => {
    const out = validateMerges([{ canonical: 'made-up', members: ['MQL5', 'mql5-ea'], reason: 'x' }], group);
    expect(out).toHaveLength(0);
  });

  it('rejects members outside the candidate group', () => {
    const out = validateMerges(
      [{ canonical: 'MQL5', members: ['MQL5', 'something-else'], reason: 'x' }],
      group,
    );
    expect(out).toHaveLength(0);
  });

  it('rejects a single-member merge', () => {
    const out = validateMerges([{ canonical: 'MQL5', members: ['MQL5'], reason: 'x' }], group);
    expect(out).toHaveLength(0);
  });

  it('drops the second claim on an entity already merged by an earlier item', () => {
    const out = validateMerges(
      [
        { canonical: 'MQL5', members: ['MQL5', 'mql5-ea'], reason: 'same thing' },
        { canonical: 'mql5-ea', members: ['MQL5', 'mql5-ea'], reason: 'also same thing' },
      ],
      group,
    );
    expect(out).toHaveLength(1);
  });
});

describe('findDuplicateEntities timeout retry', () => {
  /** Fake pool returning two facts whose entities form a candidate group. */
  function fakePool(): Pool {
    const facts = [
      {
        id: 'f1', statement: 'Uses OpenCode daily', category: 'fact',
        entities: ['OpenCode'], confidence: 0.9, source: 'distilled',
        provenance: [], project: null, status: 'active',
        superseded_by: null, created_at: new Date(), updated_at: new Date(),
      },
      {
        id: 'f2', statement: 'Prefers opencode over cursor', category: 'preference',
        entities: ['opencode'], confidence: 0.8, source: 'distilled',
        provenance: [], project: null, status: 'active',
        superseded_by: null, created_at: new Date(), updated_at: new Date(),
      },
    ];
    return {
      query: async (sql: string) => {
        if (sql.includes('FROM facts WHERE status')) return { rows: facts };
        throw new Error(`unexpected query: ${sql}`);
      },
    } as unknown as Pool;
  }

  it('absorbs first LlmTimeoutError and retries, then succeeds', async () => {
    let calls = 0;
    const llm: LlmClient = {
      complete: async (_s, _u, _opts) => {
        calls += 1;
        if (calls === 1) throw new LlmTimeoutError();
        return JSON.stringify([{ canonical: 'OpenCode', members: ['OpenCode', 'opencode'], reason: 'case variant' }]);
      },
    };
    const report = await findDuplicateEntities(fakePool(), llm);
    expect(report.proposals).toHaveLength(1);
    expect(report.failures).toHaveLength(0);
    expect(calls).toBe(2);
  });

  it('surfaces failure when two consecutive LlmTimeoutErrors occur', async () => {
    const llm: LlmClient = {
      complete: async () => { throw new LlmTimeoutError(); },
    };
    const report = await findDuplicateEntities(fakePool(), llm);
    expect(report.proposals).toHaveLength(0);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0].error).toBe('LLM request timed out');
  });
});
