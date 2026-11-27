import { createHash } from 'node:crypto';
import { chmodSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { InboxMethod, InboxReceipt, InboxResult } from './user-inbox-wire.js';
import { InboxError, type InboxCommand, type InboxEntry, type IngressInbox } from './ingress-inbox.js';

// A stopped coordinator may receive a burst of full-sized requests. Bound
// pending disk use per Host while preserving the normal per-request budget.
const INBOX_PENDING_BYTES = 512 * 1024 * 1024;
interface Stored {
  id: string;
  digest: string;
  meta: string;
  body: Uint8Array;
  result: string | null;
}
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const isInput = (method: InboxMethod) => method === 'submit' || method === 'enqueue';
const identity = (command: InboxCommand) => hash(JSON.stringify([
  command.actor.principalId, command.threadId, command.branchId, isInput(command.method) ? 'input' : command.method, command.key,
]));
const fingerprint = (command: InboxCommand) => hash(JSON.stringify([command.method, command.url, hash(command.body)]));
/** Independent of Catalog. Only the coordinator ever admits the original
 * operation. A committed row is the supervisor's durable acceptance. */
export class SupervisorUserInbox implements IngressInbox {
  private readonly db: DatabaseSync;

  constructor(directory: string) {
    const file = path.join(directory, 'user-inputs.sqlite');
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`
      PRAGMA busy_timeout = 2000;
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = FULL;
      PRAGMA foreign_keys = ON;
      PRAGMA secure_delete = ON;
      CREATE TABLE IF NOT EXISTS ingress_payloads (id TEXT PRIMARY KEY, body BLOB NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS admissions (
        seq INTEGER PRIMARY KEY,
        id TEXT NOT NULL UNIQUE,
        principal TEXT NOT NULL,
        thread TEXT NOT NULL,
        branch TEXT NOT NULL,
        kind TEXT NOT NULL,
        digest TEXT NOT NULL,
        meta TEXT NOT NULL,
        payload TEXT REFERENCES ingress_payloads(id),
        result TEXT
      ) STRICT;
      CREATE INDEX IF NOT EXISTS pending_admissions ON admissions(seq) WHERE result IS NULL;
      CREATE INDEX IF NOT EXISTS pending_thread_inputs ON admissions(principal, thread, branch) WHERE result IS NULL AND kind = 'input';
    `);
  }

  private prior(command: InboxCommand, id: string): Stored | undefined {
    const row = this.db.prepare('SELECT id, digest, meta, result FROM admissions WHERE id = ?').get(id) as unknown as Stored | undefined;
    if (row && row.digest !== fingerprint(command)) throw new InboxError(409, 'inbox-key-conflict');
    return row;
  }

  find(command: InboxCommand): InboxReceipt | undefined {
    const id = identity(command);
    return this.prior(command, id) ? { kind: 'inbox_accepted', inboxId: id, key: command.key } : undefined;
  }

  accept(command: InboxCommand): InboxReceipt {
    const id = identity(command);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      if (!this.prior(command, id)) {
        const payload = hash(command.body);
        if (!this.db.prepare('SELECT 1 FROM ingress_payloads WHERE id = ?').get(payload)) {
          const used = this.db.prepare('SELECT coalesce(sum(length(body)), 0) AS bytes FROM ingress_payloads').get()!;
          if (Number(used.bytes) + command.body.byteLength > INBOX_PENDING_BYTES) throw new InboxError(503, 'inbox-capacity');
          this.db.prepare('INSERT INTO ingress_payloads(id,body) VALUES(?,?)').run(payload, command.body);
        }
        const kind = isInput(command.method) ? 'input' : 'upload';
        const waiting = kind === 'input' && this.db.prepare(
          "SELECT 1 FROM admissions WHERE principal = ? AND thread = ? AND branch = ? AND result IS NULL AND kind = 'input' LIMIT 1",
        ).get(command.actor.principalId, command.threadId, command.branchId);
        const { body: _body, ...meta } = command;
        const replayMethod = waiting ? 'enqueue' : command.method;
        this.db.prepare('INSERT INTO admissions(id,principal,thread,branch,kind,digest,meta,payload) VALUES(?,?,?,?,?,?,?,?)')
          .run(id, command.actor.principalId, command.threadId, command.branchId, kind, fingerprint(command), JSON.stringify({ ...meta, replayMethod, queueNext: Boolean(waiting) }), payload);
      }
      this.db.exec('COMMIT');
      return { kind: 'inbox_accepted', inboxId: id, key: command.key };
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  status(principal: string, id: string): InboxResult | null | undefined {
    const row = this.db.prepare('SELECT result FROM admissions WHERE id = ? AND principal = ?').get(id, principal);
    return row ? row.result === null ? null : JSON.parse(String(row.result)) as InboxResult : undefined;
  }

  hasPending(scope?: Pick<InboxCommand, 'actor' | 'threadId' | 'branchId'>): boolean {
    return Boolean(scope ? this.db.prepare(
      'SELECT 1 FROM admissions WHERE principal = ? AND thread = ? AND branch = ? AND result IS NULL LIMIT 1',
    ).get(scope.actor.principalId, scope.threadId, scope.branchId)
      : this.db.prepare('SELECT 1 FROM admissions WHERE result IS NULL LIMIT 1').get());
  }

  async replay(receive: (entry: InboxEntry) => Promise<InboxResult>, signal: AbortSignal, settled?: () => void): Promise<void> {
    const next = this.db.prepare('SELECT seq,id,principal,thread,branch,meta,payload FROM admissions WHERE result IS NULL AND seq > ? ORDER BY seq LIMIT 1');
    const payload = this.db.prepare('SELECT body FROM ingress_payloads WHERE id = ?');
    const start = this.db.prepare("UPDATE admissions SET meta = json_set(meta, '$.firstAttemptAtMs', ?) WHERE id = ?");
    const blocked = new Set<string>();
    const acknowledge = this.db.prepare('UPDATE admissions SET payload = NULL, meta = ?, result = ? WHERE id = ? AND result IS NULL');
    const retire = this.db.prepare('DELETE FROM ingress_payloads WHERE id = ? AND NOT EXISTS (SELECT 1 FROM admissions WHERE payload = ?)');
    let changed = false;
    let seq = 0;
    for (;;) {
      signal.throwIfAborted();
      const row = next.get(seq) as unknown as (Stored & { seq: number; principal: string; thread: string; branch: string; payload: string }) | undefined;
      if (!row) break;
      seq = row.seq;
      const scope = JSON.stringify([row.principal, row.thread, row.branch]);
      if (blocked.has(scope)) continue;
      let result: InboxResult;
      try {
        const body = payload.get(row.payload)?.body;
        if (!(body instanceof Uint8Array)) throw new Error('Supervisor inbox payload is missing');
        const meta = JSON.parse(row.meta) as Omit<InboxEntry, 'id' | 'body' | 'firstAttemptAtMs'> & { firstAttemptAtMs?: number };
        const firstAttemptAtMs = meta.firstAttemptAtMs ?? Date.now();
        if (meta.firstAttemptAtMs === undefined) start.run(firstAttemptAtMs, row.id);
        const entry = { ...meta, firstAttemptAtMs, id: row.id, body };
        result = await receive(entry);
      } catch {
        signal.throwIfAborted();
        // Keep the original command and its payload. Other branches can be
        // admitted while this branch waits for an authoritative result.
        blocked.add(scope);
        continue;
      }
      this.db.exec('BEGIN IMMEDIATE');
      try {
        acknowledge.run('{}', JSON.stringify(result), row.id);
        retire.run(row.payload, row.payload);
        this.db.exec('COMMIT');
      } catch (error) { this.db.exec('ROLLBACK'); throw error; }
      changed = true;
      settled?.();
    }
    if (changed) this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void { this.db.close(); }
}
