/**
 * Client for the dictation local-speech worker process.
 *
 * Lazily forks the worker on first use, correlates request/response messages
 * by requestId, routes session events to per-session EventEmitters, and
 * shuts the worker down after an idle TTL so the ONNX runtime does not sit
 * in memory while dictation is unused.
 */

import { fork, type ChildProcess, type ForkOptions } from 'child_process';
import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import { fileURLToPath } from 'url';

import { applySherpaLoaderEnv } from './sherpa-loader.js';
import { remapAsarUnpackedPath } from '../../structure/runtime-path.js';
import type { WorkerRequest } from '../types.js';

const DEFAULT_REQUEST_TIMEOUT_MS = 30000;
const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
const DEFAULT_LOCAL_SAMPLE_RATE = 16000;
const STDERR_TAIL_MAX_CHARS = 2000;

const runsFromTypeScriptSource = fileURLToPath(import.meta.url).endsWith('.ts');
const workerPath = remapAsarUnpackedPath(fileURLToPath(new URL(`./worker-process.${runsFromTypeScriptSource ? 'ts' : 'js'}`, import.meta.url)));
const workerExecArgv = runsFromTypeScriptSource && !process.versions.bun
  ? ['--import', import.meta.resolve('tsx')]
  : [];

interface PendingWorkerRequest {
  reject(error: unknown): void;
  resolve(value: Record<string, unknown>): void;
  timeout: ReturnType<typeof setTimeout>;
  onReply?(ok: boolean): void;
}

const asRecord = (value: unknown): Record<string, unknown> => (
  value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {}
);

function forkDictationWorker(): ChildProcess {
  const env = { ...process.env };
  applySherpaLoaderEnv(env);
  const options: ForkOptions & { windowsHide: boolean } = {
    env,
    execArgv: workerExecArgv,
    serialization: 'advanced',
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    windowsHide: true,
  };
  return fork(workerPath, [], options);
}

export class DictationWorkerClient {
  readonly requestTimeoutMs: number;
  readonly idleTtlMs: number;
  private readonly pendingRequests: Map<string, PendingWorkerRequest>;
  private readonly sessionEmitters: Map<string, EventEmitter>;
  private worker: ChildProcess | null;
  private stderrTail: string;
  private idleTimer: ReturnType<typeof setTimeout> | null;
  private workerExit: Promise<void> | null = null;
  private retiring: Promise<void> | null = null;
  private stopping = false;
  private readonly forkWorker: () => ChildProcess;

  /**
   * @param {{ requestTimeoutMs?: number, idleTtlMs?: number }} [options]
   */
  constructor(options: { idleTtlMs?: number; requestTimeoutMs?: number; forkWorker?: () => ChildProcess } = {}) {
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS;
    this.pendingRequests = new Map();
    this.sessionEmitters = new Map();
    this.worker = null;
    this.stderrTail = '';
    this.idleTimer = null;
    this.forkWorker = options.forkWorker ?? forkDictationWorker;
  }

  /**
   * Synthesize speech in the worker. Returns WAV bytes.
   * @param {{ modelsDir: string, modelId: string, text: string, speakerId?: number, speed?: number }} params
   * @returns {Promise<{ audio: Buffer, format: string }>}
   */
  async synthesizeSpeech(params: {
    modelId: string;
    modelsDir: string;
    speakerId?: number;
    speed?: number;
    text: string;
  }): Promise<{ audio: Buffer; format: string }> {
    // Long texts on slow hardware can exceed the default request timeout.
    const result = await this.sendRequest(
      { type: 'tts.synthesize', ...params },
      { timeoutMs: 120000 },
    );
    return {
      audio: Buffer.isBuffer(result.audio) ? result.audio : Buffer.from(result.audio as Uint8Array),
      format: typeof result.format === 'string' && result.format ? result.format : 'audio/wav',
    };
  }

