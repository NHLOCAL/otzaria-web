import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

test('bundled PDF importer preserves the application discovery policy and validates archives', () => {
  const result = spawnSync('python3', [fileURLToPath(new URL('./test_companions.py', import.meta.url))], { encoding: 'utf8' });
  assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
});
