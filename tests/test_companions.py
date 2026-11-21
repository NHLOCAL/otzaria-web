import io
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest

import zstandard

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from sync_companions import extract_pdfs, pdf_id, selected_release


class CompanionImportTests(unittest.TestCase):
    def test_latest_release_with_asset_wins(self):
        calls = []
        def fetch(path):
            calls.append(path)
            return {'tag_name': 'latest', 'assets': [{'name': 'talmud_bavli_latest.tar.zst'}]}
        release, _ = selected_release(fetch)
        self.assertEqual(release['tag_name'], 'latest')
        self.assertEqual(len(calls), 1)

    def test_fallback_skips_prereleases_and_stops_at_three_pages(self):
        calls = []
        def fetch(path):
            calls.append(path)
            if path.endswith('/latest'):
                return {'tag_name': 'no-pdf', 'assets': []}
            return [{'tag_name': 'preview', 'prerelease': True, 'assets': [{'name': 'talmud_bavli_latest.tar.zst'}]}]
        with self.assertRaisesRegex(ValueError, 'not found'):
            selected_release(fetch)
        self.assertEqual(len(calls), 4)
        self.assertTrue(calls[-1].endswith('page=3'))

    def test_stable_id_is_not_based_on_the_pdf_bytes_or_archive_path(self):
        self.assertEqual(pdf_id('ברכות'), pdf_id('ברכות'))
        self.assertNotEqual(pdf_id('ברכות'), pdf_id('שבת'))
        self.assertTrue(pdf_id('ברכות').isascii())

    def make_archive(self, directory, entries):
        raw = io.BytesIO()
        with tarfile.open(fileobj=raw, mode='w') as archive:
            for name, content, link in entries:
                info = tarfile.TarInfo(name)
                if link:
                    info.type = tarfile.SYMTYPE
                    info.linkname = 'outside.pdf'
                    archive.addfile(info)
                else:
                    info.size = len(content)
                    archive.addfile(info, io.BytesIO(content))
        result = directory / 'pack.tar.zst'
        result.write_bytes(zstandard.ZstdCompressor().compress(raw.getvalue()))
        return result

    def test_streaming_pdf_extraction_preserves_title_and_exact_bytes(self):
        with tempfile.TemporaryDirectory() as temporary:
            root = Path(temporary)
            body = b'%PDF-1.7\nexact content\n%%EOF\n'
            archive = self.make_archive(root, [('תלמוד בבלי/ברכות.pdf', body, False)])
            result = extract_pdfs(archive, root / 'output')
            self.assertEqual(result[0]['title'], 'ברכות')
            self.assertEqual(result[0]['externalLibraryId'], 'talmud-pdf:ברכות')
            self.assertEqual((root / 'output' / result[0]['file']).read_bytes(), body)

    def test_malformed_paths_links_and_non_pdf_content_fail(self):
        for name, content, link in [('../escaped.pdf', b'%PDF-1.7', False), ('linked.pdf', b'', True), ('book.pdf', b'not a PDF', False)]:
            with self.subTest(name=name), tempfile.TemporaryDirectory() as temporary:
                root = Path(temporary)
                archive = self.make_archive(root, [(name, content, link)])
                with self.assertRaises(ValueError):
                    extract_pdfs(archive, root / 'output')


if __name__ == '__main__':
    unittest.main()
