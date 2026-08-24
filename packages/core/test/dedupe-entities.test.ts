import { describe, it, expect } from 'vitest';
import { groupCandidates, validateMerges } from '../src/dedupe-entities.js';

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
