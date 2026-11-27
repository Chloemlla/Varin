import { access, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it as test } from 'vitest';
import { runLocalSupervisor, type SupervisorRunnerOptions } from './supervisor-runner.js';
import { SupervisorJournal } from './supervisor-journal.js';
import { PARK_EXIT_CODE } from './host-parking.js';

const owner = 'original-persistent-host';
const fixtureProgram = `
import { createServer } from 'node:http';
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const root = process.env.TEST_SUPERVISOR_ROOT;
const launchId = process.env.VARIN_LOCAL_SUPERVISOR_LAUNCH_ID;
const command = join(root, String(process.pid));
const server = createServer((req, res) => {
  const ready = !existsSync(join(root, 'hold-readiness'));
  res.writeHead(req.url !== '/health' ? 404 : ready ? 200 : 503, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ status: ready ? 'ok' : 'unavailable', ready, kernel: { ready } }));
});
server.listen(0, '127.0.0.1', () => process.send({ type: 'varin:ready', port: server.address().port }));
const close = (code) => { clearInterval(watch); server.close(() => process.exit(code)); };
const watch = setInterval(() => {
  if (!existsSync(command)) return;
  const config = JSON.parse(readFileSync(command, 'utf8'));
  clearInterval(watch);
  if (!config.park) return close(config.code);
  if (config.marker) {
    const dir = join(root, 'supervisor-wake');
    const fd = openSync(join(dir, 'park-' + launchId + '.json'), 'wx', 0o600);
    writeFileSync(fd, JSON.stringify({ version: 1, owner: config.owner, launchId, pid: process.pid, revision: config.revision }));
    fsyncSync(fd); closeSync(fd);
    const directory = openSync(dir, 'r'); fsyncSync(directory); closeSync(directory);
  }
  process.send({ type: 'varin:supervisor-parked', owner: config.owner, pid: process.pid,
    launchId: config.wrongLaunch ? 'different-process' : launchId,
    wakeRevision: config.revision }, () => close(config.code));
}, 30);
process.on('SIGTERM', () => close(0));
process.on('disconnect', () => close(0));
`;
type Event = Parameters<NonNullable<SupervisorRunnerOptions['status']>>;
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const exists = (file: string) => access(file).then(() => true, () => false);
const it = test.skipIf(process.platform === 'win32');
async function fixture(run: (f: {
  folder: string; journal: SupervisorJournal; events: Event[]; signal: AbortController;
  launch(): ReturnType<typeof runLocalSupervisor>; command(pid: number, value: object): Promise<void>;
}) => Promise<void>) {
  const folder = await mkdtemp(path.join(tmpdir(), 'varin-resident-supervisor-'));
  const signal = new AbortController();
  const entry = path.join(folder, 'child.mjs');
  const journal = await SupervisorJournal.open(path.join(folder, 'supervisor-wake'), owner);
  const events: Event[] = [];
  let runner: ReturnType<typeof runLocalSupervisor> | undefined;
  await writeFile(entry, fixtureProgram, { mode: 0o600 });
  const launch = () => runner ??= runLocalSupervisor({ journal, entry, signal: signal.signal, pollMs: 30,
    startupMs: 5000, stopMs: 2000, env: { ...process.env, TEST_SUPERVISOR_ROOT: folder },
    status: (...event) => events.push(event) });
  const command = async (pid: number, value: object) => {
    const target = path.join(folder, String(pid));
    await writeFile(target + '.tmp', JSON.stringify(value));
    await rename(target + '.tmp', target);
  };
  try { await run({ folder, journal, events, signal, launch, command }); }
  finally {
    signal.abort();
    try { await runner; } finally { await rm(folder, { recursive: true, force: true }); }
  }
}
const pids = (events: Event[], step: Event[0]) => events.filter(([state]) => state === step).map(([, id]) => id!);
const readyFile = (journal: SupervisorJournal, rev: number) =>
  path.join(journal.directory, 'wake-ready-' + String(rev).padStart(16, '0') + '.json');
