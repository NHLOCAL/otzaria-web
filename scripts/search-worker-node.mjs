/* File-backed adapter for exercising the production module worker with Node's
 * actual Worker threads. This is test tooling and is never shipped to clients. */
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

export function createNodeSearchWorkerFactory({ directory, basePath = '/', latencyMs = 0, failUrlPattern = '', onFetch = () => {} }) {
  return () => {
    const worker = new Worker(new URL(import.meta.url), { workerData: { directory, basePath, latencyMs,
      failUrlPattern: typeof failUrlPattern === 'function' ? failUrlPattern() : failUrlPattern } });
    return {
      postMessage: message => worker.postMessage(message),
      terminate: () => worker.terminate(),
      addEventListener(type, listener) {
        if (type === 'message') worker.on('message', data => data?.kind === 'fetch' ? onFetch(data) : listener({ data }));
        if (type === 'error') worker.on('error', error => listener({ message: error.message }));
      },
    };
  };
}

if (!isMainThread) {
  const { createSearchWorkerHandler } = await import('../public/search-worker.mjs');
  const { directory, basePath, latencyMs, failUrlPattern } = workerData;
  let active = 0;
  function fileFor(value) {
    const url = new URL(value);
    if (!url.pathname.startsWith(basePath)) throw new Error('Unexpected worker test base path');
    const file = path.resolve(directory, decodeURIComponent(url.pathname.slice(basePath.length)));
    if (!file.startsWith(`${path.resolve(directory)}${path.sep}`)) throw new Error('Worker test path escaped build directory');
    return file;
  }
  const handle = createSearchWorkerHandler({
    postMessage: message => parentPort.postMessage(message),
    importPagefind: url => import(pathToFileURL(fileFor(url)).href),
    fetchResource: async url => {
      const start = performance.now();
      active++;
      const concurrency = active;
      try {
        if (latencyMs) await delay(latencyMs);
        const file = fileFor(url);
        if (failUrlPattern && url.includes(failUrlPattern)) return new Response('Injected failure', { status: 503 });
        const data = await fs.readFile(file);
        parentPort.postMessage({ kind: 'fetch', file: path.relative(directory, file), bytes: data.length,
          milliseconds: Number((performance.now() - start).toFixed(2)), concurrency });
        return new Response(data, { status: 200 });
      } finally { active--; }
    },
  });
  parentPort.on('message', handle);
}
