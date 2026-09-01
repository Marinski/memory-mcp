import { describe, it, expect, vi } from 'vitest';
import { backfillFactProjects } from '../src/projects.js';
import type { Pool } from 'pg';
import type { QdrantClient } from '../src/vector/qdrant.js';

const payload = (session_id: string, project?: string) => ({
  session_id,
  source_tool: 'claude-code',
  ...(project ? { project } : {}),
  turn_range: '0',
  text: 't',
  content_hash: 'h',
});

describe('backfillFactProjects', () => {
  it('sets facts.project from the session project in the archive', async () => {
    const updated: { id: string; project: string }[] = [];
    const pool = {
      query: vi.fn(async (sql: string, params?: unknown[]) => {
        if (sql.includes('FROM facts WHERE project IS NULL')) {
          return {
            rows: [
              { id: 'f1', provenance: [{ session_id: 's1' }] },
              { id: 'f2', provenance: [{ session_id: 's2' }] },
              { id: 'f3', provenance: [{ session_id: 's3' }] },
            ],
          };
        }
        if (sql.startsWith('UPDATE facts SET project')) {
          updated.push({ id: params![1] as string, project: params![0] as string });
          return { rowCount: 1 };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as Pool;
    const qdrant = {
      scrollBySession: vi.fn(async (sid: string) => {
        if (sid === 's1') return [{ id: 'x', payload: payload('s1', 'infra') }];
        if (sid === 's2') return [{ id: 'y', payload: payload('s2') }];
        return [];
      }),
    } as unknown as QdrantClient;

    const report = await backfillFactProjects(pool, qdrant);

    expect(report).toEqual({ factsScanned: 3, sessionsResolved: 1, factsUpdated: 1, unresolved: 2 });
    expect(updated).toEqual([{ id: 'f1', project: 'infra' }]);
    expect(qdrant.scrollBySession).toHaveBeenCalledTimes(3);
  });

  it('leaves facts with no project in their sessions NULL and reports them unresolved', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM facts WHERE project IS NULL')) {
          return { rows: [{ id: 'f1', provenance: [{ session_id: 's1' }] }] };
        }
        if (sql.startsWith('UPDATE facts SET project')) return { rowCount: 0 };
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as Pool;
    const qdrant = {
      scrollBySession: vi.fn(async () => [{ id: 'x', payload: payload('s1') }]),
    } as unknown as QdrantClient;

    const report = await backfillFactProjects(pool, qdrant);

    expect(report).toEqual({ factsScanned: 1, sessionsResolved: 0, factsUpdated: 0, unresolved: 1 });
  });

  it('does not scan facts that carry no provenance', async () => {
    const pool = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('FROM facts WHERE project IS NULL')) {
          return { rows: [{ id: 'f1', provenance: [] }] };
        }
        throw new Error(`unexpected query: ${sql}`);
      }),
    } as unknown as Pool;
    const qdrant = { scrollBySession: vi.fn() } as unknown as QdrantClient;

    const report = await backfillFactProjects(pool, qdrant);

    expect(report).toEqual({ factsScanned: 1, sessionsResolved: 0, factsUpdated: 0, unresolved: 1 });
    expect(qdrant.scrollBySession).not.toHaveBeenCalled();
  });
});