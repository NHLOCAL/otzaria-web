#!/usr/bin/env python3
"""Export all provider metadata bundled by the native Otzaria installer."""
from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import sys
import uuid

from sync_library import api, digest_file, download_part, json_bytes, load_json, safe_path, swap_snapshot, validated_asset_bytes

REPOSITORY = 'Otzaria/otzar-HB_catalog'
ARCHIVE_NAME = 'otzar-HB_catalog.db.zst'
DATABASE_NAME = 'otzar-HB_catalog.db'
APP_COMMIT = 'cee59520a8e6d35d5350b8f51cde322d4b4b99cf'
EXPORTER_VERSION = 2
PAGE_SIZE = 200
MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024
MAX_DATABASE_BYTES = 2 * 1024 * 1024 * 1024
PROVIDERS = (
    {'id': 'otzar', 'name': 'אוצר החכמה', 'table': 'otzar_hahochma', 'key': 'book_id', 'columns': {'book_id', 'title', 'authors', 'volume', 'from_year', 'to_year', 'places', 'subjects', 'pages'}},
    {'id': 'hebrewbooks', 'name': 'HebrewBooks', 'table': 'hebrew_books', 'key': 'id_book', 'columns': {'id_book', 'title', 'author', 'printing_place', 'printing_year', 'pub_date', 'pages', 'tags'}},
)
MAPPINGS = (
    {'provider': 'otzar', 'table': 'otzaria_otzar_hahochma', 'key': 'oh_id'},
    {'provider': 'hebrewbooks', 'table': 'otzaria_hebrew_books', 'key': 'hb_id'},
)


def selected_release(fetch_api=api):
    """Mirror ExternalCatalogRepository: latest release, zstd before plain DB."""
    release = fetch_api('/repos/' + REPOSITORY + '/releases/latest')
    if not isinstance(release, dict) or release.get('draft') or release.get('prerelease') or not release.get('tag_name'):
        raise ValueError('Expected a stable external catalog release')
    assets = release.get('assets', [])
    for name in (ARCHIVE_NAME, DATABASE_NAME):
        asset = next((item for item in assets if item.get('name') == name and item.get('browser_download_url')), None)
        if asset:
            return release, asset
    raise ValueError('The application external catalog database asset was not found')


def archive_identity(release, asset):
    size = asset.get('size')
    if type(size) is not int or not 0 < size <= MAX_ARCHIVE_BYTES:
        raise ValueError('Unexpected external catalog archive size')
    if not asset.get('browser_download_url', '').startswith('https://github.com/' + REPOSITORY + '/releases/download/'):
        raise ValueError('Unexpected external catalog archive URL')
    digest = asset.get('digest') or ''
    sha = digest[7:].lower() if digest.startswith('sha256:') else ''
    if not re.fullmatch('[a-f0-9]{64}', sha):
        raise ValueError('Missing external catalog SHA-256 checksum')
    return {'name': asset['name'], 'size': size, 'sha256': sha}


def release_version(release):
    asset = next((item for item in release.get('assets', []) if item.get('name') == 'version.txt'), None)
    if not asset:
        raise ValueError('Missing external catalog version.txt')
    if not asset.get('browser_download_url', '').startswith('https://github.com/' + REPOSITORY + '/releases/download/'):
        raise ValueError('Unexpected external catalog version URL')
    match = re.search(r'\d+', validated_asset_bytes(asset).decode('utf-8').strip())
    if not match:
        raise ValueError('Invalid external catalog version')
    return int(match.group())


def open_database(path):
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def extract_database(archive, destination, compressed):
    if compressed:
        import zstandard
        with archive.open('rb') as source, zstandard.ZstdDecompressor().stream_reader(source) as reader, destination.open('wb') as output:
            total = 0
            while chunk := reader.read(1024 * 1024):
                total += len(chunk)
                if total > MAX_DATABASE_BYTES:
                    raise ValueError('External catalog extraction exceeds its size budget')
                output.write(chunk)
    else:
        if archive.stat().st_size > MAX_DATABASE_BYTES:
            raise ValueError('External catalog database exceeds its size budget')
        shutil.copyfile(archive, destination)
    with destination.open('rb') as database:
        if database.read(16) != b'SQLite format 3\x00':
            raise ValueError('External catalog is not an SQLite database')


def string_list(value):
    if value is None or value == '':
        return []
    if isinstance(value, str):
        try:
            decoded = json.loads(value)
        except (ValueError, TypeError):
            decoded = None
        if isinstance(decoded, list) and all(isinstance(item, str) for item in decoded):
            return decoded
        return [value]
    if isinstance(value, list) and all(isinstance(item, str) for item in value):
        return value
    raise ValueError('Unexpected external catalog bibliographic value')


def text_value(value):
    return str(value) if value is not None and value != '' else None


