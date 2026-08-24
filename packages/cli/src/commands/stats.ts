import type { Command } from 'commander';
import { memoryStats } from '@memory/core';
import { createContext } from '../context.js';

export function registerStats(program: Command): void {
  program
    .command('stats')
    .description('Counts across facts, archive, ledger, review queue')
    .action(async () => {
      const ctx = createContext();
      try {
        const s = await memoryStats(ctx.pool, ctx.qdrant);
        console.log(JSON.stringify(s, null, 2));
      } finally {
        await ctx.pool.end();
      }
    });
}
