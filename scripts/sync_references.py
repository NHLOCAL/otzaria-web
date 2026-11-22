#!/usr/bin/env python3
"""Attach the native About-dialog Otzar references without rewriting book text."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import re
import sys
import uuid

from sync_library import digest_file, json_bytes, load_json, open_database, safe_path

REFERENCE_SCHEMA_VERSION = 1
MAPPING_TABLE = 'otzaria_otzar_hahochma'


def native_otzar_references(connection, book_ids):
    """Mirror ExternalCatalogRepository._queryOtzarBooksForOtzariaId.

    The mapping table is optional in the released native catalog. In particular,
    db-v10 includes HebrewBooks mappings but no Otzar mapping table. Never infer
    associations from titles or from the unrelated HebrewBooks mapping.
    """
    tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if MAPPING_TABLE not in tables:
        return {}, False
    needed = {'otzaria_otzar_hahochma': {'otzaria_id', 'oh_id', 'is_best', 'confidence'}, 'otzar_hahochma': {'book_id', 'title', 'volume'}}
    for table, columns in needed.items():
        actual = {row[1] for row in connection.execute('PRAGMA table_info("' + table + '")')}
        if not columns <= actual:
            raise ValueError('Native Otzar mapping schema changed: ' + table)
    references = {}
    query = '''
      SELECT m.otzaria_id,b.book_id,b.title,b.volume
      FROM otzaria_otzar_hahochma m
      JOIN otzar_hahochma b ON b.book_id=m.oh_id
      ORDER BY m.otzaria_id,m.is_best DESC,
        CASE m.confidence WHEN 'certain' THEN 0 WHEN 'likely' THEN 1 ELSE 2 END,
        m.oh_id
    '''
    for row in connection.execute(query):
        if row['otzaria_id'] not in book_ids:
            continue
        entries = references.setdefault(row['otzaria_id'], [])
        if len(entries) >= 20:
            continue
        identifier = row['book_id']
        if not isinstance(identifier, int) or not 0 <= identifier <= 9007199254740991:
            raise ValueError('Invalid external Otzar book identifier')
        entry = {'provider': 'otzar', 'id': identifier, 'title': row['title'] or '', 'url': 'https://tablet.otzar.org/book/book.php?book=' + str(identifier)}
        volume = str(row['volume']).strip() if row['volume'] is not None else ''
        if volume:
            entry['volume'] = volume
        entries.append(entry)
    return references, True


def enrich_references(library, external, check=False):
    library = Path(library)
    external = Path(external)
    if check and (not (library / 'catalog.json').exists() or not (external / 'catalog.json').exists()):
        return {'changed': True, 'reason': 'A required catalog snapshot is missing'}
    catalog = load_json(library / 'catalog.json')
    if catalog.get('schemaVersion') != 1 or not catalog.get('books'):
        raise ValueError('Invalid core library catalog')
    external_catalog = load_json(external / 'catalog.json')
    database_info = external_catalog.get('database', {})
    database = safe_path(external, database_info.get('file'))
    if database.stat().st_size != database_info.get('bytes') or digest_file(database) != database_info.get('sha256'):
        raise ValueError('External catalog database checksum mismatch')
    source = external_catalog.get('source', {})
    if source.get('repository') != 'Otzaria/otzar-HB_catalog' or not re.fullmatch('[a-f0-9]{64}', source.get('archiveSha256', '')):
        raise ValueError('Missing authenticated external catalog provenance')
    original = json_bytes(catalog)
    book_ids = {book['upstreamId'] for book in catalog['books']}
    connection = open_database(database)
    try:
        references, available = native_otzar_references(connection, book_ids)
    finally:
        connection.close()
    base_count = published_count = base_references = published_references = 0
    for book in catalog['books']:
        entries = references.get(book['upstreamId'], [])
        book['mappedOtzarReferences'] = entries
        if entries:
            published_count += 1
            published_references += len(entries)
            if not book.get('editionOf'):
                base_count += 1
                base_references += len(entries)
    stable_source = {key: source[key] for key in ('id', 'repository', 'release', 'tag', 'publishedAt', 'version', 'archiveSha256', 'url') if key in source}
    catalog['externalReferences'] = {
        'schemaVersion': REFERENCE_SCHEMA_VERSION,
        'source': stable_source,
        'mappingTable': MAPPING_TABLE,
        'mappingTableAvailable': available,
        'selection': {'limitPerBook': 20, 'order': ['is_best DESC', 'confidence: certain, likely, other', 'oh_id ASC']},
        'counts': {'mappedBaseBooks': base_count, 'mappedPublishedBooks': published_count, 'baseReferences': base_references, 'publishedReferences': published_references},
    }
    catalog['scope']['externalCatalog'] = {'downloadedByNativeInstaller': True, 'providerListingsEnabledByDefault': False, 'publishedSeparatelyAsMetadata': True, 'remotePdfPayloadsImported': False}
    catalog['scope']['content'] = catalog['scope']['content'].replace('The optional external PDF-provider catalog and lexical search databases are separate application downloads.', 'The external provider catalog is downloaded by the native installer and published separately as link metadata; provider listings are disabled by default. The lexical search database is a separate application download.')
    content = json_bytes(catalog)
    changed = content != original
    if changed and not check:
        temporary = library / ('catalog.references-next-' + uuid.uuid4().hex + '.json')
        try:
            temporary.write_bytes(content)
            temporary.replace(library / 'catalog.json')
        finally:
            temporary.unlink(missing_ok=True)
    return {'changed': changed, 'mappingTableAvailable': available, **catalog['externalReferences']['counts'], 'output': str(library / 'catalog.json')}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--library')
    parser.add_argument('--external')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    root = Path(args.root).resolve()
    try:
        result = enrich_references(Path(args.library).resolve() if args.library else root / '.cache/library', Path(args.external).resolve() if args.external else root / '.cache/external', args.check)
        print(json.dumps(result, ensure_ascii=False))
    except Exception as error:
        print(type(error).__name__ + ': ' + str(error), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
