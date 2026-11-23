#!/usr/bin/env python3
"""Audit artist-backfill ID mismatches without modifying Violet's database.

Reads id_mismatch statuses from the existing artist backfill JSONL.
Only marks exact-title, equal-page-count, non-conflicting-artist/group pairs as
review candidates; these are NOT proven identical galleries.
"""
import argparse
import json
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request
from pathlib import Path

from backfill_artists import GALLERY_URL, USER_AGENT, clean_values, parse_gallery_js, MISSING_ARTISTS


def norm(text):
    return ' '.join(unicodedata.normalize('NFKC', text or '').casefold().split())


def piped(text):
    return [s.strip() for s in (text or '').split('|')
            if s.strip() and s.strip().casefold() not in ('n/a', 'na')]


def mismatch_ids(path):
    ids = set()
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            try:
                record = json.loads(line)
                if record.get('mode') == 'apply' and record.get('status') == 'id_mismatch':
                    ids.add(int(record['id']))
            except (ValueError, KeyError, TypeError):
                continue
    return sorted(ids)


def resume_ids(path):
    if not path.exists():
        return set()
    ids = set()
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            try:
                record = json.loads(line)
                if record['status'] not in ('network_error', 'http_error', 'parse_error'):
                    ids.add(int(record['id']))
            except (ValueError, KeyError, TypeError):
                continue
    return ids


def get_js(gallery_id, delay):
    request = urllib.request.Request(
        GALLERY_URL.format(gallery_id),
        headers={'User-Agent': USER_AGENT, 'Referer': 'https://hitomi.la/'},
    )
    for attempt in range(3):
        time.sleep(delay)
        try:
            with urllib.request.urlopen(request, timeout=15) as response:
                return {'status': 'ok', 'info': parse_gallery_js(
                    response.read().decode('utf-8', 'replace'))}
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                return {'status': 'http_404'}
            if exc.code in (429, 500, 502, 503, 504) and attempt < 2:
                time.sleep(1 + 2 * attempt)
                continue
            return {'status': 'http_error', 'http_code': exc.code}
        except (urllib.error.URLError, TimeoutError) as exc:
            if attempt < 2:
                time.sleep(1 + 2 * attempt)
                continue
            return {'status': 'network_error', 'detail': str(exc)}
        except (ValueError, json.JSONDecodeError) as exc:
            return {'status': 'parse_error', 'detail': str(exc)}
    return {'status': 'network_error'}


def record(db, gallery_id):
    return db.execute(
        'SELECT Id, Title, Artists, "Groups", Files, Language, ExistOnHitomi '
        'FROM HitomiColumnModel WHERE Id=?', (gallery_id,),
    ).fetchone()


def classify(target, source, info):
    """Conservatively classify a possible gallery replacement.

    Rows: Id, Title, Artists, Groups, Files, Language, ExistOnHitomi.
    A review_candidate is never automatically applied to the database.
    """
    artists = clean_values(info.get('artists'), 'artist')
    groups = clean_values(info.get('groups'), 'group')
    if source is None or norm(source[5]) != 'korean':
        return 'source_missing_or_non_korean'
    if not artists:
        return 'no_artists'
    source_artists = piped(source[2])
    if source_artists and set(map(norm, source_artists)) != set(map(norm, artists)):
        return 'artist_conflict'
    target_groups = {norm(s) for s in piped(target[3])}
    source_groups = {norm(s) for s in piped(source[3])}
    js_groups = {norm(s) for s in groups}
    if target_groups and (not js_groups or not target_groups & js_groups):
        return 'group_unverified_or_conflict'
    if source_groups and (not js_groups or not source_groups & js_groups):
        return 'group_unverified_or_conflict'
    try:
        target_count = int(target[4])
        source_count = int(source[4])
        js_count = len(info.get('files') or [])
    except (ValueError, TypeError):
        return 'page_count_unknown'
    if target_count <= 0 or target_count != source_count or target_count != js_count:
        return 'page_count_diff'
    title = norm(target[1])
    if not title or title != norm(source[1]) or (info.get('title') and title != norm(info['title'])):
        return 'title_diff'
    return 'review_candidate'


def audit_one(db, gallery_id, delay):
    result = {'id': gallery_id}
    target = record(db, gallery_id)
    if target is None or norm(target[5]) != 'korean' or target[6] != 1 or piped(target[2]):
        result['status'] = 'not_eligible'
        return result
    fetched = get_js(gallery_id, delay)
    if fetched['status'] != 'ok':
        return {**result, **fetched}
    info = fetched['info']
    try:
        source_id = int(info['id'])
    except (KeyError, ValueError, TypeError):
        return {**result, 'status': 'no_js_id'}
    if source_id == gallery_id:
        return {**result, 'status': 'now_matches'}
    source = record(db, source_id)
    result.update({
        'source_id': source_id,
        'target_title': target[1],
        'source_title': source[1] if source else None,
        'js_title': info.get('title'),
        'target_files': target[4],
        'source_files': source[4] if source else None,
        'js_files': len(info.get('files') or []),
        'js_artists': clean_values(info.get('artists'), 'artist'),
        'js_groups': clean_values(info.get('groups'), 'group'),
        'status': classify(target, source, info),
    })
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('db', type=Path)
    parser.add_argument('--source-report', type=Path, required=True,
                        help='Existing artist backfill JSONL with id_mismatch statuses')
    parser.add_argument('--report', type=Path, required=True,
                        help='Separate JSONL audit output, never use apply log')
    parser.add_argument('--limit', type=int, default=20)
    parser.add_argument('--delay', type=float, default=0.6,
                        help='Seconds between sequential requests (minimum 0.5)')
    parser.add_argument('--resume', action='store_true')
    parser.add_argument('--ids', type=int, nargs='+', help='Audit selected mismatched IDs')
    args = parser.parse_args(argv)
    if args.limit < 1 or args.delay < 0.5:
        parser.error('--limit must be >= 1, --delay must be >= 0.5')
    if args.report.resolve() == args.source_report.resolve():
        parser.error('--report must be distinct from --source-report')
    if not args.db.is_file() or not args.source_report.is_file():
        parser.error('database/source-report file does not exist')

    ids = mismatch_ids(args.source_report)
    if args.ids:
        allowed = set(args.ids)
        ids = [gallery_id for gallery_id in ids if gallery_id in allowed]
    if args.resume:
        seen = resume_ids(args.report)
        ids = [gallery_id for gallery_id in ids if gallery_id not in seen]
    ids = ids[:args.limit]
    db = sqlite3.connect(args.db.resolve().as_uri() + '?mode=ro', uri=True)
    try:
        stats = {}
        print(f'audit (read-only): {len(ids)} IDs, delay={args.delay}s, report={args.report}',
              flush=True)
        with args.report.open('a', encoding='utf-8') as out:
            for gallery_id in ids:
                result = audit_one(db, gallery_id, args.delay)
                stats[result['status']] = stats.get(result['status'], 0) + 1
                out.write(json.dumps(result, ensure_ascii=False) + '\n')
                out.flush()
                print(f"{gallery_id}: {result['status']} "
                      f"{result.get('source_id', '')}", flush=True)
        print('Summary:', stats)
    finally:
        db.close()
    return 0


if __name__ == '__main__':
    sys.exit(main())