def provider_record(provider, row):
    raw = dict(row)
    identifier = raw[provider['key']]
    if type(identifier) is not int or not 0 < identifier <= 9007199254740991:
        raise ValueError('Invalid external provider book identifier')
    if not isinstance(raw['title'], str) or not raw['title'].strip():
        raise ValueError('External provider record has no title')
    is_otzar = provider['id'] == 'otzar'
    pages = raw.get('pages')
    if pages is not None and (type(pages) is not int or pages < 0):
        raise ValueError('Unexpected external page count')
    return {
        'id': 'external-' + provider['id'] + '-' + str(identifier),
        'provider': provider['id'], 'providerId': identifier, 'title': raw['title'],
        'authors': string_list(raw.get('authors') if is_otzar else raw.get('author')),
        'url': ('https://tablet.otzar.org/book/book.php?book=' if is_otzar else 'https://hebrewbooks.org/') + str(identifier),
        'volume': text_value(raw.get('volume')),
        'year': text_value(raw.get('from_year') if is_otzar else raw.get('printing_year') or raw.get('pub_date')),
        'yearEnd': text_value(raw.get('to_year')),
        'place': text_value(raw.get('places') if is_otzar else raw.get('printing_place')),
        'pages': pages, 'subjects': string_list(raw.get('subjects') if is_otzar else raw.get('tags')),
        'metadata': raw,
    }


def write_page(staging, file, payload):
    # Compact paginated files avoid forcing clients to load the complete catalog.
    content = (json.dumps(payload, ensure_ascii=False, separators=(',', ':')) + '\n').encode()
    destination = safe_path(staging, file)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_bytes(content)
    return {'file': file, 'page': payload['page'], 'count': len(payload['records']), 'sha256': hashlib.sha256(content).hexdigest(), 'bytes': len(content)}


def export_database(database, staging, source, expected_version=None, scope='full'):
    connection = open_database(database)
    try:
        if connection.execute('PRAGMA quick_check').fetchone()[0] != 'ok':
            raise ValueError('External SQLite integrity check failed')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if 'db_meta' not in tables:
            raise ValueError('External catalog db_meta table is missing')
        metadata = dict(connection.execute('SELECT key,value FROM db_meta'))
        if expected_version is not None and str(metadata.get('version')) != str(expected_version):
            raise ValueError('External catalog database and release version disagree')
        providers = []
        for provider in PROVIDERS:
            table = provider['table']
            if table not in tables or not provider['columns'] <= {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}:
                raise ValueError('Unsupported external provider schema: ' + table)
            group = {'id': provider['id'], 'name': provider['name'], 'count': 0, 'pages': []}
            records = []
            bucket = None
            previous_id = 0
            def flush():
                if records:
                    group['pages'].append(write_page(staging, 'records/external-' + provider['id'] + '-' + str(bucket) + '.json', {'schemaVersion': 1, 'provider': provider['id'], 'page': bucket, 'records': records}))
            for row in connection.execute('SELECT * FROM "' + table + '" ORDER BY "' + provider['key'] + '"'):
                record = provider_record(provider, row)
                if record['providerId'] <= previous_id:
                    raise ValueError('Duplicate external provider identifier')
                previous_id = record['providerId']
                page = (record['providerId'] - 1) // PAGE_SIZE + 1
                if page != bucket:
                    flush()
                    records = []
                    bucket = page
                records.append(record)
                group['count'] += 1
            flush()
            if not group['count']:
                raise ValueError('The external provider catalog is empty: ' + table)
            providers.append(group)
        mappings = []
        for mapping in MAPPINGS:
            table = mapping['table']
            group = {'provider': mapping['provider'], 'table': table, 'present': table in tables, 'count': 0, 'pages': []}
            if table in tables:
                required = {mapping['key'], 'otzaria_id', 'is_best', 'confidence'}
                if not required <= {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}:
                    raise ValueError('Unsupported external mapping schema: ' + table)
                records = []
                page = 1
                previous_pair = None
                for row in connection.execute('SELECT * FROM "' + table + '" ORDER BY "' + mapping['key'] + '",otzaria_id'):
                    raw = dict(row)
                    pair = (raw[mapping['key']], raw['otzaria_id'])
                    if not all(type(value) is int and 0 < value <= 9007199254740991 for value in pair) or pair == previous_pair:
                        raise ValueError('Invalid or duplicate external book mapping')
                    previous_pair = pair
                    records.append({'provider': mapping['provider'], 'providerId': pair[0], 'otzariaId': pair[1], 'otzariaTitle': raw.get('otzaria_title'), 'preferred': bool(raw['is_best']), 'confidence': raw['confidence'], 'metadata': raw})
                    group['count'] += 1
                    if len(records) == PAGE_SIZE:
                        group['pages'].append(write_page(staging, 'mappings/' + mapping['provider'] + '-' + str(page) + '.json', {'schemaVersion': 1, 'provider': mapping['provider'], 'page': page, 'records': records}))
                        records = []
                        page += 1
                if records:
                    group['pages'].append(write_page(staging, 'mappings/' + mapping['provider'] + '-' + str(page) + '.json', {'schemaVersion': 1, 'provider': mapping['provider'], 'page': page, 'records': records}))
            mappings.append(group)
        catalog = {
            'schemaVersion': 1, 'exporterVersion': EXPORTER_VERSION,
            'source': source, 'scope': {'mode': scope, 'complete': scope == 'full', 'content': 'Bibliographic metadata and source links; no remote provider PDF payloads.', 'downloadedByNativeInstaller': True, 'providerListingsEnabledByDefault': False},
            'database': {'file': 'catalog.db', 'sha256': digest_file(database), 'bytes': database.stat().st_size},
            'databaseMetadata': metadata, 'paging': {'strategy': 'native-id-buckets', 'size': PAGE_SIZE},
            'providers': providers, 'mappings': mappings,
            'counts': {'records': sum(group['count'] for group in providers), **{group['id']: group['count'] for group in providers}, 'mappings': sum(group['count'] for group in mappings)},
        }
        (staging / 'catalog.json').write_bytes(json_bytes(catalog))
        return catalog
    finally:
        connection.close()


