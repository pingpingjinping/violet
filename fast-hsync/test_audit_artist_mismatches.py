import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'audit_artist_mismatches', Path(__file__).with_name('audit_artist_mismatches.py')
)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


def db_fixture(path):
    db = sqlite3.connect(path)
    db.executescript("""
    CREATE TABLE HitomiColumnModel (
        Id INTEGER PRIMARY KEY, Title TEXT, Artists TEXT, "Groups" TEXT,
        Files INTEGER, Language TEXT, ExistOnHitomi INTEGER
    );
    INSERT INTO HitomiColumnModel VALUES
        (1266970, 'futanari otoko', '|N/A|', '|potato house|', 15, 'korean', 1),
        (1266972, 'futanari otoko', '|potato|', '|potato house|', 15, 'korean', 1),
        (984565, 'New Face Ch.1-5', '|N/A|', NULL, 66, 'korean', 1),
        (1026435, 'New Face Ch.1-22', '|lsd|', NULL, 328, 'korean', 1),
        (2955989, 'Same title', '|N/A|', NULL, 22, 'korean', 1),
        (2956059, 'Same title', '|aratagawa nikei|', NULL, 22, 'korean', 1);
    """)
    return db


class ArtistMismatchAuditTests(unittest.TestCase):
    def test_mismatch_source_report_dedup(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'artist.jsonl'
            path.write_text('\n'.join([
                json.dumps({'mode': 'apply', 'id': 1266970, 'status': 'id_mismatch'}),
                json.dumps({'mode': 'dry-run', 'id': 111, 'status': 'id_mismatch'}),
                json.dumps({'mode': 'apply', 'id': 1266970, 'status': 'id_mismatch'}),
                json.dumps({'mode': 'apply', 'id': 984565, 'status': 'no_artists'}),
                json.dumps({'mode': 'apply', 'id': 2955989, 'status': 'id_mismatch'}),
            ]) + '\n')
            self.assertEqual(audit.mismatch_ids(path), [1266970, 2955989])

    def test_exact_title_count_and_group_are_review_only(self):
        with tempfile.TemporaryDirectory() as td:
            db = db_fixture(str(Path(td) / 'db.sqlite'))
            info = {
                'id': 1266972, 'title': 'futanari otoko',
                'artists': [{'artist': 'potato'}],
                'groups': [{'group': 'potato house'}],
                'files': [{}] * 15
            }
            with patch.object(audit, 'get_js', return_value={'status': 'ok', 'info': info}):
                result = audit.audit_one(db, 1266970, 0.5)
            self.assertEqual(result['status'], 'review_candidate')
            self.assertEqual(result['source_id'], 1266972)
            self.assertEqual(db.execute(
                'SELECT Artists FROM HitomiColumnModel WHERE Id=1266970'
            ).fetchone()[0], '|N/A|')
            db.close()

    def test_extra_chapters_never_marked_candidate(self):
        with tempfile.TemporaryDirectory() as td:
            db = db_fixture(str(Path(td) / 'db.sqlite'))
            info = {'id': 1026435, 'title': 'New Face Ch.1-22',
                    'artists': [{'artist': 'lsd'}], 'files': [{}] * 328}
            with patch.object(audit, 'get_js', return_value={'status': 'ok', 'info': info}):
                result = audit.audit_one(db, 984565, 0.5)
            self.assertEqual(result['status'], 'page_count_diff')
            db.close()

    def test_artist_conflict_and_missing_js_artists(self):
        with tempfile.TemporaryDirectory() as td:
            db = db_fixture(str(Path(td) / 'db.sqlite'))
            a, b = audit.record(db, 2955989), audit.record(db, 2956059)
            info = {'title': 'Same title', 'files': [{}]*22,
                    'artists': [{'artist': 'wrong artist'}]}
            self.assertEqual(audit.classify(a, b, info), 'artist_conflict')
            info['artists'] = []
            self.assertEqual(audit.classify(a, b, info), 'no_artists')
            db.close()

    def test_resume_retryable_states(self):
        with tempfile.TemporaryDirectory() as td:
            path = Path(td) / 'audit.jsonl'
            path.write_text('\n'.join([
                '{"id":1,"status":"review_candidate"}',
                '{"id":2,"status":"http_404"}',
                '{"id":3,"status":"network_error"}',
                '{"id":4,"status":"http_error"}'
            ]) + '\n')
            self.assertEqual(audit.resume_ids(path), {1, 2})


if __name__ == '__main__':
    unittest.main()
