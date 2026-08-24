/**
 * The normalized session model every parser emits. Everything downstream
 * (scrub, chunk, embed, distill) is source-agnostic and consumes only this.
 */

export type SourceTool =
  | 'chatgpt'
  | 'claude'
  | 'claude-code'
  | 'opencode'
  | 'markdown';

export interface Turn {
  role: 'user' | 'assistant' | 'system' | 'tool';
  text: string;
  /** Unix epoch millis when known. */
  ts?: number;
}

export interface Session {
  /** Stable id derived from the source (conversation id, file name, ...). */
  id: string;
  sourceTool: SourceTool;
  title?: string;
  /** Device folder name the file arrived from (inbox/<device>/...). */
  device?: string;
  /** Project association when the source provides one (claude-code cwd, ...). */
  project?: string;
  startedAt?: number;
  turns: Turn[];
}

/** Drop empty turns, coerce whitespace, drop sessions with no content. */
export function tidySession(s: Session): Session | null {
  const turns = s.turns
    .map((t) => ({ ...t, text: t.text.replace(/\r\n/g, '\n').trim() }))
    .filter((t) => t.text.length > 0);
  if (turns.length === 0) return null;
  return { ...s, turns };
}
