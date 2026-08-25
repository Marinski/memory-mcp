import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Command } from 'commander';
import { allFacts, type Fact } from '@memory/core';
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
 * The other direction — a category page (decision.md, project.md, ...)
 * linking OUT to the entities in its own facts — is kept as real
 * [[wikilinks]]: a table of contents for a category with dozens to a few
 * hundred facts is exactly the many-to-few fan-out Graph view can render
 * usefully. fact.md is the exception: it's the generic catch-all category
 * (over half of all facts land there), so its link count scales into the
 * thousands and turns fact.md itself into a hub as bad as the one this
 * design was built to avoid. Its entity mentions render as plain text
 * instead — still readable, just not a graph edge.
 *
 * Two entities that co-occur in only one fact are also not linked — one
 * incidental shared mention (both happen to sit in the same sentence about
 * some umbrella host/tool) is weak evidence of an actual relationship, and
 * a few high-frequency "umbrella" entities co-occurring once each with
 * dozens of unrelated others is exactly what turns the graph into a dense,
 * low-information hairball. Repeated co-occurrence (MIN_COOCCURRENCE+) is
 * a real signal; a single one is just shared context, so it renders as
 * plain text instead.
 *
 * daily/YYYY-MM-DD.md is a different kind of page from everything above: a
 * historical event log rather than a current-state view. Category/entity
 * pages only ever show active facts (current truth); a day's file instead
 * records what HAPPENED that day and never needs to change once written —
 * "Learned" entries are keyed by created_at, "Superseded" entries by the day
 * the replacement happened (updated_at), not the day the old fact was
 * originally learned, so a past day's file is never retroactively edited.
 * Dated by created_at/updated_at (when memory-mcp recorded the event), not
 * the source session's actual date — cheap and always available, at the
 * cost of some lag when review runs well after ingest.
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
        const allFactRows = await allFacts(ctx.pool, 10_000);
        // Category/entity/index pages show current truth only — same
        // active-only set listRecentFacts would have returned.
        const facts = allFactRows.filter((f) => f.status === 'active');

        // Full regenerate so a fact that's superseded/deleted doesn't leave
        // a stale page behind — the export always mirrors current state.
        await rm(opts.out, { recursive: true, force: true });
        const entitiesDir = path.join(opts.out, 'entities');
        const dailyDir = path.join(opts.out, 'daily');
        await mkdir(entitiesDir, { recursive: true });
        await mkdir(dailyDir, { recursive: true });

        const usedSlugs = new Map<string, string>();
        const entitySlug = new Map<string, string>();
        // Built from every fact regardless of status, not just active ones:
        // the daily log links entities mentioned in now-superseded facts
        // too, and every entity ever mentioned needs a stable slug so that
        // link() never renders "undefined" for one whose only mentions have
        // since gone stale (its entity page simply won't exist, which
        // Obsidian shows as a normal unresolved link).
        for (const f of allFactRows) {
          for (const e of f.entities) {
            if (!entitySlug.has(e)) entitySlug.set(e, slugify(e, usedSlugs));
          }
        }
        const link = (entity: string) => `[[entities/${entitySlug.get(entity)}|${entity}]]`;
        const entityLinks = (list: string[]) =>
          list.length ? ` _(${list.map(link).join(', ')})_` : '';
        const entityMentions = (list: string[]) => (list.length ? ` _(${list.join(', ')})_` : '');

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
          const mentions = category === 'fact' ? entityMentions : entityLinks;
          for (const f of list) {
            lines.push(`- ${f.statement}${mentions(f.entities)} <!-- fact:${f.id} source:${f.source} -->`);
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

        const dayKey = (d: Date) => d.toISOString().slice(0, 10);
        const factById = new Map(allFactRows.map((f) => [f.id, f]));
        const learnedByDay = new Map<string, Fact[]>();
        const supersededByDay = new Map<string, Fact[]>();
        for (const f of allFactRows) {
          const learnedDay = dayKey(f.created_at);
          (learnedByDay.get(learnedDay) ?? learnedByDay.set(learnedDay, []).get(learnedDay)!).push(f);
          if (f.status === 'superseded') {
            const staleDay = dayKey(f.updated_at);
            (supersededByDay.get(staleDay) ?? supersededByDay.set(staleDay, []).get(staleDay)!).push(f);
          }
        }
        const allDays = [...new Set([...learnedByDay.keys(), ...supersededByDay.keys()])].sort();
        for (const day of allDays) {
          const lines = [`# ${day}`, ''];
          const learned = learnedByDay.get(day) ?? [];
          if (learned.length) {
            lines.push(`## Learned (${learned.length})`, '');
            for (const f of learned) {
              lines.push(`- [${f.category}] ${f.statement}${entityLinks(f.entities)} <!-- fact:${f.id} source:${f.source} -->`);
            }
            lines.push('');
          }
          const superseded = supersededByDay.get(day) ?? [];
          if (superseded.length) {
            lines.push(`## Superseded (${superseded.length})`, '');
            for (const f of superseded) {
              const replacement = f.superseded_by ? factById.get(f.superseded_by) : undefined;
              const arrow = replacement ? ` → replaced by: ${replacement.statement}` : '';
              lines.push(`- ${f.statement}${arrow} <!-- fact:${f.id} -->`);
            }
            lines.push('');
          }
          await writeFile(path.join(dailyDir, `${day}.md`), lines.join('\n') + '\n');
        }

        const topEntities = [...byEntity.entries()]
          .sort((a, b) => b[1].length - a[1].length)
          .slice(0, 40);
        const recentDays = [...allDays].reverse().slice(0, 14);
        await writeFile(
          path.join(opts.out, 'index.md'),
          `# Memory vault\n\n` +
            `Exported ${new Date().toISOString()} — ${facts.length} active facts, ${byEntity.size} entities.\n\n` +
            `## Categories\n\n${[...byCategory.keys()].map((c) => `- [[${c}]]`).join('\n')}\n\n` +
            `## Daily log\n\n${recentDays.map((d) => `- [[daily/${d}|${d}]]`).join('\n')}\n\n` +
            `## Most-mentioned projects & tools\n\n${topEntities
              .map(([e, list]) => `- ${link(e)} (${list.length})`)
              .join('\n')}\n`,
        );

        console.log(`exported ${facts.length} facts (${byEntity.size} entities, ${allDays.length} daily notes) to ${opts.out}`);
      } finally {
        await ctx.pool.end();
      }
    });
}
