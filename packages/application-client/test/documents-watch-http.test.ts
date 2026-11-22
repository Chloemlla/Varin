import assert from 'node:assert/strict';
import { it } from 'node:test';
import { createWebDocumentsAPI } from '../src/documents-http.js';
import type { DocumentsAPI, VarinDirtyStateBarrierEvent, VarinDocumentWatchEvent } from '../src/types.js';

const workspaceId = 'workspace';
const acquire: VarinDirtyStateBarrierEvent = {
  kind: 'dirty-state-barrier', action: 'acquire', barrierId: 'restore',
  caseSensitive: true, workspaceId, paths: ['bulletin.txt'],
};
const release = { ...acquire, action: 'release' } as const;
const invalidated = {
  kind: 'invalidated', reason: 'entry-changed', resource: { workspaceId, resourceId: 'bulletin.txt' },
  sourceId: 'watcher', generation: 1, sequence: 1,
} as const;

function response(events: VarinDocumentWatchEvent[], disconnect = false) {
  const body = events.map(event => `data: ${JSON.stringify(event)}\n\n`).join('');
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      if (disconnect) controller.close();
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

function observe(documents: DocumentsAPI, signal: AbortSignal, until: (event: VarinDocumentWatchEvent) => boolean) {
  return new Promise<VarinDocumentWatchEvent[]>(resolve => {
    const events: VarinDocumentWatchEvent[] = [];
    documents.watch(workspaceId, event => {
      events.push(event);
      if (until(event)) resolve([...events]);
    }, { signal });
  });
}

it('delivers the restored entry and releases its editing hold on the original watch', { timeout: 3000 }, async t => {
  let requests = 0;
  const documents = createWebDocumentsAPI(async () => {
    requests++;
    return response([acquire, invalidated, release]);
  });
  const events = await observe(documents, t.signal, event => event.kind === 'reset'
    || (event.kind === 'dirty-state-barrier' && event.action === 'release'));
  assert.deepEqual(events, [acquire, invalidated, release]);
  assert.equal(requests, 1);
});

it('ends holds belonging to a disconnected watch before processing the next registration', { timeout: 3000 }, async t => {
  let requests = 0;
  const documents = createWebDocumentsAPI(async () => ++requests === 1 ? response([acquire], true) : response([invalidated]));
  const events = await observe(documents, t.signal, event => event.kind === 'invalidated' || requests > 2);
  assert.deepEqual(events.map(event => event.kind === 'reset' ? event.reason : event), [
    acquire, release, 'reconnected', invalidated,
  ]);
});
