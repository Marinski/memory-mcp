#!/usr/bin/env python3
"""Export VS Code's native Chat panel sessions into memory-mcp's ingest JSON.

Reads sessions/turns from the global SQLite store VS Code Server keeps for
its Chat panel (backs any provider routed through it, not just Copilot,
despite the extension-scoped path). Other stores that exist alongside it —
per-session agentSessionData/*.db (empty on every machine checked),
per-file editor undo history, per-workspace supplements — are not chat
transcripts and are not read here.

Deliberately does NOT redact secrets: memory-mcp's own ingest pipeline
(packages/core/src/ingest/scrub.ts) already runs fail-closed gitleaks +
regex scrubbing on every file dropped in the inbox, for every source.

One JSON file per session: unchanged sessions keep an identical hash
across runs, so memory-mcp's content-hash ledger skips them.

Output carries a top-level "source": "vscode" marker — the JSON shape is
otherwise identical to OpenCode's session export, and that field is the
only way detectSourceKind() in memory-mcp's parser tells the two apart
(see packages/core/src/ingest/parsers/index.ts).
"""

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

DEFAULT_DB = os.path.expanduser(
    "~/.vscode-server/data/User/globalStorage/github.copilot-chat/session-store.db"
)


def slugify(text, limit=60):
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (slug or "untitled")[:limit]


def to_epoch_ms(iso_ts):
    """Session/turn timestamps are ISO 8601 strings, not epoch millis."""
    if not iso_ts:
        return None
    ts = iso_ts.replace("Z", "+00:00")
    try:
        return int(datetime.fromisoformat(ts).timestamp() * 1000)
    except ValueError:
        return None


def export(db_path, out_dir, min_chars):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    os.makedirs(out_dir, exist_ok=True)

    sessions = con.execute("""
        SELECT id, cwd, repository, summary, created_at
        FROM sessions ORDER BY created_at
    """).fetchall()

    written = 0
    for s in sessions:
        rows = con.execute("""
            SELECT user_message, assistant_response, timestamp
            FROM turns WHERE session_id = ? ORDER BY turn_index
        """, (s["id"],)).fetchall()

        messages = []
        total_chars = 0
        for r in rows:
            created = to_epoch_ms(r["timestamp"])
            if r["user_message"]:
                messages.append({
                    "role": "user",
                    "parts": [{"type": "text", "text": r["user_message"]}],
                    "time": {"created": created},
                })
                total_chars += len(r["user_message"])
            if r["assistant_response"]:
                messages.append({
                    "role": "assistant",
                    "parts": [{"type": "text", "text": r["assistant_response"]}],
                    "time": {"created": created},
                })
                total_chars += len(r["assistant_response"])

        if total_chars < min_chars:
            continue

        created_ms = to_epoch_ms(s["created_at"])
        date = (
            datetime.fromtimestamp(created_ms / 1000, timezone.utc).strftime("%Y-%m-%d")
            if created_ms else "undated"
        )
        title = (s["summary"] or s["id"]).strip()
        name = f"{date}-{slugify(title)}.json"

        session_obj = {
            "source": "vscode",
            "id": s["id"],
            "title": title,
            "time": {"created": created_ms},
            "directory": s["cwd"] or s["repository"],
            "messages": messages,
        }
        with open(os.path.join(out_dir, name), "w") as fh:
            json.dump(session_obj, fh)
        written += 1

    con.close()
    return written, len(sessions)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=DEFAULT_DB)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min-chars", type=int, default=200,
                     help="skip stub sessions with less real content than this")
    args = ap.parse_args()
    if not os.path.isfile(args.db):
        print(f"no VS Code session store at {args.db}, nothing to export")
        return
    written, total = export(args.db, args.out, args.min_chars)
    print(f"exported {written} of {total} vscode sessions -> {args.out}")


if __name__ == "__main__":
    main()
