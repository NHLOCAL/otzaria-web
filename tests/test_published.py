import copy
from pathlib import Path
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
from check_published import publication_matches, run


class PublicationCheckTests(unittest.TestCase):
    def setUp(self):
        self.expected = dict(revision='a' * 40, site_url='https://example.org/', base_path='/', database_manifest='b' * 64, database_archive='c' * 64, pdf_archive='d' * 64, external_archive='e' * 64)
        self.manifest = {
            'schemaVersion': 1, 'profile': 'full', 'codeRevision': self.expected['revision'],
            'siteUrl': 'https://example.org/', 'basePath': '/', 'scope': {'complete': True}, 'search': {'status': 'ready'}, 'externalScope': {'complete': True}, 'externalSearch': {'status': 'ready', 'records': 123}, 'counts': {'externalRecords': 123},
            'sources': [
                {'repository': 'Otzaria/SeforimLibrary', 'manifestSha256': 'b' * 64, 'archiveSha256': 'c' * 64},
                {'id': 'talmud-pdfs', 'repository': 'Otzaria/otzaria-library', 'archiveSha256': 'd' * 64},
                {'id': 'otzaria-external-catalog', 'repository': 'Otzaria/otzar-HB_catalog', 'archiveSha256': 'e' * 64},
            ],
        }

    def test_only_identical_complete_searchable_publication_is_skipped(self):
        self.assertTrue(publication_matches(self.manifest, **self.expected))
        for path, value in [
            (('codeRevision',), 'e' * 40), (('profile',), 'starter'),
            (('scope', 'complete'), False), (('search', 'status'), 'pending'),
            (('basePath',), '/another/'), (('schemaVersion',), 2),
            (('siteUrl',), 'https://wrong.example.org/'),
            (('sources', 0, 'manifestSha256'), 'new-manifest'),
            (('sources', 0, 'archiveSha256'), 'new-database'),
            (('sources', 1, 'archiveSha256'), 'new-pdfs'),
            (('sources', 2, 'archiveSha256'), 'new-external-metadata'),
            (('externalSearch', 'status'), 'pending'), (('counts', 'externalRecords'), 0),
            (('externalScope', 'complete'), False), (('externalSearch', 'records'), 122),
        ]:
            changed = copy.deepcopy(self.manifest)
            parent = changed
            for component in path[:-1]:
                parent = parent[component]
            parent[path[-1]] = value
            with self.subTest(path=path):
                self.assertFalse(publication_matches(changed, **self.expected))

    def test_old_and_ambiguous_manifests_rebuild(self):
        old = copy.deepcopy(self.manifest)
        del old['codeRevision']
        self.assertFalse(publication_matches(old, **self.expected))
        ambiguous = copy.deepcopy(self.manifest)
        ambiguous['sources'].append(copy.deepcopy(ambiguous['sources'][0]))
        self.assertFalse(publication_matches(ambiguous, **self.expected))
        self.assertFalse(publication_matches(self.manifest, **{**self.expected, 'revision': ''}))
        missing_external = copy.deepcopy(self.manifest)
        missing_external['sources'].pop()
        self.assertFalse(publication_matches(missing_external, **self.expected))

    def test_unavailable_publication_falls_back_to_a_build(self):
        with patch('check_published.published_manifest', side_effect=TimeoutError):
            needed, reason = run(Path('.'), 'https://example.org', '/', self.expected['revision'])
        self.assertTrue(needed)
        self.assertIn('normal build', reason)

    def test_code_change_does_not_make_upstream_network_calls(self):
        with patch('check_published.published_manifest', return_value={'codeRevision': 'other'}), patch('check_published.release_state') as upstream:
            needed, _ = run(Path('.'), 'https://example.org', '/', self.expected['revision'])
        self.assertTrue(needed)
        upstream.assert_not_called()


if __name__ == '__main__':
    unittest.main()