def validate_snapshot(directory):
    catalog = load_json(directory / 'catalog.json')
    if catalog.get('schemaVersion') != 1 or catalog.get('exporterVersion') != EXPORTER_VERSION or catalog.get('paging') != {'strategy': 'native-id-buckets', 'size': PAGE_SIZE}:
        raise ValueError('Invalid external catalog snapshot')
    database = catalog.get('database', {})
    if database.get('file') != 'catalog.db':
        raise ValueError('Invalid external database filename')
    path = safe_path(directory, database['file'])
    if path.stat().st_size != database.get('bytes') or digest_file(path) != database.get('sha256'):
        raise ValueError('External database checksum mismatch')
    providers = catalog.get('providers', [])
    mappings = catalog.get('mappings', [])
    if [group.get('id') for group in providers] != [provider['id'] for provider in PROVIDERS]:
        raise ValueError('Incomplete external provider catalog')
    for group in providers + mappings:
        count = 0
        for page in group['pages']:
            path = safe_path(directory, page['file'])
            if path.stat().st_size != page['bytes'] or digest_file(path) != page['sha256']:
                raise ValueError('External metadata page checksum mismatch')
            data = load_json(path)
            if data.get('schemaVersion') != 1 or data.get('provider') != group.get('id', group.get('provider')) or data.get('page') != page['page'] or len(data.get('records', [])) != page['count'] or not 0 < page['count'] <= PAGE_SIZE:
                raise ValueError('Invalid external metadata page')
            count += page['count']
        if count != group['count']:
            raise ValueError('Incomplete external metadata export')
    if sum(group['count'] for group in providers) != catalog['counts']['records'] or sum(group['count'] for group in mappings) != catalog['counts']['mappings']:
        raise ValueError('External metadata totals disagree')
    return catalog


def run(args):
    root = Path(args.root).resolve()
    output = root / '.cache/external'
    if args.offline:
        catalog = validate_snapshot(output)
        if catalog.get('scope', {}).get('complete') is not True:
            raise ValueError('Full synchronization requires a complete external catalog')
        return {'changed': False, **catalog['counts'], 'output': str(output)}
    release, asset = selected_release()
    identity = archive_identity(release, asset)
    previous = load_json(output / 'catalog.json') if (output / 'catalog.json').exists() else None
    changed = previous is None or previous.get('source', {}).get('archiveSha256') != identity['sha256'] or previous.get('source', {}).get('id') != 'otzaria-external-catalog' or previous.get('exporterVersion') != EXPORTER_VERSION or previous.get('scope', {}).get('complete') is not True
    if args.check:
        return {'changed': changed, 'release': release['tag_name'], 'archiveSha256': identity['sha256']}
    if not changed:
        validate_snapshot(output)
        return {'changed': False, **previous['counts'], 'output': str(output)}
    version = release_version(release)
    archive = root / '.cache/upstream/archives' / (identity['sha256'] + '.part')
    print('Downloading and verifying the native external metadata catalog', file=sys.stderr, flush=True)
    download_part(asset, identity, archive)
    staging = output.with_name('external.next-' + uuid.uuid4().hex)
    staging.mkdir(parents=True)
    try:
        extract_database(archive, staging / 'catalog.db', asset['name'] == ARCHIVE_NAME)
        source = {'id': 'otzaria-external-catalog', 'repository': REPOSITORY, 'release': release['tag_name'], 'publishedAt': release['published_at'], 'version': version, 'url': asset['browser_download_url'], 'archiveSha256': identity['sha256'], 'archiveBytes': identity['size'], 'appCommit': APP_COMMIT, 'policyUrl': 'https://github.com/Otzaria/otzaria/blob/' + APP_COMMIT + '/lib/external_catalog/repository/external_catalog_repository.dart'}
        catalog = export_database(staging / 'catalog.db', staging, source, version)
        validate_snapshot(staging)
        swap_snapshot(staging, output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    return {'changed': True, **catalog['counts'], 'output': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--check', action='store_true')
    parser.add_argument('--offline', action='store_true')
    args = parser.parse_args()
    if args.check and args.offline:
        parser.error('--check and --offline cannot be combined')
    try:
        print(json.dumps(run(args), ensure_ascii=False))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
