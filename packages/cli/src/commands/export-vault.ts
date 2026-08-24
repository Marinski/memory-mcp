import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { listRecentFacts } from '@memory/core';
import { createContext } from '../context.js';

/**
 * Writes active facts as markdown into a vault directory (Obsidian-friendly),
 * one file per category plus an index.
 */
export function registerExportVault(program: Command): void {
  program
    .command('export-vault')
    .description('Export active facts as markdown into a vault directory')
    .requiredOption('--out <dir>', 'target directory')
    .action(async (opts: { out: string }) => {
      const ctx = createContext();
      try {
        const facts = await listRecentFacts(ctx.pool, 10_000);
        await mkdir(opts.out, { recursive: true });
        const byCategory = new Map<string, typeof facts>();
        for (const f of facts) {
          const list = byCategory.get(f.category) ?? [];
          list.push(f);
          byCategory.set(f.category, list);
        }
        for (const [category, list] of byCategory) {
          const lines = [`# ${category}`, ''];
          for (const f of list) {
            const ents = f.entities.length ? ` _( ${f.entities.join(', ')} )_` : '';
            lines.push(`- ${f.statement}${ents} <!-- fact:${f.id} source:${f.source} -->`);
          }
          await writeFile(path.join(opts.out, `${category}.md`), lines.join('\n') + '\n');
        }
        await writeFile(
          path.join(opts.out, 'index.md'),
          `# Memory vault\n\nExported ${new Date().toISOString()} — ${facts.length} active facts.\n\n` +
            [...byCategory.keys()].map((c) => `- [[${c}]]`).join('\n') + '\n',
        );
        console.log(`exported ${facts.length} facts to ${opts.out}`);
      } finally {
        await ctx.pool.end();
      }
    });
}