  /**
   * Create a streaming STT session in the worker.
   * @param {{ modelsDir: string, modelId: string }} params
   * @param {EventEmitter} emitter receives 'committed' | 'transcript' | 'error'
   * @returns {Promise<{ sessionId: string, requiredSampleRate: number }>}
   */
  async createSession(
    { modelsDir, modelId, language }: { modelId: string; modelsDir: string; language?: string },
    emitter: EventEmitter,
  ): Promise<{ requiredSampleRate: number; sessionId: string }> {
    const sessionId = randomUUID();
    let abandoned = false;
    let acknowledged = false;
    try {
      const result = await this.sendRequest({
        type: 'session.create',
        sessionId,
        modelsDir,
        modelId,
        ...(language ? { language } : {}),
      }, {
        onAdmission: () => this.sessionEmitters.set(sessionId, emitter),
        onReply: (ok) => {
          acknowledged = true;
          // Do not race close against an unfinished native creation. If its
          // caller timed out, retire precisely the new session once acknowledged.
          if (abandoned && ok) this.closeSession(sessionId);
          else if (abandoned) this.sessionEmitters.delete(sessionId);
        },
      });
      return {
        sessionId,
        requiredSampleRate: typeof result.requiredSampleRate === 'number'
          ? result.requiredSampleRate
          : DEFAULT_LOCAL_SAMPLE_RATE,
      };
    } catch (err) {
      abandoned = true;
      if (acknowledged) {
        this.sessionEmitters.delete(sessionId);
        this.scheduleIdleShutdownIfReady();
      }
      throw err;
    }
  }

