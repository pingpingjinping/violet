#!/usr/bin/env python3
"""Read-only audit of missing artist/group metadata for Korean EH-only rows.

No database writes, images, cookies or automatic retries. Results are kept in
a resumable local JSONL report. A separate, reviewed apply step is required.
"""
import argparse
from collections import Counter
import json
import os
from pathlib import Path
import re
import sqlite3
import time
import urllib.request

API = "https://api.e-hentai.org/api.php"
MISSING_ARTISTS = """(Artists IS NULL OR TRIM(Artists)='' OR
    UPPER(REPLACE(TRIM(Artists),'|',''))='N/A')"""
DONE = {"found", "no_metadata", "unavailable", "token_mismatch",
        "page_count_diff", "invalid_token", "language_unverified"}
TOKEN = re.compile(r"[0-9a-fA-F]{10}")


def missing(value):
    return value is None or not value.strip() or value.strip().replace("|", "").upper() == "N/A"


def clean_tags(tags, prefix):
    values = []
    for tag in tags:
        if not isinstance(tag, str) or not tag.startswith(prefix):
            continue
        value = tag[len(prefix):].strip()
        if not value or value.lower() == "n/a" or "|" in value or "\x00" in value:
            continue
        if value not in values:
            values.append(value)
    return values


def inspect(row, item):
    gid, token, pages, old_artists, old_groups = row
    out = {"id": gid, "token": token, "pages": pages}
    if item is None or item.get("error"):
        return dict(out, status="unavailable")
    if item.get("gid") != gid or item.get("token") != token:
        return dict(out, status="token_mismatch")
    if not pages or str(item.get("filecount")) != str(pages):
        return dict(out, status="page_count_diff")
    tags = item.get("tags")
    if not isinstance(tags, list):
        raise ValueError("Malformed metadata: missing tags list")
    artists = clean_tags(tags, "artist:") if missing(old_artists) else []
    groups = clean_tags(tags, "group:") if missing(old_groups) else []
    # For a future apply, require explicit source language as well as ID/token/pages.
    if "language:korean" not in tags:
        return dict(out, status="language_unverified")
    return dict(out, status="found" if artists or groups else "no_metadata",
                artists=artists, groups=groups)


def fetch(batch):
    payload = {"method": "gdata", "gidlist": [[r[0], r[1]] for r in batch],
               "namespace": 1}
    req = urllib.request.Request(API, data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json",
                 "User-Agent": "Violet-Metadata-Check/1.0"})
    with urllib.request.urlopen(req, timeout=30) as response:
        data = json.load(response)
    items = data.get("gmetadata")
    if not isinstance(items, list) or not items:
        raise ValueError("Missing metadata response")
    expected = {r[0] for r in batch}
    result = {}
    for item in items:
        if not isinstance(item, dict) or item.get("gid") not in expected:
            raise ValueError("Unexpected response ID")
        gid = item["gid"]
        if gid in result:
            raise ValueError("Duplicate response ID")
        result[gid] = item
    if set(result) != expected:
        raise ValueError("Incomplete response; stopping without marking batch done")
    return result


def resume_ids(path):
    seen = set()
    if path.exists():
        with path.open(encoding="utf-8") as stream:
            for line in stream:
                try:
                    r = json.loads(line)
                    if r.get("status") in DONE:
                        seen.add((r["id"], r.get("token"), r.get("pages")))
                except (ValueError, KeyError):
                    continue
    return seen


def run(args):
    db = sqlite3.connect(args.db.resolve().as_uri() + "?mode=ro", uri=True, timeout=30)
    try:
        rows = db.execute(f"""
            SELECT Id, EHash, Files, Artists, "Groups"
            FROM HitomiColumnModel
            WHERE LOWER(TRIM(Language))='korean' AND ExistOnHitomi=0
              AND {MISSING_ARTISTS}
            ORDER BY Id DESC
        """).fetchall()
    finally:
        db.close()
    seen = resume_ids(args.report)
    rows = [r for r in rows if tuple(r[:3]) not in seen][:args.limit]
    print(f"read-only: {len(rows)} rows, batch=5, delay={args.delay}s", flush=True)
    counts = Counter()
    # Private report, since it contains gallery tokens. No credentials used.
    fd = os.open(args.report, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
    with os.fdopen(fd, "a", encoding="utf-8") as report:
        for i in range(0, len(rows), 5):
            batch = rows[i:i+5]
            valid = [r for r in batch if isinstance(r[1], str) and TOKEN.fullmatch(r[1])]
            try:
                response = fetch(valid) if valid else {}
                results = [
                    inspect(r, response[r[0]]) if r in valid else
                    {"id": r[0], "token": r[1], "pages": r[2], "status": "invalid_token"}
                    for r in batch
                ]
            except (OSError, ValueError, TypeError, AttributeError) as exc:
                print(f"Stopped on request/response error: {type(exc).__name__}: {exc}", flush=True)
                print("Summary:", dict(counts), flush=True)
                return 1
            for item in results:
                report.write(json.dumps(item, ensure_ascii=False) + "\n")
                report.flush()
                counts[item["status"]] += 1
                if item.get("artists"):
                    counts["artist_found"] += 1
                if item.get("groups"):
                    counts["group_found"] += 1
                print(f'{item["id"]}: {item["status"]} '
                      f'artists={len(item.get("artists", []))} '
                      f'groups={len(item.get("groups", []))}', flush=True)
            if i + 5 < len(rows):
                time.sleep(args.delay)
    print("Summary:", dict(counts), flush=True)
    return 0


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("db", type=Path)
    p.add_argument("--report", type=Path, required=True)
    p.add_argument("--limit", type=int, default=100)
    p.add_argument("--delay", type=float, default=10)
    args = p.parse_args()
    if args.limit < 1 or not 10 <= args.delay < float("inf"):
        p.error("limit must be positive; delay must be at least 10 seconds")
    return run(args)


if __name__ == "__main__":
    raise SystemExit(main())
