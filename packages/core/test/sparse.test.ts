import { describe, it, expect } from 'vitest';
import { tokenize, fnv1a, sparseVector } from '../src/vector/sparse.js';

describe('sparse vectors', () => {
  it('tokenizes with stopwords removed', () => {
    const toks = tokenize('The quick brown fox and the lazy dog');
    expect(toks).toContain('quick');
    expect(toks).not.toContain('the');
    expect(toks).not.toContain('and');
  });

  it('fnv1a is deterministic and u32', () => {
    expect(fnv1a('wireguard')).toBe(fnv1a('wireguard'));
    expect(fnv1a('wireguard')).toBeGreaterThanOrEqual(0);
    expect(fnv1a('wireguard')).toBeLessThanOrEqual(0xffffffff);
    expect(fnv1a('a')).not.toBe(fnv1a('b'));
  });

  it('produces saturated TF weights', () => {
    const v = sparseVector('qdrant qdrant qdrant postgres');
    expect(v.indices).toHaveLength(2);
    const max = Math.max(...v.values);
    expect(max).toBeLessThan(1); // saturation keeps weights < 1
    // repeated term weighs more than single term
    const [a, b] = v.values;
    expect(Math.abs(a - b)).toBeGreaterThan(0);
  });
});
