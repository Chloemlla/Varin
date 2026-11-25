import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { Worker } from 'node:worker_threads';
import { tmpdir } from 'node:os';
import { createLocalSemanticEmbedder } from './local-embedder.js';
import { localComponentFixture } from './fixtures/local-component.test-helper.js';
const cleanups: Array<() => Promise<unknown>> = [];
afterEach(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); cleanups.length = 0; });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'varin-local-worker-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
  const component = await localComponentFixture(root);
  const encoder = createLocalSemanticEmbedder({ dataDir: '', pack: component.pack });
  cleanups.push(() => encoder.dispose!());
  await encoder.prepare();
  return { ...component, encoder };
}
const waitUntil = async (condition: () => Promise<boolean>) => {
  const end = Date.now() + 5000;
  while (!await condition()) { if (Date.now() > end) throw new Error('Controlled worker did not reach expected boundary'); await new Promise(resolve => setTimeout(resolve, 5)); }
};
describe('real local encoder queue and physical settlement', () => {
  it('acknowledges queued cancellation without forward and drains active cancellation while unrelated work survives', async () => {
    const f = await fixture();
    const active = new AbortController(), queued = new AbortController();
    const first = f.encoder.localExecution!.batch(['HOLD_FORWARD first'], { signal: active.signal, beforeDispatch: async () => {}, priority: 'foreground' });
    await waitUntil(async () => (await f.calls()).length === 1);
    let fenced = 0;
    const second = f.encoder.localExecution!.batch(['never enter'], { signal: queued.signal, beforeDispatch: async () => { fenced++; }, priority: 'foreground' });
    queued.abort();
    expect(await second).toMatchObject({ requestStarted: false, completed: false, cancelled: true });
    expect(fenced).toBe(0);
    active.abort();
    let drained = false; void first.then(() => { drained = true; });
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(drained).toBe(false);
    const third = f.encoder.localExecution!.batch(['unrelated survives'], { signal: new AbortController().signal, beforeDispatch: async () => {}, priority: 'foreground' });
    await f.release();
    expect(await first).toMatchObject({ requestStarted: true, completed: true, usage: { measurement: 'estimated', inputTokens: 4, outputTokens: 0 } });
    expect(await third).toMatchObject({ requestStarted: true, completed: true });
    expect(await f.calls()).toEqual([['HOLD_FORWARD first'], ['unrelated survives']]);
  });
  it('checks queued source authority only when selected and preserves an accepted retired generation across grains', async () => {
    const f = await fixture(); const pin = f.encoder.retain!();
    let retired = false; void f.encoder.retire!().then(() => { retired = true; });
    const first = f.encoder.localExecution!.batch(['HOLD_FORWARD first'], { signal: new AbortController().signal, beforeDispatch: async () => {}, priority: 'foreground' });
    await waitUntil(async () => (await f.calls()).length === 1);
    let allowed = true, fences = 0;
    const queued = f.encoder.localExecution!.batch(['stale source'], { signal: new AbortController().signal,
      beforeDispatch: async () => { fences++; if (!allowed) throw new Error('source-revision-changed'); }, priority: 'foreground' });
    allowed = false; expect(fences).toBe(0); expect(retired).toBe(false);
    await f.release(); await first;
    expect(await queued).toMatchObject({ requestStarted: false, error: 'source-revision-changed' });
    expect(await f.encoder.embed(['next accepted grain'])).toHaveLength(1);
    expect(retired).toBe(false); pin(); await f.encoder.retire!(); expect(retired).toBe(true);
    expect(await f.calls()).toHaveLength(2);
  });
  it('owner shutdown terminates the real shared worker before waiting for its non-interruptible forward', async () => {
    const f = await fixture();
    const active = f.encoder.localExecution!.batch(['HOLD_FORWARD original'], { signal: new AbortController().signal, beforeDispatch: async () => {}, priority: 'foreground' });
    await waitUntil(async () => (await f.calls()).length === 1);
    await f.encoder.dispose!();
    expect(await active).toMatchObject({ requestStarted: true, completed: false, usage: { measurement: 'estimated', inputTokens: 4 } });
  });
  it('settles a crashed worker once and serves the next request on a fresh worker', async () => {
    const f = await fixture();
    const started = new Promise<Worker>(resolve => process.once('worker', resolve));
    const pending = f.encoder.localExecution!.batch(['HOLD_FORWARD original'], {
      signal: new AbortController().signal, beforeDispatch: async () => {}, priority: 'foreground',
    });
    const worker = await started;
    await waitUntil(async () => (await f.calls()).length === 1);
    await worker.terminate();
    expect(await pending).toMatchObject({ requestStarted: true, completed: false });
    expect(await f.encoder.embed(['new request'])).toHaveLength(1);
    expect(await f.calls()).toEqual([['HOLD_FORWARD original'], ['new request']]);
  });
  it('retains observed input estimates when the actual worker exits after encoder entry', async () => {
    const f = await fixture();
    const result = await f.encoder.localExecution!.batch(['EXIT_FORWARD original'], { signal: new AbortController().signal, beforeDispatch: async () => {}, priority: 'foreground' });
    expect(result).toMatchObject({ requestStarted: true, completed: false, usage: { measurement: 'estimated', inputTokens: 4, outputTokens: 0 } });
    expect(result.error).toBeTruthy();
    expect(await f.calls()).toEqual([['EXIT_FORWARD original']]);
  });
});


it('does not start inference for tokenization; idle eviction preserves tokenization and reacquires the model', async () => {
  const root = await mkdtemp(join(tmpdir(), 'varin-lazy-inference-'));
  cleanups.push(() => rm(root, {recursive: true, force: true}));
  const { pack } = await localComponentFixture(root);
  const starts: Worker[] = [], exits: number[] = [];
  const onWorker = (value: Worker) => { starts.push(value); value.once('exit', () => exits.push(1)); };
  process.on('worker', onWorker);
  cleanups.push(async () => { process.off('worker', onWorker); });
  const encoder = createLocalSemanticEmbedder({ dataDir: root, pack, idleWorkerDelay: () => 5 });
  cleanups.push(() => encoder.dispose!());
  await encoder.prepare();
  const tokens = encoder.countTokens('nebula docking');
  expect(starts).toHaveLength(0);
  const first = await encoder.embed(['nebula docking']);
  await waitUntil(async () => exits.length === 1);
  expect(encoder.countTokens('nebula docking')).toBe(tokens);
  expect(await encoder.embed(['nebula docking'])).toEqual(first);
  expect(starts).toHaveLength(2);
});
