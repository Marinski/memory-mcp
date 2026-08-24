import type { Command } from 'commander';
import { distillPending } from '@memory/core';
import { createContext } from '../context.js';

export function registerDistill(program: Command): void {
  program
    .command('distill')
    .description('Extract candidate facts from un-distilled sessions into the review queue')
    .action(async () => {
      const ctx = createContext();
      try {
        const report = await distillPending({
          pool: ctx.pool,
          llm: ctx.llm,
          getSessionChunks: async (sid) => {
            const points = await ctx.qdrant.scrollBySession(sid);
            return points.map((p) => p.payload.text);
          },
        });
        console.log(`sessions processed: ${report.sessionsProcessed}`);
        console.log(`fact candidates queued for review: ${report.proposals}`);
        if (report.proposals > 0) console.log(`run 'memoryctl review' to approve/reject`);
      } finally {
        await ctx.pool.end();
      }
    });
}
