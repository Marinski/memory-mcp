import type { Session, SourceTool, Turn } from '../normalize.js';
import { tidySession } from '../normalize.js';

/**
 * Parses OpenCode session storage, and (via the sourceTool param) VS Code's
 * native Chat panel export — both land here as the same JSON shape
 * ({id, title, messages/parts}), single object or array. This keeps the
 * message-parsing logic in one place while still tagging each session with
 * its real source for provenance/filtering downstream.
 */

interface OcPart {
  type?: string;
  text?: string;
}
interface OcMessage {
  role?: string;
  parts?: OcPart[];
  content?: string;
  time?: { created?: number };
}
interface OcSession {
  id?: string;
  title?: string;
  time?: { created?: number };
  messages?: OcMessage[];
  directory?: string;
}

function msgText(m: OcMessage): string {
  if (typeof m.content === 'string') return m.content;
  return (m.parts ?? [])
    .filter((p) => p.type === 'text' && typeof p.text === 'string')
    .map((p) => p.text as string)
    .join('\n');
}

export function parseOpencode(content: string, sourceTool: SourceTool = 'opencode'): Session[] {
  const data = JSON.parse(content) as OcSession | OcSession[];
  const list = Array.isArray(data) ? data : [data];
  const sessions: Session[] = [];
  for (const sess of list) {
    if (!sess.id || !Array.isArray(sess.messages)) continue;
    const turns: Turn[] = [];
    for (const m of sess.messages) {
      const role = m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const text = msgText(m);
      if (!text) continue;
      turns.push({ role, text, ts: m.time?.created });
    }
    const project = sess.directory ? sess.directory.split('/').filter(Boolean).pop() : undefined;
    const s = tidySession({
      id: `${sourceTool}:${sess.id}`,
      sourceTool,
      title: sess.title,
      project,
      startedAt: sess.time?.created,
      turns,
    });
    if (s) sessions.push(s);
  }
  return sessions;
}
