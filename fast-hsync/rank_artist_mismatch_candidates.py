#!/usr/bin/env python3
"""Rank already-audited artist mismatch candidates for MANUAL review.

Read-only SQLite, no network calls, no automatic gallery identity decisions.
EHash identifies an ExHentai gallery, NOT the image contents. Matching
thumbnails/metadata are hints, not evidence of identical page images.
"""
import argparse
from collections import Counter
import json
import sqlite3
from pathlib import Path

REVIEW_STATUSES = {'review_candidate', 'translation_title_review'}


def values(raw):
    return {x.strip().casefold() for x in (raw or '').split('|')
            if x.strip() and x.strip().casefold() not in ('n/a', 'na')}


def compare_value(left, right):
    if not left or not right:
        return 'missing'
    return 'same' if left == right else 'different'


def group_match(left, right):
    a, b = values(left), values(right)
    if not a or not b:
        return 'missing'
    if a == b:
        return 'same'
    return 'overlap' if a & b else 'conflict'


def tag_similarity(left, right):
    a, b = values(left), values(right)
    if not a or not b:
        return None
    return round(len(a & b) / len(a | b), 4)


def rank(row):
    """Prioritize human inspection; never declare any gallery verified."""
    thumb = row['thumbnail']
    group = row['groups']
    tags = row['tags_jaccard']
    if group == 'conflict':
        return 'metadata_conflict'
    if thumb == 'same' and group == 'same' and tags is not None and tags >= 0.8:
        return 'first_review'
    if (thumb == 'same' or group == 'same') and tags is not None and tags >= 0.8:
        return 'next_review'
    if thumb == 'same' or group in ('same', 'overlap') or (tags is not None and tags >= 0.8):
        return 'other_review'
    return 'limited_evidence'


def latest_candidates(path):
    latest = {}
    with path.open(encoding='utf-8') as stream:
        for line in stream:
            if not line.strip():
                continue
            entry = json.loads(line)
            latest[int(entry['id'])] = entry
    return [entry for entry in latest.values()
            if entry.get('status') in REVIEW_STATUSES]


def get_row(db, gallery_id):
    return db.execute(
        'SELECT Id, Title, Artists, "Groups", Tags, Thumbnail, EHash, Files, '
        'Language, ExistOnHitomi FROM HitomiColumnModel WHERE Id=?',
        (gallery_id,),
    ).fetchone()


def analyze(db, item):
    target, source = get_row(db, item['id']), get_row(db, item['source_id'])
    result = {
        'id': item['id'], 'source_id': item['source_id'],
        'audit_status': item['status'], 'js_artists': item.get('js_artists', []),
        'title': item.get('target_title'), 'image_verified': False,
    }
    if target is None or source is None:
        result['review_tier'] = 'db_missing'
        return result
    if values(target[2]) or target[9] != 1 or (target[8] or '').casefold() != 'korean':
        result['review_tier'] = 'not_eligible'
        return result
    result.update({
        'thumbnail': compare_value(target[5], source[5]),
        'ehash': compare_value(target[6], source[6]),
        'groups': group_match(target[3], source[3]),
        'tags_jaccard': tag_similarity(target[4], source[4]),
        'target_files': target[7], 'source_files': source[7],
        'target_title': target[1], 'source_title': source[1],
    })
    result['review_tier'] = rank(result)
    return result


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('db', type=Path)
    parser.add_argument('--audit-report', type=Path, required=True)
    parser.add_argument('--report', type=Path, required=True)
    parser.add_argument('--top', type=int, default=25)
    args = parser.parse_args(argv)
    if args.top < 0:
        parser.error('--top must be nonnegative')
    if not args.db.is_file() or not args.audit_report.is_file():
        parser.error('DB or audit report not found')
    if args.audit_report.resolve() == args.report.resolve():
        parser.error('--report must differ from --audit-report')
    if args.db.resolve() == args.report.resolve():
        parser.error('--report must differ from DB')

    uri = args.db.resolve().as_uri() + '?mode=ro'
    with sqlite3.connect(uri, uri=True) as db:
        results = [analyze(db, item) for item in latest_candidates(args.audit_report)]
    order = {
        'first_review': 0, 'next_review': 1, 'other_review': 2,
        'limited_evidence': 3, 'metadata_conflict': 4,
        'not_eligible': 5, 'db_missing': 6,
    }
    results.sort(key=lambda r: (order[r['review_tier']], r['id']))
    with args.report.open('w', encoding='utf-8') as out:
        for entry in results:
            out.write(json.dumps(entry, ensure_ascii=False) + '\n')
    print('Read-only review ranking:', len(results), 'candidates')
    for name, count in sorted(Counter(r['review_tier'] for r in results).items(),
                              key=lambda x: order[x[0]]):
        print(f'  {name}: {count}')
    print('Top review pairs (NOT image-verified):')
    for r in results[:args.top]:
        print(f"  {r['id']} -> {r['source_id']} | {r['review_tier']} | "
              f"thumb={r.get('thumbnail', '?')}, group={r.get('groups', '?')}, "
              f"tags={r.get('tags_jaccard')} | {r['js_artists']}")
    print('Report:', args.report)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
