#!/usr/bin/env python3
"""Import the official Otzaria application database without reinterpreting its corpus.

All network inputs are pinned to a release and verified against its published
SHA-256 manifest. SQLite is opened read-only. Publication is an atomic directory
swap only after all selected books and provenance have been validated.
"""
from __future__ import annotations
import argparse
import collections
import concurrent.futures
import hashlib
import html
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from datetime import datetime, timezone

EXPORTER_VERSION = 4
MAX_LINE_BYTES = 16 * 1024 * 1024
MAX_DATABASE_BYTES = 40 * 1024 * 1024 * 1024


def now():
    return datetime.now(timezone.utc).isoformat().replace('+00:00', 'Z')


def digest_file(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for chunk in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def json_bytes(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + '\n').encode()


def load_json(path):
    with open(path, encoding='utf-8') as f:
        return json.load(f)


def safe_path(root, value):
    if not isinstance(value, str) or not value or '\\' in value or '\0' in value:
        raise ValueError('Unsafe relative path')
    path = PurePosixPath(value)
    if path.is_absolute() or any(x in ('.', '..') for x in value.split('/')):
        raise ValueError('Unsafe relative path')
    target = Path(root).joinpath(*path.parts)
    if not target.resolve().is_relative_to(Path(root).resolve()):
        raise ValueError('Path escapes destination')
    return target


def fetch(url, max_bytes=16 * 1024 * 1024):
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme != 'https' or parsed.hostname not in ('api.github.com', 'raw.githubusercontent.com', 'github.com'):
        raise ValueError('Unexpected upstream URL')
    headers = {'User-Agent': 'otzaria-web-official-sync/1.0'}
    if parsed.hostname == 'api.github.com':
        headers['Accept'] = 'application/vnd.github+json'
        headers['X-GitHub-Api-Version'] = '2022-11-28'
        if os.environ.get('GITHUB_TOKEN'):
            headers['Authorization'] = 'Bearer ' + os.environ['GITHUB_TOKEN']
    for attempt in range(4):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=90) as response:
                data = response.read(max_bytes + 1)
                if len(data) > max_bytes:
                    raise ValueError('Upstream JSON exceeds maximum size')
                return data
        except urllib.error.HTTPError as error:
            if error.code not in (429, 500, 502, 503, 504) or attempt == 3:
                raise
        except (TimeoutError, urllib.error.URLError):
            if attempt == 3:
                raise
        time.sleep(2 ** attempt)


def api(path):
    return json.loads(fetch('https://api.github.com' + path))


def validated_asset_bytes(asset):
    data = fetch(asset['browser_download_url'])
    declared = asset.get('digest')
    if declared and declared.startswith('sha256:') and hashlib.sha256(data).hexdigest() != declared[7:]:
        raise ValueError('GitHub asset digest mismatch: ' + asset['name'])
    if len(data) != asset['size']:
        raise ValueError('GitHub asset size mismatch: ' + asset['name'])
    return data


def select_database_asset(assets, maximum_schema):
    """Mirror EmptyLibraryBloc.parseLatestDatabaseAsset, including precedence."""
    candidates = [('seforim-schema' + str(schema) + '.db.zst', schema) for schema in range(maximum_schema, 5, -1)]
    candidates.append(('seforim.db.zst', 5))
    for archive, schema in candidates:
        for name, split in [(archive, False), (archive + '.manifest.json', True)]:
            asset = assets.get(name)
            if asset and asset.get('browser_download_url'):
                return {'archive': archive, 'schemaVersion': schema, 'name': name, 'split': split}
    raise ValueError('No database asset readable by the configured Otzaria application schema')


