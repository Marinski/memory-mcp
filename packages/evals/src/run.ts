import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import {
  loadConfig,
  createPool,
  createQdrantClient,
  createEmbedder,
  searchArchive,
} from '@memory/core';

/**
 * Retrieval quality harness: recall@k, MRR, p95 latency over golden.yaml.
 * Runs against the live stores (ingest fixtures/exports first). Exits
 * non-zero when recall@5 < 0.8 so it can gate changes.
 */

interface GoldenQuery {
  query: string;
  expected_sessions: string[];
}

const K = 5;
const RECALL_TARGET = 0.8;

async function main(): Promise<void> {
  const dir = path.dirname(fileURLToPath(import.meta.url));
  const goldenPath = path.resolve(dir, '..', '..', 'golden.yaml');
  const golden = parse(readFileSync(goldenPath, 'utf8')) as { queries: GoldenQuery[] };

  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const qdrant = createQdrantClient(cfg.qdrantUrl, cfg.qdrantCollection, cfg.embedDims);
  const embedder = createEmbedder(cfg);

  let hits = 0;
  let rrSum = 0;
  const latencies: number[] = [];
  const misses: string[] = [];

  for (const q of golden.queries) {
    const t0 = performance.now();
    const results = await searchArchive(qdrant, embedder, q.query, { limit: K });
    latencies.push(performance.now() - t0);
    const sessions = results.map((r) => r.session_id);
    const rank = sessions.findIndex((s) => q.expected_sessions.includes(s));
    if (rank >= 0) {
      hits += 1;
      rrSum += 1 / (rank + 1);
    } else {
      misses.push(q.query);
    }
  }

  const n = golden.queries.length;
  const recall = n ? hits / n : 0;
  const mrr = n ? rrSum / n : 0;
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * 0.95))] ?? 0;

  console.log(`queries:    ${n}`);
  console.log(`recall@${K}:  ${recall.toFixed(3)} (target >= ${RECALL_TARGET})`);
  console.log(`MRR:        ${mrr.toFixed(3)}`);
  console.log(`p95 latency: ${p95.toFixed(0)} ms`);
  if (misses.length) {
    console.log(`\nmisses:`);
    for (const m of misses) console.log(`  - ${m}`);
  }

  await pool.end();
  if (recall < RECALL_TARGET) {
    console.error(`\nrecall@${K} below target — tune chunking/fusion or document unreachable queries in golden.yaml`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
