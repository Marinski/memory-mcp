import type { Command } from 'commander';
import { createContext } from '../context.js';

/**
 * Rebuild the archive collection after an EMBED_MODEL/EMBED_DIMS change.
 * v1 keeps this deliberately simple: it drops the collection and tells you
 * to re-run ingest from the archived inbox files (the ledger is cleared so
 * hashes re-process). Re-embedding in place would need the raw chunk text
 * of every point re-sent through the new model anyway.
 */
export function registerReembed(program: Command): void {
  program
    .command('reembed')
    .description('Drop the archive collection + ledger so ingest can rebuild with new embeddings')
    .option('--yes', 'skip confirmation')
    .action(async (opts: { yes?: boolean }) => {
      if (!opts.yes) {
        console.error('this drops the Qdrant collection and clears the ingest ledger; re-run with --yes');
        process.exit(1);
      }
      const ctx = createContext();
      try {
        const res = await fetch(`${ctx.cfg.qdrantUrl.replace(/\/+$/, '')}/collections/${ctx.cfg.qdrantCollection}`, { method: 'DELETE' });
        if (!res.ok) throw new Error(`failed to drop collection: ${res.status}`);
        await ctx.pool.query('TRUNCATE ingest_ledger CASCADE');
        await ctx.qdrant.ensureCollection();
        console.log(`collection recreated with dims ${ctx.cfg.embedDims}; ledger cleared`);
        console.log(`move archived files back into the inbox and run 'memoryctl ingest'`);
      } finally {
        await ctx.pool.end();
      }
    });
}