def release_state(config):
    repository = config['repository']
    if not re.fullmatch(r'[\w.-]+/[\w.-]+', repository):
        raise ValueError('Invalid source repository')
    release = api('/repos/' + repository + '/releases/latest')
    if release.get('draft') or release.get('prerelease'):
        raise ValueError('Expected a published stable database release')
    assets = {x['name']: x for x in release['assets']}
    selected = select_database_asset(assets, config['databaseSchemaVersion'])
    expected = selected['name']
    provenance = json.loads(validated_asset_bytes(assets['build_provenance.json']))
    stats_bytes = validated_asset_bytes(assets['library_stats.json'])
    stats = json.loads(stats_bytes)
    published = {x['name']: x for x in provenance['assets']}
    if selected['split']:
        manifest_bytes = validated_asset_bytes(assets[expected])
        manifest = json.loads(manifest_bytes)
        if manifest.get('archive') != selected['archive']:
            raise ValueError('Manifest points to a different database archive')
        if expected not in published or published[expected]['sha256'] != hashlib.sha256(manifest_bytes).hexdigest():
            raise ValueError('Build provenance does not authenticate archive manifest')
    else:
        asset = assets[expected]
        published_hash = published.get(expected, {}).get('sha256')
        github_hash = (asset.get('digest') or '').removeprefix('sha256:')
        if not published_hash or not re.fullmatch('[a-f0-9]{64}', published_hash):
            raise ValueError('No authenticated checksum for the single database archive')
        if github_hash and github_hash != published_hash:
            raise ValueError('GitHub and build provenance archive checksums disagree')
        manifest = {'schemaVersion': 1, 'archive': expected, 'size': asset['size'], 'sha256': published_hash, 'parts': [{'name': expected, 'size': asset['size'], 'sha256': published_hash}]}
        # A deterministic receipt gives the same update-comparison contract for
        # monolithic archives as for published split manifests.
        manifest_bytes = json_bytes(manifest)
    if manifest.get('schemaVersion') != 1 or not manifest.get('parts'):
        raise ValueError('Unexpected database archive manifest')
    if not re.fullmatch('[a-f0-9]{64}', manifest.get('sha256', '')):
        raise ValueError('Missing aggregate database archive checksum')
    if len({x['name'] for x in manifest['parts']}) != len(manifest['parts']):
        raise ValueError('Duplicate database archive parts')
    for part in manifest['parts']:
        if not re.fullmatch(re.escape(selected['archive']) + r'(?:\.part-\d+)?', part['name']):
            raise ValueError('Unsafe archive asset name')
        if part['name'] not in assets or assets[part['name']]['size'] != part['size']:
            raise ValueError('Incomplete release or part size mismatch')
        if not re.fullmatch('[a-f0-9]{64}', part.get('sha256', '')):
            raise ValueError('Missing part checksum')
    if sum(x['size'] for x in manifest['parts']) != manifest['size']:
        raise ValueError('Archive part size sum mismatch')
    for name in [expected, 'library_stats.json'] + [p['name'] for p in manifest['parts']]:
        if name not in published or published[name]['size'] != assets[name]['size']:
            raise ValueError('Build provenance assets are inconsistent')
    if published['library_stats.json']['sha256'] != hashlib.sha256(stats_bytes).hexdigest():
        raise ValueError('Build provenance does not authenticate release statistics')
    for part in manifest['parts']:
        if published[part['name']]['sha256'] != part['sha256']:
            raise ValueError('Build provenance does not authenticate archive part')
    library_commit = api('/repos/' + config['libraryRepository'] + '/commits/' + urllib.parse.quote(config['libraryRef'], safe=''))
    return {'release': release, 'assets': assets, 'manifest': manifest, 'manifestSha256': hashlib.sha256(manifest_bytes).hexdigest(), 'archiveSelection': selected, 'provenance': provenance, 'stats': stats, 'libraryHead': library_commit['sha'], 'checkedAt': now()}


def download_part(asset, part, destination):
    if destination.exists() and destination.stat().st_size == part['size'] and digest_file(destination) == part['sha256']:
        return destination
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.partial-' + uuid.uuid4().hex)
    try:
        for attempt in range(4):
            try:
                digest = hashlib.sha256()
                total = 0
                with urllib.request.urlopen(asset['browser_download_url'], timeout=180) as response, temporary.open('wb') as output:
                    while chunk := response.read(4 * 1024 * 1024):
                        total += len(chunk)
                        if total > part['size']:
                            raise ValueError('Archive part exceeds declared size')
                        digest.update(chunk)
                        output.write(chunk)
                if total != part['size'] or digest.hexdigest() != part['sha256']:
                    raise ValueError('Archive part checksum mismatch: ' + part['name'])
                temporary.replace(destination)
                return destination
            except (TimeoutError, urllib.error.URLError, OSError):
                if attempt == 3:
                    raise
                time.sleep(2 ** attempt)
    finally:
        temporary.unlink(missing_ok=True)


