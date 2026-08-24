import { describe, it, expect, vi } from 'vitest';
import { executeForgetByQuery } from '../src/forget.js';
import type { QdrantClient } from '../src/vector/qdrant.js';
import type { Embedder } from '../src/vector/embed.js';

describe('executeForgetByQuery', () => {
  it('deletes in rounds until nothing matches (beyond the per-search top-K)', async () => {
    // 2 waves of archive matches: the second wave only surfaces after the
    // first is deleted — a single-pass delete would leave it behind.
    const waves = [
      [{ id: 'c1', score: 0.9, payload: { session_id: 's1', source_tool: 'chatgpt', turn_range: '0', text: 'secret a', content_hash: 'h' } }],
      [{ id: 'c2', score: 0.8, payload: { session_id: 's1', source_tool: 'chatgpt', turn_range: '1', text: 'secret b', content_hash: 'h' } }],
      [],
    ];
    let call = 0;
    const qdrant = {
      queryHybrid: vi.fn(async () => waves[Math.min(call++, waves.length - 1)]),
      deletePoints: vi.fn(async () => undefined),
    } as unknown as QdrantClient;
    const embedder: Embedder = { dims: 4, model: 't', embed: vi.fn(async (t: string[]) => t.map(() => [1, 0, 0, 0])) };
    const pool = { query: vi.fn(async () => ({ rows: [], rowCount: 0 })) } as never;

    const outcome = await executeForgetByQuery(pool, qdrant, embedder, 'secret');
    expect(outcome.deleted_chunks).toBe(2);
    expect(qdrant.deletePoints).toHaveBeenCalledWith(['c1']);
    expect(qdrant.deletePoints).toHaveBeenCalledWith(['c2']);
  });
});
