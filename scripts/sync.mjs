#!/usr/bin/env node
import { syncLibrary, checkUpstream } from '../src/upstream.mjs';
import { resolve } from 'node:path';
import { appendFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
const allowed = new Set(['--profile', '--check', '--offline', '--output', '--help']);
for (let i = 0; i < args.length; i++) {
  if (!allowed.has(args[i])) throw new Error(`Unknown option: ${args[i]}`);
  if (args[i] === '--profile' || args[i] === '--output') {
    if (!args[i + 1] || args[i + 1].startsWith('--')) throw new Error(`Missing value for ${args[i]}`);
    i++;
  }
}
if (args.includes('--help')) {
  console.log('node scripts/sync.mjs [--profile starter|full] [--check] [--offline] [--output directory]');
  process.exit(0);
}
const value = (flag) => args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined;
const profile = value('--profile') || process.env.LIBRARY_PROFILE || 'full';
if (!['starter', 'full'].includes(profile)) throw new Error('Profile must be starter or full.');
if (args.includes('--check') && args.includes('--offline')) throw new Error('--check and --offline cannot be combined.');
const root = resolve(import.meta.dirname, '..');
const options = { root, profile, output: value('--output') ? resolve(value('--output')) : resolve(root, '.cache/library') };
const result = args.includes('--check') ? await checkUpstream(options) : await syncLibrary({ ...options, offline: args.includes('--offline') });
if (profile === 'full') {
  const companionArgs = [resolve(root, 'scripts/sync_companions.py'), '--root', root];
  if (args.includes('--check')) companionArgs.push('--check');
  if (args.includes('--offline')) companionArgs.push('--offline');
  result.companions = await new Promise((resolveResult, reject) => {
    const child = spawn('python3', companionArgs, {stdio:['ignore','pipe','inherit']});
    let output = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => output += chunk);
    child.on('error', reject);
    child.on('close', code => {
      if (code !== 0) reject(new Error('Companion synchronization failed; publishing must stop.'));
      else {try{resolveResult(JSON.parse(output.trim()));}catch(error){reject(error);}}
    });
  });
  result.changed = result.changed || result.companions.changed;
}
console.log(JSON.stringify(result, null, 2));
if (process.env.GITHUB_OUTPUT && 'changed' in result) await appendFile(process.env.GITHUB_OUTPUT, `changed=${result.changed}\n`);
