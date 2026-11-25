import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsPromisesDefault from 'node:fs/promises';
import pathDefault from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

// ── Public types ─────────────────────────────────────────────────────────

export type VarinSettingsDocument = Record<string, unknown>;

export type SettingsProjectionValue = string | number | boolean | null | undefined
  | readonly SettingsProjectionValue[] | { readonly [key: string]: SettingsProjectionValue };

type ReadonlyProjection<Value> = Readonly<Value>;

export interface SettingsProjection<Value extends SettingsProjectionValue> {
  read(): Promise<ReadonlyProjection<Value>>;
  readSync(): ReadonlyProjection<Value>;
}

export interface SettingsFileTransaction<Result> {
  document?: VarinSettingsDocument;
  result: Result;
  write?: boolean;
}

export interface SettingsFileStore {
  readonly filePath: string;
  read(options?: { cache?: boolean }): Promise<VarinSettingsDocument>;
  readSync(): VarinSettingsDocument;
  /** Validate a small, immutable view once per observed file snapshot. */
  createProjection<Value extends SettingsProjectionValue>(
    project: (document: VarinSettingsDocument) => Value,
  ): SettingsProjection<Value>;
  replace(settings: VarinSettingsDocument): Promise<VarinSettingsDocument>;
  transact<Result>(
    mutator: (
      current: VarinSettingsDocument,
    ) => SettingsFileTransaction<Result> | Promise<SettingsFileTransaction<Result>>,
    options?: { signal?: AbortSignal },
  ): Promise<Result>;
  update(
    mutator: (
      current: VarinSettingsDocument,
    ) => VarinSettingsDocument | void | Promise<VarinSettingsDocument | void>,
  ): Promise<VarinSettingsDocument>;
}

export interface SettingsFileStoreOptions {
  filePath: string;
  defaultValue?: VarinSettingsDocument;
  fsModule?: Pick<typeof fs, 'readFileSync'> & Partial<Pick<typeof fs, 'watch' | 'statSync'>>;
  fsPromises?: Pick<
    typeof fsPromisesDefault,
    'chmod' | 'mkdir' | 'open' | 'readFile' | 'rename' | 'rm' | 'stat' | 'writeFile'
  >;
  pathModule?: Pick<typeof pathDefault, 'dirname' | 'resolve'>;
  processLike?: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>;
}

// ── Internal helpers ─────────────────────────────────────────────────────

interface LockOwner {
  pid?: unknown;
  token?: string;
}

type ReleaseLock = () => Promise<void>;

const mutationQueues = new Map<string, Promise<unknown>>();
const LOCK_RETRY_MS = 25;

// Text, rather than object identity, is shared across stores in the same Host.
// The missing sentinel preserves each caller's own default value.
interface DocumentSnapshot {
  raw: string | null;
}
interface CachedDocument {
  snapshot?: DocumentSnapshot;
  generation: number;
  signature?: string;
  loading?: Promise<DocumentSnapshot>;
}
const documents = new Map<string, CachedDocument>();
const statSignature = (stat: fs.Stats): string => `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}:${stat.ino}`;

const errorCode = (error: unknown): string | undefined => (
  error !== null && typeof error === 'object' && typeof (error as { code?: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined
);

const assertObject = (value: unknown): VarinSettingsDocument => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Settings file is malformed (non-object payload)');
  }
  return value as VarinSettingsDocument;
};

const parseSettings = (raw: string): VarinSettingsDocument => assertObject(JSON.parse(raw));

const immutableProjection = <Value extends SettingsProjectionValue>(value: Value): ReadonlyProjection<Value> => {
  // Detach even when a projector uses its own reusable defaults.
  const result = structuredClone(value);
  const visited = new WeakSet<object>();
  const freeze = (node: unknown): void => {
    if (node === undefined || node === null || ['boolean', 'number', 'string'].includes(typeof node)) return;
    if (typeof node !== 'object'
      || (!Array.isArray(node) && Object.prototype.toString.call(node) !== '[object Object]')) {
      throw new TypeError('Settings projections must contain plain data');
    }
    if (visited.has(node)) return;
    visited.add(node);
    for (const child of Object.values(node)) freeze(child);
    Object.freeze(node);
  };
  freeze(result);
  return result as ReadonlyProjection<Value>;
};

const processIsAlive = (
  processLike: Pick<NodeJS.Process, 'kill' | 'pid' | 'platform'>,
  pid: number,
): boolean => {
  if (!Number.isSafeInteger(pid) || pid <= 0 || typeof processLike.kill !== 'function') return false;
  try {
    processLike.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === 'EPERM';
  }
};

const enqueueMutation = <Result>(key: string, operation: () => Promise<Result>): Promise<Result> => {
  const previous = mutationQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  const settled = current.catch(() => undefined).finally(() => {
    if (mutationQueues.get(key) === settled) mutationQueues.delete(key);
  });
  mutationQueues.set(key, settled);
  return current;
};

// ── Store factory ─────────────────────────────────────────────────────────

