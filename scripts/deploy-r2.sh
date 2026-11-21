#!/usr/bin/env bash
set -euo pipefail

# Credentials are supplied through RCLONE_CONFIG_R2_* environment variables.
# Only a dedicated, empty destination or one already marked for this repo is used.
: "${R2_BUCKET:?R2_BUCKET is required}"
if [[ ! "$R2_BUCKET" =~ ^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$ ]]; then
  echo 'Invalid R2 bucket name.' >&2
  exit 1
fi
OTZARIA_PREFIX="${R2_PREFIX:-}"
if [[ ! "$OTZARIA_PREFIX" =~ ^[A-Za-z0-9/_-]*$ ]]; then
  echo 'R2_PREFIX may contain only letters, digits, slashes, underscores and hyphens.' >&2
  exit 1
fi
OTZARIA_PREFIX="${OTZARIA_PREFIX#/}"
OTZARIA_PREFIX="${OTZARIA_PREFIX%/}"
OTZARIA_DEST="r2:${R2_BUCKET}${OTZARIA_PREFIX:+/${OTZARIA_PREFIX}}"
OTZARIA_OUT="${OUTPUT_DIR:-dist}"
test -s "$OTZARIA_OUT/index.html"
test -s "$OTZARIA_OUT/build-manifest.json"
export OTZARIA_PREFIX
node --input-type=module - "$OTZARIA_OUT/build-manifest.json" <<'NODE'
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const prefix = (manifest.basePath || '/').replace(/^\/+|\/+$/g, '');
if (prefix !== process.env.OTZARIA_PREFIX) throw new Error('R2_PREFIX must match the BASE_PATH used to build the site.');
if (manifest.search?.status !== 'ready') throw new Error('Refusing to deploy a site whose search index is not ready.');
NODE
OTZARIA_TEMP="$(mktemp -d)"
trap 'rm -rf "$OTZARIA_TEMP"' EXIT
export OTZARIA_REPOSITORY="${GITHUB_REPOSITORY:-NHLOCAL/otzaria-web}"

if rclone cat "$OTZARIA_DEST/.otzaria-managed.json" > "$OTZARIA_TEMP/owner.json" 2>/dev/null; then
  node --input-type=module - "$OTZARIA_TEMP/owner.json" <<'NODE'
import { readFileSync } from 'node:fs';
const owner = JSON.parse(readFileSync(process.argv[2], 'utf8'));
if (owner.repository !== process.env.OTZARIA_REPOSITORY) throw new Error('R2 destination belongs to another project.');
NODE
else
  OTZARIA_EXISTING="$(rclone lsf "$OTZARIA_DEST" --max-depth 1)"
  if [[ -n "$OTZARIA_EXISTING" ]]; then
    echo 'Refusing to synchronize an unmarked nonempty destination. Use a dedicated empty R2 bucket or prefix.' >&2
    exit 1
  fi
  node --input-type=module - "$OTZARIA_TEMP/owner.json" <<'NODE'
import { writeFileSync } from 'node:fs';
writeFileSync(process.argv[2], JSON.stringify({ repository: process.env.OTZARIA_REPOSITORY, schemaVersion: 1 }) + '\n');
NODE
  rclone copyto "$OTZARIA_TEMP/owner.json" "$OTZARIA_DEST/.otzaria-managed.json" --checksum
fi

# Publish discovery and search bootstrap files only after their referenced content.
cat > "$OTZARIA_TEMP/entrypoints.txt" <<'RULES'
/*.html
/catalog/**
/categories/**
/books/**/index.html
/books/**/book.json
/catalog.json
/pdfs/catalog.json
/media/catalog.json
/connection-types.json
/sources.json
/search-manifest.json
/llms*.txt
/robots.txt
/sitemap*.xml
/sitemaps/**
/pagefind/pagefind-entry.json
/pagefind/pagefind.js
/pagefind/pagefind-ui.js
/pagefind/pagefind-ui.css
/pagefind/**/pagefind-entry.json
/pagefind/**/pagefind.js
/pagefind/**/pagefind-ui.js
/pagefind/**/pagefind-ui.css
RULES

OTZARIA_FLAGS=(--checksum --fast-list --transfers 16 --checkers 32 --retries 3 --stats 30s --metadata-set 'cache-control=public,max-age=300')
rclone copy "$OTZARIA_OUT" "$OTZARIA_DEST" "${OTZARIA_FLAGS[@]}" --exclude-from "$OTZARIA_TEMP/entrypoints.txt" --exclude '/build-manifest.json' --exclude '/_headers' --exclude '/.nojekyll'
rclone copy "$OTZARIA_OUT" "$OTZARIA_DEST" "${OTZARIA_FLAGS[@]}" --include-from "$OTZARIA_TEMP/entrypoints.txt"

# Delete removed content only after successful publication. Keep historical
# Pagefind fragments so a browser with a cached search bootstrap still works.
rclone sync "$OTZARIA_OUT" "$OTZARIA_DEST" "${OTZARIA_FLAGS[@]}" --delete-after --exclude '/pagefind/**' --exclude '/build-manifest.json' --exclude '/.otzaria-managed.json' --exclude '/_headers' --exclude '/.nojekyll'

# This is also the scheduled preflight's completion marker. Never replace it
# before every content/discovery upload and removal above has succeeded.
rclone copyto "$OTZARIA_OUT/build-manifest.json" "$OTZARIA_DEST/build-manifest.json" "${OTZARIA_FLAGS[@]}"
echo 'R2 object publication completed. Historical Pagefind fragments were retained.'
if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
  echo 'R2 publication completed after synchronization, build, search indexing and verification. Entry points were uploaded after content; obsolete reading pages were removed afterwards.' >> "$GITHUB_STEP_SUMMARY"
fi
