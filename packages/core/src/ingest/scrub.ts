import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Session } from './normalize.js';

/**
 * Mandatory, fail-closed scrubbing. Runs BEFORE anything is embedded or
 * stored:
 *  1. custom regex set (broker API keys, MT5 creds, WG keys, SMTP, generic
 *     token shapes) — always on, no external dependency
 *  2. gitleaks subprocess over the normalized session text — required unless
 *     gitleaksPath === 'off' (tests only)
 * Findings are replaced with [REDACTED:<type>]; the count is recorded in the
 * ingest ledger. Any scrub failure throws, which quarantines the file —
 * nothing partially ingests.
 */

export interface ScrubResult {
  session: Session;
  secretsFound: number;
}

interface RegexRule {
  type: string;
  re: RegExp;
}

// Order matters: more specific rules first so labels are meaningful.
const RULES: RegexRule[] = [
  { type: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: 'openai-key', re: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  { type: 'github-token', re: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { type: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g },
  { type: 'private-key-block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g },
  // WireGuard keys: base64, exactly 44 chars ending '=' near wg-ish context
  { type: 'wireguard-key', re: /\b(?:PrivateKey|PresharedKey)\s*=\s*[A-Za-z0-9+/]{43}=/g },
  // MT5 / broker creds: password assignments near login/account context
  { type: 'mt5-cred', re: /\b(?:mt5|MT5|broker|investor)?[_ ]?[Pp]assword\s*[:=]\s*["']?[^\s"',;]{6,}/g },
  { type: 'smtp-cred', re: /\bsmtp:\/\/[^:\s]+:[^@\s]+@/g },
  { type: 'url-basic-auth', re: /\b(?:https?|postgres(?:ql)?|redis|amqp):\/\/[^:\/\s]+:[^@\/\s]+@/g },
  { type: 'generic-bearer', re: /\b[Bb]earer\s+[A-Za-z0-9_\-.=]{24,}\b/g },
];

export function redactWithRules(text: string): { text: string; found: number } {
  let found = 0;
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.re, () => {
      found += 1;
      return `[REDACTED:${rule.type}]`;
    });
  }
  return { text: out, found };
}

interface GitleaksFinding {
  Secret?: string;
  RuleID?: string;
}

function runGitleaks(gitleaksPath: string, text: string): GitleaksFinding[] {
  const dir = mkdtempSync(path.join(tmpdir(), 'memscrub-'));
  try {
    const target = path.join(dir, 'session.txt');
    const report = path.join(dir, 'report.json');
    writeFileSync(target, text);
    const res = spawnSync(
      gitleaksPath,
      ['detect', '--no-git', '--no-banner', '--source', dir, '--report-format', 'json', '--report-path', report, '--exit-code', '2'],
      { encoding: 'utf8' },
    );
    if (res.error) {
      throw new Error(`gitleaks failed to run (${String(res.error.message)}) — scrubbing is fail-closed, aborting ingest`);
    }
    // exit 0: clean; exit 2: leaks found (we asked for 2); anything else: error
    if (res.status !== 0 && res.status !== 2) {
      throw new Error(`gitleaks exited ${res.status}: ${res.stderr}`);
    }
    if (!existsSync(report)) return [];
    const parsed = JSON.parse(readFileSync(report, 'utf8')) as GitleaksFinding[];
    return Array.isArray(parsed) ? parsed : [];
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function scrubSession(session: Session, gitleaksPath: string): ScrubResult {
  let secretsFound = 0;
  const turns = session.turns.map((t) => {
    const r = redactWithRules(t.text);
    secretsFound += r.found;
    return { ...t, text: r.text };
  });

  if (gitleaksPath !== 'off') {
    const joined = turns.map((t) => t.text).join('\n\n');
    const findings = runGitleaks(gitleaksPath, joined);
    for (const f of findings) {
      const secret = f.Secret;
      if (!secret || secret.length < 4) continue;
      const label = `[REDACTED:${f.RuleID ?? 'gitleaks'}]`;
      for (const t of turns) {
        if (t.text.includes(secret)) {
          t.text = t.text.split(secret).join(label);
          secretsFound += 1;
        }
      }
    }
  }

  return { session: { ...session, turns }, secretsFound };
}
