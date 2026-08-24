import { createHash } from 'node:crypto';
import { readFile, rename, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Pool } from 'pg';
import type { MemoryConfig } from '../config.js';
import type { Embedder } from '../vector/embed.js';
import type { QdrantClient, ChunkPayload } from '../vector/qdrant.js';
import { chunkPointId } from '../vector/qdrant.js';
import { sparseVector } from '../vector/sparse.js';
import { chunkSession } from '../vector/chunker.js';
import { detectSourceKind, parsers } from './parsers/index.js';
import { scrubSession } from './scrub.js';
import { ledgerHasHash, recordIngest } from '../db/ledger.js';

/**
 * parse -> normalize -> scrub (fail-closed) -> chunk -> embed -> upsert +
 * ledger. Outcomes:
 *  - 'ingested'    fully processed; ledger row makes re-runs no-ops
 *  - 'skipped'     content hash already in the ledger
 *  - 'quarantined' bad INPUT (unparseable / empty) — recorded in the ledger
 *                  so the identical file never re-processes
 *  - 'failed'      transient INFRASTRUCTURE error (embedder, Qdrant,
 *                  gitleaks) — nothing recorded, any upserted points rolled
 *                  back, the file stays in place so the next run retries it
 */

/** Bad input — quarantine. Everything else is treated as transient. */
class QuarantineError extends Error {}

export interface IngestDeps {
  pool: Pool;
  qdrant: QdrantClient;
  embedder: Embedder;
  cfg: Pick<MemoryConfig, 'gitleaksPath' | 'inboxDir'>;
}

export interface IngestFileResult {
  file: string;
  status: 'ingested' | 'skipped' | 'quarantined' | 'failed';
  sessions: number;
  chunks: number;
  secretsFound: number;
  error?: string;
}

export async function ingestFile(
  deps: IngestDeps,
  filePath: string,
  device?: string,
): Promise<IngestFileResult> {
  const { pool, qdrant, embedder, cfg } = deps;
  const raw = await readFile(filePath, 'utf8');
  const contentHash = createHash('sha256').update(raw).digest('hex');

  if (await ledgerHasHash(pool, contentHash)) {
    return { file: filePath, status: 'skipped', sessions: 0, chunks: 0, secretsFound: 0 };
  }

  const upsertedSessions: string[] = [];
  let sessions;
  try {
    const kind = detectSourceKind(filePath, raw);
    sessions = parsers[kind](raw, filePath).map((s) => (device ? { ...s, device } : s));
    if (sessions.length === 0) throw new Error('no sessions parsed from file');
  } catch (err) {
    // Parse/detect failures are bad input: quarantine and remember the hash.
    const msg = err instanceof Error ? err.message : String(err);
    await recordIngest(pool, {
      source_path: filePath,
      source_kind: 'unknown',
      content_hash: contentHash,
      sessions: 0,
      chunks: 0,
      secrets_found: 0,
      status: 'quarantined',
      sessionIds: [],
    });
    return { file: filePath, status: 'quarantined', sessions: 0, chunks: 0, secretsFound: 0, error: msg };
  }

  try {
    let totalChunks = 0;
    let totalSecrets = 0;
    const sessionIds: string[] = [];

    for (const session of sessions) {
      const { session: clean, secretsFound } = scrubSession(session, cfg.gitleaksPath);
      totalSecrets += secretsFound;
      const chunks = chunkSession(clean);
      if (chunks.length === 0) continue;
      const vectors = await embedder.embed(chunks.map((c) => c.text));
      const points = chunks.map((c, i) => {
        const payload: ChunkPayload = {
          session_id: clean.id,
          source_tool: clean.sourceTool,
          device: clean.device,
          project: clean.project,
          ts: clean.startedAt,
          turn_range: c.turnRange,
          text: c.text,
          content_hash: contentHash,
        };
        // Point id = f(session_id, chunk_index): a cumulative re-export of the
        // same session overwrites its own points instead of duplicating them.
        return { id: chunkPointId(clean.id, c.index), dense: vectors[i], sparse: sparseVector(c.text), payload };
      });
      await qdrant.upsert(points);
      upsertedSessions.push(clean.id);
      totalChunks += chunks.length;
      sessionIds.push(clean.id);
    }

    await recordIngest(pool, {
      source_path: filePath,
      source_kind: sessions[0].sourceTool,
      content_hash: contentHash,
      sessions: sessions.length,
      chunks: totalChunks,
      secrets_found: totalSecrets,
      status: 'ingested',
      sessionIds,
    });
    return { file: filePath, status: 'ingested', sessions: sessions.length, chunks: totalChunks, secretsFound: totalSecrets };
  } catch (err) {
    // Transient infrastructure failure (embedder / Qdrant / gitleaks):
    // nothing partial may remain queryable — roll back sessions whose
    // points already landed, record NOTHING in the ledger, and leave the
    // file where it is so the next run retries it.
    const msg = err instanceof Error ? err.message : String(err);
    for (const sid of upsertedSessions) {
      await deps.qdrant.deleteBySession(sid).catch(() => undefined);
    }
    return { file: filePath, status: 'failed', sessions: 0, chunks: 0, secretsFound: 0, error: msg };
  }
}

/**
 * Scan the inbox (one folder per device), ingest new files, move them to
 * archive/ on success or quarantine/ on failure.
 */
export async function ingestInbox(deps: IngestDeps): Promise<IngestFileResult[]> {
  const inbox = deps.cfg.inboxDir;
  const root = path.dirname(inbox);
  const archiveDir = path.join(root, 'archive');
  const quarantineDir = path.join(root, 'quarantine');
  await mkdir(archiveDir, { recursive: true });
  await mkdir(quarantineDir, { recursive: true });

  const results: IngestFileResult[] = [];
  const devices = await readdir(inbox).catch(() => [] as string[]);
  for (const device of devices) {
    const deviceDir = path.join(inbox, device);
    if (!(await stat(deviceDir)).isDirectory()) continue;
    const files = await walk(deviceDir);
    for (const file of files) {
      const res = await ingestFile(deps, file, device);
      results.push(res);
      const rel = path.relative(inbox, file);
      if (res.status === 'ingested' || res.status === 'skipped') {
        const dest = path.join(archiveDir, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(file, dest);
      } else if (res.status === 'quarantined') {
        const dest = path.join(quarantineDir, rel);
        await mkdir(path.dirname(dest), { recursive: true });
        await rename(file, dest);
      }
      // 'failed' (transient): file stays in the inbox for the next run
    }
  }
  return results;
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else if (entry.isFile() && !entry.name.startsWith('.')) out.push(p);
  }
  return out;
}
