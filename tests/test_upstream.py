"""Integrity and official-reader compatibility checks for corpus ingestion."""
import hashlib
import base64
import importlib.util
import io
import json
from pathlib import Path
import sqlite3
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'scripts/sync_library.py'
spec = importlib.util.spec_from_file_location('sync_library', MODULE)
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)
media_spec = importlib.util.spec_from_file_location('media_assets', MODULE.with_name('media_assets.py'))
media = importlib.util.module_from_spec(media_spec)
media_spec.loader.exec_module(media)


class UpstreamTests(unittest.TestCase):
    def test_native_source_metadata_refresh_preserves_text_provenance_and_is_idempotent(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'books').mkdir()
            (root / 'lines').mkdir()
            (root / 'books/b-1.txt').write_text('תוכן מקורי\n', encoding='utf-8')
            (root / 'lines/b-1.json').write_text('[31]', encoding='utf-8')
            payloads = {str(file.relative_to(root)): file.read_bytes() for file in root.rglob('*') if file.is_file()}
            original = {
                'exporterVersion': sync.EXPORTER_VERSION,
                'generatedAt': '2026-11-19T23:21:11Z',
                'scope': {'content': 'Old scope', 'complete': True},
                'books': [
                    {'id': 'b-1', 'title': 'א', 'sourceKey': 'KSK', 'sourceName': 'כונס ספרים קטנים', 'sourceUrl': 'https://github.com/Otzaria/SeforimLibrary/releases/test', 'contentSha256': 'text-digest', 'file': 'books/b-1.txt', 'lineIdsSha256': 'line-digest'},
                    {'id': 'b-2', 'title': 'ב', 'sourceKey': 'National-LibraryToOtzaria', 'sourceName': 'הספרייה הלאומית', 'sourceUrl': 'https://github.com/Otzaria/SeforimLibrary/releases/test'},
                    {'id': 'b-3', 'title': 'ג', 'sourceKey': 'Sefaria', 'sourceName': 'ספריא', 'customMetadata': 'keep'},
                ],
            }
            (root / 'catalog.json').write_bytes(sync.json_bytes(original))
            catalog, corrections, changed = sync.refresh_metadata_labels(root)
            self.assertTrue(changed)
            self.assertEqual([row['bookId'] for row in corrections], ['b-1', 'b-2'])
            self.assertEqual(corrections[0]['old']['sourceName'], 'כונס ספרים קטנים')
            self.assertEqual(sync.source_label('KSK'), 'קובץ שיטות קמאי')
            self.assertEqual(sync.source_label('National-LibraryToOtzaria'), 'יד הרמב"ם')
            self.assertEqual(catalog['books'][0]['sourceHomepageUrl'], '')
            self.assertEqual(catalog['books'][1]['sourceHomepageUrl'], 'https://fjms.genizah.org/')
            self.assertEqual(catalog['books'][2], original['books'][2])
            for before, after in zip(original['books'], catalog['books']):
                for key, value in before.items():
                    if key != 'sourceName':
                        self.assertEqual(after[key], value)
            self.assertEqual(catalog['generatedAt'], original['generatedAt'])
            self.assertEqual(catalog['exporterVersion'], original['exporterVersion'])
            self.assertEqual(catalog['metadataRulesVersion'], sync.METADATA_RULES_VERSION)
            self.assertIn('downloaded by the native installer', catalog['scope']['content'])
            self.assertNotIn('optional external', catalog['scope']['content'])
            for name, content in payloads.items():
                self.assertEqual((root / name).read_bytes(), content)
            unchanged_bytes = (root / 'catalog.json').read_bytes()
            unchanged_mtime = (root / 'catalog.json').stat().st_mtime_ns
            self.assertEqual(sync.refresh_metadata_labels(root)[1:], ([], False))
            self.assertEqual((root / 'catalog.json').read_bytes(), unchanged_bytes)
            self.assertEqual((root / 'catalog.json').stat().st_mtime_ns, unchanged_mtime)

    def test_cached_sync_detects_and_refreshes_metadata_without_reimporting_database(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'config').mkdir()
            output = root / 'library'
            output.mkdir()
            config = {'repository': 'Otzaria/SeforimLibrary'}
            (root / 'config/sources.json').write_bytes(sync.json_bytes(config))
            original = {'schemaVersion': 1, 'exporterVersion': sync.EXPORTER_VERSION, 'profile': 'full', 'configSha256': hashlib.sha256(sync.json_bytes(config)).hexdigest(), 'sources': [{'manifestSha256': 'manifest'}], 'scope': {'content': 'Old scope'}, 'books': [{'id': 'b-1', 'title': 'א', 'sourceKey': 'KSK', 'sourceName': 'כונס ספרים קטנים'}]}
            (output / 'catalog.json').write_bytes(sync.json_bytes(original))
            state = {'manifestSha256': 'manifest', 'release': {'tag_name': 'release'}, 'stats': {'db_version': 39, 'books': 1}, 'libraryHead': 'commit', 'provenance': {'otzaria_target_commit': 'commit'}}
            args = SimpleNamespace(root=str(root), output=str(output), profile='full', offline=False, check=True)
            with patch.object(sync, 'release_state', return_value=state), patch.object(sync, 'validate_snapshot', return_value=original) as validate, patch.object(sync, 'database_file') as database, patch.object(sync, 'export_database') as export, patch.object(sync, 'write_active_archive_receipt'):
                self.assertTrue(sync.run(args)['changed'])
                self.assertEqual(sync.load_json(output / 'catalog.json'), original)
                validate.assert_not_called()
                args.check = False
                self.assertTrue(sync.run(args)['changed'])
                refreshed = sync.load_json(output / 'catalog.json')
                self.assertEqual(refreshed['books'][0]['sourceName'], 'קובץ שיטות קמאי')
                self.assertEqual(refreshed['metadataRulesVersion'], sync.METADATA_RULES_VERSION)
                self.assertFalse(sync.run(args)['changed'])
                database.assert_not_called()
                export.assert_not_called()

    def test_release_asset_selection_matches_application_schema_and_format_order(self):
        def assets(*names):
            return {name: {'name': name, 'browser_download_url': 'https://github.com/example/' + name} for name in names}
        selected = sync.select_database_asset(assets('seforim-schema8.db.zst', 'seforim-schema7.db.zst.manifest.json', 'seforim-schema6.db.zst'), 7)
        self.assertEqual((selected['schemaVersion'], selected['split']), (7, True))
        selected = sync.select_database_asset(assets('seforim-schema7.db.zst.manifest.json', 'seforim-schema7.db.zst'), 7)
        self.assertEqual((selected['schemaVersion'], selected['split']), (7, False))
        self.assertEqual(sync.select_database_asset(assets('seforim-schema6.db.zst', 'seforim.db.zst'), 7)['schemaVersion'], 6)
        self.assertEqual(sync.select_database_asset(assets('seforim.db.zst'), 7)['schemaVersion'], 5)
        with self.assertRaisesRegex(ValueError, 'No database asset readable'):
            sync.select_database_asset(assets('seforim-schema8.db.zst'), 7)

    def test_embedded_raster_media_is_deduplicated_without_changing_source_keys(self):
        png = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==')
        source = 'data:image/png;base64,' + base64.b64encode(png).decode()
        with tempfile.TemporaryDirectory() as directory:
            collector = media.MediaCollector(Path(directory) / 'media')
            parser = media.ImageParser(collector, 'b-1')
            parser.feed('<img src="' + source + '"><img src="' + source + ' "><img src=""><img alt="missing">')
            parser.close()
            result = collector.finish()
            self.assertEqual(result['counts']['files'], 1)
            self.assertEqual(result['counts']['uniqueSources'], 2)
            self.assertEqual(result['counts']['embeddedInstances'], 2)
            self.assertEqual(result['counts']['missingUpstream'], 2)
            image = collector.sources[hashlib.sha256(source.encode()).hexdigest()]
            self.assertEqual((image['width'], image['height']), (1, 1))
            self.assertEqual((Path(directory) / image['file']).read_bytes(), png)

    def test_active_or_unknown_image_sources_cannot_become_public_assets(self):
        with tempfile.TemporaryDirectory() as directory:
            collector = media.MediaCollector(Path(directory) / 'media')
            for source in ('javascript:alert(1)', 'data:image/svg+xml;base64,' + base64.b64encode(b'<svg onload="alert(1)"/>').decode(), 'https://unknown.example/image.png'):
                with self.subTest(source=source), self.assertRaisesRegex(ValueError, 'Unsupported canonical image source'):
                    collector.add('b-1', {'src': source})
            with self.assertRaisesRegex(ValueError, 'passive raster MIME'):
                collector.add('b-1', {'src': 'data:image/png;base64,' + base64.b64encode(b'<script>alert(1)</script>').decode()})

    def test_media_parser_uses_browser_attribute_decoding_and_first_attribute(self):
        with tempfile.TemporaryDirectory() as directory:
            collector = media.MediaCollector(Path(directory) / 'media')
            with patch.object(collector, 'add') as add:
                parser = media.ImageParser(collector, 'b-1')
                parser.feed('<img src="a&amp;b" src="second"/>')
                parser.close()
                add.assert_called_once_with('b-1', {'src': 'a&b'})

    def test_new_visual_markup_requires_an_adapter_instead_of_disappearing(self):
        with tempfile.TemporaryDirectory() as directory:
            collector = media.MediaCollector(Path(directory) / 'media')
            for tag in ('svg', 'math'):
                with self.subTest(tag=tag), self.assertRaisesRegex(ValueError, 'add a safe renderer'):
                    parser = media.ImageParser(collector, 'b-1')
                    parser.feed('<' + tag + '><text>source content</text></' + tag + '>')

    def test_rejects_paths_that_escape_snapshot(self):
        with tempfile.TemporaryDirectory() as directory:
            for path in ('../secret', '/absolute', 'book/../../secret', 'book\\secret', 'book/./secret', '\0file'):
                with self.subTest(path=path), self.assertRaises(ValueError):
                    sync.safe_path(directory, path)
            self.assertEqual(sync.safe_path(directory, 'books/b-1.txt'), Path(directory) / 'books/b-1.txt')

    def test_multipart_stream_preserves_every_byte_across_boundaries(self):
        with tempfile.TemporaryDirectory() as directory:
            paths = [Path(directory) / str(i) for i in range(3)]
            payloads = [b'ab', b'', b'cdefgh']
            for path, data in zip(paths, payloads):
                path.write_bytes(data)
            with io.BufferedReader(sync.ConcatenatedParts(paths), buffer_size=3) as reader:
                self.assertEqual(reader.read(4), b'abcd')
                self.assertEqual(reader.read(), b'efgh')

    def test_corrupt_download_never_becomes_cache_entry(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / 'archive.part'
            part = {'name': 'test.part', 'size': 3, 'sha256': hashlib.sha256(b'yes').hexdigest()}
            with patch('urllib.request.urlopen', return_value=io.BytesIO(b'bad')):
                with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                    sync.download_part({'browser_download_url': 'https://github.com/example'}, part, destination)
            self.assertFalse(destination.exists())
            self.assertEqual(list(Path(directory).iterdir()), [])

    def test_version_reader_distinguishes_absent_and_null_rows(self):
        # The official app preserves headings, leaves absent version rows empty,
        # and uses base text only for an existing NULL version row.
        connection = sqlite3.connect(':memory:')
        connection.row_factory = sqlite3.Row
        connection.executescript('''
          CREATE TABLE line(id INTEGER,bookId INTEGER,lineIndex INTEGER,heRef TEXT);
          CREATE TABLE line_content(id INTEGER,content TEXT);
          CREATE TABLE version_line(lineId INTEGER,versionId INTEGER,content TEXT);
          INSERT INTO line VALUES(1,7,0,NULL),(2,7,1,'1:1'),(3,7,2,'1:2'),(4,7,3,'1:3');
          INSERT INTO line_content VALUES(1,'<h1>Test</h1>'),(2,'must not leak'),(3,'shared'),(4,'base');
          INSERT INTO version_line VALUES(3,9,NULL),(4,9,'alternate');
        ''')
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / 'books').mkdir()
            record = sync.export_edition(connection, lambda value: value or '', {'id': 7, 'title': 'Test'}, {'id': 9, 'versionTitle': 'Other', 'heVersionTitle': '', 'license': 'Public Domain'}, stage, {'id': 'b-7', 'license': {'name': 'Original'}}, '2026-01-01T00:00:00Z', {})
            self.assertEqual((stage / record['file']).read_text(), '<h1>Test</h1>\n\nshared\nalternate\n')
            self.assertEqual(record['editionOf'], 'b-7')
            self.assertEqual(record['id'], 'b-7-v-9')
        connection.close()

    def test_legacy_version_reader_does_not_apply_newer_null_fallback(self):
        connection = sqlite3.connect(':memory:')
        connection.row_factory = sqlite3.Row
        connection.executescript('''
          CREATE TABLE line(id INTEGER,bookId INTEGER,lineIndex INTEGER,heRef TEXT,content TEXT);
          CREATE TABLE version_line(lineId INTEGER,versionId INTEGER,content TEXT);
          INSERT INTO line VALUES(1,7,0,NULL,'<h1>Test</h1>'),(2,7,1,'1:1','base absent'),(3,7,2,'1:2','base null'),(4,7,3,'1:3','base');
          INSERT INTO version_line VALUES(3,9,NULL),(4,9,'alternate');
        ''')
        with tempfile.TemporaryDirectory() as directory:
            stage = Path(directory)
            (stage / 'books').mkdir()
            record = sync.export_edition(connection, lambda value: value or '', {'id': 7, 'title': 'Test'}, {'id': 9, 'versionTitle': 'Other', 'heVersionTitle': '', 'license': 'Public Domain'}, stage, {'id': 'b-7', 'license': {'name': 'Original'}}, '2026-01-01T00:00:00Z', {}, split_content=False)
            self.assertEqual((stage / record['file']).read_text(), '<h1>Test</h1>\n\n\nalternate\n')
        connection.close()

    def test_older_schemas_preserve_inline_notes_without_schema_seven_tables(self):
        for schema in (5, 6):
            with self.subTest(schema=schema), tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                database = root / 'source.db'
                connection = sqlite3.connect(database)
                connection.executescript('''
                  CREATE TABLE schema_meta(key TEXT,value TEXT);
                  CREATE TABLE book(id INTEGER,title TEXT,categoryId INTEGER,sourceId INTEGER,totalLines INTEGER,heShortDesc TEXT,heDesc TEXT,contentHash TEXT);
                  CREATE TABLE category(id INTEGER,title TEXT,parentId INTEGER);
                  CREATE TABLE source(id INTEGER,name TEXT);
                  INSERT INTO book VALUES(1,'בדיקה',1,1,1,'','','abc');
                  INSERT INTO category VALUES(1,'ספרים',NULL);
                  INSERT INTO source VALUES(1,'Sefaria');
                ''')
                connection.executemany('INSERT INTO schema_meta VALUES(?,?)', [('db_schema_version', str(schema)), ('db_version', '1')])
                payload = 'טקסט <small>הערה מתוך המקור</small>'
                if schema == 5:
                    connection.execute('CREATE TABLE line(id INTEGER,bookId INTEGER,lineIndex INTEGER,heRef TEXT,content TEXT)')
                    connection.execute('INSERT INTO line VALUES(1,1,0,\'1:1\',?)', (payload,))
                else:
                    connection.execute('CREATE TABLE line(id INTEGER,bookId INTEGER,lineIndex INTEGER,heRef TEXT)')
                    connection.execute('CREATE TABLE line_content(id INTEGER,content TEXT)')
                    connection.execute('INSERT INTO line VALUES(1,1,0,\'1:1\')')
                    connection.execute('INSERT INTO line_content VALUES(1,?)', (payload,))
                connection.commit(); connection.close()
                stage = root / 'export'
                state = {'archiveSelection': {'schemaVersion': schema}, 'release': {'tag_name': 'test', 'html_url': 'https://github.com/Otzaria/SeforimLibrary/releases/test', 'published_at': '2026-01-01T00:00:00Z', 'target_commitish': 'a' * 40}, 'checkedAt': '2026-01-01T00:00:00Z', 'manifest': {'sha256': 'b' * 64}, 'manifestSha256': 'c' * 64, 'provenance': {}, 'stats': {'books': 1, 'lines': 1, 'links': 0}}
                with patch.dict(sys.modules, {'media_assets': media}):
                    catalog = sync.export_database(database, stage, {'databaseSchemaVersion': 7, 'repository': 'Otzaria/SeforimLibrary', 'attribution': 'מקור רשמי'}, 'full', state)
                self.assertEqual(catalog['sources'][0]['databaseSchemaVersion'], schema)
                self.assertEqual(catalog['counts']['baseBooks'], 1)
                self.assertEqual((stage / 'books/b-1.txt').read_text(), payload + '\n')
                self.assertEqual(sync.validate_snapshot(stage)['scope']['complete'], True)

    def test_dictionary_decoder_keeps_plain_text_and_decodes_zstd(self):
        import zstandard
        connection = sqlite3.connect(':memory:')
        connection.row_factory = sqlite3.Row
        connection.execute('CREATE TABLE zstd_dict(id INTEGER,dict BLOB)')
        decode = sync.decoder(connection)
        payload = 'בראשית ברא'.encode()
        compressed = zstandard.ZstdCompressor(write_content_size=True).compress(payload)
        self.assertEqual(decode(compressed), payload.decode())
        self.assertEqual(decode('plain'), 'plain')
        self.assertEqual(decode(None), '')
        with self.assertRaises(Exception):
            decode(b'not a zstd frame')
        connection.close()

    def test_category_cycles_fail_instead_of_looping(self):
        categories = {1: {'title': 'א', 'parentId': 2}, 2: {'title': 'ב', 'parentId': 1}}
        with self.assertRaisesRegex(ValueError, 'hierarchy'):
            sync.category_path(categories, 1)

    def test_snapshot_corruption_is_detected(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'books').mkdir()
            (root / 'books/b-1.txt').write_text('altered')
            (root / 'catalog.json').write_text(json.dumps({'schemaVersion': 1, 'books': [{'id': 'b-1', 'file': 'books/b-1.txt', 'contentSha256': hashlib.sha256(b'original').hexdigest()}]}))
            with self.assertRaisesRegex(ValueError, 'checksum mismatch'):
                sync.validate_snapshot(root)

    def test_failed_snapshot_install_restores_previous_version(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            output, stage = root / 'live', root / 'next'
            output.mkdir(); stage.mkdir()
            (output / 'proof').write_text('working')
            original_rename = Path.rename
            def fail_staging(path, target):
                if path == stage:
                    raise OSError('disk failure')
                return original_rename(path, target)
            with patch.object(Path, 'rename', fail_staging), self.assertRaises(OSError):
                sync.swap_snapshot(stage, output)
            self.assertEqual((output / 'proof').read_text(), 'working')


if __name__ == '__main__':
    unittest.main()
