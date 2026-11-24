#!/usr/bin/env python3
"""Apply locally audited Korean EH-only artist/group metadata, without network I/O.

Dry-run by default. Apply requires an explicit verified-backup confirmation.
Revalidate every candidate against the current DB within one transaction.
"""
import argparse
from collections import Counter
import json
from pathlib import Path
import sqlite3

from audit_eh_metadata import TOKEN, missing


def pipe_value(values):
    if not isinstance(values, list):
        raise ValueError("Expected tag list")
    clean = []
    for v in values:
        if (not isinstance(v, str) or not v.strip() or v != v.strip()
                or v.lower() in ("n/a", "na") or "|" in v or "\x00" in v):
            raise ValueError("Invalid tag value")
        if v not in clean:
            clean.append(v)
    return "|" + "|".join(clean) + "|" if clean else None


def load_candidates(path):
    latest = {}
    with path.open(encoding="utf-8") as stream:
        for line in stream:
            if not line.strip():
                continue
            r = json.loads(line)
            if type(r.get("id")) is not int or r["id"] <= 0:
                raise ValueError("Invalid report ID")
            latest[r["id"]] = r
    candidates = []
    for r in latest.values():
        if r.get("status") != "found":
            continue
        if (not isinstance(r.get("token"), str) or not TOKEN.fullmatch(r["token"])
                or type(r.get("pages")) is not int or r["pages"] <= 0):
            raise ValueError("Invalid identity in found record")
        a = pipe_value(r.get("artists"))
        g = pipe_value(r.get("groups"))
        if not (a or g):
            raise ValueError("Found record contains no candidate tags")
        candidates.append((r["id"], r["token"], r["pages"], a, g))
    return candidates


def run(db, candidates, apply=False):
    stats = Counter()
    db.execute("BEGIN IMMEDIATE" if apply else "BEGIN")
    try:
        if not db.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='FtsTags'").fetchone():
            raise RuntimeError("FtsTags missing; refusing to continue")
        for gid, token, pages, a, g in candidates:
            stats["checked"] += 1
            row = db.execute("""
                SELECT Artists, "Groups", Tags FROM HitomiColumnModel
                WHERE Id=? AND EHash=? AND Files=? AND ExistOnHitomi=0
                  AND LOWER(TRIM(Language))='korean'
            """, (gid, token, pages)).fetchone()
            if row is None:
                stats["identity_changed"] += 1
                continue
            old_a, old_g, tags = row
            # If existing metadata conflicts with the audited source, skip the
            # entire row rather than combine metadata from uncertain versions.
            if ((a and not missing(old_a) and old_a != a)
                    or (g and not missing(old_g) and old_g != g)):
                stats["existing_conflict"] += 1
                continue
            change_a = bool(a and missing(old_a))
            change_g = bool(g and missing(old_g))
            if not (change_a or change_g):
                stats["already_filled"] += 1
                continue
            if apply:
                cur = db.execute("""
                    UPDATE HitomiColumnModel SET Artists=?, "Groups"=?
                    WHERE Id=? AND EHash=? AND Files=? AND ExistOnHitomi=0
                      AND LOWER(TRIM(Language))='korean'
                      AND Artists IS ? AND "Groups" IS ?
                """, (a if change_a else old_a, g if change_g else old_g,
                      gid, token, pages, old_a, old_g))
                if cur.rowcount != 1:
                    raise RuntimeError(f"Unexpected update count for {gid}")
                # Preserve fast-hsync/db.go's existing index scope: EH-only
                # normal galleries are not indexed, expunged galleries are.
                if "|expunged|" in (tags or ""):
                    db.execute("DELETE FROM FtsTags WHERE rowid=?", (gid,))
                    db.execute("""
                        INSERT INTO FtsTags(rowid, Tags, Artists, Groups_, Series, Characters)
                        SELECT Id,
                            TRIM(REPLACE(REPLACE(COALESCE(Tags,''),' ','_'),'|',' ')),
                            TRIM(REPLACE(REPLACE(COALESCE(Artists,''),' ','_'),'|',' ')),
                            TRIM(REPLACE(REPLACE(COALESCE("Groups",''),' ','_'),'|',' ')),
                            TRIM(REPLACE(REPLACE(COALESCE(Series,''),' ','_'),'|',' ')),
                            TRIM(REPLACE(REPLACE(COALESCE(Characters,''),' ','_'),'|',' '))
                        FROM HitomiColumnModel WHERE Id=?
                    """, (gid,))
            stats["eligible"] += 1
            stats["artists"] += int(change_a)
            stats["groups"] += int(change_g)
            stats["both"] += int(change_a and change_g)
            stats["fts_rows"] += int("|expunged|" in (tags or ""))
        if apply:
            db.commit()
        else:
            db.rollback()
    except BaseException:
        db.rollback()
        raise
    return stats


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("db", type=Path)
    p.add_argument("--report", required=True, type=Path)
    p.add_argument("--apply", action="store_true")
    p.add_argument("--backup-confirmed", action="store_true")
    args = p.parse_args()
    if args.apply and not args.backup_confirmed:
        p.error("--apply requires --backup-confirmed")
    candidates = load_candidates(args.report)
    db = sqlite3.connect(args.db.resolve().as_uri() + ("?mode=rw" if args.apply else "?mode=ro"),
                         uri=True, timeout=30)
    try:
        stats = run(db, candidates, args.apply)
    finally:
        db.close()
    print("Mode:", "applied" if args.apply else "dry-run")
    print("Summary:", dict(stats))
    if args.apply:
        print("Committed. Mobile DB export is separate.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
