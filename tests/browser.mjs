/**
 * Browser integration smoke for the built static site.
 * Run after npm run build and npx playwright install --with-deps chromium.
 * Intended for CI too: no external accounts, APIs, or running server required.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect } from '@playwright/test';
import { ROOT, getConfig } from '../src/config.mjs';

const config = getConfig();
const resultDir = path.join(ROOT, '.cache/browser-results');
const screenshotDir = path.join(ROOT, '.cache/browser-screenshots');
await fs.mkdir(resultDir, { recursive: true });
await fs.mkdir(screenshotDir, { recursive: true });

const port = Number(process.env.BROWSER_TEST_PORT || 4175);
assert(Number.isInteger(port) && port > 0 && port < 65536, 'Invalid BROWSER_TEST_PORT');
const origin = `http://127.0.0.1:${port}`;
const localUrl = relative => new URL(`${config.basePath}${relative.replace(/^\/+/, '')}`, origin).href;
const normalize = value => String(value).normalize('NFKD').replace(/[\u0591-\u05bd\u05bf-\u05c7]/g, '').replace(/\s+/g, ' ').trim();
const report = { startedAt: new Date().toISOString(), origin, basePath: config.basePath, viewports: { desktop: { width: 1488, height: 1056 }, mobile: { width: 390, height: 844 } }, steps: [], screenshots: [], console: [], pageErrors: [], networkFailures: [] };
const expectUI = expect.configure({ timeout: 20_000 });
let serverLog = '';
let serverError;
let browser;
let activePage;
let failure;
const server = spawn(process.execPath, ['scripts/serve.mjs'], { cwd: ROOT, env: { ...process.env, PORT: String(port) }, stdio: ['ignore', 'pipe', 'pipe'] });
server.stdout.on('data', chunk => { serverLog = `${serverLog}${chunk}`.slice(-12_000); });
server.stderr.on('data', chunk => { serverLog = `${serverLog}${chunk}`.slice(-12_000); });
server.on('error', error => { serverError = error; });

function monitor(page, label) {
  page.on('console', message => {
    if (['warning', 'warn', 'error'].includes(message.type())) report.console.push({ page: label, type: message.type(), text: message.text(), location: message.location() });
  });
  page.on('pageerror', error => report.pageErrors.push({ page: label, message: error.message, stack: error.stack }));
  page.on('requestfailed', request => {
    const error = request.failure()?.errorText || 'unknown';
    // Navigation cancels requests from the old document by design.
    if (!error.includes('ERR_ABORTED')) report.networkFailures.push({ page: label, url: request.url(), error });
  });
  page.on('response', response => {
    if (response.url().startsWith(origin) && response.status() >= 400) report.networkFailures.push({ page: label, url: response.url(), status: response.status() });
  });
}

async function screenshot(name, page = activePage, { fullPage = false } = {}) {
  if (!page || page.isClosed()) return;
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(screenshotDir, filename), fullPage, animations: 'disabled' });
  report.screenshots.push({ name, file: `.cache/browser-screenshots/${filename}`, url: page.url(), viewport: page.viewportSize(), fullPage });
}

async function step(name, run) {
  const start = Date.now();
  try {
    const details = await run();
    report.steps.push({ name, status: 'passed', milliseconds: Date.now() - start, ...(details ? { details } : {}) });
    console.log(`PASS ${name}`);
  } catch (error) {
    report.steps.push({ name, status: 'failed', milliseconds: Date.now() - start, message: error.message });
    await screenshot(`failure-${String(report.steps.length).padStart(2, '0')}`).catch(() => {});
    if (activePage && !activePage.isClosed()) await fs.writeFile(path.join(resultDir, 'failure-page.html'), await activePage.content()).catch(() => {});
    throw error;
  }
}

async function readyPage(page) {
  await page.waitForLoadState('networkidle');
  await page.evaluate(async () => { await document.fonts.ready; });
}

async function noOverflow(page) {
  const size = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
  assert(size.document <= size.viewport + 1, `Horizontal overflow: document ${size.document}px, viewport ${size.viewport}px`);
  return size;
}

async function settledSearch(page) {
  await expectUI(page.locator('[data-search-status]')).toContainText('נמצאו');
  await expectUI(page.locator('[data-search-region]')).not.toHaveAttribute('aria-busy', 'true');
  await expectUI(page.locator('.search-result h2 a').first()).toBeVisible();
}

function checkResultHref(href) {
  const url = new URL(href, origin);
  assert.equal(url.origin, origin, 'Search result leaves the current static host');
  assert(url.pathname.startsWith(`${config.basePath}books/`), `Search result has the wrong base path: ${url.pathname}`);
  assert(url.pathname.endsWith('.html'), 'Search result must be a real static HTML file');
  const doubledBase = config.basePath === '/' ? null : `${config.basePath}${config.basePath.slice(1)}`;
  assert(!doubledBase || !url.pathname.includes(doubledBase), `Duplicated base path: ${url.pathname}`);
  return url.pathname;
}

async function readBuiltJson(href) {
  const url = new URL(href, origin);
  assert.equal(url.origin, origin, 'Metadata file leaves the current static host');
  assert(url.pathname.startsWith(config.basePath), 'Metadata file has the wrong base path');
  return JSON.parse(await fs.readFile(path.join(config.outputDir, url.pathname.slice(config.basePath.length)), 'utf8'));
}

try {
  await step('Preview server serves actual built HTML', async () => {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      if (serverError) throw serverError;
      if (server.exitCode !== null) throw new Error(`Preview server exited with ${server.exitCode}: ${serverLog}`);
      try {
        const response = await fetch(localUrl('index.html'));
        if (response.ok && (await response.text()).includes('<html lang="he" dir="rtl">')) return { url: localUrl('index.html') };
      } catch { /* Wait for the spawned server, not an arbitrary fixed sleep. */ }
      await delay(150);
    }
    throw new Error(`Preview server did not become ready: ${serverLog}`);
  });

  const catalog = JSON.parse(await fs.readFile(path.join(config.outputDir, 'catalog.json'), 'utf8'));
  const genesis = catalog.books.find(book => book.id === 'b-1' || book.title === 'בראשית');
  assert(genesis, 'The smoke corpus must include Genesis');
  const genesisMetadata = JSON.parse(await fs.readFile(path.join(config.outputDir, 'books', genesis.id, 'book.json'), 'utf8'));
  const genesisIds = new Set([genesis.id, ...(genesisMetadata.editions || []).map(edition => edition.id)]);
  const isGenesis = pathname => genesisIds.has(pathname.split('/books/')[1]?.split('/')[0]);
  const firstSection = genesisMetadata.sections[0];
  const firstReading = new URL(firstSection.url, origin).href;
  const bookUrl = new URL(genesis.url, origin).href;
  const externalCatalog = await readBuiltJson(localUrl('external/catalog.json'));
  const hebrewBooks = externalCatalog.providers.find(provider => provider.id === 'hebrewbooks');
  const otzar = externalCatalog.providers.find(provider => provider.id === 'otzar');
  assert(hebrewBooks && otzar, 'The smoke corpus must contain both external providers');
  let externalGenesis;
  for (const entry of hebrewBooks.pages) {
    const records = (await readBuiltJson(entry.url)).records;
    externalGenesis = records.find(record => record.localBooks?.some(book => book.id === genesis.id));
    if (externalGenesis) break;
  }
  assert(externalGenesis, 'The actual external fixture needs a verified mapping to Genesis');
  const authorRecord = (await readBuiltJson(otzar.pages[0].url)).records.find(record => record.authors?.length);
  assert(authorRecord, 'The actual external fixture needs an author query');

  browser = await chromium.launch({ headless: true });
  const desktop = await browser.newContext({ viewport: report.viewports.desktop, locale: 'he-IL', reducedMotion: 'reduce' });
  const page = await desktop.newPage(); activePage = page; monitor(page, 'desktop');
  page.setDefaultTimeout(20_000);

  await step('Desktop home, fonts, semantic content, and layout', async () => {
    await page.goto(localUrl('index.html'), { waitUntil: 'networkidle' });
    await readyPage(page);
    await expectUI(page).toHaveTitle(/אוצריא/);
    await expectUI(page.getByRole('heading', { name: 'כל ספר פותח עולם.' })).toBeVisible();
    await expectUI(page.locator('.book-row').first()).toBeVisible();
    assert(await page.locator('.book-row').count() > 0, 'Catalogue preview is empty');
    const fonts = await page.evaluate(() => ({ ui: document.fonts.check('16px Heebo'), reading: document.fonts.check('24px "Frank Ruhl Libre"') }));
    assert(fonts.ui && fonts.reading, 'A self-hosted Hebrew font did not load');
    const sizing = await noOverflow(page);
    await screenshot('home-desktop');
    return { fonts, sizing };
  });

  let unpointedResults;
  await step('Real unpointed Hebrew query returns complete-text results', async () => {
    await page.locator('input[name="q"]').fill('בראשית ברא');
    await page.getByRole('button', { name: 'חיפוש', exact: true }).click();
    await expectUI(page).toHaveURL(/search\.html\?q=/);
    await settledSearch(page);
    const links = await page.locator('.search-result h2 a').evaluateAll(elements => elements.map(element => element.href));
    unpointedResults = links.map(checkResultHref);
    // Every upstream edition is part of the corpus. Federation can rank a
    // pointed edition above the primary one without losing the source text.
    assert(unpointedResults.some(isGenesis), 'No Genesis edition appeared on the first results page');
    const excerpts = await page.locator('.search-result .result-excerpt').allTextContents();
    assert(excerpts.some((excerpt, index) => isGenesis(unpointedResults[index]) && normalize(excerpt).includes('בראשית ברא')), 'The opening verse was not present in a Genesis search excerpt');
    await screenshot('search-desktop');
    return { status: await page.locator('[data-search-status]').innerText(), resultsShown: links.length };
  });

  await step('Niqqud and plain Hebrew queries agree', async () => {
    await page.locator('[data-search-input]').fill('בְּרֵאשִׁית בָּרָא');
    await page.locator('[data-search-form]').getByRole('button', { name: 'חיפוש', exact: true }).click();
    await settledSearch(page);
    const links = await page.locator('.search-result h2 a').evaluateAll(elements => elements.map(element => element.href));
    assert.deepEqual(links.map(checkResultHref), unpointedResults, 'Niqqud changed search results');
    return { resultPathsEqual: true };
  });

  await step('Quoted phrase search finds the opening verse across editions', async () => {
    await page.locator('[data-search-input]').fill('"בראשית ברא"');
    await page.locator('[data-search-form]').getByRole('button', { name: 'חיפוש', exact: true }).click();
    await settledSearch(page);
    const links = await page.locator('.search-result h2 a').evaluateAll(elements => elements.map(element => element.href));
    const paths = links.map(checkResultHref);
    assert(paths.some(url => url.includes(`/books/${genesis.id}/`)), 'Exact opening-verse search lost the primary text');
    const excerpts = await page.locator('.search-result .result-excerpt').allTextContents();
    assert(excerpts.length > 0 && excerpts.every(excerpt => normalize(excerpt).includes('בראשית ברא')), 'Quoted search returned an excerpt without the exact phrase');
    return { resultsShown: paths.length, editions: [...new Set(paths.map(url => url.split('/books/')[1]?.split('/')[0]))] };
  });

  let selectedReader;
  await step('Category filter and search result navigation', async () => {
    const category = genesis.categories[0];
    await expectUI(page.locator('[data-search-controls]')).toBeVisible();
    await page.locator('[data-search-category]').selectOption({ label: category });
    await settledSearch(page);
    await expectUI(page.locator('[data-search-category]')).toHaveValue(category);
    const genesisResult = page.locator(`.search-result h2 a[href*="/books/${genesis.id}/"]`).first();
    const target = await genesisResult.getAttribute('href');
    checkResultHref(target);
    await genesisResult.click();
    await readyPage(page);
    selectedReader = page.url();
    assert.equal(new URL(selectedReader).pathname, new URL(target, origin).pathname);
    await expectUI(page.locator('.reading-text')).toBeVisible();
    await expectUI(page.locator('.reading-heading h1')).toContainText('בראשית');
    return { category, url: selectedReader };
  });

  await step('Search terms highlight in pointed source text', async () => {
    assert(new URL(selectedReader).searchParams.has('highlight'), 'Search did not preserve highlight parameters');
    await expectUI(page.locator('.reading-text mark.pagefind-highlight').first()).toBeVisible();
    const words = await page.locator('.reading-text mark.pagefind-highlight').allTextContents();
    assert(words.some(word => normalize(word).includes('ברא')), 'A relevant Hebrew search word was not highlighted');
    await page.evaluate(() => scrollTo(0, 0));
    await screenshot('reader-desktop');
    await noOverflow(page);
    return { highlights: words.length };
  });

  let savedReaderPath;
  await step('Reader typography, theme persistence, and bookmark', async () => {
    const initialSize = await page.locator('.reading-text').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
    await page.getByRole('button', { name: 'הגדלת אותיות', exact: true }).click();
    const largerSize = await page.locator('.reading-text').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
    assert(largerSize > initialSize, 'Font size control did not affect the reading text');
    await page.locator('[data-theme-toggle]').click();
    await expectUI(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    await expectUI(page.locator('[data-theme-toggle]')).toHaveAttribute('aria-pressed', 'true');
    await page.reload({ waitUntil: 'networkidle' });
    await expectUI(page.locator('html')).toHaveAttribute('data-theme', 'dark');
    const persistedSize = await page.locator('.reading-text').evaluate(element => Number.parseFloat(getComputedStyle(element).fontSize));
    assert.equal(persistedSize, largerSize, 'Reading font size did not survive reload');
    await page.evaluate(() => scrollTo(0, 0));
    await screenshot('reader-dark');
    await page.locator('[data-theme-toggle]').click();
    await page.getByRole('button', { name: 'הקטנת אותיות', exact: true }).click();
    await page.locator('[data-bookmark]').click();
    await expectUI(page.locator('[data-bookmark]')).toHaveAttribute('aria-pressed', 'true');
    await expectUI(page.locator('.toast')).toContainText('נשמר');
    savedReaderPath = new URL(page.url()).pathname;
    return { initialSize, largerSize, persistedSize };
  });

  await step('Saved page is discoverable from the home page', async () => {
    await page.locator('.site-header .brand').click();
    await readyPage(page);
    const saved = page.locator('[data-saved-pages]');
    await expectUI(saved).toBeVisible();
    await saved.locator('summary').click();
    const link = page.locator('[data-saved-pages-list] a').first();
    await expectUI(link).toBeVisible();
    assert.equal(new URL(await link.getAttribute('href'), origin).pathname, savedReaderPath);
    await link.click();
    await readyPage(page);
    await expectUI(page.locator('[data-bookmark]')).toHaveAttribute('aria-pressed', 'true');
    return { restored: savedReaderPath };
  });

  await step('Book continuation restores the last reading section', async () => {
    // Use a known section with a next chapter rather than depending on ranking.
    await page.goto(firstReading, { waitUntil: 'networkidle' });
    const next = page.locator('.chapter-navigation a[rel="next"]');
    const nextHref = await next.getAttribute('href');
    assert(nextHref, 'Genesis has no next-section link');
    await next.click(); await readyPage(page);
    const lastPath = new URL(page.url()).pathname;
    assert.equal(lastPath, new URL(nextHref, origin).pathname);
    await page.goto(bookUrl, { waitUntil: 'networkidle' });
    const resume = page.locator('[data-continue-book]');
    await expectUI(resume).toBeVisible();
    assert.equal(new URL(await resume.getAttribute('href'), origin).pathname, lastPath);
    await resume.click(); await readyPage(page);
    assert.equal(new URL(page.url()).pathname, lastPath);
    return { lastPath };
  });

  await step('Empty search and no-match states remain usable', async () => {
    await page.goto(localUrl('search.html'), { waitUntil: 'networkidle' });
    await expectUI(page.locator('[data-search-status]')).toContainText('הקלידו');
    // Exact phrase mode avoids Pagefind's intentional prefix fallback to זז.
    await page.locator('[data-search-input]').fill('"זזזזבדיקתמילהשאינהקיימתזזזז"');
    await page.locator('[data-search-form]').getByRole('button', { name: 'חיפוש', exact: true }).click();
    await expectUI(page.locator('[data-search-status]')).toContainText('לא נמצאו');
    await expectUI(page.locator('.search-result')).toHaveCount(0);
    await expectUI(page.locator('[data-search-more]')).toBeHidden();
    await screenshot('search-empty');
    await page.locator('[data-search-input]').fill('');
    await expectUI(page.locator('[data-search-status]')).toContainText('הקלידו');
    await expectUI(page.locator('.search-result')).toHaveCount(0);
  });

  await step('Complete source and chapter navigation without JavaScript', async () => {
    const context = await browser.newContext({ viewport: report.viewports.desktop, javaScriptEnabled: false, locale: 'he-IL' });
    const noJs = await context.newPage(); activePage = noJs; monitor(noJs, 'no-js');
    try {
      await noJs.goto(firstReading, { waitUntil: 'networkidle' });
      await expectUI(noJs.locator('.reading-text')).toBeVisible();
      const text = normalize(await noJs.locator('.reading-text').innerText());
      assert(text.includes('בראשית ברא אלהים'), 'The opening verse is absent without JavaScript');
      assert(text.includes('יום הששי'), 'The end of Genesis chapter 1 is absent without JavaScript');
      const paragraphs = await noJs.locator('.reading-text p').count();
      assert(paragraphs >= 31, 'Only a partial chapter is present without JavaScript');
      await expectUI(noJs.locator('.reader-toolbar')).toBeHidden();
      await screenshot('reader-no-javascript', noJs);
      const next = noJs.locator('.chapter-navigation a[rel="next"]');
      const href = await next.getAttribute('href');
      await next.click();
      assert.equal(new URL(noJs.url()).pathname, new URL(href, origin).pathname);
      await expectUI(noJs.locator('.reading-chapter')).toContainText('פרק ב');
      return { paragraphs, characters: text.length, nextChapter: noJs.url() };
    } finally { await context.close(); activePage = page; }
  });

  await step('Mobile home, readable text, and accessible contents', async () => {
    const context = await browser.newContext({ viewport: report.viewports.mobile, locale: 'he-IL', isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const mobile = await context.newPage(); activePage = mobile; monitor(mobile, 'mobile');
    try {
      await mobile.goto(localUrl('index.html'), { waitUntil: 'networkidle' });
      await readyPage(mobile);
      await expectUI(mobile.getByRole('heading', { name: 'כל ספר פותח עולם.' })).toBeVisible();
      const homeSize = await noOverflow(mobile);
      await screenshot('home-mobile', mobile);
      await mobile.goto(firstReading, { waitUntil: 'networkidle' });
      await readyPage(mobile);
      const toc = mobile.locator('.toc-disclosure');
      assert.equal(await toc.getAttribute('open'), null, 'The long table of contents should start collapsed on mobile');
      await toc.locator('summary').click();
      await expectUI(toc.locator('nav a').first()).toBeVisible();
      await toc.locator('summary').click();
      await expectUI(mobile.locator('.reading-text')).toBeVisible();
      const readerSize = await noOverflow(mobile);
      await screenshot('reader-mobile', mobile);
      await mobile.getByRole('button', { name: 'הגדלת אותיות', exact: true }).click();
      await noOverflow(mobile);
      return { homeSize, readerSize };
    } finally { await context.close(); activePage = page; }
  });

  await step('External records and verified local-reader links work without JavaScript', async () => {
    const context = await browser.newContext({ viewport: report.viewports.desktop, javaScriptEnabled: false, locale: 'he-IL' });
    const staticPage = await context.newPage(); activePage = staticPage; monitor(staticPage, 'external-no-js');
    try {
      await staticPage.goto(localUrl('external/index.html'), { waitUntil: 'networkidle' });
      await expectUI(staticPage.getByRole('heading', { name: 'קטלוגים חיצוניים', exact: true })).toBeVisible();
      await expectUI(staticPage.locator('.external-provider-row')).toHaveCount(externalCatalog.providers.length);
      await staticPage.locator(`.external-provider-row[href="${hebrewBooks.href}"]`).click();
      await expectUI(staticPage.locator('.external-page-index a')).toHaveCount(hebrewBooks.pages.length);
      const target = new URL(externalGenesis.url, origin);
      await staticPage.locator(`.external-page-index a[href="${target.pathname}"]`).click();
      const record = staticPage.locator(`#${externalGenesis.id}`);
      await record.scrollIntoViewIfNeeded();
      await expectUI(record.locator('h2')).toHaveText(externalGenesis.title);
      await expectUI(record.locator(`a[href="${externalGenesis.providerUrl}"]`).first()).toBeVisible();
      await screenshot('external-record-desktop', staticPage);
      const readerLink = record.locator(`.external-local-reader[href="${genesis.url}"]`);
      await expectUI(readerLink).toBeVisible();
      await readerLink.click();
      await staticPage.locator('.book-actions .button-primary').click();
      assert(normalize(await staticPage.locator('.reading-text').innerText()).includes('בראשית ברא אלהים'), 'External mapping did not reach the actual Genesis text');
      return { providerPages: hebrewBooks.pages.length, recordId: externalGenesis.id, localBook: genesis.id };
    } finally { await context.close(); activePage = page; }
  });

  const externalRequests = [];
  const recordExternalRequest = request => externalRequests.push(request.url());
  page.on('request', recordExternalRequest);
  await step('External title search loads on demand and filters its own provider index', async () => {
    await page.goto(localUrl('external/search.html'), { waitUntil: 'networkidle' });
    await readyPage(page);
    assert(!externalRequests.some(url => new URL(url).pathname.startsWith(`${config.basePath}external/pagefind/`)), 'External index loaded before a query');
    await expectUI(page.locator('[data-external-search-controls]')).toBeVisible();
    await page.locator('[data-external-search-input]').fill(externalGenesis.title);
    await page.locator('[data-external-search-form]').getByRole('button', { name: 'חיפוש', exact: true }).click();
    const target = page.locator(`.external-result h2 a[href$="#${externalGenesis.id}"]`);
    await expectUI(target).toBeVisible();
    await expectUI(page.locator('[data-external-search]')).not.toHaveAttribute('aria-busy', 'true');
    assert.equal(new URL(await target.getAttribute('href'), origin).href, new URL(externalGenesis.url, origin).href);
    assert(externalRequests.some(url => new URL(url).pathname.startsWith(`${config.basePath}external/pagefind/`)), 'External search never requested its static index');
    assert(!externalRequests.some(url => new URL(url).pathname.startsWith(`${config.basePath}pagefind/`)), 'External metadata search loaded the core full-text index');
    await screenshot('external-search-desktop');
    await page.locator('[data-external-search-provider]').selectOption('otzar');
    await expectUI(page.locator('[data-external-search-status]')).toContainText('לא נמצאו');
    await expectUI(page.locator('.external-result')).toHaveCount(0);
    await page.locator('[data-external-search-provider]').selectOption('hebrewbooks');
    await expectUI(target).toBeVisible();
    return { query: externalGenesis.title, target: externalGenesis.url, isolatedIndex: true };
  });

  await step('External author search preserves source identity and does not invent local mappings', async () => {
    await page.locator('[data-external-search-provider]').selectOption('otzar');
    await page.locator('[data-external-search-input]').fill(authorRecord.authors[0]);
    await page.locator('[data-external-search-form]').getByRole('button', { name: 'חיפוש', exact: true }).click();
    const target = page.locator(`.external-result h2 a[href$="#${authorRecord.id}"]`);
    await expectUI(target).toBeVisible();
    const item = target.locator('..').locator('..');
    await expectUI(item.locator('.external-author')).toContainText(authorRecord.authors[0]);
    await expectUI(item.locator(`a[href="${authorRecord.providerUrl}"]`)).toBeVisible();
    await target.click(); await readyPage(page);
    const record = page.locator(`#${authorRecord.id}`);
    await expectUI(record.locator('h2')).toHaveText(authorRecord.title);
    await expectUI(record.locator('.external-local-reader')).toHaveCount(authorRecord.localBooks.length);
    assert.equal(externalRequests.filter(url => new URL(url).origin !== origin).length, 0, 'Search fetched content from an external provider');
    return { author: authorRecord.authors[0], providerUrl: authorRecord.providerUrl, localMappings: authorRecord.localBooks.length };
  });
  page.off('request', recordExternalRequest);

  await step('External catalogue and metadata remain readable on mobile', async () => {
    const context = await browser.newContext({ viewport: report.viewports.mobile, locale: 'he-IL', isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const mobile = await context.newPage(); activePage = mobile; monitor(mobile, 'external-mobile');
    try {
      await mobile.goto(localUrl('external/index.html'), { waitUntil: 'networkidle' });
      await readyPage(mobile);
      await expectUI(mobile.locator('.site-header a[href$="external/index.html"]')).toBeVisible();
      const landingSize = await noOverflow(mobile);
      await screenshot('external-home-mobile', mobile);
      await mobile.goto(new URL(externalGenesis.url, origin).href, { waitUntil: 'networkidle' });
      await readyPage(mobile);
      await expectUI(mobile.locator(`#${externalGenesis.id} h2`)).toBeVisible();
      const recordSize = await noOverflow(mobile);
      await screenshot('external-record-mobile', mobile);
      return { landingSize, recordSize };
    } finally { await context.close(); activePage = page; }
  });

  await step('No JavaScript errors or failed static asset requests', async () => {
    const consoleErrors = report.console.filter(entry => entry.type === 'error');
    assert.equal(report.pageErrors.length, 0, JSON.stringify(report.pageErrors, null, 2));
    assert.equal(consoleErrors.length, 0, JSON.stringify(consoleErrors, null, 2));
    assert.equal(report.networkFailures.length, 0, JSON.stringify(report.networkFailures, null, 2));
    return { consoleErrors: 0, runtimeErrors: 0, failedRequests: 0, warnings: report.console.filter(entry => entry.type !== 'error') };
  });
} catch (error) {
  failure = error;
  console.error(error.stack || error.message);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (server.exitCode === null) {
    server.kill('SIGTERM');
    await Promise.race([new Promise(resolve => server.once('exit', resolve)), delay(2000)]);
    if (server.exitCode === null) server.kill('SIGKILL');
  }
  report.finishedAt = new Date().toISOString();
  report.status = failure ? 'failed' : 'passed';
  if (failure) report.failure = { message: failure.message, stack: failure.stack, serverLog };
  await fs.writeFile(path.join(resultDir, 'results.json'), JSON.stringify(report, null, 2));
  console.log(`Browser QA ${report.status}: ${report.steps.filter(item => item.status === 'passed').length}/${report.steps.length} checks; ${report.screenshots.length} screenshots`);
  console.log('Results: .cache/browser-results/results.json');
  process.exitCode = failure ? 1 : 0;
}
