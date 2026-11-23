import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    'rank_artist_mismatch_candidates',
    Path(__file__).with_name('rank_artist_mismatch_candidates.py')
)
rank = importlib.util.module_from_spec(spec)
spec.loader.exec_module(rank)


def fixture(path):
    db = sqlite3.connect(path)
    db.executescript("""
        CREATE TABLE HitomiColumnModel (
            Id INTEGER PRIMARY KEY, Title TEXT, Artists TEXT, "Groups" TEXT,
            Tags TEXT, Thumbnail TEXT, EHash TEXT, Files INTEGER,
            Language TEXT, ExistOnHitomi INTEGER
        );
        INSERT INTO HitomiColumnModel VALUES
            (1, 'Same title', '|N/A|', '|same|', '|a|b|', 'cover.jpg', NULL, 10, 'korean', 1),
            (2, 'Same title', '|artist|', '|same|', '|a|b|', 'cover.jpg', 'hash2', 10, 'korean', 1),
            (3, 'Different groups', '|N/A|', '|g1|', '|a|', 'a.jpg', NULL, 5, 'korean', 1),
            (4, 'Different groups', '|artist|', '|g2|', '|b|', 'b.jpg', NULL, 5, 'korean', 1),
            (5, 'No metadata', '|N/A|', NULL, '|N/A|', NULL, NULL, 7, 'korean', 1),
            (6, 'No metadata', '|artist|', NULL, NULL, NULL, NULL, 7, 'korean', 1),
            (7, 'Excluded', '|N/A|', NULL, NULL, NULL, NULL, 10, 'korean', 1),
            (8, 'Excluded', '|artist|', NULL, NULL, NULL, NULL, 10, 'korean', 1);
    """)
    db.commit()
    return db


class RankCandidateTests(unittest.TestCase):
    def test_rank_is_review_only(self):
        with tempfile.TemporaryDirectory() as d:
            root = Path(d)
            dbfile, audit, report = (root / 'db.sqlite',
                                     root / 'audit.jsonl', root / 'ranked.jsonl')
            db = fixture(dbfile)
            db.close()
            records = [
                {'id': 1, 'source_id': 2, 'status': 'review_candidate',
                 'js_artists': ['artist']},
                {'id': 3, 'source_id': 4, 'status': 'review_candidate',
                 'js_artists': ['artist']},
                {'id': 5, 'source_id': 6, 'status': 'translation_title_review',
                 'js_artists': ['artist']},
                {'id': 7, 'source_id': 8, 'status': 'review_candidate'},
                {'id': 7, 'status': 'no_artists'},  # last audit status wins
            ]
            audit.write_text(''.join(json.dumps(r) + '\n' for r in records))
            self.assertEqual(rank.main([
                str(dbfile), '--audit-report', str(audit),
                '--report', str(report), '--top', '0']), 0)
            results = [json.loads(x) for x in report.read_text().splitlines()]
            self.assertEqual(len(results), 3)
            by_id = {x['id']: x for x in results}
            self.assertEqual(by_id[1]['review_tier'], 'first_review')
            self.assertEqual(by_id[1]['thumbnail'], 'same')
            self.assertEqual(by_id[1]['tags_jaccard'], 1.0)
            self.assertIs(by_id[1]['image_verified'], False)
            self.assertEqual(by_id[3]['review_tier'], 'metadata_conflict')
            self.assertEqual(by_id[5]['review_tier'], 'limited_evidence')
            db = sqlite3.connect(dbfile)
            self.assertEqual(db.execute('SELECT Artists FROM HitomiColumnModel WHERE Id=1'
                                        ).fetchone()[0], '|N/A|')
            db.close()

    def test_value_comparisons(self):
        self.assertEqual(rank.group_match('|a|b|', '|b|c|'), 'overlap')
        self.assertEqual(rank.group_match('|a|', '|c|'), 'conflict')
        self.assertEqual(rank.group_match(None, '|c|'), 'missing')
        self.assertIsNone(rank.tag_similarity(None, '|c|'))
        self.assertEqual(rank.tag_similarity('|a|b|', '|b|c|'), 0.3333)


if __name__ == '__main__':
    unittest.main()
