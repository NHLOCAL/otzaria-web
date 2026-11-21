import json
from pathlib import Path
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from prune_archive_cache import prune, retained_archives


class ArchiveCacheTests(unittest.TestCase):
    def test_current_database_and_older_current_pdf_win_over_recent_obsolete_archives(self):
        entries = [
            {'name': 'current-db', 'bytes': 6, 'mtime': 20},
            {'name': 'current-pdf', 'bytes': 2, 'mtime': 1},
            {'name': 'obsolete-db', 'bytes': 6, 'mtime': 30},
        ]
        self.assertEqual(retained_archives(entries, {'current-db', 'current-pdf'}, 8), {'current-db', 'current-pdf'})

    def test_budget_is_a_hard_bound_even_when_current_release_alone_is_larger(self):
        entries = [{'name': 'large-current', 'bytes': 11, 'mtime': 30}, {'name': 'small-current', 'bytes': 3, 'mtime': 20}, {'name': 'old', 'bytes': 7, 'mtime': 10}]
        kept = retained_archives(entries, {'large-current', 'small-current'}, 10)
        self.assertEqual(kept, {'small-current', 'old'})
        self.assertLessEqual(sum(item['bytes'] for item in entries if item['name'] in kept), 10)
        self.assertEqual(retained_archives(entries, set(), 0), set())

    def test_cleanup_only_removes_owned_compressed_cache_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / '.cache/upstream/archives'; cache.mkdir(parents=True)
            active_name = 'a' * 64 + '.part'; old_name = 'b' * 64 + '.part'
            (cache / active_name).write_bytes(b'1234'); (cache / old_name).write_bytes(b'5678')
            (cache / 'notes.txt').write_text('not owned')
            snapshot = root / '.cache/library/catalog.json'; snapshot.parent.mkdir(); snapshot.write_text('validated snapshot')
            (root / '.cache/upstream/active-database-archives.json').write_text(json.dumps({'files': [active_name]}))
            result = prune(root, 4)
            self.assertEqual(result['keptBytes'], 4)
            self.assertEqual(result['removedFiles'], 1)
            self.assertTrue((cache / active_name).exists()); self.assertFalse((cache / old_name).exists())
            self.assertEqual(snapshot.read_text(), 'validated snapshot')
            self.assertEqual((cache / 'notes.txt').read_text(), 'not owned')

    def test_invalid_receipt_does_not_delete_any_cache_files(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            cache = root / '.cache/upstream/archives'; cache.mkdir(parents=True)
            name = 'a' * 64 + '.part'; (cache / name).write_bytes(b'1234')
            (root / '.cache/upstream/active-database-archives.json').write_text(json.dumps({'files': ['../../outside']}))
            with self.assertRaises(ValueError):
                prune(root, 0)
            self.assertTrue((cache / name).exists())


if __name__ == '__main__':
    unittest.main()