class ConcatenatedParts(io.RawIOBase):
    def __init__(self, paths):
        self.paths = iter(paths)
        self.current = None

    def readable(self):
        return True

    def readinto(self, buffer):
        while True:
            if self.current is None:
                try:
                    self.current = open(next(self.paths), 'rb')
                except StopIteration:
                    return 0
            size = self.current.readinto(buffer)
            if size:
                return size
            self.current.close()
            self.current = None

    def close(self):
        if self.current:
            self.current.close()
        super().close()


def database_file(root, state):
    import zstandard
    cache = root / '.cache/upstream'
    manifest = state['manifest']
    destination = cache / 'databases' / (manifest['sha256'] + '.db')
    receipt = destination.with_suffix('.receipt.json')
    if destination.exists() and receipt.exists():
        known = load_json(receipt)
        if known.get('size') == destination.stat().st_size and known.get('sha256') == digest_file(destination):
            return destination
    parts = []
    for part in manifest['parts']:
        print('Verifying archive part ' + part['name'], file=sys.stderr, flush=True)
        parts.append(download_part(state['assets'][part['name']], part, cache / 'archives' / (part['sha256'] + '.part')))
    aggregate = hashlib.sha256()
    for path in parts:
        with path.open('rb') as f:
            for chunk in iter(lambda: f.read(4 * 1024 * 1024), b''):
                aggregate.update(chunk)
    if aggregate.hexdigest() != manifest['sha256']:
        raise ValueError('Combined archive SHA-256 mismatch')
    destination.parent.mkdir(parents=True, exist_ok=True)
    temporary = destination.with_suffix('.partial-' + uuid.uuid4().hex)
    digest = hashlib.sha256()
    size = 0
    try:
        with io.BufferedReader(ConcatenatedParts(parts)) as compressed, zstandard.ZstdDecompressor().stream_reader(compressed) as source, temporary.open('wb') as output:
            while chunk := source.read(4 * 1024 * 1024):
                size += len(chunk)
                if size > MAX_DATABASE_BYTES:
                    raise ValueError('Decompressed database exceeds safety limit')
                digest.update(chunk)
                output.write(chunk)
        with temporary.open('rb') as f:
            if f.read(16) != b'SQLite format 3\x00':
                raise ValueError('Archive does not contain a SQLite database')
        temporary.replace(destination)
        receipt.write_bytes(json_bytes({'sha256': digest.hexdigest(), 'size': size, 'archiveSha256': manifest['sha256']}))
    finally:
        temporary.unlink(missing_ok=True)
    return destination


def open_database(path):
    connection = sqlite3.connect(path.resolve().as_uri() + '?mode=ro&immutable=1', uri=True)
    connection.row_factory = sqlite3.Row
    connection.execute('PRAGMA query_only=ON')
    return connection


def category_path(categories, category_id):
    result = []
    seen = set()
    while category_id is not None:
        if category_id in seen or category_id not in categories:
            raise ValueError('Invalid upstream category hierarchy')
        seen.add(category_id)
        row = categories[category_id]
        if row['title'] not in ('אוצריא', 'Root', ''):
            result.append(row['title'])
        category_id = row['parentId']
    return list(reversed(result)) or ['ספרים']


def decoder(connection):
    import zstandard
    dictionaries = {}
    has_dictionary = connection.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name='zstd_dict'").fetchone()
    for row in connection.execute('SELECT id, dict FROM zstd_dict') if has_dictionary else []:
        dictionary = zstandard.ZstdCompressionDict(row['dict'])
        dictionaries[dictionary.dict_id()] = zstandard.ZstdDecompressor(dict_data=dictionary)
    empty = zstandard.ZstdDecompressor()
    def decode(data):
        if data is None:
            return ''
        if isinstance(data, str):
            return data
        parameters = zstandard.get_frame_parameters(data)
        selected = empty if parameters.dict_id == 0 else dictionaries.get(parameters.dict_id)
        if selected is None:
            raise ValueError('Missing line compression dictionary')
        if parameters.content_size > MAX_LINE_BYTES:
            raise ValueError('Line exceeds decompressed size limit')
        return selected.decompress(data, max_output_size=MAX_LINE_BYTES).decode('utf-8')
    return decode


