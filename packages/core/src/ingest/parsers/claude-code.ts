import type { Session, Turn } from '../normalize.js';
import { tidySession } from '../normalize.js';

/**
 * Parses ~/.claude/projects/<project>/<session>.jsonl logs. Records of
 * interest are type 'user' and 'assistant' whose message content is text
 * (string, or content-block arrays containing {type:'text'}). Tool results,
 * attachments, hooks and queue bookkeeping are skipped — the conversation
 * text is what the archive is for.
 */

interface JsonlRecord {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  isSidechain?: boolean;
  message?: {
    role?: string;
    content?: string | { type?: string; text?: string }[];
  };
}

function contentText(content: string | { type?: string; text?: string }[] | undefined): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text as string)
      .join('\n');
  }
  return '';
}

export function parseClaudeCode(content: string, sourcePath: string): Session[] {
  const turns: Turn[] = [];
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let startedAt: number | undefined;
  let sawRecord = false;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: JsonlRecord;
    try {
      rec = JSON.parse(trimmed) as JsonlRecord;
    } catch {
      throw new Error(`claude-code jsonl: unparseable line in ${sourcePath}`);
    }
    sawRecord = true;
    if (rec.sessionId && !sessionId) sessionId = rec.sessionId;
    if (rec.cwd && !cwd) cwd = rec.cwd;
    if (rec.type !== 'user' && rec.type !== 'assistant') continue;
    if (rec.isSidechain) continue;
    const role = rec.message?.role;
    if (role !== 'user' && role !== 'assistant') continue;
    const text = contentText(rec.message?.content);
    if (!text.trim()) continue;
    // Skip synthetic tool-result user records rendered as content arrays of
    // non-text blocks (contentText already returns '' for those).
    const ts = rec.timestamp ? Date.parse(rec.timestamp) : undefined;
    if (startedAt === undefined && ts !== undefined) startedAt = ts;
    turns.push({ role, text, ts });
  }
  if (!sawRecord) throw new Error(`claude-code jsonl: empty or invalid file ${sourcePath}`);

  const fallbackId = sourcePath.replace(/^.*\//, '').replace(/\.jsonl$/, '');
  const project = cwd ? cwd.split('/').filter(Boolean).pop() : undefined;
  const s = tidySession({
    id: `claude-code:${sessionId ?? fallbackId}`,
    sourceTool: 'claude-code',
    project,
    startedAt,
    turns,
  });
  return s ? [s] : [];
}
