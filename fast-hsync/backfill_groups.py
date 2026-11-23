#!/usr/bin/env python3
"""Read-only-by-default group metadata backfill for existing Korean Violet records.

Only missing Groups values are eligible; Artists and all other fields are preserved.
Requires --apply --backup-confirmed to modify SQLite and its FtsTags index.
"""
import argparse
import concurrent.futures
import json
import sqlite3
import sys
from pathlib import Path

from backfill_artists import fetch_gallery, read_resume_ids, MISSING_ARTISTS

MISSING_GROUPS = """("Groups" IS NULL OR TRIM("Groups") = ''
 OR UPPER(REPLACE(TRIM("Groups"), '|', '')) = 'N/A')"""


def candidates(db, specific_ids, limit, hitomi_only=False, missing_artists_only=False):
    hitomi_filter = ' AND ExistOnHitomi=1' if hitomi_only else ''
    artist_filter = f' AND {MISSING_ARTISTS}' if missing_artists_only else ''
    where = f"LOWER(TRIM(Language))='korean' AND {MISSING_GROUPS}{hitomi_filter}{artist_filter}"
    if specific_ids:
        placeholders = ','.join('?' for _ in specific_ids)
        return db.execute(
            f'SELECT Id, "Groups" FROM HitomiColumnModel '
            f'WHERE {where} AND Id IN ({placeholders}) ORDER BY Id LIMIT ?',
            [*specific_ids, limit],
        ).fetchall()
    return db.execute(
        f'SELECT Id, "Groups" FROM HitomiColumnModel '
        f'WHERE {where} ORDER BY Id LIMIT ?', (limit,),
    ).fetchall()


def resolve_group(row):
    gallery_id = row[0]
    response = fetch_gallery(gallery_id)
    if response['status'] != 'ok':
        return {'id': gallery_id, 'status': response['status'],
                'detail': response.get('detail', '')}
    groups = response.get('groups') or []
    if not groups:
        return {'id': gallery_id, 'status': 'no_groups'}
    # fetch_gallery validates the requested ID matches the galleryinfo ID,
    # and strips invalid pipe-delimited values from the source data.
    return {'id': gallery_id, 'status': 'found',
            'groups': '|' + '|'.join(groups) + '|'}


def apply_group(db, row, result, hitomi_only=False, missing_artists_only=False):
    gallery_id, old_groups = row
    hitomi_filter = ' AND ExistOnHitomi=1' if hitomi_only else ''
    artist_filter = f' AND {MISSING_ARTISTS}' if missing_artists_only else ''
    try:
        # Compare-and-set ensures no regular sync or other job replaced
        # the missing value since we read it.
        changed = db.execute(
            f'UPDATE HitomiColumnModel SET "Groups" = ? '
            f'WHERE Id = ? AND "Groups" IS ? '
            f"AND LOWER(TRIM(Language))='korean' AND {MISSING_GROUPS}{hitomi_filter}{artist_filter}",
            (result['groups'], gallery_id, old_groups),
        )
        if changed.rowcount != 1:
            db.rollback()
            return False

        # Preserve the same FTS conversion as fast-hsync/db.go.
        db.execute('DELETE FROM FtsTags WHERE rowid = ?', (gallery_id,))
        db.execute('''INSERT INTO FtsTags(rowid, Tags, Artists, Groups_, Series, Characters)
            SELECT Id,
                TRIM(REPLACE(REPLACE(COALESCE(Tags, ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE(Artists, ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE("Groups", ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE(Series, ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE(Characters, ''), ' ', '_'), '|', ' '))
            FROM HitomiColumnModel WHERE Id = ?
              AND (ExistOnHitomi = 1 OR Tags LIKE '%|expunged|%')''',
                   (gallery_id,))
        db.commit()
        return True
    except Exception:
        db.rollback()
        raise


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('db', type=Path, help='Existing Violet data.db')
    parser.add_argument('--ids', type=int, nargs='+', help='Test only these IDs')
    parser.add_argument('--hitomi-only', action='store_true',
                        help='Only process ExistOnHitomi=1 records')
    parser.add_argument('--missing-artists-only', action='store_true',
                        help='Only check records where Artists and Groups are both missing')
    parser.add_argument('--limit', type=int, default=20,
                        help='Max records per run (default 20)')
    parser.add_argument('--workers', type=int, default=2,
                        help='Concurrent gallery JS requests (1..4)')
    parser.add_argument('--report', type=Path,
                        default=Path('backfill-groups-report.jsonl'))
    parser.add_argument('--resume', action='store_true',
                        help='Skip completed records in this report and mode')
    parser.add_argument('--apply', action='store_true',
                        help='Write missing Groups and update FtsTags')
    parser.add_argument('--backup-confirmed', action='store_true',
                        help='Confirm a verified SQLite backup exists')
    args = parser.parse_args(argv)

    if args.limit < 1 or not 1 <= args.workers <= 4:
        parser.error('--limit must be >= 1 and --workers must be 1..4')
    if args.ids and any(item <= 0 for item in args.ids):
        parser.error('--ids must contain positive integers')
    if args.apply and not args.backup_confirmed:
        parser.error('--apply requires --backup-confirmed after verifying a backup')
    if not args.db.is_file():
        parser.error('database file does not exist')

    mode = 'apply' if args.apply else 'dry-run'
    uri = args.db.resolve().as_uri() + ('?mode=rw' if args.apply else '?mode=ro')
    db = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        db.execute('PRAGMA busy_timeout=30000')
        fts_exists = db.execute(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='FtsTags'"
        ).fetchone() is not None
        if args.apply and not fts_exists:
            parser.error('FtsTags is missing; refusing to update without search index')
        seen = read_resume_ids(args.report, mode) if args.resume else set()
        rows = candidates(db, args.ids, args.limit + len(seen), args.hitomi_only,
                          args.missing_artists_only)
        rows = [r for r in rows if r[0] not in seen][:args.limit]
        print(f'{mode}: {len(rows)} rows, workers={args.workers}, '
              f'HitomiOnly={args.hitomi_only}, '
              f'MissingArtistsOnly={args.missing_artists_only}, '
              f'FtsTags={fts_exists}, report={args.report}', flush=True)

        counts = {}
        with args.report.open('a', encoding='utf-8') as report:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                for row, result in zip(rows, pool.map(resolve_group, rows)):
                    if args.apply and result['status'] == 'found':
                        try:
                            result['status'] = ('applied' if apply_group(db, row, result, args.hitomi_only,
                                                             args.missing_artists_only)
                                                else 'stale')
                        except sqlite3.Error as exc:
                            result['status'] = 'db_error'
                            result['detail'] = str(exc)
                    result['mode'] = mode
                    counts[result['status']] = counts.get(result['status'], 0) + 1
                    report.write(json.dumps(result, ensure_ascii=False) + '\n')
                    report.flush()
                    print(f"{row[0]}: {result['status']} {result.get('groups', '')}",
                          flush=True)
        print('Summary:', counts)
        if args.apply:
            print('Groups and FtsTags updated. Mobile DB export/deployment is separate.')
        return 0
    finally:
        db.close()


if __name__ == '__main__':
    sys.exit(main())
