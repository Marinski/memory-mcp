import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { ingestFile, type IngestDeps } from '../src/ingest/pipeline.js';
import type { QdrantClient } from '../src/vector/qdrant.js';
import type { Embedder } from '../src/vector/embed.js';

/** Fake pg pool capturing ledger writes; fake qdrant capturing upserts. */
function makeDeps(opts: { knownHashes?: Set<string> } = {}) {
  const ledgerRows: any[] = [];
  const pool = {
    query: vi.fn(async (sql: string, params?: any[]) => {
      if (sql.includes('SELECT 1 FROM ingest_ledger')) {
        const known = opts.knownHashes?.has(params![0]) ?? false;
        return { rowCount: known ? 1 : 0, rows: known ? [{ '?column?': 1 }] : [] };
      }
      if (sql.includes('INSERT INTO ingest_ledger')) {
        ledgerRows.push(params);
        return { rowCount: 1, rows: [{ id: 'ledger-1' }] };
      }
      return { rowCount: 0, rows: [] };
    }),
  } as any;

  const upserts: any[] = [];
  const deletedSessions: string[] = [];
  const qdrant: QdrantClient = {
    ensureCollection: vi.fn(),
    collectionInfo: vi.fn(),
    upsert: vi.fn(async (pts) => { upserts.push(...pts); }),
    queryHybrid: vi.fn(),
    deletePoints: vi.fn(),
    deleteBySession: vi.fn(async (sid) => { deletedSessions.push(sid); }),
    scrollBySession: vi.fn(),
    count: vi.fn(),
  } as any;

  const embedder: Embedder = {
    dims: 4,
    model: 'test',
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3, 0.4])),
  };

  const deps: IngestDeps = { pool, qdrant, embedder, cfg: { gitleaksPath: 'off', inboxDir: '/tmp/na' } };
  return { deps, ledgerRows, upserts, deletedSessions, pool };
}

function writeFixture(name: string, content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'memtest-'));
  const p = path.join(dir, name);
  writeFileSync(p, content);
  return p;
}

const CLAUDE_EXPORT = JSON.stringify([
  {
    uuid: 'p1',
    name: 't',
    created_at: '2025-01-01T00:00:00Z',
    chat_messages: [
      { sender: 'human', text: 'my key is sk-abcdef1234567890ABCDEF1234567890', created_at: '2025-01-01T00:00:01Z' },
      { sender: 'assistant', text: 'rotate it', created_at: '2025-01-01T00:00:02Z' },
    ],
  },
]);

describe('ingestFile', () => {
  it('ingests, scrubs before upsert, and records the ledger', async () => {
    const { deps, ledgerRows, upserts } = makeDeps();
    const file = writeFixture('export.json', CLAUDE_EXPORT);
    const res = await ingestFile(deps, file, 'workstation');
    expect(res.status).toBe('ingested');
    expect(res.secretsFound).toBeGreaterThanOrEqual(1);
    // the secret must arrive in Qdrant already redacted
    const stored = upserts.map((u) => u.payload.text).join('\n');
    expect(stored).not.toContain('sk-abcdef');
    expect(stored).toContain('[REDACTED:');
    expect(upserts[0].payload.device).toBe('workstation');
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0][6]).toBe('ingested'); // status param
  });

  it('is a no-op when the content hash is already in the ledger', async () => {
    const file = writeFixture('export.json', CLAUDE_EXPORT);
    const { createHash } = await import('node:crypto');
    const hash = createHash('sha256').update(CLAUDE_EXPORT).digest('hex');
    const { deps, upserts } = makeDeps({ knownHashes: new Set([hash]) });
    const res = await ingestFile(deps, file);
    expect(res.status).toBe('skipped');
    expect(upserts).toHaveLength(0);
  });

  it('quarantines malformed files and leaves nothing partial', async () => {
    const { deps, ledgerRows, upserts } = makeDeps();
    const file = writeFixture('bad.jsonl', 'this is not json\n');
    const res = await ingestFile(deps, file);
    expect(res.status).toBe('quarantined');
    expect(res.error).toBeTruthy();
    expect(upserts).toHaveLength(0);
    expect(ledgerRows[0][6]).toBe('quarantined');
  });

  it('treats infra failure as transient: rollback, no ledger record, retryable', async () => {
    const { deps, deletedSessions, ledgerRows } = makeDeps();
    let calls = 0;
    (deps.embedder.embed as any) = vi.fn(async (texts: string[]) => {
      calls += 1;
      if (calls > 1) throw new Error('embed backend down');
      return texts.map(() => [0.1, 0.2, 0.3, 0.4]);
    });
    const twoSessions = JSON.stringify([
      { uuid: 's1', chat_messages: [{ sender: 'human', text: 'first session text' }] },
      { uuid: 's2', chat_messages: [{ sender: 'human', text: 'second session text' }] },
    ]);
    const file = writeFixture('two.json', twoSessions);
    const res = await ingestFile(deps, file);
    expect(res.status).toBe('failed');
    expect(deletedSessions).toContain('claude:s1');
    // nothing recorded: the same file re-processes on the next run
    expect(ledgerRows).toHaveLength(0);
  });

  it('uses stable point ids so a cumulative re-export upserts instead of duplicating', async () => {
    const first = makeDeps();
    const fileA = writeFixture('export.json', CLAUDE_EXPORT);
    await ingestFile(first.deps, fileA);
    // same session shipped again inside a bigger (different-hash) export
    const cumulative = JSON.parse(CLAUDE_EXPORT);
    cumulative.push({ uuid: 'p2', chat_messages: [{ sender: 'human', text: 'a newer conversation' }] });
    const second = makeDeps();
    const fileB = writeFixture('export2.json', JSON.stringify(cumulative));
    await ingestFile(second.deps, fileB);
    const idsA = first.upserts.map((u) => u.id);
    const idsB = second.upserts.filter((u) => u.payload.session_id === 'claude:p1').map((u) => u.id);
    expect(idsB).toEqual(idsA); // overwrites, not duplicates
  });
});
