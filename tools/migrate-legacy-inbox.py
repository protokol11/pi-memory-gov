"""Migrate the pre-ADR-0044 legacy inbox into the current two-tier store.

Spec: .docs/SPECS/session-search/spec-2-import-hermes-memory.md, decisions 6-9.
Copies <cwd>/.pi/memory-inbox.jsonl verbatim into <cwd>/.pi/memory/inbox.jsonl:
bytes unchanged, validation of ALL lines before ANY write, idempotent by id,
source file never modified. Dry run by default; --write appends.
"""

import argparse
import json
import os
import sys
from dataclasses import dataclass, field

REQUIRED_STR_KEYS = ("id", "ts", "text", "layer", "verifier")
ALL_KEYS = REQUIRED_STR_KEYS + ("source", "trusted", "judgment_id", "supersedes")
ALLOWED_SOURCES = {"user-said", "agent-inferred", "doc-anchor", "imported-hermes"}


@dataclass
class LineReport:
    number: int
    id: str | None = None
    reasons: list[str] = field(default_factory=list)


def validate_line(number: int, raw: str) -> LineReport:
    """Validate one raw line (newline already stripped)."""
    rep = LineReport(number=number)
    try:
        obj = json.loads(raw)
    except json.JSONDecodeError as e:
        rep.reasons.append(f"not valid JSON: {e}")
        return rep
    if not isinstance(obj, dict):
        rep.reasons.append("line is not a JSON object")
        return rep
    for key in ALL_KEYS:
        if key not in obj:
            rep.reasons.append(f"missing key: {key}")
    for key in REQUIRED_STR_KEYS:
        if key in obj:
            v = obj[key]
            if not isinstance(v, str) or not v:
                rep.reasons.append(f"{key} must be a non-empty string")
    if "source" in obj and obj["source"] not in ALLOWED_SOURCES:
        rep.reasons.append(f"source must be one of {sorted(ALLOWED_SOURCES)}")
    if "trusted" in obj and not isinstance(obj["trusted"], bool):
        rep.reasons.append("trusted must be a bool")
    for key in ("judgment_id", "supersedes"):
        if key in obj:
            v = obj[key]
            if v is not None and not isinstance(v, str):
                rep.reasons.append(f"{key} must be null or a string")
    if isinstance(obj.get("id"), str) and obj["id"]:
        rep.id = obj["id"]
    return rep


def read_ids(target_path: str) -> set[str]:
    """Ids already present in the target file (empty set if none)."""
    ids: set[str] = set()
    if not os.path.exists(target_path):
        return ids
    with open(target_path, encoding="utf-8") as f:
        for raw in f:
            raw = raw.rstrip("\n")
            if not raw:
                continue
            try:
                obj = json.loads(raw)
            except json.JSONDecodeError:
                continue  # target is append-only history; only id lookups matter
            if isinstance(obj, dict) and isinstance(obj.get("id"), str):
                ids.add(obj["id"])
    return ids


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--write", action="store_true", help="append to target (default: dry run)")
    parser.add_argument("--cwd", default=os.getcwd(), help="working directory override")
    args = parser.parse_args()

    cwd = os.path.abspath(args.cwd)
    source_path = os.path.join(cwd, ".pi", "memory-inbox.jsonl")
    target_path = os.path.join(cwd, ".pi", "memory", "inbox.jsonl")

    if not os.path.exists(source_path):
        print(f"ERROR: source file not found: {source_path}", file=sys.stderr)
        return 1

    try:
        with open(source_path, "rb") as f:
            raw_bytes = f.read()
    except OSError as e:
        print(f"ERROR: cannot read {source_path}: {e}", file=sys.stderr)
        return 1

    # Decode once so we can validate; the written bytes come from the same
    # raw lines, so re-encoding never rewrites a line. Split on b"\n" only:
    # str.splitlines() also eats "\r", which would break byte preservation on
    # a CRLF file (decision 6).
    raw_lines = raw_bytes.split(b"\n")
    if raw_lines and raw_lines[-1] == b"":
        raw_lines.pop()  # trailing newline, not an empty record
    lines = [blob.decode("utf-8") for blob in raw_lines]

    reports = [validate_line(i + 1, line) for i, line in enumerate(lines)]
    invalid = [r for r in reports if r.reasons]

    existing_ids = read_ids(target_path)

    # Duplicate ids within the source are an error even if valid individually.
    id_lines: dict[str, list[int]] = {}
    for r in reports:
        if r.id:
            id_lines.setdefault(r.id, []).append(r.number)
    for rid, nums in sorted(id_lines.items()):
        if len(nums) > 1:
            invalid.append(
                LineReport(number=nums[1], reasons=[f"duplicate id {rid!r} also on line {nums[0]}"])
            )

    to_append = [
        raw_lines[r.number - 1]
        for r in reports
        if not r.reasons and r.id not in existing_ids
    ]
    already_present = sum(1 for r in reports if not r.reasons and r.id in existing_ids)
    trusted_carried = sum(1 for line in to_append if b'"trusted":true' in line)

    print(f"source: {source_path}")
    print(f"target: {target_path}")
    print(f"lines read: {len(lines)}")
    print(f"valid: {len(lines) - sum(1 for r in reports if r.reasons)}")
    print(f"invalid: {len(invalid)}")
    for r in invalid:
        for reason in r.reasons:
            print(f"  line {r.number}: {reason}")
    print(f"already present: {already_present}")
    if invalid:
        print("aborting: nothing written")
        return 1

    if not args.write:
        print(f"dry run — to append: {len(to_append)} (trusted:true carried over: {trusted_carried}); nothing written")
        return 0

    if not to_append:
        print("appended: 0")
        return 0

    try:
        os.makedirs(os.path.dirname(target_path), exist_ok=True)
        with open(target_path, "ab") as f:
            for line in to_append:
                f.write(line + b"\n")
    except OSError as e:
        print(f"ERROR: write failed: {e}", file=sys.stderr)
        return 1

    print(f"appended: {len(to_append)} (trusted:true carried over: {trusted_carried})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