const poll = { interval: 50, timeout: 5000 };

it('starts the actual subprocess, acknowledges only ready health, restarts an unclaimed clean exit, and stops on request', async () => {
  await fixture(async ({ folder, journal, events, signal, launch, command }) => {
    const hold = path.join(folder, 'hold-readiness');
    await writeFile(hold, 'hold');
    await journal.publishWake({ revision: 1, nextWakeAtMs: Date.now() });
    const processDone = launch();
    await expect.poll(() => pids(events, 'started').length, poll).toBe(1);
    await delay(300);
    expect(await exists(readyFile(journal, 1))).toBe(false);
    expect(pids(events, 'ready')).toEqual([]);
    await rm(hold);
    await expect.poll(() => exists(readyFile(journal, 1)), poll).toBe(true);
    const first = pids(events, 'ready')[0]!;
    expect(alive(first)).toBe(true);
    await command(first, { code: 0 });
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(2);
    const second = pids(events, 'ready')[1]!;
    expect(second).not.toBe(first);
    expect(alive(first)).toBe(false);
    expect(pids(events, 'parked')).toEqual([]);
    signal.abort();
    await expect(processDone).resolves.toEqual({ stoppedCleanly: true });
    expect(pids(events, 'stopped')).toEqual([second]);
    expect(alive(second)).toBe(false);
  });
}, 15_000);

it('can wait without an existing child only for a current authenticated receipt, and accepted durable input then wakes the original owner', async () => {
  await fixture(async ({ journal, events, launch, command }) => {
    await journal.publishWake({ revision: 1, nextWakeAtMs: null });
    void launch();
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(1);
    const first = pids(events, 'ready')[0]!;
    await command(first, { park: true, owner, revision: 1, code: PARK_EXIT_CODE, marker: true, wrongLaunch: true });
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(2);
    const second = pids(events, 'ready')[1]!;
    await command(second, { park: true, owner, revision: 1, code: PARK_EXIT_CODE });
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(3);
    const third = pids(events, 'ready')[2]!;
    await command(third, { park: true, owner, revision: 1, code: PARK_EXIT_CODE, marker: true });
    await expect.poll(() => pids(events, 'parked'), poll).toEqual([third]);
    expect(alive(third)).toBe(false);
    await delay(150);
    expect(pids(events, 'started')).toEqual([first, second, third]);
    await journal.accept('fixture-page', {
      identity: { principalId: 'original-user', source: { extensionId: 'event.test', sourceId: 'source', connectionId: 'conn', accountId: 'account' } },
      expectedCursor: null, nextCursor: 'first-cursor', status: null, events: [
        { eventId: 'first-event', objectId: null, revision: null, occurredAtMs: 5, attributes: {},
          content: { data: null, parts: [] }, echoOf: null },
      ],
    });
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(4);
    expect(await journal.hasPendingEvents()).toBe(true); // Only the original Catalog consumes payloads.
  });
}, 15_000);

it('waits without a child through a future wake and verifies readiness for that same revision', async () => {
  await fixture(async ({ journal, events, launch, command }) => {
    const deadline = Date.now() + 1200;
    await journal.publishWake({ revision: 8, nextWakeAtMs: deadline });
    void launch();
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(1);
    const first = pids(events, 'ready')[0]!;
    await command(first, { park: true, owner, revision: 8, code: PARK_EXIT_CODE, marker: true });
    await expect.poll(() => pids(events, 'parked'), poll).toEqual([first]);
    expect(alive(first)).toBe(false);
    expect(await exists(readyFile(journal, 8))).toBe(false);
    await expect.poll(() => pids(events, 'ready').length, poll).toBe(2);
    expect(Date.now()).toBeGreaterThanOrEqual(deadline);
    expect(pids(events, 'ready')[1]).not.toBe(first);
    await expect.poll(() => exists(readyFile(journal, 8)), poll).toBe(true);
  });
}, 15_000);
