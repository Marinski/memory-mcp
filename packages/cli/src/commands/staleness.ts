import type { Command } from 'commander';
import { listStaleFacts } from '@memory/core';
import { createContext } from '../context.js';

export function registerStaleness(program: Command): void {
  program
    .command('staleness')
    .description('Report active facts older than N months and recently superseded facts')
    .option('--older-than <months>', 'months threshold for staleness', '3')
    .option('--recent <n>', 'number of recent superseded facts to show', '20')
    .action(async (opts: { olderThan: string; recent: string }) => {
      const ctx = createContext();
      try {
        const months = parseInt(opts.olderThan, 10);
        const recent = parseInt(opts.recent, 10);
        if (!Number.isInteger(months) || months <= 0 || !Number.isInteger(recent) || recent < 0) {
          console.error('--older-than and --recent must be positive integers');
          process.exit(2);
        }
        const r = await listStaleFacts(ctx.pool, {
          olderThanMonths: months,
          recentLimit: recent,
        });
        console.log(`active stale (> ${months} months): ${r.active_stale.length}`);
        console.log(`recently superseded: ${r.superseded_recent.length}`);
        if (r.active_stale.length > 0) {
          console.log('\nstale active facts:');
          for (const f of r.active_stale) {
            const age = Math.floor((Date.now() - f.updated_at.getTime()) / (1000 * 60 * 60 * 24));
            console.log(`  [${f.category}] ${f.statement} (${age}d old, id: ${f.id})`);
          }
        }
        if (r.superseded_recent.length > 0) {
          console.log('\nrecently superseded:');
          for (const f of r.superseded_recent) {
            const arrow = f.superseded_by ? ` → replaced by ${f.superseded_by}` : '';
            console.log(`  [${f.category}] ${f.statement}${arrow} (id: ${f.id})`);
          }
        }
      } finally {
        await ctx.pool.end();
      }
    });
}