def source_notice(source, versions, config):
    names = sorted({v['license'] for v in versions if v.get('license')})
    if not names:
        defaults = {'DictaToOtzaria': 'CC BY-SA 4.0', 'pninimToOtzaria': 'GNU FDL 1.3', 'ToratEmetToOtzaria': 'CC BY-NC-SA 2.5'}
        names = [defaults.get(source, 'לפי תנאי המקור והרשאת אוצריא')]
    return {'name': ' / '.join(names), 'url': 'https://github.com/Otzaria/otzaria-library/blob/main/README.md', 'attribution': config['attribution'] + ' מקור הספר: ' + source + '.'}


def source_label(key):
    return {'Sefaria': 'ספריא', 'DictaToOtzaria': 'דיקטה', 'wikisourceToOtzaria': 'ויקיטקסט', 'pninimToOtzaria': 'פנינים', 'ToratEmetToOtzaria': 'תורת אמת', 'Ben-YehudaToOtzaria': 'פרויקט בן יהודה', 'wikiJewishBooksToOtzaria': 'אוצר הספרים היהודי השיתופי', 'tashmaToOtzaria': 'תא שמע', 'MoreBooks': 'ספרים נוספים באוצריא', 'OnYourWayToOtzaria': 'ובלכתך בדרך', 'OraytaToOtzaria': 'אורייתא', 'National-LibraryToOtzaria': 'הספרייה הלאומית', 'KSK': 'כונס ספרים קטנים', 'yam-HaHachmaToOtzaria': 'ים החכמה', 'BeitAharonVeYisraelToOtzaria': 'מכון בית אהרן וישראל', 'Unknown': 'מאגר אוצריא'}.get(key, key)


def expand_banner(template, title):
    # Match the application's banner_title.dart: URL targets use an encoded
    # title; visible text uses the literal title. Keep the template separately.
    encoded = urllib.parse.quote(title, safe='.-*_')
    expanded = re.sub(r'\]\((https?://[^)]*)\)', lambda match: '](' + match.group(1).replace('{title}', encoded) + ')', template)
    return expanded.replace('{title}', title)


def export_links(connection, book_id, destination, tables=None):
    """Keep the graph and application suppression/range/anchor rules losslessly."""
    queries = [
        ('links', 'SELECT id,sourceLineId,targetBookId,targetLineId,connectionTypeId,targetLineIndex FROM link WHERE sourceBookId=? ORDER BY id'),
        ('ranges', 'SELECT r.linkId,r.side,r.endLineId,r.endLineIndex FROM link_range r JOIN link l ON l.id=r.linkId WHERE l.sourceBookId=? ORDER BY r.linkId,r.side'),
        ('anchors', 'SELECT a.linkId,a.side,a.charStart,a.charEnd,a.label FROM link_anchor a JOIN link l ON l.id=a.linkId WHERE l.sourceBookId=? ORDER BY a.linkId,a.side'),
        ('suppressed', 'SELECT s.linkId,s.side,s.reasonMask FROM link_suppressed_side s JOIN link l ON l.id=s.linkId WHERE l.sourceBookId=? ORDER BY s.linkId,s.side')
    ]
    count = 0
    with destination.open('w', encoding='utf-8') as target:
        target.write('{"schemaVersion":1,"columns":["id","sourceLineId","targetBookId","targetLineId","connectionTypeId","targetLineIndex"],"rangeColumns":["linkId","side","endLineId","endLineIndex"],"anchorColumns":["linkId","side","charStart","charEnd","label"],"suppressionColumns":["linkId","side","reasonMask"]')
        for key, query in queries:
            target.write(',"' + key + '":[')
            first = True
            table = {'links': 'link', 'ranges': 'link_range', 'anchors': 'link_anchor', 'suppressed': 'link_suppressed_side'}[key]
            rows = connection.execute(query, (book_id,)) if tables is None or (table in tables and 'link' in tables) else []
            for row in rows:
                if not first:
                    target.write(',')
                target.write(json.dumps(list(row), ensure_ascii=False, separators=(',', ':')))
                first = False
                if key == 'links':
                    count += 1
            target.write(']')
        target.write('}\n')
    return count


