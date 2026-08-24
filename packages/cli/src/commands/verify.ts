import type { Command } from 'commander';
import { createContext } from '../context.js';

export function registerVerify(program: Command): void {
  program
    .command('verify')
    .description('Report schema version, collection dims, and connectivity to Postgres, Qdrant, aigate')
    .action(async () => {
      const ctx = createContext();
      let failures = 0;
      try {
        try {
          const res = await ctx.pool.query('SELECT max(version) AS v FROM schema_migrations');
          console.log(`postgres: ok (schema version ${res.rows[0].v})`);
        } catch (err) {
          failures += 1;
          console.error(`postgres: FAIL — ${err instanceof Error ? err.message : err}`);
        }
        try {
          const info = await ctx.qdrant.collectionInfo();
          const match = info.dims === ctx.cfg.embedDims ? 'matches EMBED_DIMS' : `MISMATCH: EMBED_DIMS=${ctx.cfg.embedDims}`;
          console.log(`qdrant: ok (collection dims ${info.dims}, ${match}; ${info.points} points)`);
          if (info.dims !== ctx.cfg.embedDims) failures += 1;
        } catch (err) {
          failures += 1;
          console.error(`qdrant: FAIL — ${err instanceof Error ? err.message : err}`);
        }
        try {
          const [v] = await ctx.embedder.embed(['connectivity probe']);
          console.log(`aigate embeddings: ok (${ctx.cfg.embedModel}, ${v.length} dims)`);
        } catch (err) {
          failures += 1;
          console.error(`aigate embeddings: FAIL — ${err instanceof Error ? err.message : err}`);
        }
      } finally {
        await ctx.pool.end();
      }
      if (failures > 0) process.exit(1);
    });
}
