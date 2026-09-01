import { describe, it, expect, vi } from 'vitest';
import { createQdrantClient } from '../src/vector/qdrant.js';
import { listRecentSessions } from '../src/sessions.js';
import type { QdrantClient } from '../src/vector/qdrant.js';

function fakeQdrant(recentSessions: QdrantClient['recentSessions']): QdrantClient {
  return { recentSessions } as unknown as QdrantClient;
}

function chunk(sessionId: string, ts: number | undefined, sourceTool = 'chatgpt'): never {
  return {
    id: `point-${sessionId}-${ts ?? 'x'}`,
    payload: { session_id: sessionId, source_tool: sourceTool, ts },
  } as never;
}

describe('qdrant recentSessions', () => {
  it('aggregates chunks per session, sorts newest last_ts first, honors limit', async () => {
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      const points = [chunk('s1', 1000), chunk('s1', 3000), chunk('s2', 2000)];
      const filtered = body.filter?.must?.[0]?.key === 'project' ? points.slice(0, 1) : points;
      return { ok: true, json: async () => ({ result: { points: filtered, next_page_offset: null } }) } as Response;
    });
    const qdrant = createQdrantClient('http://qdrant:6333', 'mem', 4, fetchImpl as unknown as typeof fetch);

    const all = await qdrant.recentSessions(10);
    expect(all.map((s) => s.session_id)).toEqual(['s1', 's2']);
    expect(all[0]).toMatchObject({ session_id: 's1', source_tool: 'chatgpt', last_ts: 3000, chunk_count: 2 });
    expect(all[1]).toMatchObject({ session_id: 's2', last_ts: 2000, chunk_count: 1 });

    const limited = await qdrant.recentSessions(1);
    expect(limited).toHaveLength(1);
    expect(limited[0].session_id).toBe('s1');

    await qdrant.recentSessions(10, 'proj');
    const scrollBodies = fetchImpl.mock.calls.map(([, init]) => JSON.parse(String(init?.body)));
    expect(scrollBodies.some((b) => b.filter?.must?.[0]?.key === 'project' && b.filter.must[0].match.value === 'proj')).toBe(true);
  });

  it('sorts sessions without a timestamp last', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { points: [chunk('old', undefined), chunk('new', 5000)], next_page_offset: null } }),
    }) as Response);
    const qdrant = createQdrantClient('http://qdrant:6333', 'mem', 4, fetchImpl as unknown as typeof fetch);
    const sessions = await qdrant.recentSessions(10);
    expect(sessions.map((s) => s.session_id)).toEqual(['new', 'old']);
  });

  it('stops paginating when next_page_offset is exhausted', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      json: async () => ({ result: { points: [chunk('s1', 1)], next_page_offset: null } }),
    }) as Response);
    const qdrant = createQdrantClient('http://qdrant:6333', 'mem', 4, fetchImpl as unknown as typeof fetch);
    const sessions = await qdrant.recentSessions(10);
    expect(sessions).toHaveLength(1);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('listRecentSessions', () => {
  it('delegates with clamped default limit (10)', async () => {
    const recentSessions = vi.fn(async () => []);
    const sessions = await listRecentSessions(fakeQdrant(recentSessions as unknown as QdrantClient['recentSessions']));
    expect(sessions).toEqual([]);
    expect(recentSessions).toHaveBeenCalledWith(10, undefined);
  });

  it('clamps the limit to [1,100] and forwards project', async () => {
    const recentSessions = vi.fn(async () => []);
    const qdrant = fakeQdrant(recentSessions as unknown as QdrantClient['recentSessions']);
    await listRecentSessions(qdrant, { limit: 999, project: 'proj' });
    expect(recentSessions).toHaveBeenCalledWith(100, 'proj');
    await listRecentSessions(qdrant, { limit: 0 });
    expect(recentSessions).toHaveBeenLastCalledWith(1, undefined);
  });
});