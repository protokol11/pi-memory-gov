"""Import pi-hermes-memory Markdown into the user-tier inbox JSONL.

Implements .docs/SPECS/session-search/spec-2-import-hermes-memory.md,
"Solution" + Implementation Decisions 1-5, 8-9: hermes' three Markdown
files become untrusted user-tier inbox lines, idempotent by content hash.
Dry run by default; --write appends. Never rewrites the source Markdown.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

FILES = ("MEMORY.md", "USER.md", "failures.md")
SEPARATOR = "§"
# The trailing metadata comment carries created/last chronology that must
# survive, but not inside text where it would pollute lexical ranking.
COMMENT_RE = re.compile(r"\s*<!--\s*([^>]*)-->\s*$")


@dataclass
class FileReport:
    name: str
    entries: int = 0
    skipped_empty: int = 0
    dup_in_run: int = 0


@dataclass
class RunStats:
    duplicates_in_run: int = 0
    already_present: int = 0
    appended: int = 0
    bytes_written: int = 0
    pending: list[tuple[str, dict]] = field(default_factory=list)


def split_entries(content: str) -> list[str]:
    return content.split("\n" + SEPARATOR + "\n")


def parse_entry(raw: str, fname: str, n: int) -> tuple[str, str] | None:
    """Return (stored_text, verifier) or None for an empty entry."""
    text = raw.rstrip("\n")
    meta: str | None = None
    m = COMMENT_RE.search(text)
    if m:
        meta = ", ".join(part.strip() for part in m.group(1).split(","))
        text = text[: m.start()]
    text = text.strip()  # only edge normalisation; inner lines stay verbatim
    if not text:
        return None
    verifier = f"hermes:{fname}:{n}"
    if meta:
        verifier += f" ({meta})"
    return text, verifier


def iso_now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def build_line(text: str, verifier: str, ts: str) -> dict:
    # The id is the content hash: idempotency is then a set lookup over the
    # target file, with no marker field and no rewrite of existing lines.
    entry_id = "hermes-" + hashlib.sha256(text.encode("utf-8")).hexdigest()[:16]
    return {
        "id": entry_id,
        "ts": ts,
        "text": text,
        "layer": "user",
        "verifier": verifier,
        "source": "imported-hermes",
        "trusted": False,
        "judgment_id": None,
        "supersedes": None,
    }


def load_existing_ids(target: Path) -> set[str]:
    if not target.exists():
        return set()
    ids: set[str] = set()
    with target.open("r", encoding="utf-8") as fh:
        for lineno, line in enumerate(fh, 1):
            line = line.strip()
            if not line:
                continue
            try:
                ids.add(json.loads(line)["id"])
            except (json.JSONDecodeError, KeyError) as exc:
                raise ValueError(f"{target}:{lineno}: unreadable inbox line: {exc}") from exc
    return ids


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--write", action="store_true", help="append to the inbox (default: dry run)")
    parser.add_argument("--home", help="override home dir (default: ~)")
    parser.add_argument("--source-dir", help="override pi-hermes-memory dir")
    parser.add_argument("--verbose", action="store_true", help="print ids of lines to append")
    args = parser.parse_args(argv)

    home = Path(args.home) if args.home else Path.home()
    source_dir = Path(args.source_dir) if args.source_dir else home / ".pi" / "agent" / "pi-hermes-memory"
    target = home / ".pi" / "memory" / "inbox.jsonl"

    try:
        existing_ids = load_existing_ids(target)
    except (OSError, ValueError) as exc:
        print(f"error reading target {target}: {exc}", file=sys.stderr)
        return 1

    ts = iso_now()
    seen: set[str] = set()
    stats = RunStats()
    reports: list[FileReport] = []

    for fname in FILES:
        path = source_dir / fname
        rep = FileReport(name=fname)
        reports.append(rep)
        try:
            content = path.read_text(encoding="utf-8")
        except OSError as exc:
            print(f"error reading {path}: {exc}", file=sys.stderr)
            return 1
        for n, raw in enumerate(split_entries(content), 1):
            parsed = parse_entry(raw, fname, n)
            if parsed is None:
                rep.skipped_empty += 1
                continue
            rep.entries += 1
            line = build_line(parsed[0], parsed[1], ts)
            eid = line["id"]
            if eid in seen:
                rep.dup_in_run += 1
                stats.duplicates_in_run += 1
                continue
            seen.add(eid)
            if eid in existing_ids:
                stats.already_present += 1
                continue
            stats.pending.append((eid, line))

    total_entries = sum(r.entries for r in reports)
    total_skipped = sum(r.skipped_empty for r in reports)
    mode = "write" if args.write else "dry run"
    print(f"import-hermes-memory ({mode})")
    print(f"source: {source_dir}")
    print(f"target: {target}")
    for rep in reports:
        print(f"  {rep.name}: entries={rep.entries} skipped_empty={rep.skipped_empty} "
              f"dup_in_run={rep.dup_in_run}")
    print(f"total entries: {total_entries}")
    print(f"skipped empty: {total_skipped}")
    print(f"duplicates in run: {stats.duplicates_in_run}")
    print(f"already present in target: {stats.already_present}")
    print(f"to append (dry run): {len(stats.pending)}" if not args.write
          else f"appended: {len(stats.pending)}")

    if args.verbose:
        for eid, _ in stats.pending:
            print(f"  {eid}")

    if not args.write:
        return 0

    try:
        target.parent.mkdir(parents=True, exist_ok=True)
        with target.open("a", encoding="utf-8") as fh:
            for eid, line in stats.pending:
                blob = json.dumps(line, ensure_ascii=False) + "\n"
                try:
                    fh.write(blob)
                except OSError as exc:
                    print(f"error writing entry {eid}: {exc}", file=sys.stderr)
                    return 1
                stats.appended += 1
                stats.bytes_written += len(blob.encode("utf-8"))
    except OSError as exc:
        print(f"error opening {target} for append: {exc}", file=sys.stderr)
        return 1
    print(f"appended: {stats.appended} lines, {stats.bytes_written} bytes")
    return 0


if __name__ == "__main__":
    sys.exit(main())
