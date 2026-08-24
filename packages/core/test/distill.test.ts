import { describe, it, expect } from 'vitest';
import { validateProposals } from '../src/distill/extract.js';
import { extractJson } from '../src/distill/llm.js';
import { checkContradictions } from '../src/remember.js';
import type { Fact } from '../src/db/facts.js';
import type { LlmClient } from '../src/distill/llm.js';

describe('extractJson', () => {
  it('parses plain and fenced JSON', () => {
    expect(extractJson('[1,2]')).toEqual([1, 2]);
    expect(extractJson('Here you go:\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(() => extractJson('no json here')).toThrow();
  });
});

describe('validateProposals', () => {
  it('keeps valid proposals, drops junk, clamps confidence', () => {
    const out = validateProposals([
      { statement: 'Marin prefers Klaro for cookie consent', category: 'preference', entities: ['Klaro'], confidence: 1.7 },
      { statement: '', category: 'fact', entities: [], confidence: 0.5 },
      { statement: 'x', category: 'nonsense', entities: [], confidence: 0.5 },
      'not an object',
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].confidence).toBe(1);
  });
});

describe('checkContradictions', () => {
  const fact = (id: string, statement: string): Fact =>
    ({ id, statement, category: 'preference', entities: [], confidence: 1, source: 'user', provenance: [], status: 'active', superseded_by: null, created_at: new Date(), updated_at: new Date() });

  it('returns only ids the LLM names that exist among candidates', async () => {
    const llm: LlmClient = { complete: async () => '["f1","bogus"]' };
    const out = await checkContradictions(llm, 'new', [fact('f1', 'old')]);
    expect(out).toEqual(['f1']);
  });

  it('is best-effort: LLM failure yields no supersedes', async () => {
    const llm: LlmClient = { complete: async () => { throw new Error('down'); } };
    const out = await checkContradictions(llm, 'new', [fact('f1', 'old')]);
    expect(out).toEqual([]);
  });
});
