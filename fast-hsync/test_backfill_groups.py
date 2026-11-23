import importlib.util
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    'backfill_groups', Path(__file__).with_name('backfill_groups.py')
)
# Existing tests run from fast-hsync working directory, so imports resolve.
backfill = importlib.util.module_from_spec(spec)
spec.loader.exec_module(backfill)


def fixture_db(path):
    db = sqlite3.connect(str(path))
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
            (3269198,'existing', '|artist|', NULL,
             '|glasses|', '', '', 'korean', 1),
            (3312755,'other', '|N/A|', '',
             '|test|', '', '', 'korean', 1),
            (9999999,'already has a group', '|artist|', '|existing group|',
             '|tag|', '', '', 'korean', 1);
        INSERT INTO FtsTags(rowid, Tags, Artists, Groups_, Series, Characters)
        VALUES (3269198, 'glasses', 'artist', '', '', ''),
               (3312755, 'test', 'N/A', '', '', ''),
               (9999999, 'tag', 'artist', 'existing_group', '', '');
    """)
    return db


class GroupBackfillTests(unittest.TestCase):
    def test_candidates_only_missing_groups(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = fixture_db(Path(tmp) / 'db.sqlite')
            self.assertEqual([r[0] for r in backfill.candidates(db, None, 20)],
                             [3269198, 3312755])
            self.assertEqual(backfill.candidates(db, [9999999], 10), [])
            db.close()

    def test_missing_artists_only_selection_and_write_time_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = fixture_db(Path(tmp) / 'db.sqlite')
            # Only 3312755 is missing both Artists and Groups.
            self.assertEqual([r[0] for r in backfill.candidates(
                db, None, 20, hitomi_only=True, missing_artists_only=True)],
                [3312755])
            # A stale row must not be updated if Artists were filled meanwhile.
            row = backfill.candidates(
                db, [3312755], 1, True, True)[0]
            db.execute("UPDATE HitomiColumnModel SET Artists='|found|' WHERE Id=3312755")
            db.commit()
            self.assertFalse(backfill.apply_group(
                db, row, {'groups': '|wrong|'},
                hitomi_only=True, missing_artists_only=True))
            self.assertEqual(db.execute(
                'SELECT Artists, "Groups" FROM HitomiColumnModel WHERE Id=3312755'
            ).fetchone(), ('|found|', ''))
            # Existing Artists must never get overwritten, even when manually asked.
            self.assertFalse(backfill.apply_group(
                db, (3269198, None), {'groups': '|wrong|'},
                hitomi_only=True, missing_artists_only=True))
            db.close()

    def test_group_resolution_and_skip_empty_or_mismatch(self):
        row = (3269198, None)
        with patch.object(backfill, 'fetch_gallery', return_value={
            'status': 'ok', 'groups': [
                'himegoto jukujo', 'kemusi no bansan kai', 'sound sticker'
            ]}):
            result = backfill.resolve_group(row)
        self.assertEqual(result['status'], 'found')
        self.assertEqual(
            result['groups'],
            '|himegoto jukujo|kemusi no bansan kai|sound sticker|')
        with patch.object(backfill, 'fetch_gallery',
                          return_value={'status': 'ok', 'groups': []}):
            self.assertEqual(backfill.resolve_group(row)['status'], 'no_groups')
        with patch.object(backfill, 'fetch_gallery',
                          return_value={'status': 'id_mismatch'}):
            self.assertEqual(backfill.resolve_group(row)['status'], 'id_mismatch')

    def test_update_only_missing_groups_and_fts(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = fixture_db(Path(tmp) / 'db.sqlite')
            row = backfill.candidates(db, [3269198], 1)[0]
            self.assertTrue(backfill.apply_group(
                db, row, {'groups': '|orangemaru|'}))
            self.assertEqual(
                db.execute('SELECT Title, Artists, "Groups" FROM HitomiColumnModel '
                           'WHERE Id = 3269198').fetchone(),
                ('existing', '|artist|', '|orangemaru|'))
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM FtsTags "
                           "WHERE Groups_ MATCH 'orangemaru'").fetchone()[0], 1)
            self.assertEqual(
                db.execute("SELECT COUNT(*) FROM FtsTags "
                           "WHERE Tags MATCH 'glasses'").fetchone()[0], 1)
            self.assertFalse(backfill.apply_group(
                db, row, {'groups': '|overwritten|'}))
            self.assertEqual(
                db.execute('SELECT "Groups" FROM HitomiColumnModel '
                           'WHERE Id = 3269198').fetchone()[0], '|orangemaru|')
            db.close()

    def test_hitomi_only_limits_candidates_and_write_guard(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = fixture_db(Path(tmp) / 'db.sqlite')
            db.execute("""INSERT INTO HitomiColumnModel
                VALUES (8888888, 'exh-only', '|N/A|', NULL,
                        '|tag|', '', '', 'korean', 0)""")
            db.commit()
            self.assertEqual(
                [r[0] for r in backfill.candidates(db, None, 20)],
                [3269198, 3312755, 8888888])
            self.assertEqual(
                [r[0] for r in backfill.candidates(db, None, 20, True)],
                [3269198, 3312755])
            # Even an old, previously read row cannot update an EH-only record.
            self.assertFalse(backfill.apply_group(
                db, (8888888, None), {'groups': '|mistaken|'},
                hitomi_only=True))
            self.assertIsNone(db.execute(
                'SELECT "Groups" FROM HitomiColumnModel WHERE Id=8888888'
            ).fetchone()[0])
            # A record becoming ineligible between read and write is rejected.
            row = backfill.candidates(db, [3269198], 1, True)[0]
            db.execute('UPDATE HitomiColumnModel SET ExistOnHitomi=0 WHERE Id=3269198')
            db.commit()
            self.assertFalse(backfill.apply_group(
                db, row, {'groups': '|mistaken|'}, hitomi_only=True))
            db.close()

    def test_group_is_not_inferred_from_artist(self):
        with tempfile.TemporaryDirectory() as tmp:
            db = fixture_db(Path(tmp) / 'db.sqlite')
            row = backfill.candidates(db, [3312755], 1)[0]
            self.assertTrue(backfill.apply_group(
                db, row, {'groups': '|kabuto 3-gou|'}))
            self.assertEqual(
                db.execute('SELECT Artists, "Groups" FROM HitomiColumnModel '
                           'WHERE Id=3312755').fetchone(),
                ('|N/A|', '|kabuto 3-gou|'))
            db.close()


if __name__ == '__main__':
    unittest.main()
