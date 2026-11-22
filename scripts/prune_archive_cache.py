#!/usr/bin/env python3
"""Bound expendable compressed archive cache, preferring the verified current release."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re


DEFAULT_BUDGET = 5 * 1024 * 1024 * 1024
ARCHIVE_NAME = re.compile(r'[a-f0-9]{64}(?:\.part|\.tar\.zst)')


def retained_archives(entries, active, budget):
    """Plan retention without deleting files; current files have first priority."""
    if not isinstance(budget, int) or budget < 0:
        raise ValueError('Archive cache budget must be a nonnegative integer')
    retained = set()
    used = 0
    for entry in sorted(entries, key=lambda item: (item['name'] not in active, -item['mtime'], item['name'])):
        if entry['bytes'] < 0:
            raise ValueError('Invalid cached archive size')
        if used + entry['bytes'] <= budget:
            retained.add(entry['name'])
            used += entry['bytes']
    return retained


def current_archives(root):
    active = set()
    receipt = root / '.cache/upstream/active-database-archives.json'
    if receipt.exists():
        data = json.loads(receipt.read_text(encoding='utf-8'))
        if not isinstance(data, dict) or not isinstance(data.get('files'), list):
            raise ValueError('Invalid current database archive receipt')
        for name in data['files']:
            if not isinstance(name, str) or not re.fullmatch(r'[a-f0-9]{64}\.part', name):
                raise ValueError('Invalid archive filename in database receipt')
            active.add(name)
    companion = root / '.cache/companions/catalog.json'
    if companion.exists():
        digest = json.loads(companion.read_text(encoding='utf-8')).get('source', {}).get('archiveSha256')
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('Invalid companion archive digest')
        active.add(digest + '.tar.zst')
    external = root / '.cache/external/catalog.json'
    if external.exists():
        digest = json.loads(external.read_text(encoding='utf-8')).get('source', {}).get('archiveSha256')
        if not isinstance(digest, str) or not re.fullmatch('[a-f0-9]{64}', digest):
            raise ValueError('Invalid external catalog archive digest')
        active.add(digest + '.part')
    return active


def prune(root, budget=DEFAULT_BUDGET):
    root = root.resolve()
    directory = root / '.cache/upstream/archives'
    if not directory.exists():
        return {'keptFiles': 0, 'keptBytes': 0, 'removedFiles': 0, 'removedBytes': 0, 'currentFilesNotCached': 0, 'budgetBytes': budget}
    if not directory.resolve().is_relative_to(root) or directory.is_symlink():
        raise ValueError('Archive cache must remain inside the project directory')
    active = current_archives(root)
    entries = []
    for file in directory.iterdir():
        # Only content-addressed compressed cache files belong to this cleanup.
        # Imported snapshots, source databases, unknown files and links are not touched.
        if file.is_symlink() or not file.is_file() or not ARCHIVE_NAME.fullmatch(file.name):
            continue
        stat = file.stat()
        entries.append({'name': file.name, 'bytes': stat.st_size, 'mtime': stat.st_mtime_ns})
    kept = retained_archives(entries, active, budget)
    removed = [entry for entry in entries if entry['name'] not in kept]
    for entry in removed:
        (directory / entry['name']).unlink()
    return {
        'keptFiles': len(kept), 'keptBytes': sum(entry['bytes'] for entry in entries if entry['name'] in kept),
        'removedFiles': len(removed), 'removedBytes': sum(entry['bytes'] for entry in removed),
        'currentFilesNotCached': len(active - kept), 'budgetBytes': budget,
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--root', default=str(Path(__file__).resolve().parents[1]))
    parser.add_argument('--max-bytes', type=int, default=DEFAULT_BUDGET)
    args = parser.parse_args()
    result = prune(Path(args.root), args.max_bytes)
    print(json.dumps(result))
    if os.environ.get('GITHUB_STEP_SUMMARY'):
        with open(os.environ['GITHUB_STEP_SUMMARY'], 'a', encoding='utf-8') as summary:
            summary.write(f"Compressed archive cache: {result['keptBytes']} bytes retained; {result['removedBytes']} expendable bytes removed.\n")
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
