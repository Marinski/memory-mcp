import type { Command } from 'commander';
import { findDuplicateEntities, applyEntityMerges } from '@memory/core';
import { createContext } from '../context.js';

export function registerDedupeEntities(program: Command): void {
  program
    .command('dedupe-entities')
    .description('Find and (optionally) merge near-duplicate entity names, LLM-judged against real fact content')
    .option('--apply', 'apply the proposed merges (default: dry run, prints proposals only)')
    .action(async (opts: { apply?: boolean }) => {
      const ctx = createContext();
      try {
        const report = await findDuplicateEntities(ctx.pool, ctx.llm);
        console.log(
          `${report.entitiesConsidered} entities, ${report.groupsEvaluated} candidate group(s) evaluated` +
            (report.groupsSkippedTooLarge > 0 ? ` (${report.groupsSkippedTooLarge} skipped, too large)` : ''),
        );

        if (report.proposals.length === 0) {
          console.log('no merges proposed');
        } else {
          console.log(`\n${report.proposals.length} merge(s) proposed:\n`);
          for (const p of report.proposals) {
            const rest = p.members.filter((m) => m !== p.canonical);
            console.log(`  "${p.canonical}" <- ${rest.map((m) => `"${m}"`).join(', ')}`);
            if (p.reason) console.log(`    ${p.reason}`);
          }
        }

        if (report.failures.length > 0) {
          console.log(`\n${report.failures.length} group(s) failed to evaluate (unparseable LLM response):`);
          for (const f of report.failures) console.log(`  ${f.group.join(', ')}: ${f.error}`);
        }

        if (opts.apply) {
          const touched = await applyEntityMerges(ctx.pool, report.proposals);
          console.log(`\napplied: ${touched} fact(s) updated`);
        } else if (report.proposals.length > 0) {
          console.log(`\ndry run — re-run with --apply to merge these`);
        }
      } finally {
        await ctx.pool.end();
      }
    });
}
