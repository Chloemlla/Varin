import { execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { SupervisorJournal } from './supervisor-journal.js';
import { runLocalSupervisor } from './supervisor-runner.js';
import type { FollowupEventReceiveParams } from '@varin/protocol';

async function readPage(): Promise<FollowupEventReceiveParams> {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    length += bytes.length;
    if (length > 4 * 1024 * 1024) throw new Error('Supervisor input is too large');
    chunks.push(bytes);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as FollowupEventReceiveParams;
}

function ensureRunning(command: string[]): Promise<void> {
  const [executable, ...args] = command;
  if (!executable) throw new Error('A local readiness command is required');
  return new Promise((resolve, reject) => {
    // Do not forward journal content to an executable or let a journal record
    // pick a command. Operators supply explicit argv only.
    execFile(executable, args, { timeout: 30_000 }, error => {
      if (error) reject(new Error('Local readiness command failed')); else resolve();
    });
  });
}

/** Absolute wake deadlines can outlive a Node timer. Re-read the original
 * revision periodically so another supervisor can replace this registration. */
export async function waitForPublishedWake(
  journal: Pick<SupervisorJournal, 'currentWake' | 'reconcileDueWake'>,
  revision: number,
  ensureReady: () => Promise<void>,
  clock = { now: Date.now, wait: (ms: number) => sleep(ms) },
): Promise<'stale' | 'waiting' | 'ready'> {
  if (!Number.isSafeInteger(revision) || revision < 0) throw new Error('Invalid wake revision');
  for (;;) {
    const publication = await journal.currentWake();
    if (publication?.revision !== revision) return 'stale';
    if (publication.nextWakeAtMs === null) return 'waiting';
    const now = clock.now();
    if (publication.nextWakeAtMs <= now) return journal.reconcileDueWake(revision, now, ensureReady);
    await clock.wait(Math.min(publication.nextWakeAtMs - now, 60_000));
  }
}

async function main(argv: string[]): Promise<unknown> {
  const [directory, owner, action, ...args] = argv;
  if (!directory || !owner) throw new Error('Supervisor journal and owner are required');
  if (action === 'run' && path.basename(directory) !== 'supervisor-wake') throw new Error('A resident supervisor must use DATA_DIR/supervisor-wake');
  const journal = await SupervisorJournal.open(directory, owner);
  if (action === 'accept' && args.length === 1) return journal.accept(args[0]!, await readPage());
  if (action === 'publish' && args.length === 2) {
    if (!/^\d+$/.test(args[0]!) || !(args[1] === 'none' || /^\d+$/.test(args[1]!))) throw new Error('Invalid wake publication');
    return journal.publishWake({revision: Number(args[0]), nextWakeAtMs: args[1] === 'none' ? null : Number(args[1])});
  }
  if (action === 'status' && !args.length) return { wake: await journal.currentWake(), pending: await journal.hasPendingEvents() };
  if (action === 'run' && !args.length) {
    const stop = new AbortController();
    const requestStop = () => stop.abort();
    process.on('SIGTERM', requestStop);
    process.on('SIGINT', requestStop);
    try {
      const outcome = await runLocalSupervisor({ journal, entry: fileURLToPath(new URL('../../index.js', import.meta.url)),
        env: { ...process.env, VARIN_DATA_DIR: path.dirname(journal.directory) }, signal: stop.signal,
        status: (state, pid) => console.log(JSON.stringify({ supervisor: state, ...(pid === undefined ? {} : { pid }) })) });
      if (!outcome.stoppedCleanly) throw new Error('Application Host did not drain cleanly');
      return { supervisor: 'stopped' };
    } finally {
      process.off('SIGTERM', requestStop);
      process.off('SIGINT', requestStop);
    }
  }

  if (action === 'wake-due' && args.length > 2 && /^\d+$/.test(args[0]!) && args[1] === '--') {
    return { wake: await journal.reconcileDueWake(Number(args[0]), Date.now(), () => ensureRunning(args.slice(2))) };
  }
  if (action === 'wait-due' && args.length > 2 && /^\d+$/.test(args[0]!) && args[1] === '--') {
    return { wake: await waitForPublishedWake(journal, Number(args[0]), () => ensureRunning(args.slice(2))) };
  }
  if (action === 'wake-inbox' && args.length > 1 && args[0] === '--') {
    if (!await journal.hasPendingEvents()) return { wake: 'waiting' };
    await ensureRunning(args.slice(1));
    return { wake: 'ready' };
  }
  throw new Error('Invalid supervisor command');
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void main(process.argv.slice(2)).then(
    result => console.log(JSON.stringify(result)),
    () => { console.error('Local supervisor command failed'); process.exitCode = 1; },
  );
}
