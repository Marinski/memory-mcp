import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { listRecentFacts, type Fact } from '@memory/core';
import { createContext } from '../context.js';

const INVALID_FILENAME_CHARS = /[\\/:*?"<>|\x00-\x1f]/g;

/** Windows/Obsidian-safe filename for an entity, disambiguated on collision. */
function slugify(name: string, usedSlugs: Map<string, string>): string {
  let slug = name.trim().replace(INVALID_FILENAME_CHARS, '-').replace(/[. ]+$/, '');
  if (!slug) slug = 'untitled';
  const key = slug.toLowerCase();
  const owner = usedSlugs.get(key);
  if (owner !== undefined && owner !== name) {
    slug = `${slug} (${Buffer.from(name).toString('hex').slice(0, 6)})`;
  }
  usedSlugs.set(key, name);
  return slug;
}

/**
 * Writes active facts as markdown into a vault directory (Obsidian-friendly):
 * one file per category, one file per entity (project/tool/person mentioned
 * in a fact), and an index. Entities [[wikilink]] each other when they
 * co-occur in the same fact — that's real relational structure, and it's
 * what gives Obsidian's graph view something worth drawing.
 *
 * Category is metadata, not a relationship, so it is NOT a wikilink: every
 * fact and every entity would otherwise link to one of only 5 category
 * pages, turning them into artificial mega-hubs that drown out the actual
 * entity structure. Category shows up as a plain heading on entity pages
 * and as a `tags:` frontmatter property instead — still visible in Graph
 * view if wanted, but toggleable independently (Filters > Tags) rather than
 * baked into the link graph.
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

        // Full regenerate so a fact that's superseded/deleted doesn't leave
        // a stale page behind — the export always mirrors current state.
        await rm(opts.out, { recursive: true, force: true });
        const entitiesDir = path.join(opts.out, 'entities');
        await mkdir(entitiesDir, { recursive: true });

        const usedSlugs = new Map<string, string>();
        const entitySlug = new Map<string, string>();
        for (const f of facts) {
          for (const e of f.entities) {
            if (!entitySlug.has(e)) entitySlug.set(e, slugify(e, usedSlugs));
          }
        }
        const link = (entity: string) => `[[entities/${entitySlug.get(entity)}|${entity}]]`;
        const entityLinks = (list: string[]) =>
          list.length ? ` _(${list.map(link).join(', ')})_` : '';
        const entityPlain = (list: string[]) => (list.length ? ` _(${list.join(', ')})_` : '');

        const byCategory = new Map<string, Fact[]>();
        const byEntity = new Map<string, Fact[]>();
        for (const f of facts) {
          (byCategory.get(f.category) ?? byCategory.set(f.category, []).get(f.category)!).push(f);
          for (const e of f.entities) {
            (byEntity.get(e) ?? byEntity.set(e, []).get(e)!).push(f);
          }
        }

        for (const [category, list] of byCategory) {
          // Entity mentions are plain text here, not [[wikilinks]] — see the
          // category-vs-relationship note above.
          const lines = [`# ${category}`, ''];
          for (const f of list) {
            lines.push(`- ${f.statement}${entityPlain(f.entities)} <!-- fact:${f.id} source:${f.source} -->`);
          }
          await writeFile(path.join(opts.out, `${category}.md`), lines.join('\n') + '\n');
        }

        for (const [entity, list] of byEntity) {
          const slug = entitySlug.get(entity)!;
          const byCat = new Map<string, Fact[]>();
          for (const f of list) {
            (byCat.get(f.category) ?? byCat.set(f.category, []).get(f.category)!).push(f);
          }
          const categories = [...byCat.keys()].sort();
          const lines = [
            '---',
            `tags: [${categories.join(', ')}]`,
            '---',
            '',
            `# ${entity}`,
            '',
          ];
          for (const category of categories) {
            const catFacts = byCat.get(category)!;
            lines.push(`## ${category}`, '');
            for (const f of catFacts) {
              const related = f.entities.filter((e) => e !== entity);
              lines.push(`- ${f.statement}${entityLinks(related)} <!-- fact:${f.id} source:${f.source} -->`);
            }
            lines.push('');
          }
          await writeFile(path.join(entitiesDir, `${slug}.md`), lines.join('\n') + '\n');
        }

        const topEntities = [...byEntity.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 40);
        await writeFile(
          path.join(opts.out, 'index.md'),
          `# Memory vault\n\n` +
            `Exported ${new Date().toISOString()} — ${facts.length} active facts, ${byEntity.size} entities.\n\n` +
            `## Categories\n\n${[...byCategory.keys()].map((c) => `- [[${c}]]`).join('\n')}\n\n` +
            `## Most-mentioned projects & tools\n\n${topEntities
              .map(([e, list]) => `- ${link(e)} (${list.length})`)
              .join('\n')}\n`,
        );

        console.log(`exported ${facts.length} facts (${byEntity.size} entities) to ${opts.out}`);
      } finally {
        await ctx.pool.end();
      }
    });
}
