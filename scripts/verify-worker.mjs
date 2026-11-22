import fs from 'node:fs/promises';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { verifyHtml } from '../src/verify-html.mjs';

const files = new Set(workerData.files);
parentPort.on('message', async batch => {
  const failures = [];
  let failureCount = 0;
  try {
    for (const relative of batch) {
      const content = await fs.readFile(path.join(workerData.root, relative), 'utf8');
      const errors = verifyHtml(content, { ...workerData, relative, files });
      failureCount += errors.length;
      if (failures.length < 50) failures.push(...errors.slice(0, 50 - failures.length));
    }
    parentPort.postMessage({ count: batch.length, failures, failureCount });
  } catch (error) { parentPort.postMessage({ error: error.message }); }
});
