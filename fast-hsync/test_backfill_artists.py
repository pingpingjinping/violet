import importlib.util
import json
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'backfill_artists', Path(__file__).with_name('backfill_artists.py')
)
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)


class ArtistBackfillTests(unittest.TestCase):
    def test_parse_gallery_js_and_clean_values(self):
        raw = 'var galleryinfo = ' + json.dumps({
            'id': 2614220,
            'artists': [{'artist': 'takizawa taki'}, {'artist': 'takizawa taki'}],
            'groups': [{'group': 'shiroi tentoumushi'}],
        }) + ';'
        info = backfill.parse_gallery_js(raw)
        self.assertEqual(backfill.clean_values(info['artists'], 'artist'), ['takizawa taki'])
        self.assertEqual(backfill.clean_values(info['groups'], 'group'), ['shiroi tentoumushi'])

    def test_fallback_only_if_group_matches(self):
        row = (2250876, '|N/A|', '|shiroi tentoumushi|')

        def fake_fetch(gallery_id):
            if gallery_id == 2250876:
                return {'status': 'http_404'}
            return {'status': 'ok', 'artists': ['takizawa taki'], 'groups': ['shiroi tentoumushi']}

        with patch.object(backfill, 'fetch_gallery', side_effect=fake_fetch):
            good = backfill.resolve_artist(row, {2250876: 2614220})
            self.assertEqual(good['artists'], '|takizawa taki|')
            self.assertEqual(good['source_id'], 2614220)
            bad = backfill.resolve_artist((2250876, '|N/A|', '|unrelated|'), {2250876: 2614220})
            self.assertEqual(bad['status'], 'fallback_group_mismatch')

    def test_database_update_preserves_fields_and_updates_fts(self):
        with tempfile.TemporaryDirectory() as temp:
            db = sqlite3.connect(str(Path(temp) / 'test.db'))
            db.executescript("""
                CREATE TABLE HitomiColumnModel (
                    Id INTEGER PRIMARY KEY, Title TEXT, Artists TEXT, "Groups" TEXT,
                    Tags TEXT, Series TEXT, Characters TEXT, Language TEXT,
                    ExistOnHitomi INTEGER
                );
                CREATE VIRTUAL TABLE FtsTags USING fts5(
                    Tags, Artists, Groups_, Series, Characters,
                    tokenize="unicode61 tokenchars ':_'"
                );
                INSERT INTO HitomiColumnModel VALUES
                    (2614220, 'test title', '|N/A|', '|shiroi tentoumushi|',
                     '|foo|', '', '', 'korean', 1);
                INSERT INTO FtsTags(rowid, Tags, Artists, Groups_, Series, Characters)
                    VALUES (2614220, 'foo', 'N/A', 'shiroi_tentoumushi', '', '');
            """)
            row = backfill.candidates(db, [2614220], 20)[0]
            self.assertTrue(backfill.update_one(db, row, {'artists': '|takizawa taki|'}, True))
            self.assertEqual(
                db.execute("SELECT Artists, Title FROM HitomiColumnModel").fetchone(),
                ('|takizawa taki|', 'test title'),
            )
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM FtsTags WHERE Artists MATCH 'takizawa_taki'").fetchone()[0],
                1,
            )
            # Compare-and-set prevents overwriting the now non-missing artist.
            self.assertFalse(backfill.update_one(db, row, {'artists': '|wrong|'}, True))
            db.close()

    def test_resume_skips_completed_records(self):
        with tempfile.TemporaryDirectory() as temp:
            report = Path(temp) / 'report.jsonl'
            report.write_text(
                '{"id":2250876,"mode":"apply","status":"http_404"}\n'
                '{"id":2614220,"mode":"apply","status":"applied"}\n'
                '{"id":2614221,"mode":"apply","status":"network_error"}\n',
                encoding='utf-8',
            )
            self.assertEqual(backfill.read_resume_ids(report, 'apply'), {2250876, 2614220})
            self.assertEqual(backfill.read_resume_ids(report, 'dry-run'), set())


if __name__ == '__main__':
    unittest.main()
