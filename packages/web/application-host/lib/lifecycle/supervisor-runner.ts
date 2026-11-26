import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { SupervisorJournal } from './supervisor-journal.js';

export const SUPERVISOR_LAUNCH = 'VARIN_LOCAL_SUPERVISOR_LAUNCH_ID';
export const validSupervisorLaunch = (value: string | undefined): value is string =>
  typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

interface Exit { code: number | null; signal: NodeJS.Signals | null }
export interface SupervisorRunnerOptions {
  journal: SupervisorJournal;
  entry: string;
  env: NodeJS.ProcessEnv;
  signal: AbortSignal;
  /** These expose content-free transitions; the CLI never logs journal pages or credentials. */
  status?(event: 'started' | 'ready' | 'stopped' | 'restarting' | 'parked', pid: number | undefined): void;
  pollMs?: number;
  startupMs?: number;
  stopMs?: number;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const livePort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).catch(error => {
  if (!signal.aborted) throw error;
});

function launch(options: SupervisorRunnerOptions) {
  const launchId = randomUUID();
  const child = spawn(process.execPath, [options.entry], {
    env: { ...options.env, VARIN_HOST: '127.0.0.1', VARIN_LOCAL_SUPERVISOR: '1', [SUPERVISOR_LAUNCH]: launchId },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let exit: Exit | undefined;
  let port: number | undefined;
  let ready = false;
  let park: number | undefined;
  let invalidPark = false;
  const ended = new AbortController();
  const exited = new Promise<Exit>(resolve => {
    // close follows process exit and IPC closure; do not start another Host earlier.
    child.once('close', (code, signal) => {
      exit = { code, signal };
      ended.abort();
      resolve(exit);
    });
    child.on('error', () => undefined); // close reports a failed spawn too.
  });
  child.on('message', (message: unknown) => {
    if (!object(message)) return;
    if (message.type === 'varin:ready' && livePort(message.port) && port === undefined) port = message.port;
    // Reserved for a future lossless owner close. A clean OS exit, external
    // file, unauthenticated network response, or wrong process cannot substitute.
    if (message.type === 'varin:supervisor-parked') {
      if (!ready || message.launchId !== launchId || message.owner !== options.journal.owner ||
          message.pid !== child.pid || !revision(message.wakeRevision) || park !== undefined) {
        invalidPark = true;
      } else park = message.wakeRevision;
    }
  });
  const cycleSignal = AbortSignal.any([options.signal, ended.signal]);
  const responsive = async () => {
    if (cycleSignal.aborted || !port) return false;
    try {
      const status = await fetch(`http://127.0.0.1:${port}/health`, {
        redirect: 'error', signal: AbortSignal.any([cycleSignal, AbortSignal.timeout(1000)]),
      });
      if (!status.ok) { await status.body?.cancel(); return false; }
      const body: unknown = await status.json();
      return !cycleSignal.aborted && object(body) && body.status === 'ok' && body.ready === true &&
        object(body.kernel) && body.kernel.ready === true;
    } catch { return false; }
  };
  let stop: Promise<Exit> | undefined;
  return {
    pid: child.pid,
    signal: cycleSignal,
    exited,
    exit: () => exit,
    parkRevision: () => invalidPark ? undefined : park,
    responsive,
    async awaitReady(): Promise<boolean> {
      // Monotonic time for the process-startup budget; wake deadlines use UTC.
      const deadline = performance.now() + (options.startupMs ?? 60_000);
      while (!cycleSignal.aborted && performance.now() < deadline) {
        if (await responsive()) { ready = true; return true; }
        await wait(100, cycleSignal);
      }
      return false;
    },
    stop() {
      return stop ??= (async () => {
        if (exit) return exit;
        // Host owns the normal graceful drain; hard stop is reported by the
        // actual signal status, and never gives a positive Park receipt.
        child.kill('SIGTERM');
        const force = setTimeout(() => { if (!exit) child.kill('SIGKILL'); }, options.stopMs ?? 60_000);
        force.unref();
        try { return await exited; } finally { clearTimeout(force); }
      })();
    },
  };
}

export async function runLocalSupervisor(options: SupervisorRunnerOptions): Promise<{ stoppedCleanly: boolean }> {
  const interval = options.pollMs ?? 1000;
  let start = true; // A fresh supervisor conservatively reconciles the original Host.
  let failures = 0;
  while (!options.signal.aborted) {
    if (!start) {
      const wanted = await options.journal.currentWake();
      // Crash replay stays with the child Catalog; no journal body leaves this process.
      if (!await options.journal.hasPendingEvents() && (wanted?.nextWakeAtMs == null || wanted.nextWakeAtMs > Date.now())) {
        const untilWake = wanted?.nextWakeAtMs == null ? interval : Math.max(1, wanted.nextWakeAtMs - Date.now());
        await wait(Math.min(interval, untilWake), options.signal);
        continue;
      }
    }
    if (options.signal.aborted) break;
    const child = launch(options);
    let readyAt = 0;
    let fault: unknown;
    try {
      options.status?.('started', child.pid);
      if (await child.awaitReady()) {
        readyAt = performance.now();
        options.status?.('ready', child.pid);
        let receiptRevision: number | undefined;
        const noReceipt = new Error('Original Host is not ready');
        while (!child.signal.aborted) {
          const publication = await options.journal.currentWake();
          if (publication && publication.nextWakeAtMs != null && publication.nextWakeAtMs <= Date.now() &&
              receiptRevision !== publication.revision) {
            const result = await options.journal.reconcileDueWake(publication.revision, Date.now(), async () => {
              if (!await child.responsive()) throw noReceipt;
            }).catch(error => { if (error === noReceipt) return 'waiting'; throw error; });
            if (result === 'ready') receiptRevision = publication.revision;
          }
          await wait(interval, child.signal);
        }
      }
    } catch (error) { fault = error; }
    const naturalExit = child.exit();
    const result = naturalExit ?? await child.stop();
    if (options.signal.aborted) {
      options.status?.('stopped', child.pid);
      return { stoppedCleanly: result.code === 0 && result.signal === null };
    }
    const claimed = child.parkRevision();
    if (naturalExit && result.code === 0 && result.signal === null && fault === undefined &&
        claimed !== undefined && (await options.journal.currentWake())?.revision === claimed) {
      options.status?.('parked', child.pid);
      start = false;
      failures = 0;
      continue;
    }
    if (fault !== undefined) throw fault;
    start = true;
    failures = readyAt && performance.now() - readyAt >= 30_000 ? 0 : Math.min(failures + 1, 6);
    options.status?.('restarting', child.pid);
    await wait(Math.min(15_000, interval * 2 ** failures), options.signal);
  }
  return { stoppedCleanly: true };
}
