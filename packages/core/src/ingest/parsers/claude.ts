import type { Session, Turn } from '../normalize.js';
import { tidySession } from '../normalize.js';

/**
 * Parses conversations.json from a Claude (claude.ai) data export:
 * an array of conversations with chat_messages[{sender, text, created_at}].
 */

interface ClaudeMessage {
  sender?: string; // 'human' | 'assistant'
  text?: string;
  content?: { type?: string; text?: string }[];
  created_at?: string;
}
interface ClaudeConversation {
  uuid?: string;
  name?: string;
  created_at?: string;
  chat_messages?: ClaudeMessage[];
}

function msgText(m: ClaudeMessage): string {
  if (m.text && m.text.trim()) return m.text;
  return (m.content ?? [])
    .filter((c) => c.type === 'text' && c.text)
    .map((c) => c.text as string)
    .join('\n');
}

export function parseClaude(content: string): Session[] {
  const data = JSON.parse(content) as ClaudeConversation[];
  if (!Array.isArray(data)) throw new Error('claude export: expected top-level array');
  const sessions: Session[] = [];
  for (const conv of data) {
    if (!conv.uuid) continue;
    const turns: Turn[] = [];
    for (const m of conv.chat_messages ?? []) {
      const role = m.sender === 'human' ? 'user' : m.sender === 'assistant' ? 'assistant' : null;
      if (!role) continue;
      const text = msgText(m);
      if (!text) continue;
      turns.push({ role, text, ts: m.created_at ? Date.parse(m.created_at) : undefined });
    }
    const s = tidySession({
      id: `claude:${conv.uuid}`,
      sourceTool: 'claude',
      title: conv.name,
      startedAt: conv.created_at ? Date.parse(conv.created_at) : undefined,
      turns,
    });
    if (s) sessions.push(s);
  }
  return sessions;
}
