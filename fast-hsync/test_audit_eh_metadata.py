import unittest
from audit_eh_metadata import inspect, resume_ids
from pathlib import Path
from tempfile import TemporaryDirectory
import json

class TestAudit(unittest.TestCase):
    def setUp(self):
        self.row = (123, "abcdef0123", 20, "|N/A|", None)
        self.item = {"gid": 123, "token": "abcdef0123", "filecount": "20",
                     "tags": ["language:korean", "artist:example", "group:example group"]}

    def test_found(self):
        result = inspect(self.row, self.item)
        self.assertEqual(result["status"], "found")
        self.assertEqual(result["artists"], ["example"])
        self.assertEqual(result["groups"], ["example group"])

    def test_preserve_group(self):
        result = inspect((*self.row[:4], "|existing|"), self.item)
        self.assertEqual(result["groups"], [])

    def test_mismatch(self):
        self.assertEqual(inspect(self.row, dict(self.item, token="different"))["status"], "token_mismatch")
        self.assertEqual(inspect(self.row, dict(self.item, filecount="21"))["status"], "page_count_diff")
        self.assertEqual(inspect(self.row, dict(self.item, tags=["artist:example"]))["status"], "language_unverified")

    def test_empty_or_error(self):
        self.assertEqual(inspect(self.row, dict(self.item, tags=["language:korean"]))["status"], "no_metadata")
        self.assertEqual(inspect(self.row, {"error": "not found"})["status"], "unavailable")
        with self.assertRaises(ValueError):
            inspect(self.row, dict(self.item, tags=None))

    def test_resume(self):
        with TemporaryDirectory() as folder:
            p = Path(folder) / "report.jsonl"
            p.write_text(json.dumps(inspect(self.row, self.item)) + "\n{", encoding="utf-8")
            self.assertEqual(resume_ids(p), {self.row[:3]})

if __name__ == "__main__":
    unittest.main()
