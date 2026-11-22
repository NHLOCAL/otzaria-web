import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';

// Execute the actual github-script body, so a changed publication condition is
// covered without maintaining a second copy of the decision logic in this test.
const workflow = await fs.readFile(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');
const block = workflow.match(/^          script: \|\n([\s\S]*?)(?=\n      - name:)/m)?.[1];
assert.ok(block, 'The publication preflight script must be present');
const source = block.split('\n').map(line => line.replace(/^ {12}/, '')).join('\n');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runPreflight = new AsyncFunction('core', 'github', 'context', 'process', source);

async function run(eventName, overrides = {}) {
  const outputs = {};
  let failed = null;
  let pagesRequests = 0;
  const core = {
    setOutput: (key, value) => { outputs[key] = value; },
    setFailed: message => { failed = message; },
    notice() {},
    summary: { addRaw() { return this; }, async write() {} },
  };
  const github = { rest: { repos: { async getPages() { pagesRequests++; return { data: { build_type: 'workflow' } }; } } } };
  await runPreflight(core, github, { eventName, repo: { owner: 'example', repo: 'library' } }, {
    env: { LIBRARY_PROFILE: 'full', DEPLOY_TARGET: 'cloudflare-r2', BUILD_MODE: 'publish', EVENT_NAME: eventName, ...overrides },
  });
  return { outputs, failed, pagesRequests };
}

const configuredR2 = { R2_ACCESS_KEY_ID: 'configured', R2_SECRET_ACCESS_KEY: 'configured', R2_ACCOUNT_ID: 'configured', R2_BUCKET: 'configured', PUBLIC_SITE_URL: 'https://example.org' };

test('pull requests cannot publish even if mode and credentials request publication', async () => {
  const result = await run('pull_request', configuredR2);
  assert.deepEqual(result.outputs, { publish: 'false', pages_enabled: 'false', allowed: 'true' });
  assert.equal(result.failed, null);
  assert.equal(result.pagesRequests, 0);
});

test('pull request Pages validation never checks or enables the deployment', async () => {
  const result = await run('pull_request', { ...configuredR2, LIBRARY_PROFILE: 'starter', DEPLOY_TARGET: 'github-pages' });
  assert.equal(result.outputs.publish, 'false');
  assert.equal(result.outputs.pages_enabled, 'false');
  assert.equal(result.outputs.allowed, 'true');
  assert.equal(result.pagesRequests, 0);
});

test('missing publication configuration skips automatic builds and rejects manual publication', async () => {
  const automatic = await run('push');
  assert.equal(automatic.outputs.allowed, 'false');
  assert.equal(automatic.failed, null);
  const manual = await run('workflow_dispatch');
  assert.equal(manual.outputs.allowed, 'false');
  assert.match(manual.failed, /No expensive build was started/);
});

test('explicit build-only works without a destination, configured publication still works', async () => {
  const dry = await run('workflow_dispatch', { BUILD_MODE: 'build-only' });
  assert.equal(dry.outputs.allowed, 'true');
  assert.equal(dry.outputs.publish, 'false');
  const publish = await run('workflow_dispatch', configuredR2);
  assert.equal(publish.outputs.allowed, 'true');
  assert.equal(publish.outputs.publish, 'true');
});

test('the full corpus cannot be sent to the smaller GitHub Pages hosting target', async () => {
  const result = await run('workflow_dispatch', { DEPLOY_TARGET: 'github-pages' });
  assert.equal(result.outputs.allowed, 'false');
  assert.equal(result.outputs.publish, 'false');
  assert.match(result.failed, /exceeds GitHub Pages/);
});
