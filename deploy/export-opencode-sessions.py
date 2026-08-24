#!/usr/bin/env python3
"""Export OpenCode sessions into memory-mcp's native ingest JSON shape.

Reads ONLY session/message/part/project from OpenCode's local SQLite store.
The same database also holds `account`/`credential` tables (OAuth tokens,
API keys) — those are never selected here and must never be.

Deliberately does NOT redact secrets: memory-mcp's own ingest pipeline
(packages/core/src/ingest/scrub.ts) already runs fail-closed gitleaks +
regex scrubbing on every file dropped in the inbox, for every source. Adding
a second, divergent redaction pass here would be redundant and could drift
out of sync with the one that actually matters.

One JSON file per session (not one combined file): unchanged sessions keep
an identical hash across runs, so memory-mcp's content-hash ledger skips
them — only new/edited sessions get re-embedded on each run.
"""

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

DEFAULT_DB = os.path.expanduser("~/.local/share/opencode/opencode.db")

# Only 'text' parts carry content worth keeping. 'reasoning' is excluded —
# long, low-signal once the answer exists, matches export-opencode.py.
TEXT_PARTS = {"text"}


def slugify(text, limit=60):
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return (slug or "untitled")[:limit]


def list_sessions(con):
    return con.execute("""
        SELECT s.id, s.title, s.slug, s.directory, s.time_created, p.worktree
        FROM session s
        LEFT JOIN project p ON p.id = s.project_id
        ORDER BY s.time_created
    """).fetchall()


def session_turns(con, session_id):
    """Consecutive same-role text parts merged into one turn, in order."""
    rows = con.execute("""
        SELECT m.data AS mdata, pt.data AS pdata
        FROM message m
        LEFT JOIN part pt ON pt.message_id = m.id
        WHERE m.session_id = ?
        ORDER BY m.time_created, m.id, pt.id
    """, (session_id,)).fetchall()

    turns, last_role, buf = [], None, []

    def flush():
        if buf and last_role in ("user", "assistant"):
            text = "\n\n".join(buf).strip()
            if text:
                turns.append({"role": last_role, "text": text})
        buf.clear()

    for r in rows:
        try:
            mdata = json.loads(r["mdata"])
        except (TypeError, ValueError):
            continue
        role = mdata.get("role")
        if role != last_role:
            flush()
            last_role = role
        if not r["pdata"]:
            continue
        try:
            pdata = json.loads(r["pdata"])
        except (TypeError, ValueError):
            continue
        if pdata.get("type") in TEXT_PARTS:
            text = (pdata.get("text") or "").strip()
            if text:
                buf.append(text)
    flush()
    return turns


def export(db_path, out_dir, min_chars):
    con = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    con.row_factory = sqlite3.Row
    os.makedirs(out_dir, exist_ok=True)

    sessions = list_sessions(con)
    written = 0
    for s in sessions:
        turns = session_turns(con, s["id"])
        total_chars = sum(len(t["text"]) for t in turns)
        if total_chars < min_chars:
            continue

        created_ms = s["time_created"]
        date = (
            datetime.fromtimestamp(created_ms / 1000, timezone.utc).strftime("%Y-%m-%d")
            if created_ms else "undated"
        )
        title = (s["title"] or s["slug"] or s["id"]).strip()
        name = f"{date}-{slugify(s['slug'] or title)}.json"

        session_obj = {
            "id": s["id"],
            "title": title,
            "time": {"created": created_ms},
            "directory": s["worktree"] or s["directory"],
            "messages": [
                {
                    "role": t["role"],
                    "parts": [{"type": "text", "text": t["text"]}],
                    "time": {"created": created_ms},
                }
                for t in turns
            ],
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
        print(f"no OpenCode db at {args.db}, nothing to export")
        return
    written, total = export(args.db, args.out, args.min_chars)
    print(f"exported {written} of {total} opencode sessions -> {args.out}")


if __name__ == "__main__":
    main()
