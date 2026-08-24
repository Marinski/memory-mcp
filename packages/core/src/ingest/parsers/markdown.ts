import { createHash } from 'node:crypto';
import type { Session } from '../normalize.js';
import { tidySession } from '../normalize.js';

/**
 * Loose markdown notes (Obsidian vault import). A note becomes a single
 * one-turn session; the H1 (or filename) becomes the title. Content is
 * user-authored, so the role is 'user'.
 */
export function parseMarkdown(content: string, sourcePath: string): Session[] {
  const name = sourcePath.replace(/^.*\//, '').replace(/\.md$/i, '');
  const h1 = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  const hash = createHash('sha256').update(content).digest('hex').slice(0, 12);
  const s = tidySession({
    id: `markdown:${name}:${hash}`,
    sourceTool: 'markdown',
    title: h1 ?? name,
    turns: [{ role: 'user', text: content }],
  });
  return s ? [s] : [];
}
