import type { Command } from 'commander';
import { triagePending } from '@memory/core';
import { createContext } from '../context.js';

export function registerTriage(program: Command): void {
  program
    .command('triage')
    .description('Auto-resolve the review queue: reject duplicates and ephemera, approve the rest')
    .action(async () => {
      const ctx = createContext();
      try {
        const r = await triagePending(ctx.pool, ctx.llm);
        console.log(`candidates scanned: ${r.scanned}`);
        console.log(`rejected as exact duplicates: ${r.rejectedDuplicates}`);
        console.log(`rejected by judge (ephemera/near-dupes): ${r.rejectedByJudge}`);
        console.log(`approved: ${r.approved} (superseded ${r.superseded} older facts)`);
        if (r.leftPending > 0) console.log(`left pending for next run: ${r.leftPending}`);
      } finally {
        await ctx.pool.end();
      }
    });
}
