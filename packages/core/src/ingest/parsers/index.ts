import type { Session, SourceTool } from '../normalize.js';
import { parseChatgpt } from './chatgpt.js';
import { parseClaude } from './claude.js';
import { parseClaudeCode } from './claude-code.js';
import { parseOpencode } from './opencode.js';
import { parseMarkdown } from './markdown.js';

export type Parser = (content: string, sourcePath: string) => Session[];

export const parsers: Record<SourceTool, Parser> = {
  chatgpt: (c) => parseChatgpt(c),
  claude: (c) => parseClaude(c),
  'claude-code': parseClaudeCode,
  opencode: (c) => parseOpencode(c),
  vscode: (c) => parseOpencode(c, 'vscode'),
  markdown: parseMarkdown,
};

/**
 * Pick a parser from the file path and a peek at content. Adding a source
 * = one parser file + one branch here.
 */
export function detectSourceKind(sourcePath: string, content: string): SourceTool {
  if (/\.jsonl$/i.test(sourcePath)) return 'claude-code';
  if (/\.md$/i.test(sourcePath)) return 'markdown';
  if (/\.json$/i.test(sourcePath)) {
    const head = content.slice(0, 4096);
    if (/"mapping"\s*:/.test(head) || /"current_node"\s*:/.test(head)) return 'chatgpt';
    if (/"chat_messages"\s*:/.test(head)) return 'claude';
    // vscode's export uses the exact same {messages/parts} shape as
    // opencode's — this marker field is the only way to tell them apart,
    // so it must be checked before the generic opencode fallback below.
    if (/"source"\s*:\s*"vscode"/.test(head)) return 'vscode';
    if (/"parts"\s*:/.test(head) || /"messages"\s*:/.test(head)) return 'opencode';
    // conversations.json naming disambiguates the two big exports
    if (/conversations\.json$/i.test(sourcePath)) return 'chatgpt';
  }
  throw new Error(`cannot detect source kind for ${sourcePath}`);
}

export { parseChatgpt, parseClaude, parseClaudeCode, parseOpencode, parseMarkdown };