def export_edition(connection, decode, row, version, staging, metadata, release_date, old, split_content=True):
    """Mirror DatabaseLibraryProvider.getVersionLines exactly, including gaps."""
    identifier = metadata['id'] + '-v-' + str(version['id'])
    file = 'books/' + identifier + '.txt'
    digest = hashlib.sha256()
    length = 0
    with (staging / file).open('wb') as target:
        base_content = 'lc.content' if split_content else 'l.content'
        base_join = ' LEFT JOIN line_content lc ON lc.id=l.id' if split_content else ''
        query = 'SELECT l.heRef,' + base_content + ' AS baseContent,vl.lineId AS versionLineId,vl.content AS versionContent FROM line l' + base_join + ' LEFT JOIN version_line vl ON vl.versionId=? AND vl.lineId=l.id WHERE l.bookId=? ORDER BY l.lineIndex'
        for line in connection.execute(query, (version['id'], row['id'])):
            if line['heRef'] is None:
                content = decode(line['baseContent'])
            elif line['versionLineId'] is None or (not split_content and line['versionContent'] is None):
                content = ''
            else:
                content = decode(line['versionContent'] if line['versionContent'] is not None else line['baseContent'])
            data = (content.replace('\r\n', '\n').replace('\r', '\n').replace('\n', '<br>') + '\n').encode()
            target.write(data)
            digest.update(data)
            length += len(data)
    hash_value = digest.hexdigest()
    edition_title = version['heVersionTitle'] or version['versionTitle']
    edition = {**metadata, 'id': identifier, 'editionOf': metadata['id'], 'editionTitle': edition_title, 'upstreamVersionId': version['id'], 'title': row['title'] + ' · ' + edition_title, 'file': file, 'bytes': length, 'contentSha256': hash_value, 'versions': [version], 'updatedAt': old[identifier]['updatedAt'] if identifier in old and old[identifier]['contentSha256'] == hash_value else release_date}
    if version['license']:
        edition['license'] = {**metadata['license'], 'name': version['license']}
    return edition


