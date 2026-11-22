import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

// This is an observed sum of process RSS, not unique resident memory. Shared
// pages may be counted twice, and peaks shorter than the interval can be missed.
export async function processTreeRss(pid, procRoot = '/proc') {
  if (!Number.isInteger(pid) || pid < 1) return null;
  const visited = new Set();
  let rss = 0;
  let observed = 0;
  async function visit(current) {
    if (visited.has(current)) return;
    visited.add(current);
    const directory = path.join(procRoot, String(current));
    const [status, children] = await Promise.all([
      fs.readFile(path.join(directory, 'status'), 'utf8').catch(() => ''),
      fs.readFile(path.join(directory, 'task', String(current), 'children'), 'utf8').catch(() => ''),
    ]);
    const match = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    if (match) { rss += Number(match[1]) * 1024; observed++; }
    await Promise.all(children.trim().split(/\s+/).filter(Boolean).map(value => visit(Number(value))));
  }
  await visit(pid);
  return observed ? { rssBytes: rss, processes: observed } : null;
}

export async function resourceSnapshot(directory = process.cwd()) {
  const disk = await fs.statfs(directory).catch(() => null);
  return {
    memoryTotalBytes: os.totalmem(),
    memoryFreeBytes: os.freemem(),
    memoryAvailableToProcessBytes: typeof process.availableMemory === 'function' ? process.availableMemory() : null,
    diskAvailableBytes: disk ? disk.bavail * disk.bsize : null,
    diskTotalBytes: disk ? disk.blocks * disk.bsize : null,
    cpuCount: os.availableParallelism(),
  };
}

export async function profileCommand({ label, command, args = [], reportDirectory = '.cache/performance', intervalMs = 250, cwd = process.cwd(), env = process.env }) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(label || '')) throw new Error('Profile label must be 1-80 letters, digits, underscores or hyphens');
  if (!command) throw new Error('A command is required');
  if (!Number.isInteger(intervalMs) || intervalMs < 20 || intervalMs > 60_000) throw new Error('Invalid profiling interval');
  const before = await resourceSnapshot(cwd);
  const startedAt = new Date().toISOString();
  const started = performance.now();
  let peakRssBytes = null;
  let peakProcesses = 0;
  let samples = 0;
  let pendingSample = null;
  let launchError = null;
  const detached = process.platform !== 'win32';
  const child = spawn(command, args, { cwd, env, stdio: 'inherit', detached });
  async function sample() {
    if (pendingSample || process.platform !== 'linux') return;
    pendingSample = processTreeRss(child.pid).then(value => {
      if (!value) return;
      peakRssBytes = Math.max(peakRssBytes || 0, value.rssBytes);
      peakProcesses = Math.max(peakProcesses, value.processes);
      samples++;
    });
    try { await pendingSample; } finally { pendingSample = null; }
  }
  const forwardSignal = signal => {
    if (!child.pid) return;
    try {
      if (detached) process.kill(-child.pid, signal);
      else child.kill(signal);
    } catch (error) { if (error.code !== 'ESRCH') throw error; }
  };
  const onTerm = () => forwardSignal('SIGTERM');
  const onInt = () => forwardSignal('SIGINT');
  process.on('SIGTERM', onTerm);
  process.on('SIGINT', onInt);
  const outcome = new Promise(resolve => {
    child.once('error', error => { launchError = error.message; resolve({ code: 1, signal: null }); });
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const timer = setInterval(() => { void sample(); }, intervalMs);
  await sample();
  const { code, signal } = await outcome;
  clearInterval(timer);
  if (pendingSample) await pendingSample;
  process.off('SIGTERM', onTerm);
  process.off('SIGINT', onInt);
  const exitCode = code ?? (signal ? 128 + (os.constants.signals[signal] || 1) : 1);
  const report = {
    schemaVersion: 1,
    label,
    startedAt,
    completedAt: new Date().toISOString(),
    wallTimeMs: Math.round((performance.now() - started) * 100) / 100,
    exitCode,
    signal,
    launchError,
    sampledPeakRssBytes: peakRssBytes,
    sampledPeakProcessCount: peakProcesses,
    sampleCount: samples,
    sampleIntervalMs: intervalMs,
    rssMeasurement: 'Sampled sum of RSS for the child and descendants on Linux; shared pages can be counted more than once and short peaks can be missed.',
    before,
    after: await resourceSnapshot(cwd),
  };
  const directory = path.resolve(cwd, reportDirectory);
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, `${label}.json`);
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, `${JSON.stringify(report, null, 2)}\n`);
  await fs.rename(temporary, file);
  console.log(`${label}: ${(report.wallTimeMs / 1000).toFixed(2)}s, exit ${exitCode}, sampled process-tree RSS ${peakRssBytes === null ? 'unavailable' : `${(peakRssBytes / 1024 / 1024).toFixed(1)} MiB`}`);
  if (env.GITHUB_STEP_SUMMARY) {
    await fs.appendFile(env.GITHUB_STEP_SUMMARY, `| ${label} | ${(report.wallTimeMs / 1000).toFixed(2)} s | ${peakRssBytes === null ? 'unavailable' : `${(peakRssBytes / 1024 / 1024).toFixed(1)} MiB`} | ${exitCode} |\n`);
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [label, separator, command, ...args] = process.argv.slice(2);
  if (separator !== '--' || !command) throw new Error('Usage: node scripts/profile-command.mjs <label> -- <command> [args...]');
  const report = await profileCommand({ label, command, args, reportDirectory: process.env.PERFORMANCE_REPORT_DIR || '.cache/performance' });
  process.exitCode = report.exitCode;
}