  appendSessionAudio(sessionId: string, audio: Buffer): void {
    void this.sendSessionRequest(sessionId, { type: 'session.append', sessionId, audio }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  commitSession(sessionId: string): void {
    void this.sendSessionRequest(sessionId, { type: 'session.commit', sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  clearSession(sessionId: string): void {
    void this.sendSessionRequest(sessionId, { type: 'session.clear', sessionId }).catch((err) => {
      this.emitSessionError(sessionId, err);
    });
  }

  private sendSessionRequest(sessionId: string, input: WorkerRequest): Promise<Record<string, unknown>> {
    if (!this.sessionEmitters.has(sessionId) || !this.worker) {
      return Promise.reject(new Error('Dictation session is no longer available'));
    }
    return this.sendRequest(input, { existingWorker: this.worker });
  }

  closeSession(sessionId: string): void {
    if (!this.sessionEmitters.delete(sessionId)) return;
    const worker = this.worker;
    if (worker) {
      void this.sendRequest({ type: 'session.close', sessionId }, { existingWorker: worker }).catch(() => {
        // The original generation may already be gone; never start a worker for stale cleanup.
      });
    }
    this.scheduleIdleShutdownIfReady();
  }

  activity() {
    return {
      state: this.retiring ? 'retiring' as const : this.worker ? 'live' as const : 'cold' as const,
      pendingRequests: this.pendingRequests.size,
      sessions: this.sessionEmitters.size,
      warm: this.idleTimer !== null,
    };
  }

  shutdown(): Promise<void> {
    this.stopping = true;
    return this.retireWorker(new Error('Dictation worker shut down'));
  }

  private retireWorker(reason?: Error): Promise<void> {
    if (this.retiring) return this.retiring;
    this.clearIdleTimer();
    const worker = this.worker;
    if (!worker) return Promise.resolve();
    // Publish retirement before disconnect/kill: those requests don't prove physical exit.
    const exited = this.workerExit!;
    this.retiring = exited;
    if (reason) this.failConsumers(reason);
    try { if (worker.connected) worker.disconnect(); } catch { /* wait for exit */ }
    try { if (!worker.killed) worker.kill(); } catch { /* wait for exit */ }
    return exited;
  }

  private async sendRequest(
    input: WorkerRequest,
    options: { timeoutMs?: number; existingWorker?: ChildProcess; onAdmission?: () => void; onReply?: (ok: boolean) => void } = {},
  ): Promise<Record<string, unknown>> {
    if (this.worker && (!this.worker.connected || this.worker.killed)) {
      void this.retireWorker(new Error('Dictation worker IPC disconnected'));
    }
    while (this.retiring) {
      if (options.existingWorker) throw new Error('Dictation worker generation is closing');
      await this.retiring;
    }
    if (this.stopping) throw new Error('Dictation worker shut down');
    if (options.existingWorker && options.existingWorker !== this.worker)
      throw new Error('Dictation worker generation changed');

    const worker = this.worker ?? this.openWorker();
    const requestId = randomUUID();
    this.clearIdleTimer();
    options.onAdmission?.();
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        // Return the timeout to the caller, but retain native activity until the
        // original worker acknowledges the request or physically exits.
        reject(new Error(`Dictation worker request timed out: ${input.type}`));
      }, options.timeoutMs ?? this.requestTimeoutMs);
      this.pendingRequests.set(requestId, { resolve, reject, timeout, ...(options.onReply ? { onReply: options.onReply } : {}) });
      const sent = (error: Error | null) => {
        if (error && this.pendingRequests.has(requestId)) {
          void this.retireWorker(error);
        }
      };
      try {
        if (!worker.send) sent(new Error('Dictation worker IPC is unavailable'));
        else worker.send({ ...input, requestId }, sent);
      } catch (error) {
        sent(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  private openWorker(): ChildProcess {
    const worker = this.forkWorker();
    this.worker = worker;
    this.stderrTail = '';
    this.workerExit = new Promise<void>((resolve) => {
      const settle = (code: number | null, signal: NodeJS.Signals | null, spawnError?: Error) => {
        resolve();
        this.handleWorkerExit(worker, code, signal, spawnError);
      };
      // Retirement follows the process lifetime. After a parent-initiated
      // disconnect and kill, Node may emit exit without emitting close.
      worker.once('exit', settle);
      worker.on('error', (error) => {
        if (worker.pid === undefined) settle(null, null, error);
        else if (worker === this.worker && !this.retiring) void this.retireWorker(error);
      });
    });
    worker.stderr?.on('data', (chunk) => {
      if (worker !== this.worker) return;
      const text = Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
      this.stderrTail = (this.stderrTail + text).slice(-STDERR_TAIL_MAX_CHARS);
    });
    worker.on('message', (message) => {
      if (worker === this.worker && !this.retiring) this.handleWorkerMessage(message);
    });
    worker.once('disconnect', () => {
      if (worker === this.worker && !this.retiring)
        void this.retireWorker(new Error('Dictation worker IPC disconnected'));
    });
    return worker;
  }

  private handleWorkerMessage(message: unknown): void {
    const value = asRecord(message);
    if (value.type === 'response' && typeof value.requestId === 'string') {
      const pending = this.pendingRequests.get(value.requestId);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timeout);
      this.pendingRequests.delete(value.requestId);
      pending.onReply?.(Boolean(value.ok));
      this.scheduleIdleShutdownIfReady();
      if (value.ok) {
        pending.resolve(asRecord(value.result));
      } else {
        pending.reject(new Error(typeof value.error === 'string' ? value.error : 'Dictation worker request failed'));
      }
      return;
    }

    const emitter = typeof value.sessionId === 'string' ? this.sessionEmitters.get(value.sessionId) : undefined;
    if (!emitter) {
      return;
    }
    switch (value.type) {
      case 'session.committed':
        emitter.emit('committed', value.payload);
        return;
      case 'session.transcript':
        emitter.emit('transcript', value.payload);
        return;
      case 'session.error':
        emitter.emit('error', new Error(typeof value.error === 'string' ? value.error : 'Dictation session failed'));
        return;
      default:
    }
  }

  private handleWorkerExit(worker: ChildProcess, code: number | null, signal: NodeJS.Signals | null, spawnError?: Error): void {
    if (this.worker !== worker) return;
    const wasRetiring = this.retiring !== null;
    this.worker = null;
    this.workerExit = null;
    this.retiring = null;
    this.clearIdleTimer();
    if (!wasRetiring) {
      const stderr = this.stderrTail.trim();
      this.failConsumers(spawnError ?? new Error(
        `Dictation worker exited (code ${code ?? 'null'}${signal ? `, signal ${signal}` : ''}).` +
          (stderr ? ` Last stderr: ${stderr.slice(-500)}` : ''),
      ));
    }
  }

  private failConsumers(error: Error): void {
    this.rejectAllPending(error);
    const emitters = [...this.sessionEmitters.values()];
    this.sessionEmitters.clear();
    for (const emitter of emitters) {
      if (emitter.listenerCount('error') > 0) emitter.emit('error', error);
    }
  }

  rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }

  emitSessionError(sessionId: string, error: unknown): void {
    const emitter = this.sessionEmitters.get(sessionId);
    if (emitter && emitter.listenerCount('error') > 0) {
      emitter.emit('error', error instanceof Error ? error : new Error(String(error)));
    }
  }

  private scheduleIdleShutdownIfReady(): void {
    if (!this.worker || this.retiring || this.stopping || this.pendingRequests.size || this.sessionEmitters.size) return;
    this.clearIdleTimer();
    this.idleTimer = setTimeout(() => {
      if (!this.pendingRequests.size && !this.sessionEmitters.size) void this.retireWorker();
    }, this.idleTtlMs);
    this.idleTimer.unref();
  }

  clearIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * StreamingTranscriptionSession backed by the worker process.
 * Matches the session contract consumed by DictationStreamManager.
 */
export class WorkerBackedTranscriptionSession extends EventEmitter {
  readonly client: DictationWorkerClient;
  readonly modelConfig: { modelId: string; modelsDir: string; language?: string };
  requiredSampleRate: number;
  private connectedSessionId: string | null;
  private connecting: Promise<void> | null;
  private closed = false;

  /**
   * @param {DictationWorkerClient} client
   * @param {{ modelsDir: string, modelId: string }} modelConfig
   */
  constructor(client: DictationWorkerClient, modelConfig: { modelId: string; modelsDir: string; language?: string }) {
    super();
    this.client = client;
    this.modelConfig = modelConfig;
    this.requiredSampleRate = DEFAULT_LOCAL_SAMPLE_RATE;
    this.connectedSessionId = null;
    this.connecting = null;
  }

  async connect(): Promise<void> {
    if (this.closed) throw new Error('Local STT session closed');
    if (this.connectedSessionId) {
      return;
    }
    if (!this.connecting) {
      this.connecting = (async () => {
        try {
          const result = await this.client.createSession(this.modelConfig, this);
          if (this.closed) {
            this.client.closeSession(result.sessionId);
            throw new Error('Local STT session closed');
          }
          this.connectedSessionId = result.sessionId;
          this.requiredSampleRate = result.requiredSampleRate;
        } finally {
          this.connecting = null;
        }
      })();
    }
    await this.connecting;
  }

  appendPcm16(pcm16le: Buffer): void {
    if (!this.connectedSessionId) {
      this.emit('error', new Error('Local STT session not connected'));
      return;
    }
    this.client.appendSessionAudio(this.connectedSessionId, pcm16le);
  }

  commit(): void {
    if (!this.connectedSessionId) {
      this.emit('error', new Error('Local STT session not connected'));
      return;
    }
    this.client.commitSession(this.connectedSessionId);
  }

  clear(): void {
    if (this.connectedSessionId) {
      this.client.clearSession(this.connectedSessionId);
    }
  }

  close(): void {
    this.closed = true;
    const sessionId = this.connectedSessionId;
    this.connectedSessionId = null;
    if (sessionId) {
      this.client.closeSession(sessionId);
    }
  }
}
