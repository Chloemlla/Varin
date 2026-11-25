// bun packages/ui/scripts/measure-released-history.mjs [path/to/another/checkout/.../thread-history.ts]
// Run each checkout in a fresh process with the same Bun. This measures owner
// retention on one engine, not Chromium RSS or interprocess memory.
import { heapStats } from 'bun:jsc';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const source = process.argv[2] ? pathToFileURL(resolve(process.argv[2])) : new URL('../src/lib/agent-runtime/thread-history.ts', import.meta.url);
const { threadHistoryWindow } = await import(source.href);
const api = { historyUsage: async () => [] };
const identityFor = i => ({ runtime: 'agent', threadId: 'thread' + i, branchId: 'main' });
const threads = 30, itemsPerThread = 500, textBytes = 2048;

async function visit(i) {
  const identity = identityFor(i);
  const window = threadHistoryWindow(api, 'local', identity), close = window.subscribe(() => {});
  const history = Array.from({ length: itemsPerThread }, (_, j) => ({
    id: String(j), parent: j ? String(j - 1) : null, thread_id: identity.threadId,
    run_id: 'run', source: 'assistant', provider: null,
    content: { text: Buffer.alloc(textBytes, (j + i) % 128).toString('latin1') },
  }));
  window.accept({ history, historyPage: { head: String(itemsPerThread - 1), previous: null }, operations: [] });
  await Promise.resolve();
  close(); await new Promise(resolve => queueMicrotask(resolve));
}

await visit(-1); // load code and warm the one Host's observation path
Bun.gc(true); const baseline = heapStats().heapSize;
for (let i = 0; i < threads; i++) await visit(i);
Bun.gc(true); const final = heapStats().heapSize;
let retainedItems = 0;
for (let i = 0; i < threads; i++) retainedItems += threadHistoryWindow(api, 'local', identityFor(i)).getSnapshot().items.length;
console.log(JSON.stringify({ bun: Bun.version, threads, itemsPerThread, textBytes, baseline, final, growth: final - baseline, retainedItems }));
