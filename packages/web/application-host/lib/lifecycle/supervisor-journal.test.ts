import { chmod, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test, vi } from 'vitest';
import type { FollowupEventReceiveParams, FollowupEventReceiveReceipt } from '@varin/protocol';
import { SupervisorJournal } from './supervisor-journal.js';
import { startSupervisorInbox } from './supervisor-inbox.js';
import { waitForPublishedWake } from './local-supervisor.js';

const owner = 'stable-original-owner';
const it = test.skipIf(process.platform === 'win32');

test.runIf(process.platform === 'win32')('reports unsupported directory durability before creating a journal', async () => {
  await inDirectory(async folder => {
    await expect(SupervisorJournal.open(folder, owner)).rejects.toThrow('POSIX directory sync');
    await expect(readdir(folder)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
const identity = { principalId: 'original-user', source: { extensionId: 'original.extension', sourceId: 'events', connectionId: 'connection', accountId: 'account' } };
const page: FollowupEventReceiveParams = {
  identity, expectedCursor: null, nextCursor: 'first-original-cursor', status: null,
  events: [{ eventId: 'original-event', objectId: 'original-object', revision: '1', occurredAtMs: 20, attributes: {},
    content: { data: null, parts: [{ kind: 'text', text: 'original input' }] }, echoOf: null }],
};
async function inDirectory(run: (folder: string) => Promise<void>) {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-supervisor-'));
  try { await run(path.join(root, 'journal')); } finally { await rm(root, { recursive: true, force: true }); }
}

/** Same cursor/duplicate rules as the Catalog, independent of the journal. */
function catalog() {
  let cursor: string | null = null;
  const accepted = new Set<string>();
  const receive = vi.fn(async (request: FollowupEventReceiveParams): Promise<FollowupEventReceiveReceipt> => {
    expect(request.identity).toEqual(identity);
    const fresh = request.events.filter(event => !accepted.has(event.eventId));
    if (cursor !== request.expectedCursor && !(fresh.length === 0 && cursor === request.nextCursor)) {
      throw new Error('event source cursor changed');
    }
    for (const item of fresh) accepted.add(item.eventId);
    cursor = request.nextCursor;
    return { accepted: fresh.length, duplicates: request.events.length - fresh.length,
      checkpoint: { identity, cursor, status: null } };
  });
  return { accepted, receive };
}

it('reopens after acceptance and after Catalog commit without losing or duplicating the original input', async () => inDirectory(async folder => {
  const original = catalog();
  const acceptedBeforeCrash = await SupervisorJournal.open(folder, owner, { afterEventCommit: () => { throw new Error('lost caller receipt'); } });
  await expect(acceptedBeforeCrash.accept('original-page', page)).rejects.toThrow('lost caller receipt');

  const commitsThenDies = await SupervisorJournal.open(folder, owner, { afterCatalogReceipt: () => { throw new Error('lost local acknowledgement'); } });
  expect(await commitsThenDies.hasPendingEvents()).toBe(true);
  await expect(commitsThenDies.replay(original.receive)).rejects.toThrow('lost local acknowledgement');
  expect([...original.accepted]).toEqual(['original-event']);

  const survivor = await SupervisorJournal.open(folder, owner);
  expect(await survivor.replay(original.receive)).toEqual({ delivered: 1, retained: 0 });
  expect(original.receive.mock.calls).toEqual([[page, undefined], [page, undefined]]);
  expect([...original.accepted]).toEqual(['original-event']);
  expect(await survivor.hasPendingEvents()).toBe(false);
  expect((await readdir(folder)).filter(name => name.endsWith('.ack'))).toHaveLength(1);
  expect((await readdir(folder)).filter(name => name.endsWith('.archived'))).toHaveLength(0);
  await survivor.accept('original-page', page);
  expect(await survivor.hasPendingEvents()).toBe(false);
  await expect(survivor.accept('original-page', { ...page, nextCursor: 'conflicting-cursor' })).rejects.toThrow('key conflict');
  await expect(SupervisorJournal.open(folder, 'wrong-owner')).rejects.toThrow('key conflict');
}));

it('recovers a durable wake publication and fences superseded wake notifications', async () => inDirectory(async folder => {
  const failing = await SupervisorJournal.open(folder, owner, { afterWakeCommit: () => { throw new Error('publisher interrupted'); } });
  await expect(failing.publishWake({ revision: 41, nextWakeAtMs: 100 })).rejects.toThrow('publisher interrupted');
  const supervisor = await SupervisorJournal.open(folder, owner);
  expect(await supervisor.currentWake()).toEqual({ revision: 41, nextWakeAtMs: 100 });
  const ensureRunning = vi.fn(async () => {});
  expect(await supervisor.reconcileDueWake(41, 99, ensureRunning)).toBe('waiting');
  expect(ensureRunning).not.toHaveBeenCalled();
  await expect(supervisor.reconcileDueWake(41, 100, async () => { throw new Error('not ready'); })).rejects.toThrow('not ready');
  expect((await readdir(folder)).some(file => file.startsWith('wake-ready'))).toBe(false);

  expect(await supervisor.reconcileDueWake(41, 100, async () => {
    await supervisor.publishWake({ revision: 42, nextWakeAtMs: 200 });
  })).toBe('stale');
  expect(await supervisor.reconcileDueWake(41, 300, ensureRunning)).toBe('stale');
  expect(ensureRunning).not.toHaveBeenCalled();
  expect(await supervisor.reconcileDueWake(42, 300, ensureRunning)).toBe('ready');
  expect(ensureRunning).toHaveBeenCalledOnce();
  expect((await readdir(folder)).filter(file => file.startsWith('wake-ready'))).toEqual(['wake-ready-0000000000000042.json']);
  await expect(supervisor.publishWake({ revision: 41, nextWakeAtMs: 100 })).rejects.toThrow('Stale');
  await expect(supervisor.publishWake({ revision: 42, nextWakeAtMs: 201 })).rejects.toThrow('key conflict');
}));

it('keeps a 26 day deadline absolute while rejecting a replaced timer and recovering an already due wake', async () => inDirectory(async folder => {
  const journal = await SupervisorJournal.open(folder, owner);
  const due = 26 * 24 * 60 * 60 * 1000;
  await journal.publishWake({ revision: 1, nextWakeAtMs: due });
  const ensureReady = vi.fn(async () => {});
  let now = 0;
  const wait = vi.fn(async (ms: number) => {
    expect(ms).toBe(60_000);
    now += ms;
    await journal.publishWake({ revision: 2, nextWakeAtMs: due });
  });
  expect(await waitForPublishedWake(journal, 1, ensureReady, { now: () => now, wait })).toBe('stale');
  expect(wait).toHaveBeenCalledOnce();
  expect(ensureReady).not.toHaveBeenCalled();

  const recovered = await SupervisorJournal.open(folder, owner);
  const finalWait = vi.fn(async (ms: number) => { now += ms; });
  now = due - 2;
  expect(await waitForPublishedWake(recovered, 2, ensureReady, { now: () => now, wait: finalWait })).toBe('ready');
  expect(finalWait).toHaveBeenCalledExactlyOnceWith(2);
  expect(ensureReady).toHaveBeenCalledOnce();
  expect(await waitForPublishedWake(recovered, 2, ensureReady, { now: () => now, wait: finalWait })).toBe('ready');
  expect(finalWait).toHaveBeenCalledOnce();
  expect(ensureReady).toHaveBeenCalledTimes(2);
}));

it('watches foreground inboxes and leaves unverifiable acknowledgements queued', async () => inDirectory(async folder => {
  const journal = await SupervisorJournal.open(folder, owner);
  const original = catalog();
  await journal.accept('pending-on-start', page);
  expect(await journal.replay(async request => ({
    accepted: request.events.length, duplicates: 0, checkpoint: { identity, cursor: 'forged-cursor', status: null },
  }))).toEqual({ delivered: 0, retained: 1 });
  expect(await journal.hasPendingEvents()).toBe(true);
  const inbox = startSupervisorInbox(journal, original.receive, () => {});
  try {
    await vi.waitFor(async () => expect(await journal.hasPendingEvents()).toBe(false));
    await journal.accept('new-while-watching', { ...page, expectedCursor: page.nextCursor, nextCursor: 'second-original-cursor',
      events: [{ ...page.events[0]!, eventId: 'second-original-event' }] });
    await vi.waitFor(async () => expect(await journal.hasPendingEvents()).toBe(false));
    expect([...original.accepted]).toEqual(['original-event', 'second-original-event']);
  } finally { await inbox.close(); }
}));

it('replays a pending cursor chain in one startup scan when hashed filenames are reversed', async () => inDirectory(async folder => {
  const journal = await SupervisorJournal.open(folder, owner);
  const original = catalog();
  const second = { ...page, expectedCursor: page.nextCursor, nextCursor: 'second-original-cursor',
    events: [{ ...page.events[0]!, eventId: 'second-event' }] };
  // SHA-256("two") sorts before SHA-256("one").
  await journal.accept('one', page);
  await journal.accept('two', second);
  const inbox = startSupervisorInbox(journal, original.receive, () => {});
  try {
    await inbox.initialReplay;
    expect(await journal.hasPendingEvents()).toBe(false);
    expect(original.receive.mock.calls.map(([input]) => input.nextCursor)).toEqual([page.nextCursor, second.nextCursor]);
  } finally { await inbox.close(); }
}));

it('rejects a journal directory accessible to another OS user', async () => inDirectory(async folder => {
  await SupervisorJournal.open(folder, owner);
  await chmod(folder, 0o755);
  await expect(SupervisorJournal.open(folder, owner)).rejects.toThrow('private');
}));
