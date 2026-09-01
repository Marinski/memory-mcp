import type { Command } from 'commander';
import { backfillFactProjects } from '@memory/core';
import { createContext } from '../context.js';

export function registerBackfillProjects(program: Command): void {
  program
    .command('backfill-projects')
    .description('Set facts.project from session project metadata in the archive')
    .action(async () => {
      const ctx = createContext();
      try {
        const r = await backfillFactProjects(ctx.pool, ctx.qdrant);
        console.log(`facts scanned: ${r.factsScanned}`);
        console.log(`sessions resolved to a project: ${r.sessionsResolved}`);
        console.log(`facts updated: ${r.factsUpdated}`);
        console.log(`facts left unresolved (no project in session archive): ${r.unresolved}`);
      } finally {
        await ctx.pool.end();
      }
    });
}