def export_database(database, staging, config, profile, state, previous=None):
    from media_assets import export_media
    connection = open_database(database)
    try:
        schema = dict(connection.execute('SELECT key,value FROM schema_meta'))
        database_schema = int(schema.get('db_schema_version', 0))
        if not 5 <= database_schema <= config['databaseSchemaVersion']:
            raise ValueError('Database schema differs from the application version supported by this importer')
        selected_schema = state.get('archiveSelection', {}).get('schemaVersion')
        if selected_schema is not None and selected_schema != database_schema:
            raise ValueError('Downloaded database schema does not match selected application archive')
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        split_content = 'line_content' in tables
        rows = [dict(row) for row in connection.execute('SELECT * FROM book ORDER BY id')]
        if state.get('stats') and len(rows) != state['stats']['books']:
            raise ValueError('Database book count differs from official release statistics')
        if profile == 'starter':
            wanted = set(config['starterTitles'])
            rows = [row for row in rows if row['title'] in wanted]
            missing = wanted - {row['title'] for row in rows}
            if missing:
                raise ValueError('Starter titles missing from official database: ' + ', '.join(sorted(missing)))
        categories = {row['id']: dict(row) for row in connection.execute('SELECT * FROM category')}
        sources = dict(connection.execute('SELECT id,name FROM source'))
        authors = collections.defaultdict(list)
        for row in connection.execute('SELECT ba.bookId,a.name FROM book_author ba JOIN author a ON a.id=ba.authorId ORDER BY a.id') if {'book_author', 'author'} <= tables else []:
            authors[row['bookId']].append(row['name'])
        versions = collections.defaultdict(list)
        for row in connection.execute('SELECT * FROM book_version ORDER BY bookId,priority DESC,id') if 'book_version' in tables else []:
            version = dict(row)
            if version['hasContent']:
                version['editionBookId'] = 'b-' + str(version['bookId']) + '-v-' + str(version['id'])
            versions[row['bookId']].append(version)
        banners = collections.defaultdict(list)
        for row in connection.execute('SELECT bb.bookId,b.text FROM book_banner bb JOIN banner b ON b.id=bb.bannerId') if {'book_banner', 'banner'} <= tables else []:
            banners[row['bookId']].append(row['text'])
        protections = dict(connection.execute('SELECT bookId,level FROM book_protection')) if 'book_protection' in tables else {}
        decode = decoder(connection)
        old = {book['id']: book for book in (previous or {}).get('books', [])}
        (staging / 'books').mkdir(parents=True, exist_ok=True)
        (staging / 'lines').mkdir(parents=True, exist_ok=True)
        (staging / 'links').mkdir(parents=True, exist_ok=True)
        output = []
        total_lines = 0
        total_notes = 0
        total_bytes = 0
        total_links = 0
        edition_count = 0
        release_date = state['release']['published_at']
        for index, row in enumerate(rows):
            book_id = 'b-' + str(row['id'])
            notes = collections.defaultdict(list)
            for note in connection.execute('SELECT n.* FROM line_note n JOIN line l ON l.id=n.lineId WHERE l.bookId=? ORDER BY l.lineIndex,n.noteIndex', (row['id'],)) if 'line_note' in tables else []:
                notes[note['lineId']].append((note['noteIndex'], decode(note['body'])))
            content_hash = hashlib.sha256()
            length = 0
            line_count = 0
            line_ids = []
            with (staging / 'books' / (book_id + '.txt')).open('wb') as target:
                line_query = 'SELECT l.id,l.lineIndex,l.heRef,lc.content FROM line l JOIN line_content lc ON lc.id=l.id WHERE l.bookId=? ORDER BY l.lineIndex' if split_content else 'SELECT l.id,l.lineIndex,l.heRef,l.content FROM line l WHERE l.bookId=? ORDER BY l.lineIndex'
                for line in connection.execute(line_query, (row['id'],)):
                    if line['lineIndex'] != line_count:
                        raise ValueError('Non-contiguous source line indices: ' + book_id)
                    line_ids.append(line['id'])
                    content = decode(line['content']).replace('\r\n', '\n').replace('\r', '\n').replace('\n', '<br>')
                    for note_index, body in notes.get(line['id'], []):
                        content += ' <small>[' + str(note_index + 1) + '] ' + body.replace('\n', '<br>') + '</small>'
                        total_notes += 1
                    data = (content + '\n').encode()
                    target.write(data)
                    content_hash.update(data)
                    length += len(data)
                    line_count += 1
                if line_count == 0:
                    data = ('<h1>' + html.escape(row['title']) + '</h1>\n').encode()
                    target.write(data)
                    content_hash.update(data)
                    length += len(data)
            if line_count != row['totalLines']:
                raise ValueError('Decoded line count differs from canonical book metadata: ' + book_id)
            value = content_hash.hexdigest()
            line_ids_file = 'lines/' + book_id + '.json'
            (staging / line_ids_file).write_text(json.dumps(line_ids, separators=(',', ':')) + '\n', encoding='utf-8')
            links_file = 'links/' + book_id + '.json'
            link_count = export_links(connection, row['id'], staging / links_file, tables)
            total_links += link_count
            source_name = sources.get(row['sourceId'], 'Unknown')
            metadata = {'id': book_id, 'upstreamId': row['id'], 'title': row['title'], 'author': ', '.join(authors[row['id']]), 'authors': authors[row['id']], 'categories': category_path(categories, row['categoryId']), 'description': row['heShortDesc'] or row['heDesc'] or '', 'sourceId': 'otzaria-database', 'sourceName': source_name, 'sourcePath': 'book/' + str(row['id']), 'sourceUrl': state['release']['html_url'], 'rawUrl': state['release']['html_url'], 'contentSha256': value, 'upstreamContentHash': str(row['contentHash']), 'license': source_notice(source_name, versions[row['id']], config), 'versions': versions[row['id']], 'banners': banners[row['id']], 'file': 'books/' + book_id + '.txt', 'bytes': length, 'sourceLineCount': line_count, 'updatedAt': old[book_id]['updatedAt'] if book_id in old and old[book_id]['contentSha256'] == value else release_date}
            metadata.update({'sourceName': source_label(source_name), 'sourceKey': source_name, 'lineIdsFile': line_ids_file, 'lineIdsSha256': digest_file(staging / line_ids_file), 'linksFile': links_file, 'linksSha256': digest_file(staging / links_file), 'linkCount': link_count})
            metadata.update({'protectionLevel': protections.get(row['id'], 0), 'rawBanners': banners[row['id']], 'banners': [expand_banner(template, row['title']) for template in banners[row['id']]]})
            output.append(metadata)
            for version in versions[row['id']]:
                if version['hasContent']:
                    edition = export_edition(connection, decode, row, version, staging, metadata, release_date, old, split_content)
                    output.append(edition)
                    total_bytes += edition['bytes']
                    edition_count += 1
            total_lines += line_count
            total_bytes += length
            if (index + 1) % 500 == 0:
                print(f'Imported {index + 1}/{len(rows)} books', file=sys.stderr, flush=True)
        total_books = connection.execute('SELECT count(*) FROM book').fetchone()[0]
        if profile == 'full' and state.get('stats') and total_lines != state['stats']['lines']:
            raise ValueError('Full export line count differs from official release statistics')
        if profile == 'full' and state.get('stats') and total_links != state['stats']['links']:
            raise ValueError('Full export link count differs from official release statistics')
        catalog = {'schemaVersion': 1, 'exporterVersion': EXPORTER_VERSION, 'profile': profile, 'generatedAt': now(), 'configSha256': hashlib.sha256(json_bytes(config)).hexdigest(), 'sources': [{'id': 'otzaria-database', 'name': 'ספריית אוצריא הרשמית', 'repository': config['repository'], 'release': state['release']['tag_name'], 'commit': state['release']['target_commitish'], 'publishedAt': release_date, 'checkedAt': state['checkedAt'], 'databaseVersion': int(schema['db_version']), 'databaseSchemaVersion': int(schema['db_schema_version']), 'archiveSha256': state['manifest']['sha256'], 'manifestSha256': state['manifestSha256'], 'libraryCommit': state['provenance'].get('otzaria_target_commit'), 'libraryHead': state.get('libraryHead'), 'licenseUrl': 'https://github.com/Otzaria/otzaria-library/blob/main/README.md'}], 'books': output, 'counts': {'discovered': total_books, 'published': len(output), 'excluded': total_books-len(output), 'lines': total_lines, 'notes': total_notes, 'sourceBytes': total_bytes}, 'scope': {'complete': profile == 'full', 'description': 'כל הספרים והטקסט הראשי במסד הנתונים הרשמי של תוכנת אוצריא.' if profile == 'full' else 'אוסף פיתוח של ספרים מלאים מהמסד הרשמי. בפריסה המלאה נכללים כל ספרי המסד.', 'content': 'Base text and inline notes from the official application database; edition metadata and source notices are preserved. Alternate version text, inter-book links and the separately installed external PDF catalog are not exported by this adapter.'}, 'upstreamStatus': {'releaseTag': state['release']['tag_name'], 'publishedAt': release_date, 'unreleasedSourceChanges': state.get('libraryHead') != state['provenance'].get('otzaria_target_commit')}}
        catalog['counts'].update({'baseBooks': len(rows), 'editionBooks': edition_count, 'links': total_links, 'excluded': total_books-len(rows)})
        catalog['connectionTypes'] = {str(row[0]): row[1] for row in connection.execute('SELECT id,name FROM connection_type ORDER BY id')} if 'connection_type' in tables else {}
        catalog['scope']['content'] = 'All canonical application books, primary text, inline notes, available alternate edition texts, edition metadata, source notices and outgoing links with range/anchor/suppression metadata. Companion Talmud PDFs are imported separately. The optional external PDF-provider catalog and lexical search databases are separate application downloads.'
        if profile == 'full':
            catalog['scope']['description'] = 'כל הספרים, המהדורות הזמינות וקישורי המקורות במסד הנתונים הרשמי של תוכנת אוצריא.'
        catalog['media'] = export_media(staging, output)
        catalog['scope']['content'] += ' Embedded raster images are preserved as content-addressed static media; original missing image sources are explicitly reported.'
        (staging / 'catalog.json').write_bytes(json_bytes(catalog))
        (staging / 'provenance.json').write_bytes(json_bytes({'release': {k: state['release'][k] for k in ['tag_name', 'html_url', 'published_at', 'target_commitish']}, 'archiveManifest': state['manifest'], 'buildProvenance': state['provenance'], 'officialStats': state.get('stats', {})}))
        return catalog
    finally:
        connection.close()


