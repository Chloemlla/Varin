import { spawn } from 'node:child_process';
import crypto, { randomUUID } from 'node:crypto';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import type { IngressInbox } from './ingress-inbox.js';
import type { SupervisorJournal } from './supervisor-journal.js';
import { openSupervisorGateway } from './supervisor-gateway.js';
import { PARK_EXIT_CODE, SUPERVISOR_LAUNCH, SUPERVISOR_PARKING } from './host-parking.js';
import { authenticateOfflineGateway } from '../client-auth/remote-clients.js';
import type { ResourceProvider } from '../deployment/resource-provider.js';
import type { createSupervisorSandbox } from './supervisor-sandbox.js';

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
  parking?: { listenPort: number; idleMs: number };
  sandboxProvider?: ResourceProvider;
  ingressInbox?: IngressInbox;
  listening?(port: number): void;
}
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const livePort = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65535;
const revision = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const wait = (ms: number, signal: AbortSignal) => delay(ms, undefined, { signal }).catch(error => {
  if (!signal.aborted) throw error;
});

function launch(options: SupervisorRunnerOptions, sandbox?: ReturnType<typeof createSupervisorSandbox>) {
  const launchId = randomUUID();
  const inboxProof = randomUUID();
  let inboxProofDelivered = false;
  const child = spawn(process.execPath, [options.entry], {
    env: { ...options.env, VARIN_HOST: '127.0.0.1', VARIN_LOCAL_SUPERVISOR: '1', [SUPERVISOR_LAUNCH]: launchId,
      [SUPERVISOR_PARKING]: options.parking ? '1' : '0', ...(options.parking && { VARIN_PORT: '0' }) },
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  sandbox?.attach(child);
  let exit: Exit | undefined;
  let port: number | undefined;
  let ready = false;
  let park: number | undefined;
  let invalidPark = false;
  let parkRequestedAt: number | undefined;
  let canPark = false;
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
    if (message.type === 'varin:inbox-proof' && options.parking && !inboxProofDelivered && typeof message.nonce === 'string') {
      inboxProofDelivered = true;
      child.send({ nonce: message.nonce, proof: inboxProof }, () => undefined);
    }
    if (message.type === 'varin:ready' && livePort(message.port) && port === undefined) port = message.port;
    if (message.type === 'varin:supervisor-can-park' && message.launchId === launchId) canPark = true;
    if (message.type === 'varin:supervisor-park-declined' && message.launchId === launchId && park === undefined) parkRequestedAt = undefined;
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
    launchId,
    inboxProof,
    parkRevision: () => invalidPark ? undefined : park,
    canPark: () => canPark,
    port: () => ready && parkRequestedAt === undefined ? port : undefined,
    parkTimedOut: () => parkRequestedAt !== undefined && performance.now() - parkRequestedAt >= (options.stopMs ?? 60_000),
    requestPark() {
      if (parkRequestedAt !== undefined || !child.connected) return;
      parkRequestedAt = performance.now();
      child.send({ type: 'varin:try-park' }, error => { if (error) parkRequestedAt = undefined; });
    },
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
  const localInbox = options.parking && !options.ingressInbox ? new (await import('./user-inbox.js')).SupervisorUserInbox(options.journal.directory) : undefined;
  const inbox = options.ingressInbox ?? localInbox;
  let gateway: Awaited<ReturnType<typeof openSupervisorGateway>> | undefined;
  let receiverWake = false;
  const sandbox = options.parking && options.sandboxProvider
    ? (await import('./supervisor-sandbox.js')).createSupervisorSandbox(options.sandboxProvider, options.journal, () => {
      receiverWake = true; gateway?.wake();
    })
    : undefined;
  try {
    if (options.parking && inbox) {
      const storePath = path.join(path.dirname(options.journal.directory), 'remote-clients.json');
      gateway = await openSupervisorGateway(options.parking.listenPort, { inbox,
        authenticate: authorization => authenticateOfflineGateway(authorization, { crypto, fsPromises, path, storePath }) });
    }
    if (gateway) options.listening?.(gateway.port);
    return await supervise(options, gateway, sandbox, () => receiverWake, () => { receiverWake = false; });
  } finally {
    try { await sandbox?.close(); }
    finally {
      try { await gateway?.close(); }
      finally { localInbox?.close(); }
    }
  }
}

async function supervise(options: SupervisorRunnerOptions, gateway: Awaited<ReturnType<typeof openSupervisorGateway>> | undefined,
  sandbox: ReturnType<typeof createSupervisorSandbox> | undefined, hasReceiverDemand: () => boolean,
  clearReceiverDemand: () => void): Promise<{ stoppedCleanly: boolean }> {
  const interval = options.pollMs ?? 1000;
  let start = true; // A fresh supervisor conservatively reconciles the original Host.
  let failures = 0;
  while (!options.signal.aborted) {
    if (!start) {
      const wanted = await options.journal.currentWake();
      // Crash replay stays with the child Catalog; no journal body leaves this process.
      if (!hasReceiverDemand() && !await gateway?.hasDemand() && !await options.journal.hasPendingEvents() && (wanted?.nextWakeAtMs == null || wanted.nextWakeAtMs > Date.now())) {
        const untilWake = wanted?.nextWakeAtMs == null ? interval : Math.max(1, wanted.nextWakeAtMs - Date.now());
        const delayMs = Math.min(interval, untilWake);
        if (gateway) await gateway.waitForDemand(delayMs, options.signal);
        else await wait(delayMs, options.signal);
        continue;
      }
    }
    if (options.signal.aborted) break;
    await sandbox?.returnReceivers();
    clearReceiverDemand();
    const child = launch(options, sandbox);
    let readyAt = 0;
    let fault: unknown;
    try {
      options.status?.('started', child.pid);
      if (await child.awaitReady()) {
        readyAt = performance.now();
        let lastParkAttempt = readyAt;
        let announcedReady = false;
        const announceReady = () => {
          if (announcedReady) return;
          announcedReady = true;
          options.status?.('ready', child.pid);
        };
        if (!gateway) announceReady();
        let receiptRevision: number | undefined;
        const noReceipt = new Error('Original Host is not ready');
        while (!child.signal.aborted) {
          if (gateway && options.parking) {
            if (child.parkTimedOut()) break;
            const port = child.port();
            if (port) {
              gateway.activate(port, child.inboxProof, child.signal);
              announceReady();
            }
            if (port && child.canPark() && await gateway.quietFor() >= options.parking.idleMs && performance.now() - lastParkAttempt >= options.parking.idleMs) {
              lastParkAttempt = performance.now();
              gateway.setTarget(undefined);
              child.requestPark();
            }
          }
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
    gateway?.setTarget(undefined);
    const naturalExit = child.exit();
    const result = naturalExit ?? await child.stop();
    const claimed = child.parkRevision();
    const parked = naturalExit?.code === PARK_EXIT_CODE && result.signal === null && fault === undefined && child.pid !== undefined &&
      claimed !== undefined && await options.journal.consumePark({ launchId: child.launchId, pid: child.pid, revision: claimed }).catch(() => false);
    if (options.signal.aborted) {
      options.status?.('stopped', child.pid);
      return { stoppedCleanly: parked || result.code === 0 && result.signal === null };
    }
    if (parked) {
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