export const createSettingsFileStore = ({
  filePath,
  defaultValue = {},
  fsModule = fs,
  fsPromises = fsPromisesDefault,
  pathModule = pathDefault,
  processLike = process,
}: SettingsFileStoreOptions): SettingsFileStore => {
  const readDefault = (): VarinSettingsDocument => structuredClone(assertObject(defaultValue));
  const resolvedPath = pathModule.resolve(filePath);
  const lockPath = `${resolvedPath}.lock`;
  const previousPath = `${resolvedPath}.previous`;
  const directory = pathModule.dirname(resolvedPath);

  const cached = documents.get(resolvedPath) ?? { generation: 0 };
  documents.set(resolvedPath, cached);
  const invalidate = (): void => { cached.generation++; delete cached.snapshot; delete cached.signature; delete cached.loading; };
  const signature = async (): Promise<string> => (await Promise.all([resolvedPath, previousPath].map(async target => {
    try { return statSignature(await fsPromises.stat(target)); }
    catch (error) { if (errorCode(error) === 'ENOENT') return 'missing'; throw error; }
  }))).join('|');
  const signatureSync = (): string | undefined => {
    if (!fsModule.statSync) return undefined;
    return [resolvedPath, previousPath].map(target => {
      try { return statSignature(fsModule.statSync!(target)); }
      catch (error) { if (errorCode(error) === 'ENOENT') return 'missing'; throw error; }
    }).join('|');
  };
  const load = async (): Promise<string | null> => {
    try { return await fsPromises.readFile(resolvedPath, 'utf8'); }
    catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
      try { return await fsPromises.readFile(previousPath, 'utf8'); }
      catch (previousError) { if (errorCode(previousError) === 'ENOENT') return null; throw previousError; }
    }
  };
  const decode = (raw: string | null): VarinSettingsDocument => raw === null ? readDefault() : parseSettings(raw);
  const readSnapshot = async (): Promise<DocumentSnapshot> => {
    // Watch notifications can lag behind completed writes (notably on macOS).
    // Verify identity on every read; only unchanged document text is reused.
    const next = await signature();
    if (next !== cached.signature) { invalidate(); cached.signature = next; }
    if (cached.snapshot !== undefined) return cached.snapshot;
    if (!cached.loading) {
      const generation = cached.generation;
      const loading = load().then(raw => {
        const observed = cached.generation === generation ? cached.snapshot : undefined;
        if (observed && observed.raw === raw) return observed;
        const snapshot = { raw };
        if (cached.generation === generation) cached.snapshot = snapshot;
        return snapshot;
      }).finally(() => { if (cached.loading === loading) delete cached.loading; });
      cached.loading = loading;
    }
    return cached.loading;
  };
  const readSnapshotSync = (): DocumentSnapshot => {
    const next = signatureSync();
    if (next === undefined || next !== cached.signature) { invalidate(); if (next !== undefined) cached.signature = next; }
    if (cached.snapshot === undefined) {
      try { cached.snapshot = { raw: fsModule.readFileSync(resolvedPath, 'utf8') }; }
      catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
        try { cached.snapshot = { raw: fsModule.readFileSync(previousPath, 'utf8') }; }
        catch (previousError) { if (errorCode(previousError) !== 'ENOENT') throw previousError; cached.snapshot = { raw: null }; }
      }
    }
    return cached.snapshot;
  };
  const read = async (options?: { cache?: boolean }): Promise<VarinSettingsDocument> =>
    decode(options?.cache === false ? await load() : (await readSnapshot()).raw);
  const readSync = (): VarinSettingsDocument => decode(readSnapshotSync().raw);

  const createProjection = <Value extends SettingsProjectionValue>(
    project: (document: VarinSettingsDocument) => Value,
  ): SettingsProjection<Value> => {
    // A delayed reader may still hold an older snapshot; key by the actual
    // input it saw, not the shared cache's possibly newer generation.
    const values = new WeakMap<DocumentSnapshot, { value: ReadonlyProjection<Value> }>();
    const projectSnapshot = (snapshot: DocumentSnapshot): ReadonlyProjection<Value> => {
      let entry = values.get(snapshot);
      if (!entry) {
        entry = { value: immutableProjection(project(decode(snapshot.raw))) };
        values.set(snapshot, entry);
      }
      return entry.value;
    };
    return { read: async () => projectSnapshot(await readSnapshot()), readSync: () => projectSnapshot(readSnapshotSync()) };
  };

  const acquireLock = async (signal?: AbortSignal): Promise<ReleaseLock> => {
    signal?.throwIfAborted();
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    for (;;) {
      signal?.throwIfAborted();
      let handle: import('node:fs/promises').FileHandle | undefined;
      try {
        handle = await fsPromises.open(lockPath, 'wx', 0o600);
      } catch (error) {
        if (errorCode(error) !== 'EEXIST') throw error;
      }
      if (handle) {
        const token = randomUUID();
        try {
          await handle.writeFile(JSON.stringify({ pid: processLike.pid, token }), 'utf8');
        } catch (error) {
          await handle.close().catch(() => undefined);
          await fsPromises.rm(lockPath, { force: true }).catch(() => undefined);
          throw error;
        }
        const acquiredHandle = handle;
        return async () => {
          await acquiredHandle.close();
          try {
            const owner = JSON.parse(await fsPromises.readFile(lockPath, 'utf8')) as LockOwner;
            if (owner?.token === token) await fsPromises.rm(lockPath, { force: true });
          } catch (error) {
            if (errorCode(error) !== 'ENOENT') throw error;
          }
        };
      }

      let abandoned = false;
      try {
        const owner = JSON.parse(await fsPromises.readFile(lockPath, 'utf8')) as LockOwner;
        abandoned = !processIsAlive(processLike, Number(owner?.pid));
      } catch (error) {
        if (errorCode(error) === 'ENOENT') continue;
        try {
          abandoned = Date.now() - (await fsPromises.stat(lockPath)).mtimeMs > 2_000;
        } catch (statError) {
          if (errorCode(statError) === 'ENOENT') continue;
          throw statError;
        }
      }

      if (abandoned) {
        const moved = `${lockPath}.abandoned.${processLike.pid}.${randomUUID()}`;
        try {
          await fsPromises.rename(lockPath, moved);
        } catch (error) {
          if (errorCode(error) === 'ENOENT') continue;
          throw error;
        }
        await fsPromises.rm(moved, { force: true });
        continue;
      }
      await delay(LOCK_RETRY_MS, undefined, { signal });
    }
  };

  const replaceFile = async (temporaryPath: string): Promise<void> => {
    try {
      await fsPromises.rename(temporaryPath, resolvedPath);
      return;
    } catch (error) {
      const code = errorCode(error);
      if (processLike.platform !== 'win32' || (code !== 'EPERM' && code !== 'EACCES' && code !== 'EEXIST')) {
        throw error;
      }
    }

    await fsPromises.rm(previousPath, { force: true });
    let movedCurrent = false;
    try {
      await fsPromises.rename(resolvedPath, previousPath);
      movedCurrent = true;
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }

    try {
      await fsPromises.rename(temporaryPath, resolvedPath);
    } catch (error) {
      if (movedCurrent) await fsPromises.rename(previousPath, resolvedPath).catch(() => undefined);
      throw error;
    }
    if (movedCurrent) await fsPromises.rm(previousPath, { force: true });
  };

  const writeUnlocked = async (settings: VarinSettingsDocument): Promise<void> => {
    assertObject(settings);
    await fsPromises.mkdir(directory, { recursive: true, mode: 0o700 });
    let mode = 0o600;
    let preserveMode = false;
    if (processLike.platform !== 'win32') {
      try { mode = (await fsPromises.stat(resolvedPath)).mode & 0o777; preserveMode = true; }
      catch (error) { if (errorCode(error) !== 'ENOENT') throw error; }
    }
    const temporaryPath = `${resolvedPath}.tmp-${processLike.pid}-${randomUUID()}`;
    try {
      const raw = JSON.stringify(settings, null, 2);
      await fsPromises.writeFile(temporaryPath, raw, { encoding: 'utf8', mode });
      // Apply the existing file's mode to our replacement, independently of this process's umask.
      if (preserveMode) await fsPromises.chmod(temporaryPath, mode);
      await replaceFile(temporaryPath);
      invalidate();
    } finally {
      await fsPromises.rm(temporaryPath, { force: true });
    }
  };

  const withMutationLock = <Result>(operation: () => Promise<Result>, signal?: AbortSignal): Promise<Result> => enqueueMutation(resolvedPath, async () => {
    const release = await acquireLock(signal);
    try {
      signal?.throwIfAborted();
      return await operation();
    } finally {
      await release();
    }
  });

  const replace = (settings: VarinSettingsDocument): Promise<VarinSettingsDocument> => withMutationLock(async () => {
    await writeUnlocked(settings);
    return settings;
  });

  const transact = <Result>(
    mutator: (current: VarinSettingsDocument) => SettingsFileTransaction<Result> | Promise<SettingsFileTransaction<Result>>,
    options: { signal?: AbortSignal } = {},
  ): Promise<Result> => withMutationLock(async () => {
    // Cross-process mutations must read under the lock, never from a watch cache.
    const current = decode(await load());
    // Once the mutator starts, finish its atomic commit before releasing the
    // lock. Cancellation while queued or acquiring a lock never starts it.
    options.signal?.throwIfAborted();
    const transaction = await mutator(structuredClone(current));
    if (transaction === null || typeof transaction !== 'object' || Array.isArray(transaction)) {
      throw new Error('Settings transaction must return an object');
    }
    const next = assertObject(transaction.document ?? current);
    if (transaction.write !== false) await writeUnlocked(next);
    return transaction.result;
  }, options.signal);

  const update = (
    mutator: (current: VarinSettingsDocument) => VarinSettingsDocument | void | Promise<VarinSettingsDocument | void>,
  ): Promise<VarinSettingsDocument> => transact(async (current) => {
    const next = assertObject((await mutator(current)) ?? current);
    return { document: next, result: next };
  });

  return { filePath: resolvedPath, read, readSync, createProjection, replace, transact, update };
};

export { readProjectTrust, projectTrustFile, canonicalProjectTrustPath, projectTrustDecision, validateProjectTrust } from './project-trust.js';
