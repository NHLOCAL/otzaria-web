#!/usr/bin/env python3
"""Import the bundled Bavli PDF pack selected by the actual Otzaria installer."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path, PurePosixPath
import re
import shutil
import sys
import tarfile
import unicodedata
import uuid

from sync_library import api, digest_file, download_part, json_bytes, load_json, safe_path, swap_snapshot, validated_asset_bytes

REPOSITORY = 'Otzaria/otzaria-library'
ASSET_NAME = 'talmud_bavli_latest.tar.zst'
MAX_ARCHIVE_BYTES = 3 * 1024 * 1024 * 1024
MAX_EXTRACTED_BYTES = 3 * 1024 * 1024 * 1024
MAX_PDF_BYTES = 256 * 1024 * 1024
APP_COMMIT = 'cee59520a8e6d35d5350b8f51cde322d4b4b99cf'


def pdf_id(title):
    return 'bavli-' + hashlib.sha256(unicodedata.normalize('NFC', title).encode()).hexdigest()[:20]


def selected_release(fetch_api=api):
    """Same latest-then-three-pages rule as CompanionAssetsService."""
    def find(release):
        if not isinstance(release, dict) or release.get('draft') or release.get('prerelease') or not release.get('tag_name'):
            return None
        for asset in release.get('assets', []):
            if asset.get('name') == ASSET_NAME:
                return release, asset
        return None

    prefix = '/repos/' + REPOSITORY
    found = find(fetch_api(prefix + '/releases/latest'))
    if found:
        return found
    for page in range(1, 4):
        releases = fetch_api(prefix + '/releases?per_page=100&page=' + str(page))
        if not isinstance(releases, list):
            raise ValueError('Unexpected companion release list')
        if not releases:
            break
        for release in releases:
            found = find(release)
            if found:
                return found
    raise ValueError('The bundled Bavli PDF archive was not found in the application release source')


def archive_identity(release, asset):
    size = asset.get('size', 0)
    if not isinstance(size, int) or not 0 < size <= MAX_ARCHIVE_BYTES:
        raise ValueError('Unexpected companion archive size')
    expected_prefix = 'https://github.com/' + REPOSITORY + '/releases/download/'
    if not asset.get('browser_download_url', '').startswith(expected_prefix):
        raise ValueError('Unexpected companion archive URL')
    digest = asset.get('digest', '')
    sha = digest[7:] if digest.startswith('sha256:') else None
    provenance_asset = next((a for a in release['assets'] if a.get('name') == 'otzaria_release_provenance.json'), None)
    if provenance_asset:
        provenance = json.loads(validated_asset_bytes(provenance_asset))
        declared = next((a for a in provenance.get('auxiliary_assets', []) if a.get('name') == ASSET_NAME), None)
        if not declared or declared.get('size') != size:
            raise ValueError('Companion provenance is incomplete')
        if sha and sha != declared.get('sha256'):
            raise ValueError('Companion provenance and GitHub checksum disagree')
        sha = declared.get('sha256')
    if not isinstance(sha, str) or not re.fullmatch('[a-f0-9]{64}', sha):
        raise ValueError('Missing companion archive checksum')
    return {'name': ASSET_NAME, 'size': size, 'sha256': sha}


def validate_snapshot(directory):
    catalog = load_json(directory / 'catalog.json')
    if catalog.get('schemaVersion') != 1 or not catalog.get('pdfs'):
        raise ValueError('Missing companion PDF catalogue')
    seen = set()
    for pdf in catalog['pdfs']:
        if pdf['id'] != pdf_id(pdf['title']) or pdf['id'] in seen:
            raise ValueError('Invalid or duplicate companion ID')
        seen.add(pdf['id'])
        if pdf['file'] != 'pdfs/' + pdf['id'] + '.pdf':
            raise ValueError('Unexpected companion filename')
        path = safe_path(directory, pdf['file'])
        if path.stat().st_size != pdf['bytes'] or digest_file(path) != pdf['sha256']:
            raise ValueError('Companion PDF integrity check failed: ' + pdf['title'])
    return catalog


def extract_pdfs(archive, staging):
    import zstandard
    (staging / 'pdfs').mkdir(parents=True)
    pdfs = []
    seen = set()
    total = 0
    members = 0
    with archive.open('rb') as compressed, zstandard.ZstdDecompressor().stream_reader(compressed) as reader:
        with tarfile.open(fileobj=reader, mode='r|') as package:
            for member in package:
                members += 1
                if members > 1000:
                    raise ValueError('Unexpectedly many companion archive entries')
                name = member.name
                while name.startswith('./'):
                    name = name[2:]
                parts = PurePosixPath(name).parts
                if '\\' in name or '\0' in name or name.startswith('/') or '..' in parts:
                    raise ValueError('Unsafe companion archive path')
                if member.isdir():
                    continue
                if not member.isfile():
                    raise ValueError('Companion archive contains a link or special file')
                total += member.size
                if total > MAX_EXTRACTED_BYTES:
                    raise ValueError('Companion extraction exceeds its size budget')
                if not name.lower().endswith('.pdf'):
                    continue
                if member.size <= 0 or member.size > MAX_PDF_BYTES:
                    raise ValueError('Unexpected PDF size')
                title = unicodedata.normalize('NFC', PurePosixPath(name).stem)
                identity = pdf_id(title)
                if identity in seen:
                    raise ValueError('Two bundled PDFs have the same title: ' + title)
                seen.add(identity)
                target = staging / 'pdfs' / (identity + '.pdf')
                digest = hashlib.sha256()
                written = 0
                first = True
                with package.extractfile(member) as content, target.open('wb') as destination:
                    while chunk := content.read(1024 * 1024):
                        if first and b'%PDF-' not in chunk[:1024]:
                            raise ValueError('The archive member is not a PDF: ' + title)
                        first = False
                        written += len(chunk)
                        digest.update(chunk)
                        destination.write(chunk)
                if written != member.size:
                    raise ValueError('Incomplete companion PDF')
                pdfs.append({'id': identity, 'title': title, 'file': 'pdfs/' + identity + '.pdf', 'sha256': digest.hexdigest(), 'bytes': written, 'upstreamPath': name, 'externalLibraryId': 'talmud-pdf:' + title})
        # Finish the zstd stream so a malformed trailing frame is not ignored.
        trailing = 0
        while chunk := reader.read(1024 * 1024):
            trailing += len(chunk)
            if trailing > 1024 * 1024 or chunk.strip(b'\0'):
                raise ValueError('Unexpected trailing companion archive data')
    if not pdfs:
        raise ValueError('The application companion archive contains no PDFs')
    return sorted(pdfs, key=lambda item: item['title'])


def run(args):
    root = Path(args.root).resolve()
    output = root / '.cache/companions'
    if args.offline:
        catalog = validate_snapshot(output)
        return {'changed': False, 'pdfs': len(catalog['pdfs']), 'output': str(output)}
    release, asset = selected_release()
    identity = archive_identity(release, asset)
    previous = load_json(output / 'catalog.json') if (output / 'catalog.json').exists() else None
    changed = previous is None or previous.get('source', {}).get('archiveSha256') != identity['sha256']
    if args.check:
        return {'changed': changed, 'release': release['tag_name'], 'archiveSha256': identity['sha256']}
    if not changed:
        validate_snapshot(output)
        return {'changed': False, 'pdfs': len(previous['pdfs']), 'output': str(output)}
    archive = root / '.cache/upstream/archives' / (identity['sha256'] + '.tar.zst')
    print('Downloading and verifying bundled Bavli PDF archive', file=sys.stderr, flush=True)
    download_part(asset, identity, archive)
    staging = output.with_name('companions.next-' + uuid.uuid4().hex)
    staging.mkdir(parents=True)
    try:
        pdfs = extract_pdfs(archive, staging)
        catalog = {
            'schemaVersion': 1,
            'source': {
                'id': 'otzaria-bavli-pdfs', 'repository': REPOSITORY,
                'release': release['tag_name'], 'publishedAt': release['published_at'],
                'url': asset['browser_download_url'], 'archiveSha256': identity['sha256'],
                'archiveBytes': identity['size'], 'appCommit': APP_COMMIT,
                'policyUrl': 'https://github.com/Otzaria/otzaria/blob/' + APP_COMMIT + '/lib/library_update/services/companion_assets_service.dart',
                'attribution': 'קובצי התלמוד הבבלי המצורפים להפצה הרשמית של אוצריא. פרטי המקור נשמרים בקובצי ה-PDF.'
            },
            'pdfs': pdfs,
            'counts': {'pdfs': len(pdfs), 'bytes': sum(x['bytes'] for x in pdfs)}
        }
        (staging / 'catalog.json').write_bytes(json_bytes(catalog))
        validate_snapshot(staging)
        swap_snapshot(staging, output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {'changed': True, **catalog['counts'], 'output': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
