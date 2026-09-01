import type { Pool } from 'pg';
import type { QdrantClient } from './vector/qdrant.js';

/**
 * Backfill facts.project from the archive: a fact's provenance lists the
 * sessions it came from, and those sessions carry a project in Qdrant.
 * Facts whose sessions are missing or project-less stay NULL (honest —
 * leaving a wrong project is worse than none). updated_at is untouched:
 * this is provenance repair, not a content change.
 */

export interface BackfillProjectsReport {
  factsScanned: number;
  sessionsResolved: number;
  factsUpdated: number;
  unresolved: number;
}

function factSessions(provenance: unknown): string[] {
  if (!Array.isArray(provenance)) return [];
  const out: string[] = [];
  for (const ref of provenance) {
    if (ref && typeof ref === 'object') {
      const sid = (ref as { session_id?: unknown }).session_id;
      if (typeof sid === 'string' && !out.includes(sid)) out.push(sid);
    }
  }
  return out;
}

async function sessionProject(qdrant: QdrantClient, sessionId: string): Promise<string | undefined> {
  const chunks = await qdrant.scrollBySession(sessionId);
  for (const c of chunks) {
    if (typeof c.payload.project === 'string' && c.payload.project) return c.payload.project;
  }
  return undefined;
}

export async function backfillFactProjects(pool: Pool, qdrant: QdrantClient): Promise<BackfillProjectsReport> {
  const res = await pool.query(
    `SELECT id, provenance FROM facts WHERE project IS NULL AND provenance <> '[]'::jsonb`,
  );
  const facts = res.rows as { id: string; provenance: unknown }[];
  const byProject = new Map<string, string[]>();
  const cache = new Map<string, string | undefined>();
  let sessionsResolved = 0;
  let lost = 0;

  for (const f of facts) {
    let chosen: string | undefined;
    for (const sid of factSessions(f.provenance)) {
      let project = cache.get(sid);
      if (project === undefined && !cache.has(sid)) {
        project = await sessionProject(qdrant, sid);
        cache.set(sid, project);
        if (project) sessionsResolved += 1;
      }
      if (project) {
        chosen = project;
        break;
      }
    }
    if (chosen) {
      const bucket = byProject.get(chosen) ?? [];
      bucket.push(f.id);
      byProject.set(chosen, bucket);
    } else {
      lost += 1;
    }
  }

  let factsUpdated = 0;
  for (const [project, ids] of byProject) {
    for (const chunk of ids) {
      const upd = await pool.query(`UPDATE facts SET project = $1 WHERE id = $2::uuid`, [project, chunk]);
      factsUpdated += upd.rowCount ?? 0;
    }
  }

  return { factsScanned: facts.length, sessionsResolved, factsUpdated, unresolved: lost };
}