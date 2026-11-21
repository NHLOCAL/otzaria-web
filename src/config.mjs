import path from 'node:path';

export const ROOT = path.resolve(import.meta.dirname, '..');

export function normalizeBase(value = '/') {
  if (/[?#\\\\\s]/u.test(value) || value.includes('..') || value.includes('//')) {
    throw new Error('BASE_PATH must be an absolute URL path without a host, query, fragment, whitespace, or ..');
  }
  const clean = value.replace(/^\/+|\/+$/g, '');
  return clean ? `/${clean}/` : '/';
}

export function getConfig(env = process.env) {
  const origin = new URL(env.SITE_URL || 'https://nhlocal.github.io');
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('SITE_URL must be an http(s) origin, e.g. https://library.otzaria.org. Set any path using BASE_PATH.');
  }
  const basePath = normalizeBase(env.BASE_PATH ?? '/otzaria-web/');
  return {
    origin: origin.origin,
    basePath,
    siteUrl: `${origin.origin}${basePath}`,
    outputDir: path.resolve(ROOT, env.OUTPUT_DIR || 'dist'),
    sourceCatalog: env.SOURCE_CATALOG ? path.resolve(ROOT, env.SOURCE_CATALOG) : null,
    targetSectionBytes: Number(env.SECTION_BYTES || 120_000),
    profile: env.LIBRARY_PROFILE || 'starter',
  };
}

export function sitePath(base, relative = '') {
  return `${normalizeBase(base)}${relative.replace(/^\/+/, '')}`;
}

export function absoluteUrl(config, relative = '') {
  return `${config.origin}${sitePath(config.basePath, relative)}`;
}

export function safeId(value) {
  if (!/^[a-z0-9][a-z0-9_-]{0,95}$/.test(value)) throw new Error(`Unsafe public identifier: ${String(value).slice(0,100)}`);
  return value;
}
