import type { Pool } from 'pg';
import type { LlmClient } from './llm.js';
import { extractJson } from './llm.js';
import { pendingReviews, approveReview, rejectReview, type ReviewItem } from './review.js';

/**
 * Automatic resolution of the review queue: reject duplicates and ephemera,
 * approve everything else. Replaces the per-fact interactive gate — at
 * hundreds of candidates a night the human review queue only ever grew, so
 * the owner opted for machine curation with `memoryctl review` kept as an
 * optional spot-check. Approval still flows through approveReview, so the
 * supersede-on-approve dedupe against active facts runs for every fact.
 */

const SYSTEM = `You curate a developer's personal long-term memory. You are given numbered fact
candidates extracted from AI coding sessions. Decide for each: keep or drop.
Drop:
- solved problems and debugging narratives — that an error occurred, was investigated, or was
  fixed is ephemera; only a durable gotcha, decision, or configuration is worth keeping
- transient states ("X is currently failing", "N items are pending") and session mechanics
- a near-duplicate of a lower-numbered candidate in this list (the first phrasing wins)
- vague statements that name nothing recurring and prescribe nothing actionable
Keep:
- durable preferences, decisions, architecture and infrastructure facts, recurring gotchas,
  and facts about projects, tools, hosts, services, or people
Return ONLY a JSON array with one entry per candidate: [{"i": number, "v": "keep"|"drop"}].`;

// Small enough that the numbered list plus verdict array never strains the
// distill model's context window, large enough to see near-duplicates
// side by side.
const BATCH_SIZE = 25;

export interface TriageReport {
  scanned: number;
  rejectedDuplicates: number;
  rejectedByJudge: number;
  approved: number;
  superseded: number;
  /** Judge batches that failed to parse or approvals that errored — retried next run. */
  leftPending: number;
}

function normalize(statement: string): string {
  return statement.toLowerCase().replace(/\s+/g, ' ').replace(/[.\s]+$/, '').trim();
}

interface Verdict {
  i: number;
  v: string;
}

async function judgeBatch(llm: LlmClient, batch: ReviewItem[]): Promise<Map<number, string>> {
  const listing = batch
    .map((item, i) => `${i}. [${item.proposed_fact.category}] ${item.proposed_fact.statement}`)
    .join('\n');
  const response = await llm.complete(SYSTEM, listing);
  const verdicts = extractJson<Verdict[]>(response);
  const byIndex = new Map<number, string>();
  if (Array.isArray(verdicts)) {
    for (const v of verdicts) {
      if (typeof v === 'object' && v !== null && typeof v.i === 'number' && typeof v.v === 'string') {
        byIndex.set(v.i, v.v);
      }
    }
  }
  return byIndex;
}

export async function triagePending(pool: Pool, llm: LlmClient): Promise<TriageReport> {
  const report: TriageReport = {
    scanned: 0,
    rejectedDuplicates: 0,
    rejectedByJudge: 0,
    approved: 0,
    superseded: 0,
    leftPending: 0,
  };
  const items = await pendingReviews(pool, 10_000);
  report.scanned = items.length;
  if (items.length === 0) return report;

  // Stage 1: exact-duplicate rejection, against active facts and within the
  // queue (oldest phrasing wins — pendingReviews returns created_at order).
  const activeRes = await pool.query(`SELECT statement FROM facts WHERE status = 'active'`);
  const seen = new Set<string>(
    (activeRes.rows as { statement: string }[]).map((r) => normalize(r.statement)),
  );
  const survivors: ReviewItem[] = [];
  for (const item of items) {
    const key = normalize(item.proposed_fact.statement);
    if (seen.has(key)) {
      await rejectReview(pool, item.id);
      report.rejectedDuplicates += 1;
    } else {
      seen.add(key);
      survivors.push(item);
    }
  }

  // Stage 2: LLM keep/drop judgment in batches. A candidate the judge
  // doesn't rule on is kept (dropping silently loses data; keeping at worst
  // admits a mediocre fact). A batch whose response can't be parsed is left
  // pending for the next run rather than resolved blind.
  for (let start = 0; start < survivors.length; start += BATCH_SIZE) {
    const batch = survivors.slice(start, start + BATCH_SIZE);
    let byIndex: Map<number, string>;
    try {
      byIndex = await judgeBatch(llm, batch);
    } catch {
      try {
        byIndex = await judgeBatch(llm, batch);
      } catch {
        report.leftPending += batch.length;
        continue;
      }
    }
    for (let i = 0; i < batch.length; i++) {
      const item = batch[i];
      if (byIndex.get(i) === 'drop') {
        await rejectReview(pool, item.id);
        report.rejectedByJudge += 1;
        continue;
      }
      // Stage 3: approve — approveReview runs the supersede check against
      // active facts, so re-mentions replace instead of piling up.
      try {
        const result = await approveReview(pool, llm, item.id);
        if (result) {
          report.approved += 1;
          report.superseded += result.superseded.length;
        }
      } catch {
        report.leftPending += 1;
      }
    }
  }
  return report;
}
