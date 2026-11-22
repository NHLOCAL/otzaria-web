import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { profileCommand, processTreeRss } from '../scripts/profile-command.mjs';

test('profiling preserves failure and writes a useful report without recording the environment', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const report = await profileCommand({ label: 'failed', command: process.execPath, args: ['-e', 'setTimeout(()=>process.exit(7),80)'], reportDirectory: directory, intervalMs: 20, env: { ...process.env, PRIVATE_TEST_TOKEN: 'do-not-record' } });
  assert.equal(report.exitCode, 7);
  assert.ok(report.wallTimeMs >= 60);
  const stored = await fs.readFile(path.join(directory, 'failed.json'), 'utf8');
  assert.equal(JSON.parse(stored).exitCode, 7);
  assert.ok(!stored.includes('do-not-record'));
  assert.ok(report.before.diskAvailableBytes > 0);
});

test('an unavailable executable leaves a failed profile', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-profile-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const report = await profileCommand({ label: 'missing', command: path.join(directory, 'no-such-command'), reportDirectory: directory });
  assert.equal(report.exitCode, 1);
  assert.match(report.launchError, /ENOENT/);
  assert.equal(JSON.parse(await fs.readFile(path.join(directory, 'missing.json'), 'utf8')).exitCode, 1);
});

test('Linux process-tree RSS includes descendants and tolerates vanished processes', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-proc-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  for (const [pid, rss, children] of [[10, 100, '20 30'], [20, 200, '40'], [40, 400, '']]) {
    await fs.mkdir(path.join(root, String(pid), 'task', String(pid)), { recursive: true });
    await fs.writeFile(path.join(root, String(pid), 'status'), `Name:\tnode\nVmRSS:\t${rss} kB\n`);
    await fs.writeFile(path.join(root, String(pid), 'task', String(pid), 'children'), children);
  }
  assert.deepEqual(await processTreeRss(10, root), { rssBytes: 700 * 1024, processes: 3 });
  assert.equal(await processTreeRss(999, root), null);
});

test('CLI forwards termination and still records its child signal', { skip: process.platform === 'win32' }, async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'otzaria-profile-signal-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const script = fileURLToPath(new URL('../scripts/profile-command.mjs', import.meta.url));
  const child = spawn(process.execPath, [script, 'signal', '--', process.execPath, '-e', "console.log('READY');setInterval(()=>{},1000)"], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PERFORMANCE_REPORT_DIR: directory } });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const closed = once(child, 'close');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Profile child did not start')), 5000);
    child.stdout.on('data', data => { if (data.toString().includes('READY')) { clearTimeout(timeout); resolve(); } });
  });
  child.kill('SIGTERM');
  const [code] = await closed;
  assert.equal(code, 143);
  const report = JSON.parse(await fs.readFile(path.join(directory, 'signal.json'), 'utf8'));
  assert.equal(report.signal, 'SIGTERM');
  assert.equal(report.exitCode, 143);
});