def validate_snapshot(directory):
    catalog = load_json(directory / 'catalog.json')
    if catalog.get('schemaVersion') != 1 or not catalog.get('books'):
        raise ValueError('Invalid or empty catalog')
    seen = set()
    checked_sidecars = set()
    for book in catalog['books']:
        if not re.fullmatch(r'b-\d+(?:-v-\d+)?', book['id']) or book['id'] in seen:
            raise ValueError('Invalid or duplicate book ID')
        seen.add(book['id'])
        if book['file'] != 'books/' + book['id'] + '.txt':
            raise ValueError('Unsafe book path')
        if digest_file(safe_path(directory, book['file'])) != book['contentSha256']:
            raise ValueError('Snapshot file checksum mismatch: ' + book['id'])
        for field, checksum in [('lineIdsFile', 'lineIdsSha256'), ('linksFile', 'linksSha256')]:
            path = book.get(field)
            if path and path not in checked_sidecars:
                if digest_file(safe_path(directory, path)) != book[checksum]:
                    raise ValueError('Snapshot sidecar checksum mismatch: ' + path)
                checked_sidecars.add(path)
    if catalog.get('media'):
        media_path = safe_path(directory, catalog['media']['file'])
        if digest_file(media_path) != catalog['media']['sha256']:
            raise ValueError('Media manifest checksum mismatch')
        checked_media = set()
        for image in load_json(media_path)['images']:
            if image['file'] in checked_media:
                continue
            path = safe_path(directory, image['file'])
            if path.stat().st_size != image['bytes'] or digest_file(path) != image['sha256']:
                raise ValueError('Media image checksum mismatch: ' + image['file'])
            checked_media.add(image['file'])
    return catalog


