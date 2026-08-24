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
 * Category is metadata, not a relationship, so an entity page does NOT
 * [[wikilink]] back to its category: ~1000 entity pages all linking back to
 * one of only 5 category pages was what turned those 5 into catastrophic
 * mega-hubs (in-degree in the hundreds each). Category shows up as a plain
 * heading on entity pages and as a `tags:` frontmatter property instead —
 * still visible in Graph view if wanted, but toggleable independently
 * (Filters > Tags) rather than baked into the link graph.
 *
 * The other direction — a category page (fact.md, project.md, ...) linking
 * OUT to the entities in its own facts — is kept as real [[wikilinks]]:
 * that's just one page with a few hundred outgoing links, a normal table of
 * contents, not the many-to-few fan-in that made the old design a problem.
 * If it still clutters Graph view, exclude those 5 known paths via Filters
 * rather than stripping the links — the pages stay just as useful to read
 * and click through either way.
 *
 * Two entities that co-occur in only one fact are also not linked — one
 * incidental shared mention (both happen to sit in the same sentence about
 * some umbrella host/tool) is weak evidence of an actual relationship, and
 * a few high-frequency "umbrella" entities co-occurring once each with
 * dozens of unrelated others is exactly what turns the graph into a dense,
 * low-information hairball. Repeated co-occurrence (MIN_COOCCURRENCE+) is
 * a real signal; a single one is just shared context, so it renders as
 * plain text instead.
 */
const MIN_COOCCURRENCE = 2;
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

        const byCategory = new Map<string, Fact[]>();
        const byEntity = new Map<string, Fact[]>();
        // JSON-encoded, not joined with a plain separator: entity names can
        // themselves contain spaces, so two different pairs must not collide
        // to the same joined string.
        const pairKey = (a: string, b: string) => (a < b ? JSON.stringify([a, b]) : JSON.stringify([b, a]));
        const pairCounts = new Map<string, number>();
        for (const f of facts) {
          (byCategory.get(f.category) ?? byCategory.set(f.category, []).get(f.category)!).push(f);
          for (const e of f.entities) {
            (byEntity.get(e) ?? byEntity.set(e, []).get(e)!).push(f);
          }
          const ents = [...new Set(f.entities)];
          for (let i = 0; i < ents.length; i++) {
            for (let j = i + 1; j < ents.length; j++) {
              const key = pairKey(ents[i], ents[j]);
              pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
            }
          }
        }
        // Only a repeatedly co-occurring pair gets a [[wikilink]]; a single
        // shared mention renders as plain text (see the note above).
        const renderRelated = (entity: string, related: string[]) =>
          related.length
            ? ` _(${related
                .map((e) => ((pairCounts.get(pairKey(entity, e)) ?? 0) >= MIN_COOCCURRENCE ? link(e) : e))
                .join(', ')})_`
            : '';

        for (const [category, list] of byCategory) {
          const lines = [`# ${category}`, ''];
          for (const f of list) {
            lines.push(`- ${f.statement}${entityLinks(f.entities)} <!-- fact:${f.id} source:${f.source} -->`);
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
              lines.push(`- ${f.statement}${renderRelated(entity, related)} <!-- fact:${f.id} source:${f.source} -->`);
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
