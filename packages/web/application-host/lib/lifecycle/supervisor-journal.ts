import { createHash, randomUUID } from 'node:crypto';
import { constants, watch } from 'node:fs';
import { link, lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { FollowupEventReceiveParams, FollowupEventReceiveReceipt, FollowupEventSourceIdentity } from '@varin/protocol';
import type { DurableEventInbox } from './event-inbox.js';
import type { WakePublication, WakePublisher } from './wake-publisher.js';
import { validSupervisorLaunch } from './host-parking.js';

const maxRecordBytes = 4 * 1024 * 1024;
const version = 1;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const errorCode = (error: unknown) => (error as NodeJS.ErrnoException | undefined)?.code;
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === 'object' && !Array.isArray(value));
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 512;
const encode = (value: unknown) => JSON.stringify(value, (_key, item: unknown) => object(item)
  ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
const cursor = (value: unknown) => value === null || typeof value === 'string' && value.length <= 16_384;

interface EventEnvelope {
  version: 1;
  owner: string;
  eventKey: string;
  page: FollowupEventReceiveParams;
}
interface Receipt {
  version: 1;
  owner: string;
  digest: string;
}
interface EventAcknowledgement extends Receipt {
  durable?: true;
}
const verifyEventDigest = (ack: EventAcknowledgement, digest: string): void => {
  if (ack.digest !== digest) throw new Error('Supervisor journal key conflict');
};
export interface SupervisorJournalFaults {
  afterEventCommit?(): void;
  afterCatalogReceipt?(): void;
  afterWakeCommit?(): void;
}

const validPage = (page: unknown): page is FollowupEventReceiveParams => {
  if (!object(page) || !object(page.identity) || !object(page.identity.source) || !identifier(page.identity.principalId)
    || !cursor(page.expectedCursor) || !cursor(page.nextCursor)
    || !Array.isArray(page.events)
    || !(page.status === null || object(page.status))
    || !page.events.every(event => object(event) && identifier(event.eventId) && integer(event.occurredAtMs)
      && (event.objectId === null || identifier(event.objectId)) && (event.revision === null || identifier(event.revision))
      && (event.echoOf === null || object(event.echoOf)) && 'attributes' in event
      && object(event.content) && 'data' in event.content && Array.isArray(event.content.parts))) return false;
  const source = page.identity.source;
  return [source.extensionId, source.sourceId, source.connectionId, source.accountId].every(identifier);
};

/**
 * Single logical Host + its trusted local supervisor. A journal receipt does not
 * authorize stopping the Host or change who owns an event source or Calendar.
 */
export class SupervisorJournal implements WakePublisher, DurableEventInbox {
  private constructor(readonly directory: string, readonly owner: string, private readonly faults: SupervisorJournalFaults) {}

  static async open(directory: string, owner: string, faults: SupervisorJournalFaults = {}): Promise<SupervisorJournal> {
    if (process.platform === 'win32') throw new Error('Local supervisor journal requires durable POSIX directory sync');
    if (!path.isAbsolute(directory) || !identifier(owner)) throw new Error('Invalid supervisor journal configuration');
    await mkdir(directory, { mode: 0o700 }).catch(error => { if (errorCode(error) !== 'EEXIST') throw error; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('Supervisor journal directory must be private to the Host OS account');
    }
    const journal = new SupervisorJournal(directory, owner, faults);
    // Ensure the private directory itself survives the returning open receipt.
    await journal.syncDirectory(path.dirname(directory));
    await journal.put('owner.json', { version, owner });
    return journal;
  }

  private async syncDirectory(location = this.directory): Promise<void> {
    const handle = await open(location, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await handle.sync(); } finally { await handle.close(); }
  }

  private async read(name: string): Promise<{ value: unknown; raw: string } | null> {
    const handle = await open(path.join(this.directory, name), constants.O_RDONLY | constants.O_NOFOLLOW)
      .catch(error => { if (errorCode(error) === 'ENOENT') return null; throw error; });
    if (!handle) return null;
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > maxRecordBytes) throw new Error('Invalid supervisor journal record');
      const raw = await handle.readFile({ encoding: 'utf8' });
      if (Buffer.byteLength(raw) > maxRecordBytes) throw new Error('Invalid supervisor journal record');
      return { raw, value: JSON.parse(raw) as unknown };
    } finally { await handle.close(); }
  }

  /** Immutable, no-overwrite, cross-process write. A caller only gets a receipt after both syncs. */
  private async put(name: string, value: unknown): Promise<string> {
    const raw = encode(value);
    if (Buffer.byteLength(raw) > maxRecordBytes) throw new Error('Supervisor journal record is too large');
    const temporary = path.join(this.directory, '.tmp-' + randomUUID());
    const handle = await open(temporary, 'wx', 0o600);
    try {
      try { await handle.writeFile(raw, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      try { await link(temporary, path.join(this.directory, name)); }
      catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
        const prior = await this.read(name);
        if (!prior || prior.raw !== raw) throw new Error('Supervisor journal key conflict');
      }
      await this.syncDirectory();
      return hash(raw);
    } finally { await unlink(temporary).catch(() => undefined); }
  }

  private async eventAcknowledgement(key: string): Promise<EventAcknowledgement | undefined> {
    const file = await this.read(key + '.ack');
    if (!file) return undefined;
    const ack = file.value;
    if (!object(ack) || ack.version !== version || ack.owner !== this.owner
      || typeof ack.digest !== 'string' || !/^[0-9a-f]{64}$/.test(ack.digest)
      || ack.durable !== undefined && ack.durable !== true) throw new Error('Supervisor journal key conflict');
    return { version, owner: this.owner, digest: ack.digest, ...(ack.durable === true && { durable: true }) };
  }

  private async removeEventCopy(key: string, suffix: 'pending' | 'archived'): Promise<void> {
    await unlink(path.join(this.directory, key + '.' + suffix)).catch(error => {
      if (errorCode(error) !== 'ENOENT') throw error;
    });
  }

  async currentWake(): Promise<WakePublication | null> {
    const names = (await readdir(this.directory)).filter(name => /^wake-[0-9]{16}\.json$/.test(name)).sort();
    const latest = names.at(-1);
    if (!latest) return null;
    const record = (await this.read(latest))?.value;
    if (!object(record) || record.version !== version || record.owner !== this.owner
      || !integer(record.revision) || record.revision !== Number(latest.slice(5, -5))
      || !(record.nextWakeAtMs === null || integer(record.nextWakeAtMs))) throw new Error('Invalid wake registration');
    return { revision: record.revision, nextWakeAtMs: record.nextWakeAtMs };
  }

  async publishWake(input: WakePublication): Promise<{ revision: number; digest: string }> {
    if (!integer(input.revision) || !(input.nextWakeAtMs === null || integer(input.nextWakeAtMs))) throw new Error('Invalid wake registration');
    if (((await this.currentWake())?.revision ?? -1) > input.revision) throw new Error('Stale wake registration');
    const digest = await this.put('wake-' + String(input.revision).padStart(16, '0') + '.json', {
      version, owner: this.owner, revision: input.revision, nextWakeAtMs: input.nextWakeAtMs,
    });
    this.faults.afterWakeCommit?.();
    if ((await this.currentWake())?.revision !== input.revision) throw new Error('Stale wake registration');
    return { revision: input.revision, digest };
  }

  async recordPark(input: { launchId: string; pid: number; revision: number }): Promise<void> {
    if (!validSupervisorLaunch(input.launchId) || !integer(input.pid) || input.pid === 0 ||
      (await this.currentWake())?.revision !== input.revision) throw new Error('Invalid Host park receipt');
    await this.put('park-' + input.launchId + '.json', { version, owner: this.owner, ...input });
  }

  async consumePark(input: { launchId: string; pid: number; revision: number }): Promise<boolean> {
    if (!validSupervisorLaunch(input.launchId)) return false;
    const name = 'park-' + input.launchId + '.json';
    const marker = (await this.read(name))?.value;
    if (!isDeepStrictEqual(marker, { version, owner: this.owner, ...input }) ||
      (await this.currentWake())?.revision !== input.revision) return false;
    await unlink(path.join(this.directory, name));
    await this.syncDirectory();
    return true;
  }

  /** Reconcile (not fire business schedules): the caller owns a real process supervisor. */
  async reconcileDueWake(revision: number, now: number, ensureRunning: () => Promise<void>): Promise<'stale' | 'waiting' | 'ready'> {
    if (!integer(revision) || !integer(now)) throw new Error('Invalid wake reconciliation');
    const wake = await this.currentWake();
    if (wake?.revision !== revision) return 'stale';
    if (wake.nextWakeAtMs === null || wake.nextWakeAtMs > now) return 'waiting';
    const ack = 'wake-ready-' + String(revision).padStart(16, '0') + '.json';
    // Start/reconcile must be idempotent. A previous receipt acknowledged one
    // wake attempt, not a lease proving that the process remains alive now.
    await ensureRunning();
    if ((await this.currentWake())?.revision !== revision) return 'stale';
    await this.put(ack, { version, owner: this.owner, revision });
    return (await this.currentWake())?.revision === revision ? 'ready' : 'stale';
  }

  async accept(eventKey: string, page: FollowupEventReceiveParams): Promise<Receipt> {
    if (!identifier(eventKey) || !validPage(page)) throw new Error('Invalid supervisor event page');
    const filename = hash(eventKey);
    const envelope: EventEnvelope = { version, owner: this.owner, eventKey, page };
    const storedAck = await this.eventAcknowledgement(filename);
    if (storedAck) {
      const digest = hash(encode(envelope));
      verifyEventDigest(storedAck, digest);
      return { version, owner: this.owner, digest };
    }
    const archived = path.join(this.directory, filename + '.archived');
    const pending = path.join(this.directory, filename + '.pending');
    // Older journals only archived an event after delivery. Fix its identity
    // before a new acceptance can race replay's removal of the pending name.
    await link(pending, archived).catch(error => {
      if (errorCode(error) !== 'ENOENT' && errorCode(error) !== 'EEXIST') throw error;
    });
    const digest = await this.put(filename + '.archived', envelope);
    const acknowledged = await this.eventAcknowledgement(filename);
    if (acknowledged) {
      if (acknowledged.durable) {
        await this.removeEventCopy(filename, 'archived');
        await this.syncDirectory();
      }
      verifyEventDigest(acknowledged, digest);
    } else {
      await link(archived, pending).catch(async error => {
        if (errorCode(error) === 'EEXIST') return;
        if (errorCode(error) !== 'ENOENT') throw error;
        const retired = await this.eventAcknowledgement(filename);
        if (!retired) throw error;
        verifyEventDigest(retired, digest);
      });
      await this.syncDirectory();
    }
    this.faults.afterEventCommit?.();
    return { version, owner: this.owner, digest };
  }

  onPending(wake: () => void, onError: () => void) {
    const watcher = watch(this.directory, { persistent: false }, (_event, name) => {
      if (!name || /^[a-f0-9]{64}\.pending$/.test(name)) wake();
    });
    watcher.on('error', onError);
    return () => watcher.close();
  }

  async hasPendingEvents(): Promise<boolean> {
    return (await readdir(this.directory)).some(name => /^[a-f0-9]{64}\.pending$/.test(name));
  }

  async replay(receiveDurably: (page: FollowupEventReceiveParams, signal?: AbortSignal) => Promise<FollowupEventReceiveReceipt>, signal?: AbortSignal,
    keepReceiverParked?: (identity: FollowupEventSourceIdentity) => void) {
    let delivered = 0;
    const load = async (name: string) => {
      signal?.throwIfAborted();
      const record = await this.read(name);
      if (!record) return null;
      const { value } = record;
      if (!object(value) || value.version !== version || value.owner !== this.owner || !identifier(value.eventKey)
        || hash(value.eventKey) + '.pending' !== name || !validPage(value.page)) throw new Error('Invalid supervisor inbox entry');
      return { raw: record.raw, page: value.page };
    };
    const names = (await readdir(this.directory)).filter(value => /^[a-f0-9]{64}\.pending$/.test(value)).sort();
    // Event keys are content addresses. Their lexical order says nothing
    // about the receiving Catalog cursor. Index only the edges, not the bodies.
    const entries = new Map<string, { before: string; after: string }>();
    const successors = new Map<string, string[]>();
    const previous = new Set<string>();
    for (const name of names) {
      const record = await load(name);
      if (!record) continue;
      const { identity, expectedCursor, nextCursor } = record.page;
      const before = encode([identity, expectedCursor]);
      const after = encode([identity, nextCursor]);
      entries.set(name, { before, after });
      if (before !== after) previous.add(after);
      const later = successors.get(before) ?? [];
      later.push(name);
      successors.set(before, later);
    }
    // Counterless push sources can keep their cursor. Apply those pages
    // before an edge that advances the original checkpoint.
    const orderedEdges = (names: string[]) => names.sort((left, right) => {
      const a = entries.get(left)!, b = entries.get(right)!;
      return Number(b.before === b.after) - Number(a.before === a.after);
    });
    const ready = orderedEdges([...entries].filter(([, edge]) => !previous.has(edge.before)).map(([name]) => name));
    const ordered = new Set<string>();
    for (const name of ready) {
      if (ordered.has(name)) continue;
      ordered.add(name);
      for (const next of orderedEdges(successors.get(entries.get(name)!.after) ?? [])) ready.push(next);
    }
    // Catalog still decides admission if a receiver reuses a cursor value
    // and the pending pages alone cannot establish its starting point.
    for (const name of entries.keys()) ordered.add(name);
    for (const name of ordered) {
      const record = await load(name);
      if (!record) continue;
      const key = name.slice(0, -8);
      const fingerprint = hash(record.raw);
      const saved = await this.eventAcknowledgement(key);
      if (saved) verifyEventDigest(saved, fingerprint);
      else {
        try {
          const result = await receiveDurably(record.page, signal);
          if (!isDeepStrictEqual(result.checkpoint.identity, record.page.identity) || result.checkpoint.cursor !== record.page.nextCursor
            || result.accepted + result.duplicates !== record.page.events.length) throw new Error('Invalid Catalog acknowledgement');
        } catch {
          if (signal?.aborted) throw signal.reason;
          keepReceiverParked?.(record.page.identity);
          continue;
        }
        this.faults.afterCatalogReceipt?.();
        await this.put(key + '.ack', { version, owner: this.owner, digest: fingerprint, durable: true });
      }
      // Keep old recovery copies whose ordinary Catalog receipt preceded
      // the durable command. New acknowledgements leave only the fingerprint.
      if (!saved || saved.durable) await this.removeEventCopy(key, 'archived');
      await this.removeEventCopy(key, 'pending');
      await this.syncDirectory();
      delivered++;
    }
    return { delivered, retained: entries.size - delivered };
  }
}
