import type { Session, Turn } from '../normalize.js';
import { tidySession } from '../normalize.js';

/**
 * Parses conversations.json from a ChatGPT data-export zip. Each
 * conversation holds a `mapping` of nodes; we walk from `current_node`
 * back to the root to reconstruct the active branch in order.
 */

interface CgptMessage {
  author?: { role?: string };
  content?: { content_type?: string; parts?: unknown[] };
  create_time?: number | null;
}
interface CgptNode {
  id: string;
  message?: CgptMessage | null;
  parent?: string | null;
}
interface CgptConversation {
  id?: string;
  conversation_id?: string;
  title?: string;
  create_time?: number;
  current_node?: string;
  mapping?: Record<string, CgptNode>;
}

function messageText(m: CgptMessage): string {
  const parts = m.content?.parts ?? [];
  return parts
    .map((p) => (typeof p === 'string' ? p : ''))
    .join('\n')
    .trim();
}

export function parseChatgpt(content: string): Session[] {
  const data = JSON.parse(content) as CgptConversation[];
  if (!Array.isArray(data)) throw new Error('chatgpt export: expected top-level array');
  const sessions: Session[] = [];
  for (const conv of data) {
    const mapping = conv.mapping ?? {};
    // Walk current_node -> root, then reverse.
    const chain: CgptNode[] = [];
    let cursor = conv.current_node ? mapping[conv.current_node] : undefined;
    const seen = new Set<string>();
    while (cursor && !seen.has(cursor.id)) {
      seen.add(cursor.id);
      chain.push(cursor);
      cursor = cursor.parent ? mapping[cursor.parent] : undefined;
    }
    chain.reverse();
    const turns: Turn[] = [];
    for (const node of chain) {
      const m = node.message;
      if (!m) continue;
      const role = m.author?.role;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = messageText(m);
      if (!text) continue;
      turns.push({ role, text, ts: m.create_time ? Math.round(m.create_time * 1000) : undefined });
    }
    const id = conv.conversation_id ?? conv.id;
    if (!id) continue;
    const s = tidySession({
      id: `chatgpt:${id}`,
      sourceTool: 'chatgpt',
      title: conv.title,
      startedAt: conv.create_time ? Math.round(conv.create_time * 1000) : undefined,
      turns,
    });
    if (s) sessions.push(s);
  }
  return sessions;
}
