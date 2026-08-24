import type { Command } from 'commander';
import { ingestFile, ingestInbox } from '@memory/core';
import { createContext } from '../context.js';

export function registerIngest(program: Command): void {
  program
    .command('ingest')
    .description('Ingest the inbox (or one file with --file); dedupes via the ledger')
    .option('--file <path>', 'ingest a single file instead of scanning the inbox')
    .option('--device <name>', 'device label when using --file')
    .action(async (opts: { file?: string; device?: string }) => {
      const ctx = createContext();
      try {
        const deps = { pool: ctx.pool, qdrant: ctx.qdrant, embedder: ctx.embedder, cfg: ctx.cfg };
        const results = opts.file
          ? [await ingestFile(deps, opts.file, opts.device)]
          : await ingestInbox(deps);
        let quarantined = 0;
        for (const r of results) {
          const extra = r.error ? ` — ${r.error}` : '';
          console.log(`${r.status.padEnd(11)} ${r.file} (sessions=${r.sessions} chunks=${r.chunks} secrets=${r.secretsFound})${extra}`);
          if (r.status === 'quarantined') quarantined += 1;
        }
        if (results.length === 0) console.log('inbox empty — nothing to do');
        if (quarantined > 0) process.exit(1);
      } finally {
        await ctx.pool.end();
      }
    });
}
