#!/usr/bin/env python3
"""Conservative, resumable artist-metadata backfill for an existing Violet SQLite DB.

Read-only by default. --apply additionally requires --backup-confirmed.
Only the Artists column of existing Korean records with missing artists is changed.
"""
import argparse
import concurrent.futures
import json
import sqlite3
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

GALLERY_URL = 'https://ltn.gold-usergeneratedcontent.net/galleries/{}.js'
MISSING_ARTISTS = "(Artists IS NULL OR TRIM(Artists)='' OR UPPER(REPLACE(TRIM(Artists),'|',''))='N/A')"
USER_AGENT = 'Mozilla/5.0 (compatible; VioletArtistBackfill/1.0)'


def clean_values(rows, field):
    if not isinstance(rows, list):
        return []
    values = []
    for row in rows:
        value = row.get(field) if isinstance(row, dict) else None
        if not isinstance(value, str):
            continue
        value = value.strip()
        if not value or value.lower() in ('n/a', 'na') or '|' in value or '\x00' in value:
            continue
        if value not in values:
            values.append(value)
    return values


def parse_gallery_js(raw):
    prefix = 'var galleryinfo = '
    index = raw.find(prefix)
    if index < 0:
        raise ValueError('galleryinfo prefix not found')
    data, _ = json.JSONDecoder().raw_decode(raw[index + len(prefix):].lstrip())
    if not isinstance(data, dict):
        raise ValueError('galleryinfo must be an object')
    return data


def fetch_gallery(gallery_id):
    req = urllib.request.Request(GALLERY_URL.format(gallery_id), headers={
        'User-Agent': USER_AGENT, 'Referer': 'https://hitomi.la/',
    })
    for attempt in range(3):
        try:
            time.sleep(0.3)  # Keep a modest request rate on public hosts.
            with urllib.request.urlopen(req, timeout=15) as response:
                info = parse_gallery_js(response.read().decode('utf-8', 'replace'))
            if info.get('id') is not None and str(info['id']) != str(gallery_id):
                return {'status': 'id_mismatch'}
            return {'status': 'ok', 'artists': clean_values(info.get('artists'), 'artist'),
                    'groups': clean_values(info.get('groups'), 'group')}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {'status': 'http_404'}
            if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + attempt * 2)
                continue
            return {'status': 'http_error', 'detail': str(exc.code)}
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt < 2:
                time.sleep(1 + attempt * 2)
                continue
            return {'status': 'network_error', 'detail': str(exc)}
        except (json.JSONDecodeError, ValueError) as exc:
            return {'status': 'parse_error', 'detail': str(exc)}
    return {'status': 'network_error'}


def parse_fallback(values):
    result = {}
    for value in values:
        try:
            target, source = map(int, value.split(':', 1))
            if target <= 0 or source <= 0 or target == source:
                raise ValueError
        except ValueError:
            raise ValueError('--fallback must be TARGET_ID:SOURCE_ID (different positive IDs)')
        result[target] = source
    return result


def candidates(db, specific_ids, limit):
    if specific_ids:
        qs = ','.join('?' * len(specific_ids))
        query = (f"SELECT Id, Artists, \"Groups\" FROM HitomiColumnModel "
                 f"WHERE Id IN ({qs}) AND LOWER(TRIM(Language))='korean' "
                 f"AND {MISSING_ARTISTS} ORDER BY Id LIMIT ?")
        return db.execute(query, [*specific_ids, limit]).fetchall()
    return db.execute(
        f"SELECT Id, Artists, \"Groups\" FROM HitomiColumnModel "
        f"WHERE LOWER(TRIM(Language))='korean' AND {MISSING_ARTISTS} "
        f"ORDER BY Id LIMIT ?", (limit,)).fetchall()


def resolve_artist(record, fallback):
    gallery_id, _, groups = record
    response = fetch_gallery(gallery_id)
    source_id = gallery_id
    if not response.get('artists') and response['status'] == 'http_404' and gallery_id in fallback:
        source_id = fallback[gallery_id]
        response = fetch_gallery(source_id)
        if response.get('artists'):
            expected = {x.strip().casefold() for x in (groups or '').split('|') if x.strip()}
            actual = {x.casefold() for x in response.get('groups', [])}
            if not expected or not (expected & actual):
                return {'id': gallery_id, 'status': 'fallback_group_mismatch', 'source_id': source_id}
    if not response.get('artists'):
        return {'id': gallery_id, 'status': response['status'] if response['status'] != 'ok' else 'no_artists',
                'source_id': source_id}
    return {'id': gallery_id, 'status': 'found', 'artists': '|'+ '|'.join(response['artists']) + '|',
            'source_id': source_id}