def swap_snapshot(staging, output):
    backup = output.with_name(output.name + '.previous-' + uuid.uuid4().hex)
    existed = output.exists()
    if existed:
        output.rename(backup)
    try:
        staging.rename(output)
    except BaseException:
        if existed:
            backup.rename(output)
        raise
    if existed:
        shutil.rmtree(backup)


def write_active_archive_receipt(root, state):
    """Allow bounded cache retention without coupling it to public snapshots."""
    destination = root / '.cache/upstream/active-database-archives.json'
    destination.parent.mkdir(parents=True, exist_ok=True)
    receipt = {'files': [part['sha256'] + '.part' for part in state['manifest']['parts']], 'archiveSha256': state['manifest']['sha256']}
    temporary = destination.with_suffix('.partial-' + uuid.uuid4().hex)
    try:
        temporary.write_bytes(json_bytes(receipt))
        temporary.replace(destination)
    finally:
        temporary.unlink(missing_ok=True)


def run(args):
    root = Path(args.root).resolve()
    output = Path(args.output).resolve() if args.output else root / '.cache/library'
    config = load_json(root / 'config/sources.json')
    previous_path = output / 'catalog.json'
    previous = load_json(previous_path) if previous_path.exists() else None
    if args.offline:
        source = root / 'data/starter' if args.profile == 'starter' else output
        catalog = validate_snapshot(source)
        if catalog['profile'] != args.profile:
            raise ValueError('Offline snapshot profile mismatch')
        if source.resolve() != output.resolve():
            staging = output.with_name(output.name + '.next-' + uuid.uuid4().hex)
            output.parent.mkdir(parents=True, exist_ok=True)
            shutil.copytree(source, staging)
            swap_snapshot(staging, output)
        return {'profile': args.profile, 'offline': True, 'published': len(catalog['books']), 'output': str(output), 'changed': False}
    state = release_state(config)
    prior = (previous or {}).get('sources', [{}])[0]
    changed = not previous or previous.get('profile') != args.profile or previous.get('exporterVersion') != EXPORTER_VERSION or previous.get('configSha256') != hashlib.sha256(json_bytes(config)).hexdigest() or prior.get('manifestSha256') != state['manifestSha256']
    status = {'changed': changed, 'profile': args.profile, 'release': state['release']['tag_name'], 'databaseVersion': state['stats']['db_version'], 'upstreamBooks': state['stats']['books'], 'unreleasedSourceChanges': state['libraryHead'] != state['provenance'].get('otzaria_target_commit')}
    if args.check:
        return status
    if not changed:
        validate_snapshot(output)
        write_active_archive_receipt(root, state)
        return {**status, 'published': len(previous['books']), 'output': str(output)}
    database = database_file(root, state)
    staging = output.with_name(output.name + '.next-' + uuid.uuid4().hex)
    staging.mkdir(parents=True)
    try:
        catalog = export_database(database, staging, config, args.profile, state, previous)
        validate_snapshot(staging)
        swap_snapshot(staging, output)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    write_active_archive_receipt(root, state)
    return {**status, **catalog['counts'], 'output': str(output)}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', required=True)
    parser.add_argument('--output')
    parser.add_argument('--profile', choices=['starter', 'full'], default='full')
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
