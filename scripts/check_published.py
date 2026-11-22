#!/usr/bin/env python3
"""Avoid rebuilding an unchanged full library on scheduled publication runs."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import sys
import urllib.parse
import urllib.request

from sync_library import load_json, release_state
from sync_companions import archive_identity, selected_release
from sync_external import archive_identity as external_archive_identity, selected_release as selected_external_release


def publication_matches(manifest, *, revision, site_url, base_path, database_manifest, database_archive, pdf_archive, external_archive):
    """Skip only a complete, searchable publication of this code and every source."""
    if not re.fullmatch(r'[a-f0-9]{40}', revision or ''):
        return False
    if not isinstance(manifest, dict) or manifest.get('schemaVersion') != 1:
        return False
    if manifest.get('profile') != 'full' or manifest.get('codeRevision') != revision:
        return False
    if manifest.get('siteUrl') != site_url:
        return False
    if manifest.get('basePath') != base_path or manifest.get('scope', {}).get('complete') is not True:
        return False
    if manifest.get('search', {}).get('status') != 'ready':
        return False
    if manifest.get('externalScope', {}).get('complete') is not True:
        return False
    if manifest.get('externalSearch', {}).get('status') != 'ready' or manifest.get('counts', {}).get('externalRecords', 0) <= 0:
        return False
    if manifest['externalSearch'].get('records') != manifest['counts']['externalRecords']:
        return False
    sources = manifest.get('sources')
    if not isinstance(sources, list):
        return False
    database = [source for source in sources if source.get('repository') == 'Otzaria/SeforimLibrary']
    pdfs = [source for source in sources if source.get('repository') == 'Otzaria/otzaria-library' and source.get('id') in ('talmud-pdfs', 'otzaria-bavli-pdfs')]
    external = [source for source in sources if source.get('repository') == 'Otzaria/otzar-HB_catalog' and source.get('id') == 'otzaria-external-catalog']
    if len(database) != 1 or len(pdfs) != 1 or len(external) != 1:
        return False
    return (
        database[0].get('manifestSha256') == database_manifest
        and database[0].get('archiveSha256') == database_archive
        and pdfs[0].get('archiveSha256') == pdf_archive
        and external[0].get('archiveSha256') == external_archive
    )


def published_manifest(origin, base_path):
    parsed = urllib.parse.urlsplit(origin)
    if parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path not in ('', '/'):
        raise ValueError('SITE_URL must be a public HTTPS origin')
    if not base_path.startswith('/') or not base_path.endswith('/') or '..' in base_path or '//' in base_path or re.search(r'[?#\\\s]', base_path):
        raise ValueError('Invalid BASE_PATH')
    url = origin.rstrip('/') + base_path + 'build-manifest.json'
    request = urllib.request.Request(url, headers={'User-Agent': 'otzaria-web-update-check/1.0', 'Cache-Control': 'no-cache'})
    with urllib.request.urlopen(request, timeout=30) as response:
        payload = response.read(1024 * 1024 + 1)
    if len(payload) > 1024 * 1024:
        raise ValueError('Published build manifest is unexpectedly large')
    return json.loads(payload)


def run(root, origin, base_path, revision):
    # A first deployment, older manifest, incomplete deployment or unavailable
    # public endpoint always falls back to the normal verified build pipeline.
    try:
        manifest = published_manifest(origin, base_path)
        if manifest.get('codeRevision') != revision:
            return True, 'The published code differs or has no recorded revision.'
        state = release_state(load_json(root / 'config/sources.json'))
        release, asset = selected_release()
        companion = archive_identity(release, asset)
        external_release, external_asset = selected_external_release()
        external = external_archive_identity(external_release, external_asset)
        matches = publication_matches(
            manifest, revision=revision, site_url=origin.rstrip('/') + base_path, base_path=base_path,
            database_manifest=state['manifestSha256'],
            database_archive=state['manifest']['sha256'],
            pdf_archive=companion['sha256'],
            external_archive=external['sha256'],
        )
        return not matches, ('Published code, official database, bundled PDFs and external metadata are unchanged.' if matches else 'The published library differs from the current complete sources.')
    except Exception as error:
        return True, 'The previous publication could not be verified; a normal build is required (' + type(error).__name__ + ').'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    args = parser.parse_args()
    required, reason = run(Path(args.root).resolve(), os.environ.get('PUBLIC_SITE_URL', ''), os.environ.get('BASE_PATH', '/'), os.environ.get('GITHUB_SHA', ''))
    print(json.dumps({'buildRequired': required, 'reason': reason}))
    if os.environ.get('GITHUB_OUTPUT'):
        with open(os.environ['GITHUB_OUTPUT'], 'a', encoding='utf-8') as output:
            output.write('build_required=' + str(required).lower() + '\n')
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(reason + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
