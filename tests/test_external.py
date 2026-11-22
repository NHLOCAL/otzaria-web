import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import zstandard

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from sync_external import ARCHIVE_NAME, DATABASE_NAME, archive_identity, export_database, run, selected_release, validate_snapshot


def sample_database(path):
    with sqlite3.connect(path) as connection:
        connection.executescript('''
          CREATE TABLE db_meta(key TEXT,value TEXT);
          INSERT INTO db_meta VALUES('version','10');
          CREATE TABLE otzar_hahochma(book_id INTEGER,title TEXT,authors TEXT,volume TEXT,from_year TEXT,to_year TEXT,places TEXT,subjects TEXT,pages INTEGER,extra TEXT);
          CREATE TABLE hebrew_books(id_book INTEGER,title TEXT,author TEXT,printing_place TEXT,printing_year TEXT,pub_date INTEGER,pages INTEGER,tags TEXT);
          CREATE TABLE otzaria_hebrew_books(hb_id INTEGER,otzaria_id INTEGER,otzaria_title TEXT,is_best INTEGER,confidence TEXT);
          INSERT INTO otzar_hahochma VALUES(1,'ספר ראשון','["מחבר א"]','א','תשפא','תשפב','ירושלים',NULL,123,'source value');
          INSERT INTO otzar_hahochma VALUES(201,'ספר שני','מחבר ב',NULL,NULL,NULL,NULL,NULL,NULL,NULL);
          INSERT INTO hebrew_books VALUES(2,'בראשית','מחבר ג','וילנא','תרפו',1926,55,'["תנך"]');
          INSERT INTO otzaria_hebrew_books VALUES(2,1,'בראשית',1,'certain');
          INSERT INTO otzaria_hebrew_books VALUES(2,999999,'unavailable core id',0,'likely');
        ''')


