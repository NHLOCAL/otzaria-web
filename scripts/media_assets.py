"""Preserve the raster images embedded in the official application's HTML.

Source text remains byte-for-byte unchanged. The renderer resolves decoded HTML
src attributes by their SHA-256, so large data URIs need not be copied to every
HTML page or to the manifest. Only validated passive raster formats are emitted.
"""
from __future__ import annotations
import base64
import collections
import hashlib
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import struct

MAX_IMAGE_BYTES = 16 * 1024 * 1024
IMAGE_TAG = re.compile(r'<(?:img|svg|math)\b', re.IGNORECASE)
DATA_IMAGE = re.compile(r'^data:(image/(?:png|jpeg|jpg|gif|webp));base64,(.*)$', re.IGNORECASE | re.DOTALL)


def raster_info(data, declared_mime):
    """Check format signatures and read dimensions without executing a decoder."""
    mime = declared_mime.lower().replace('image/jpg', 'image/jpeg')
    if data.startswith(b'\x89PNG\r\n\x1a\n') and len(data) >= 33 and data[12:16] == b'IHDR':
        mime = 'image/png'
        width, height = struct.unpack('>II', data[16:24])
        extension = 'png'
    elif data.startswith(b'\xff\xd8\xff'):
        mime = 'image/jpeg'
        offset = 2
        width = height = 0
        while offset + 3 < len(data):
            if data[offset] != 0xff:
                raise ValueError('Invalid JPEG segment')
            while offset < len(data) and data[offset] == 0xff:
                offset += 1
            if offset >= len(data):
                break
            marker = data[offset]
            offset += 1
            if marker in (0x01, *range(0xd0, 0xda)):
                continue
            if marker in (0xda, 0xd9) or offset + 2 > len(data):
                break
            length = int.from_bytes(data[offset:offset + 2], 'big')
            if length < 2 or offset + length > len(data):
                raise ValueError('Truncated JPEG segment')
            if marker in (0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf):
                if length < 7:
                    raise ValueError('Invalid JPEG dimensions')
                height, width = struct.unpack('>HH', data[offset + 3:offset + 7])
                break
            offset += length
        extension = 'jpg'
    elif data[:6] in (b'GIF87a', b'GIF89a') and len(data) >= 13:
        mime = 'image/gif'
        width, height = struct.unpack('<HH', data[6:10])
        extension = 'gif'
    elif len(data) >= 30 and data[:4] == b'RIFF' and data[8:12] == b'WEBP':
        mime = 'image/webp'
        # Dimensions are optional metadata; browsers read other WebP variants.
        width = height = None
        if data[12:16] == b'VP8X':
            width = 1 + int.from_bytes(data[24:27], 'little')
            height = 1 + int.from_bytes(data[27:30], 'little')
        extension = 'webp'
    else:
        raise ValueError('Embedded image bytes do not match their passive raster MIME type')
    if width is not None and (width <= 0 or height <= 0):
        raise ValueError('Invalid raster image dimensions')
    return mime, extension, width, height


class ImageParser(HTMLParser):
    def __init__(self, collector, book_id):
        super().__init__(convert_charrefs=True)
        self.collector = collector
        self.book_id = book_id

    def handle_starttag(self, tag, attributes):
        if tag in ('svg', 'math'):
            raise ValueError('Unsupported canonical visual markup in ' + self.book_id + ': ' + tag + '; add a safe renderer before publishing this release')
        if tag == 'img':
            # The HTML standard keeps the first duplicate attribute.
            attrs = {}
            for key, value in attributes:
                attrs.setdefault(key, value)
            self.collector.add(self.book_id, attrs)

    def handle_startendtag(self, tag, attributes):
        self.handle_starttag(tag, attributes)


class MediaCollector:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.sources = {}
        self.files = {}
        self.missing = collections.Counter()
        self.books = set()
        self.instances = 0
        self.embedded = 0

    def add(self, book_id, attrs):
        self.instances += 1
        self.books.add(book_id)
        source = attrs.get('src')
        if source is None or not source.strip():
            reason = 'missing-src' if source is None else 'empty-src'
            self.missing[(book_id, reason)] += 1
            return
        source_hash = hashlib.sha256(source.encode('utf-8')).hexdigest()
        self.embedded += 1
        if source_hash in self.sources:
            return
        match = DATA_IMAGE.fullmatch(source.strip())
        if not match:
            # Do not guess an unrelated asset or silently fetch arbitrary URLs.
            raise ValueError('Unsupported canonical image source in ' + book_id + ': ' + source[:70])
        payload = re.sub(r'\s+', '', match.group(2))
        if len(payload) > 4 * ((MAX_IMAGE_BYTES + 2) // 3):
            raise ValueError('Embedded image exceeds the source line size limit')
        data = base64.b64decode(payload, validate=True)
        mime, extension, width, height = raster_info(data, match.group(1))
        digest = hashlib.sha256(data).hexdigest()
        filename = digest + '.' + extension
        if filename not in self.files:
            (self.directory / filename).write_bytes(data)
            self.files[filename] = len(data)
        record = {'sourceHash': source_hash, 'sha256': digest, 'file': 'media/' + filename, 'mime': mime, 'bytes': len(data)}
        if mime != match.group(1).lower().replace('image/jpg', 'image/jpeg'):
            record['declaredMime'] = match.group(1).lower()
        if width is not None:
            record.update({'width': width, 'height': height})
        self.sources[source_hash] = record

    def collect(self, path, book_id):
        text = Path(path).read_text(encoding='utf-8')
        if IMAGE_TAG.search(text):
            parser = ImageParser(self, book_id)
            parser.feed(text)
            parser.close()

    def finish(self):
        catalog = {
            'schemaVersion': 1,
            'images': sorted(self.sources.values(), key=lambda item: item['sourceHash']),
            'counts': {'imageTags': self.instances, 'booksWithImages': len(self.books), 'embeddedInstances': self.embedded, 'uniqueSources': len(self.sources), 'files': len(self.files), 'bytes': sum(self.files.values()), 'missingUpstream': sum(self.missing.values()), 'correctedMimeTypes': sum('declaredMime' in image for image in self.sources.values())},
            'missing': [{'bookId': key[0], 'reason': key[1], 'count': count} for key, count in sorted(self.missing.items())],
            'sourcePolicy': 'Embedded raster image data from the canonical application database. Missing source attributes are retained as reported upstream gaps. No external asset is guessed or fetched.'
        }
        data = (json.dumps(catalog, ensure_ascii=False, indent=2) + '\n').encode()
        (self.directory / 'catalog.json').write_bytes(data)
        return {'file': 'media/catalog.json', 'sha256': hashlib.sha256(data).hexdigest(), 'counts': catalog['counts']}


def export_media(directory, books):
    collector = MediaCollector(Path(directory) / 'media')
    for book in books:
        collector.collect(Path(directory) / book['file'], book['id'])
    return collector.finish()
