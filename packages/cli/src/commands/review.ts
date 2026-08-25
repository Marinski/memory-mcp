import { createInterface } from 'node:readline/promises';
import type { Command } from 'commander';
import { pendingReviews, approveReview, rejectReview, type ProposedFact } from '@memory/core';
import { createContext } from '../context.js';

/**
 * Interactive review of distilled fact candidates. Approval is the only
 * path by which a distilled candidate becomes an active fact.
 */
export function registerReview(program: Command): void {
  program
    .command('review')
    .description('Approve / edit / reject distilled fact candidates')
    .action(async () => {
      const ctx = createContext();
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const items = await pendingReviews(ctx.pool);
        if (items.length === 0) {
          console.log('review queue empty');
          return;
        }
        console.log(`${items.length} candidate(s) pending\n`);
        for (const item of items) {
          const f = item.proposed_fact;
          console.log(`— [${f.category}] ${f.statement}`);
          console.log(`  entities: ${f.entities.join(', ') || '(none)'}  confidence: ${f.confidence}  session: ${item.session_ref}`);
          const answer = (await rl.question('  [a]pprove / [e]dit / [r]eject / [s]kip / [q]uit > ')).trim().toLowerCase();
          if (answer === 'q') break;
          if (answer === 's' || answer === '') continue;
          if (answer === 'r') {
            await rejectReview(ctx.pool, item.id);
            console.log('  rejected');
            continue;
          }
          let edited: Partial<ProposedFact> | undefined;
          if (answer === 'e') {
            const statement = (await rl.question(`  statement [${f.statement}]: `)).trim();
            const category = (await rl.question(`  category [${f.category}]: `)).trim();
            const entities = (await rl.question(`  entities csv [${f.entities.join(',')}]: `)).trim();
            const VALID = ['preference', 'decision', 'fact', 'project', 'person'];
            if (category && !VALID.includes(category)) {
              console.log(`  invalid category '${category}' (valid: ${VALID.join(', ')}) — keeping '${f.category}'`);
            }
            edited = {
              ...(statement ? { statement } : {}),
              ...(category && VALID.includes(category) ? { category: category as ProposedFact['category'] } : {}),
              ...(entities ? { entities: entities.split(',').map((e) => e.trim()).filter(Boolean) } : {}),
            };
          }
          const result = await approveReview(ctx.pool, ctx.llm, item.id, edited);
          if (!result) {
            console.log('  already resolved');
          } else {
            const supersedeNote = result.superseded.length ? `, superseded ${result.superseded.length}` : '';
            console.log(`  approved -> fact ${result.fact.id}${supersedeNote}`);
          }
        }
      } finally {
        rl.close();
        await ctx.pool.end();
      }
    });
}