def update_one(db, row, result, has_fts):
    gallery_id, old_artists, _ = row
    # A compare-and-set prevents overwriting a newer normal sync result.
    cur = db.execute(f"UPDATE HitomiColumnModel SET Artists=? "
                     f"WHERE Id=? AND Artists IS ? AND LOWER(TRIM(Language))='korean' "
                     f"AND {MISSING_ARTISTS}", (result['artists'], gallery_id, old_artists))
    if cur.rowcount != 1:
        db.rollback()
        return False
    if has_fts:
        db.execute('DELETE FROM FtsTags WHERE rowid=?', (gallery_id,))
        db.execute('''INSERT INTO FtsTags(rowid, Tags, Artists, Groups_, Series, Characters)
            SELECT Id,
                TRIM(REPLACE(REPLACE(COALESCE(Tags, ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE(Artists, ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE("Groups", ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE(Series, ''), ' ', '_'), '|', ' ')),
                TRIM(REPLACE(REPLACE(COALESCE(Characters, ''), ' ', '_'), '|', ' '))
            FROM HitomiColumnModel WHERE Id=?
              AND (ExistOnHitomi=1 OR Tags LIKE '%|expunged|%')''', (gallery_id,))
    db.commit()
    return True


def read_resume_ids(path, mode):
    if not path.exists():
        return set()
    ids = set()
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            try:
                record = json.loads(line)
                if record.get('mode') == mode and record.get('status') not in ('network_error', 'http_error', 'parse_error'):
                    ids.add(record['id'])
            except (ValueError, KeyError):
                continue
    return ids


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('db', type=Path)
    parser.add_argument('--ids', type=int, nargs='+', help='Check only these gallery IDs')
    parser.add_argument('--limit', type=int, default=20, help='Maximum records per run (default: 20)')
    parser.add_argument('--workers', type=int, default=2, help='Parallel requests (1..4)')
    parser.add_argument('--apply', action='store_true', help='Write artists and refresh FtsTags')
    parser.add_argument('--backup-confirmed', action='store_true', help='Confirm verified DB backup before apply')
    parser.add_argument('--fallback', action='append', default=[], metavar='TARGET:SOURCE',
                        help='Explicitly verified same-gallery alternate ID; requires matching groups')
    parser.add_argument('--report', type=Path, default=Path('backfill-artists-report.jsonl'))
    parser.add_argument('--resume', action='store_true', help='Skip already processed IDs in this mode')
    args = parser.parse_args(argv)
    if args.limit < 1 or not 1 <= args.workers <= 4:
        parser.error('--limit must be >= 1 and --workers must be 1..4')
    if args.apply and not args.backup_confirmed:
        parser.error('--apply requires --backup-confirmed; take and verify a DB backup first')
    if not args.db.is_file():
        parser.error('database file does not exist')
    try:
        fallback = parse_fallback(args.fallback)
    except ValueError as exc:
        parser.error(str(exc))

    uri = args.db.resolve().as_uri() + ('?mode=rw' if args.apply else '?mode=ro')
    db = sqlite3.connect(uri, uri=True, timeout=30)
    try:
        db.execute('PRAGMA busy_timeout=30000')
        mode = 'apply' if args.apply else 'dry-run'
        seen = read_resume_ids(args.report, mode) if args.resume else set()
        rows = candidates(db, args.ids, args.limit + len(seen))
        rows = [row for row in rows if row[0] not in seen][:args.limit]
        has_fts = bool(db.execute("SELECT 1 FROM sqlite_master WHERE name='FtsTags' AND type='table'").fetchone())
        print(f'{mode}: {len(rows)} rows, workers={args.workers}, FtsTags={has_fts}, report={args.report}', flush=True)
        counts = {}
        with args.report.open('a', encoding='utf-8') as report:
            with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as pool:
                for row, item in zip(rows, pool.map(lambda x: resolve_artist(x, fallback), rows)):
                    if args.apply and item['status'] == 'found':
                        try:
                            item['status'] = 'applied' if update_one(db, row, item, has_fts) else 'stale'
                        except sqlite3.Error as exc:
                            db.rollback()
                            item['status'] = 'db_error'
                            item['detail'] = str(exc)
                    item['mode'] = mode
                    counts[item['status']] = counts.get(item['status'], 0) + 1
                    report.write(json.dumps(item, ensure_ascii=False) + '\n')
                    report.flush()
                    print(f"{row[0]}: {item['status']} {item.get('artists', '')}", flush=True)
        print('Summary:', counts)
        if args.apply:
            print('DB artists updated. Refresh/re-export mobile DB separately; this tool does NOT publish mobile DB or sync chunks.')
        return 0
    finally:
        db.close()


if __name__ == '__main__':
    sys.exit(main())
