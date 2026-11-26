import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { DictationWorkerClient, WorkerBackedTranscriptionSession } from './worker-client.js';

class WorkerFixture extends EventEmitter {
  pid: number | undefined = 1234;
  connected = true;
  killed = false;
  sent: Array<{ requestId: string; type: string }> = [];
  send(input: { requestId: string; type: string }, callback: (error: Error | null) => void) {
    this.sent.push(input);
    callback(null);
    return true;
  }
  disconnect() {
    this.connected = false;
    this.emit('disconnect');
  }
  kill() {
    this.killed = true;
    return true;
  }
  finish(result = {}) {
    const request = this.sent.shift()!;
    this.emit('message', { type: 'response', requestId: request.requestId, ok: true, result });
  }
  exit() {
    this.emit('exit', 0, null);
  }
}
const model = { modelsDir: '/test', modelId: 'fixture' };
const speak = { ...model, text: 'hello' };
function fixture() {
  const workers: WorkerFixture[] = [];
  const client = new DictationWorkerClient({ idleTtlMs: 100, requestTimeoutMs: 10, forkWorker: () => {
    const worker = new WorkerFixture();
    workers.push(worker);
    return worker as unknown as ChildProcess;
  } });
  return { workers, client };
}
afterEach(() => vi.useRealTimers());

it('keeps active STT and TTS on one worker, then reacquires after idle exit without a close event', async () => {
  vi.useFakeTimers();
  const { workers, client } = fixture();
  const stt = new WorkerBackedTranscriptionSession(client, model);
  const opening = stt.connect();
  const speech = client.synthesizeSpeech(speak);
  expect(workers).toHaveLength(1);
  expect(client.activity()).toEqual({ state: 'live', pendingRequests: 2, sessions: 1, warm: false });
  const first = workers[0]!;
  first.finish({ requiredSampleRate: 16000 });
  first.finish({ audio: Buffer.from('wave') });
  await opening;
  await speech;
  await vi.advanceTimersByTimeAsync(250);
  expect(first.killed).toBe(false); // A live stream keeps the actual generation.
  stt.close();
  expect(first.sent[0]?.type).toBe('session.close');
  first.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(first.killed).toBe(true);
  expect(client.activity().state).toBe('retiring');
  const acquired = client.synthesizeSpeech(speak);
  expect(workers).toHaveLength(1); // A kill/disconnect request isn't exit evidence.
  first.exit();
  await Promise.resolve();
  expect(workers).toHaveLength(2);
  const second = workers[1]!;
  first.emit('close', 0, null);
  second.finish({ audio: Buffer.from('new') });
  await expect(acquired).resolves.toMatchObject({ audio: Buffer.from('new') });
  const shutdown = client.shutdown();
  second.exit();
  await shutdown;
  await expect(client.synthesizeSpeech(speak)).rejects.toThrow('shut down');
  expect(workers).toHaveLength(2);
});

it('settles a failed spawn and allows the next request to start a new worker', async () => {
  const { workers, client } = fixture();
  const failed = client.synthesizeSpeech(speak);
  const first = workers[0]!;
  first.pid = undefined;
  first.emit('error', new Error('Could not spawn worker'));
  await expect(failed).rejects.toThrow('Could not spawn worker');
  expect(client.activity().state).toBe('cold');
  const next = client.synthesizeSpeech(speak);
  const second = workers[1]!;
  second.finish({ audio: Buffer.from('new') });
  await expect(next).resolves.toMatchObject({ audio: Buffer.from('new') });
  const shutdown = client.shutdown();
  second.exit();
  await shutdown;
});

it('closes a late native session and retains timed-out physical requests until their receipts settle', async () => {
  vi.useFakeTimers();
  const { workers, client } = fixture();
  const stt = new WorkerBackedTranscriptionSession(client, model);
  const opening = stt.connect().catch(error => error);
  const worker = workers[0]!;
  stt.close();
  await vi.advanceTimersByTimeAsync(10);
  expect(await opening).toMatchObject({ message: 'Dictation worker request timed out: session.create' });
  expect(worker.sent.map(row => row.type)).toEqual(['session.create']);
  await vi.advanceTimersByTimeAsync(500);
  expect(worker.killed).toBe(false); // Timed out callers, but both receipts still pending.
  worker.finish();
  expect(worker.sent[0]?.type).toBe('session.close');
  await vi.advanceTimersByTimeAsync(500);
  expect(worker.killed).toBe(false); // The compensating native close has not acknowledged.
  worker.finish();
  await vi.advanceTimersByTimeAsync(100);
  expect(worker.killed).toBe(true);
  const drain = client.shutdown();
  const late = client.synthesizeSpeech(speak).catch(error => error);
  worker.exit();
  await drain;
  expect(await late).toMatchObject({ message: 'Dictation worker shut down' });
  expect(workers).toHaveLength(1);
});
