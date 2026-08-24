import type { Command } from 'commander';
import { migrate } from '@memory/core';
import { createContext } from '../context.js';

export function registerInit(program: Command): void {
  program
    .command('init')
    .description('Apply migrations and create the Qdrant collection (idempotent)')
    .action(async () => {
      const ctx = createContext();
      try {
        const version = await migrate(ctx.pool);
        const col = await ctx.qdrant.ensureCollection();
        console.log(`schema version: ${version}`);
        console.log(`qdrant collection '${ctx.cfg.qdrantCollection}': ${col.created ? 'created' : 'exists'} (dims ${col.dims})`);
      } finally {
        await ctx.pool.end();
      }
    });
}