class ExternalImportTests(unittest.TestCase):
    def source(self):
        return {'id': 'otzaria-external-catalog', 'repository': 'Otzaria/otzar-HB_catalog', 'archiveSha256': 'a' * 64, 'release': 'db-v10'}

    def release(self, digest='a' * 64, size=123):
        return {'tag_name': 'db-v10', 'published_at': '2026-11-01T21:54:06Z', 'assets': [{'name': ARCHIVE_NAME, 'size': size, 'digest': 'sha256:' + digest, 'browser_download_url': 'https://github.com/Otzaria/otzar-HB_catalog/releases/download/db-v10/' + ARCHIVE_NAME}]}

    def test_native_latest_selection_prefers_compressed_and_allows_plain_fallback(self):
        release = self.release()
        plain = {**release['assets'][0], 'name': DATABASE_NAME}
        release['assets'].insert(0, plain)
        _, asset = selected_release(lambda _: release)
        self.assertEqual(asset['name'], ARCHIVE_NAME)
        release['assets'].pop()
        _, asset = selected_release(lambda _: release)
        self.assertEqual(asset['name'], DATABASE_NAME)
        release['prerelease'] = True
        with self.assertRaisesRegex(ValueError, 'stable'):
            selected_release(lambda _: release)

    def test_archive_requires_authenticated_hash_and_official_source(self):
        release = self.release()
        asset = release['assets'][0]
        self.assertEqual(archive_identity(release, asset)['sha256'], 'a' * 64)
        for altered in [{**asset, 'digest': None}, {**asset, 'browser_download_url': 'https://example.org/catalog.zst'}, {**asset, 'size': 0}]:
            with self.subTest(asset=altered), self.assertRaises(ValueError):
                archive_identity(release, altered)

    def test_all_metadata_and_orphan_mappings_survive_with_stable_native_id_pages(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'catalog.db'
            sample_database(database)
            catalog = export_database(database, root, self.source(), 10)
            validate_snapshot(root)
            self.assertEqual(catalog['counts'], {'records': 3, 'otzar': 2, 'hebrewbooks': 1, 'mappings': 2})
            self.assertEqual([page['page'] for page in catalog['providers'][0]['pages']], [1, 2])
            first = json.loads((root / catalog['providers'][0]['pages'][0]['file']).read_text())['records'][0]
            self.assertEqual(first['id'], 'external-otzar-1')
            self.assertEqual(first['url'], 'https://tablet.otzar.org/book/book.php?book=1')
            self.assertEqual(first['authors'], ['מחבר א'])
            self.assertEqual(first['metadata']['extra'], 'source value')
            mappings = catalog['mappings']
            self.assertFalse(mappings[0]['present'])
            self.assertEqual(mappings[0]['pages'], [])
            mapped = json.loads((root / mappings[1]['pages'][0]['file']).read_text())['records']
            self.assertEqual([item['otzariaId'] for item in mapped], [1, 999999])
            self.assertEqual(mapped[0]['metadata']['confidence'], 'certain')
            old_page = catalog['providers'][0]['pages'][1]['file']
            with sqlite3.connect(database) as connection:
                connection.execute('DELETE FROM otzar_hahochma WHERE book_id=1')
            after = export_database(database, root, self.source(), 10)
            self.assertEqual(after['providers'][0]['pages'][0]['file'], old_page)

    def test_snapshot_detects_partial_or_corrupt_page_and_database(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            sample_database(root / 'catalog.db')
            catalog = export_database(root / 'catalog.db', root, self.source(), 10)
            page = root / catalog['providers'][0]['pages'][0]['file']
            original = page.read_bytes()
            page.write_bytes(b'{}')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                validate_snapshot(root)
            page.write_bytes(original)
            with (root / 'catalog.db').open('ab') as database:
                database.write(b'changed')
            with self.assertRaisesRegex(ValueError, 'checksum'):
                validate_snapshot(root)

    def test_duplicate_provider_ids_and_version_mismatch_fail_export(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            database = root / 'catalog.db'
            sample_database(database)
            with self.assertRaisesRegex(ValueError, 'version disagree'):
                export_database(database, root, self.source(), 11)
            with sqlite3.connect(database) as connection:
                connection.execute('INSERT INTO otzar_hahochma SELECT * FROM otzar_hahochma WHERE book_id=1')
            with self.assertRaisesRegex(ValueError, 'Duplicate'):
                export_database(database, root, self.source(), 10)

    def test_failed_new_release_preserves_previous_snapshot_and_check_does_not_download(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            output = root / '.cache/external'; output.mkdir(parents=True)
            previous = {'schemaVersion': 1, 'source': {'archiveSha256': 'old'}, 'marker': 'previous complete publication'}
            (output / 'catalog.json').write_text(json.dumps(previous))
            payload = zstandard.ZstdCompressor().compress(b'not sqlite')
            archive = root / 'broken.zst'; archive.write_bytes(payload)
            release = self.release(hashlib.sha256(payload).hexdigest(), len(payload))
            def download(asset, identity, destination):
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(archive, destination)
            args = argparse.Namespace(root=str(root), check=False, offline=False)
            with patch('sync_external.selected_release', return_value=(release, release['assets'][0])), patch('sync_external.release_version', return_value=10), patch('sync_external.download_part', side_effect=download):
                with self.assertRaisesRegex(ValueError, 'SQLite'):
                    run(args)
            self.assertEqual(json.loads((output / 'catalog.json').read_text()), previous)
            self.assertEqual(list(output.parent.glob('external.next-*')), [])
            args.check = True
            with patch('sync_external.selected_release', return_value=(release, release['assets'][0])), patch('sync_external.download_part') as download:
                self.assertTrue(run(args)['changed'])
                download.assert_not_called()

    def test_scheduled_preflight_imports_without_optional_site_packages(self):
        scripts = str(Path(__file__).resolve().parents[1] / 'scripts')
        result = subprocess.run([sys.executable, '-B', '-S', '-c', 'import sys;sys.path.insert(0,' + repr(scripts) + ');import check_published'], capture_output=True, text=True)
        self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
