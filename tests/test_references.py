"""Native external-reference rules and metadata-only snapshot enrichment."""
import hashlib
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from sync_references import enrich_references, native_otzar_references


class ReferenceTests(unittest.TestCase):
    def test_released_catalog_without_otzar_mapping_has_no_inferred_references(self):
        connection = sqlite3.connect(':memory:')
        connection.row_factory = sqlite3.Row
        connection.executescript('''
          CREATE TABLE otzar_hahochma(book_id INTEGER,title TEXT,volume TEXT);
          INSERT INTO otzar_hahochma VALUES(10,'Matching title',NULL);
          CREATE TABLE otzaria_hebrew_books(hb_id INTEGER,otzaria_id INTEGER);
          INSERT INTO otzaria_hebrew_books VALUES(10,7);
        ''')
        self.assertEqual(native_otzar_references(connection, {7}), ({}, False))
        connection.close()

    def test_otzar_mapping_uses_native_rank_and_twenty_item_limit(self):
        connection = sqlite3.connect(':memory:')
        connection.row_factory = sqlite3.Row
        connection.executescript('''
          CREATE TABLE otzar_hahochma(book_id INTEGER,title TEXT,volume TEXT);
          CREATE TABLE otzaria_otzar_hahochma(otzaria_id INTEGER,oh_id INTEGER,is_best INTEGER,confidence TEXT);
        ''')
        for identifier in range(1, 26):
            connection.execute('INSERT INTO otzar_hahochma VALUES(?,?,?)', (identifier, 'Book ' + str(identifier), ' כרך ב ' if identifier == 25 else None))
            confidence = 'certain' if identifier <= 8 else 'likely' if identifier <= 20 else 'other'
            connection.execute('INSERT INTO otzaria_otzar_hahochma VALUES(7,?,?,?)', (identifier, int(identifier == 25), confidence))
        connection.execute("INSERT INTO otzaria_otzar_hahochma VALUES(999,1,1,'certain')")
        references, available = native_otzar_references(connection, {7})
        self.assertTrue(available)
        self.assertEqual(set(references), {7})
        self.assertEqual([item['id'] for item in references[7]], [25, *range(1, 20)])
        self.assertEqual(references[7][0], {'provider': 'otzar', 'id': 25, 'title': 'Book 25', 'url': 'https://tablet.otzar.org/book/book.php?book=25', 'volume': 'כרך ב'})
        connection.close()

    def test_enrichment_is_atomic_metadata_only_and_check_does_not_write(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            library, external = root / 'library', root / 'external'
            (library / 'books').mkdir(parents=True)
            external.mkdir()
            original_text = 'טקסט מקור <b>מלא</b>\n'.encode()
            for identifier in ('b-7', 'b-7-v-9'):
                (library / 'books' / (identifier + '.txt')).write_bytes(original_text)
            original = {'schemaVersion': 1, 'exporterVersion': 4, 'books': [{'id': 'b-7', 'upstreamId': 7, 'contentSha256': hashlib.sha256(original_text).hexdigest()}, {'id': 'b-7-v-9', 'upstreamId': 7, 'editionOf': 'b-7', 'contentSha256': hashlib.sha256(original_text).hexdigest()}], 'scope': {'content': 'Source text.'}}
            catalog_path = library / 'catalog.json'
            catalog_path.write_text(json.dumps(original))
            connection = sqlite3.connect(external / 'catalog.db')
            connection.executescript('''
              CREATE TABLE otzar_hahochma(book_id INTEGER,title TEXT,volume TEXT);
              CREATE TABLE otzaria_otzar_hahochma(otzaria_id INTEGER,oh_id INTEGER,is_best INTEGER,confidence TEXT);
              INSERT INTO otzar_hahochma VALUES(10,'כותרת',NULL);
              INSERT INTO otzaria_otzar_hahochma VALUES(7,10,1,'certain');
            ''')
            connection.close()
            database = (external / 'catalog.db').read_bytes()
            (external / 'catalog.json').write_text(json.dumps({'schemaVersion': 1, 'database': {'file': 'catalog.db', 'bytes': len(database), 'sha256': hashlib.sha256(database).hexdigest()}, 'source': {'repository': 'Otzaria/otzar-HB_catalog', 'release': 'test-release', 'archiveSha256': 'a' * 64}}))
            before = catalog_path.read_bytes()
            file_times = {path: path.stat().st_mtime_ns for path in (library / 'books').iterdir()}
            self.assertTrue(enrich_references(library, external, check=True)['changed'])
            self.assertEqual(catalog_path.read_bytes(), before)
            result = enrich_references(library, external)
            self.assertEqual((result['mappedBaseBooks'], result['mappedPublishedBooks'], result['baseReferences'], result['publishedReferences']), (1, 2, 1, 2))
            updated = json.loads(catalog_path.read_text())
            self.assertEqual(updated['books'][0]['mappedOtzarReferences'], updated['books'][1]['mappedOtzarReferences'])
            self.assertFalse(enrich_references(library, external)['changed'])
            for path, modified in file_times.items():
                self.assertEqual(path.read_bytes(), original_text)
                self.assertEqual(path.stat().st_mtime_ns, modified)
            self.assertEqual([book['contentSha256'] for book in updated['books']], [book['contentSha256'] for book in original['books']])
            self.assertEqual(updated['exporterVersion'], 4)
            (external / 'catalog.db').write_bytes(b'corrupt')
            good_catalog = catalog_path.read_bytes()
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                enrich_references(library, external)
            self.assertEqual(catalog_path.read_bytes(), good_catalog)


if __name__ == '__main__':
    unittest.main()
