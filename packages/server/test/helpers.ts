import { vi } from 'vitest';
import type { ServerDeps } from '../src/deps.js';
import type { MemoryConfig } from '@memory/core';

export const testConfig: MemoryConfig = {
  databaseUrl: 'postgres://test',
  qdrantUrl: 'http://qdrant:6333',
  qdrantCollection: 'memory_archive',
  aigateBaseUrl: 'http://aigate:4000/v1',
  aigateApiKey: 'test-key',
  embedModel: 'bge-m3',
  embedDims: 4,
  distillModel: 'gemma-4-26b-a4b',
  listen: '127.0.0.1:0',
  authMode: 'static',
  staticBearer: 'test-bearer-token-0123456789abcdef',
  inboxDir: '/tmp/inbox',
  maxResultKb: 50,
  gitleaksPath: 'off',
};

export function fakeDeps(): ServerDeps {
  return {
    cfg: testConfig,
    pool: { query: vi.fn(async () => ({ rows: [], rowCount: 0 })), end: vi.fn() } as never,
    qdrant: {
      ensureCollection: vi.fn(),
      collectionInfo: vi.fn(),
      upsert: vi.fn(),
      queryHybrid: vi.fn(async () => []),
      deletePoints: vi.fn(),
      deleteBySession: vi.fn(),
      scrollBySession: vi.fn(async () => []),
      count: vi.fn(async () => 0),
    } as never,
    embedder: { dims: 4, model: 'test', embed: vi.fn(async (t: string[]) => t.map(() => [1, 0, 0, 0])) },
    llm: { complete: vi.fn(async () => '[]') },
  };
}
