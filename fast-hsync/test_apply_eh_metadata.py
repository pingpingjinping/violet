import sqlite3
import unittest
from apply_eh_metadata import run, pipe_value, load_candidates
from tempfile import TemporaryDirectory
from pathlib import Path
import json


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(":memory:")
        self.db.executescript("""
            CREATE TABLE HitomiColumnModel(
                Id INTEGER PRIMARY KEY,EHash TEXT,Files INTEGER,ExistOnHitomi INTEGER,
                Language TEXT,Artists TEXT,"Groups" TEXT,Tags TEXT,Series TEXT,Characters TEXT);
            CREATE VIRTUAL TABLE FtsTags USING fts5(Tags,Artists,Groups_,Series,Characters);
            INSERT INTO HitomiColumnModel VALUES
                (1,'abcdef0123',20,0,'korean','|N/A|',NULL,'|expunged|',NULL,NULL),
                (2,'abcdef0123',20,0,'korean',NULL,'|keep|',NULL,NULL,NULL),
                (3,'abcdef0123',20,0,'korean','|keep|',NULL,NULL,NULL,NULL),
                (4,'abcdef0123',20,1,'korean',NULL,NULL,NULL,NULL,NULL);
        """)
        self.candidates = [
            (1, 'abcdef0123', 20, '|a name|', '|g name|'),
            (2, 'abcdef0123', 20, '|a|', None),
            (3, 'abcdef0123', 20, '|different|', '|g|'),
            (4, 'abcdef0123', 20, '|a|', None),
        ]

    def tearDown(self):
        self.db.close()

    def test_dry_run_and_apply(self):
        stats = run(self.db, self.candidates)
        self.assertEqual(stats['eligible'], 2)
        self.assertEqual(self.db.execute('SELECT Artists FROM HitomiColumnModel WHERE Id=1').fetchone()[0], '|N/A|')
        self.assertEqual(run(self.db, self.candidates, True), stats)
        self.assertEqual(stats['artists'], 2)
        self.assertEqual(stats['groups'], 1)
        self.assertEqual(stats['existing_conflict'], 1)
        self.assertEqual(stats['identity_changed'], 1)
        self.assertEqual(self.db.execute('SELECT Artists, Groups_ FROM FtsTags').fetchall(), [('a_name', 'g_name')])
        self.assertEqual(self.db.execute('SELECT "Groups" FROM HitomiColumnModel WHERE Id=2').fetchone()[0], '|keep|')
        self.assertEqual(run(self.db, self.candidates, True)['eligible'], 0)

    def test_rollback(self):
        self.db.execute('CREATE TRIGGER fail BEFORE UPDATE ON HitomiColumnModel WHEN NEW.Id=2 BEGIN SELECT RAISE(ABORT,"test"); END')
        with self.assertRaises(sqlite3.Error):
            run(self.db, self.candidates, True)
        self.assertEqual(self.db.execute('SELECT Artists FROM HitomiColumnModel WHERE Id=1').fetchone()[0], '|N/A|')
        self.assertEqual(self.db.execute('SELECT COUNT(*) FROM FtsTags').fetchone()[0], 0)

    def test_invalid_tags(self):
        for value in (['bad|tag'], ['N/A'], [''], 'text'):
            with self.assertRaises(ValueError):
                pipe_value(value)

    def test_load(self):
        with TemporaryDirectory() as folder:
            path = Path(folder) / 'audit.jsonl'
            row = dict(id=1, token='abcdef0123', pages=20, status='found', artists=['a'], groups=[])
            path.write_text(json.dumps(row)+'\n'+json.dumps(dict(id=2,status='language_unverified'))+'\n')
            self.assertEqual(load_candidates(path), [(1,'abcdef0123',20,'|a|',None)])


if __name__ == '__main__':
    unittest.main()
