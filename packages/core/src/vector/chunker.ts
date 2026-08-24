import type { Session, Turn } from '../ingest/normalize.js';

/**
 * Session-aware chunking:
 *  - never split a turn mid-thought (split only at paragraph boundaries,
 *    and only when a single turn alone exceeds the budget)
 *  - fenced code blocks are kept intact up to 2x the target budget
 *  - small turns merge until ~TARGET_TOKENS
 *  - consecutive merged chunks overlap by one turn for continuity
 * Token counts are estimated at ~4 chars/token, which is adequate for
 * budgeting (retrieval quality is measured by the golden set, not here).
 */

export const TARGET_TOKENS = 512;
const HARD_MAX_TOKENS = TARGET_TOKENS * 2;

export interface Chunk {
  index: number;
  text: string;
  turnRange: string; // e.g. "3-7"
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function turnText(t: Turn): string {
  return `${t.role}: ${t.text}`;
}

/**
 * Split an oversized turn at paragraph boundaries, keeping fenced code
 * blocks whole. A piece may exceed TARGET only when it is a single
 * unsplittable block, capped at HARD_MAX.
 */
export function splitOversizedText(text: string): string[] {
  const parts: string[] = [];
  const segments = text.split(/(```[\s\S]*?```)/g).filter((s) => s.trim().length > 0);
  let current = '';
  const flush = () => {
    if (current.trim().length > 0) parts.push(current.trim());
    current = '';
  };
  for (const seg of segments) {
    const isCode = seg.startsWith('```');
    const units = isCode ? [seg] : seg.split(/\n{2,}/);
    for (const unit of units) {
      const candidate = current.length ? `${current}\n\n${unit}` : unit;
      if (estimateTokens(candidate) <= TARGET_TOKENS) {
        current = candidate;
        continue;
      }
      flush();
      if (estimateTokens(unit) <= HARD_MAX_TOKENS) {
        current = unit;
      } else {
        // Truly enormous unit (giant code block): hard-cut at HARD_MAX chars.
        const step = HARD_MAX_TOKENS * 4;
        for (let i = 0; i < unit.length; i += step) parts.push(unit.slice(i, i + step));
      }
    }
    if (isCode) flush(); // do not glue prose onto the far side of a code block
  }
  flush();
  return parts;
}

export function chunkSession(session: Session): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: { text: string; turn: number }[] = [];
  let bufTokens = 0;

  const emit = () => {
    if (buf.length === 0) return;
    const first = buf[0].turn;
    const last = buf[buf.length - 1].turn;
    chunks.push({
      index: chunks.length,
      text: buf.map((b) => b.text).join('\n\n'),
      turnRange: first === last ? `${first}` : `${first}-${last}`,
    });
  };

  /** Emit the buffer; optionally seed the next buffer with the last turn. */
  const flush = (withOverlap: boolean) => {
    emit();
    if (withOverlap && buf.length > 0) {
      const tail = buf[buf.length - 1];
      const tailTokens = estimateTokens(tail.text);
      if (tailTokens < TARGET_TOKENS) {
        buf = [tail];
        bufTokens = tailTokens;
        return;
      }
    }
    buf = [];
    bufTokens = 0;
  };

  session.turns.forEach((turn, ti) => {
    const text = turnText(turn);
    const tokens = estimateTokens(text);
    if (tokens > TARGET_TOKENS) {
      // Oversized turn: flush pending buffer, emit the turn's pieces standalone.
      flush(false);
      for (const piece of splitOversizedText(text)) {
        chunks.push({ index: chunks.length, text: piece, turnRange: `${ti}` });
      }
      return;
    }
    if (bufTokens + tokens > TARGET_TOKENS && buf.length > 0) flush(true);
    buf.push({ text, turn: ti });
    bufTokens += tokens;
  });
  flush(false);

  return chunks;
}
