#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const args = process.argv.slice(2);
if (args.some(arg => !['--check', '--offline'].includes(arg))) throw new Error('Supported options: --check, --offline');
if (args.includes('--check') && args.includes('--offline')) throw new Error('--check and --offline cannot be combined');
const root = resolve(import.meta.dirname, '..');
const child = spawn('python3', [resolve(root, 'scripts/sync_companions.py'), '--root', root, ...args], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => { process.exitCode = code ?? 1; });
