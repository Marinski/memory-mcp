import { describe, it, expect, vi } from 'vitest';
import { createEmbedder } from '../src/vector/embed.js';

const cfg = { aigateBaseUrl: 'http://aigate:4000/v1', aigateApiKey: 'k', embedModel: 'm', embedDims: 4 };

function fakeFetch(calls: string[][]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const input = (JSON.parse(init.body as string) as { input: string[] }).input;
    calls.push(input);
    return {
      ok: true,
      json: async () => ({ data: input.map((_, i) => ({ index: i, embedding: [0, 0, 0, 0] })) }),
    } as Response;
  });
}

describe('createEmbedder batching', () => {
  it('splits a request once the combined char budget would be exceeded', async () => {
    const calls: string[][] = [];
    const embedder = createEmbedder(cfg, fakeFetch(calls) as unknown as typeof fetch);
    // three ~9000-char texts: budget is 16000, so batch 1 = [a,b] (18000 > budget after b?
    // a=9000 fits alone; a+b=18000 > 16000 so b starts a new batch), batch 2 = [b,c]... verify exact split below
    const texts = ['x'.repeat(9000), 'y'.repeat(9000), 'z'.repeat(9000)];
    const out = await embedder.embed(texts);
    expect(out).toHaveLength(3);
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      const totalChars = call.reduce((sum, t) => sum + t.length, 0);
      expect(totalChars).toBeLessThanOrEqual(16000);
    }
  });

  it('keeps small texts in one request under the count cap', async () => {
    const calls: string[][] = [];
    const embedder = createEmbedder(cfg, fakeFetch(calls) as unknown as typeof fetch);
    const texts = Array.from({ length: 10 }, (_, i) => `short text ${i}`);
    await embedder.embed(texts);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(10);
  });

  it('sends an oversized single text alone rather than dropping it', async () => {
    const calls: string[][] = [];
    const embedder = createEmbedder(cfg, fakeFetch(calls) as unknown as typeof fetch);
    const huge = 'x'.repeat(20000);
    const out = await embedder.embed([huge, 'short']);
    expect(out).toHaveLength(2);
    expect(calls[0]).toEqual([huge]);
  });
});
