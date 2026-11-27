import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, open, readdir, rename, unlink } from 'node:fs/promises';
import path from 'node:path';

const missing = (error: unknown) => (error as NodeJS.ErrnoException).code === 'ENOENT';

export function deploymentCacheRoot(configured: string | undefined, hostId: string): string | undefined {
  if (!configured?.trim()) return undefined;
  if (!path.isAbsolute(configured.trim())) throw new Error('VARIN_CACHE_DIR must be an absolute path');
  // Model and MCP discovery may contain account-specific connection metadata.
  return path.join(configured.trim(), 'hosts', hostId);
}

async function fileAt(file: string) {
  const stat = await lstat(file).catch(error => { if (!missing(error)) throw error; });
  if (stat && !stat.isFile()) throw new Error('Expected a local cache file at ' + file);
  return stat;
}

/** Caller owns this Host's cache writer. Publish and sync on the destination
 * volume before deleting the retired copy. Existing entries are newer writes. */
export async function relocateCacheFile(source: string, destination: string) {
  if (path.resolve(source) === path.resolve(destination)) return;
  const original = await fileAt(source);
  if (!original) return;
  const existing = await fileAt(destination);
  if (existing && original.ino && original.dev === existing.dev && original.ino === existing.ino) return;
  if (!existing) {
    const directory = path.dirname(destination);
    const created = await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = destination + '.migration-' + randomUUID();
    try {
      await copyFile(source, temporary, constants.COPYFILE_EXCL);
      const writer = await open(temporary, 'r+');
      try { await writer.sync(); } finally { await writer.close(); }
      await rename(temporary, destination);
      if (process.platform !== 'win32') {
        const through = created ? path.dirname(created) : directory;
        for (let current = directory; ; current = path.dirname(current)) {
          const parent = await open(current, 'r');
          try { await parent.sync(); } finally { await parent.close(); }
          if (current === through) break;
        }
      }
    } finally { await unlink(temporary).catch(error => { if (!missing(error)) throw error; }); }
  }
  await unlink(source);
}

export async function relocateCacheDocument(source: string, destination: string) {
  await relocateCacheFile(source + '.previous', destination + '.previous');
  await relocateCacheFile(source, destination);
}

export async function relocateModelCaches(dataDir: string, cacheRoot: string) {
  await relocateCacheDocument(path.join(dataDir, 'model-directory.json'), path.join(cacheRoot, 'model-directory.json'));
  const legacy = path.join(dataDir, 'cache', 'tokenizers');
  const target = path.join(cacheRoot, 'tokenizers');
  const files = await readdir(legacy, { withFileTypes: true }).catch(error => {
    if (missing(error)) return [];
    throw error;
  });
  // Put vocabulary objects first, then their references. Both the old and new
  // binding lookup can still find each content hash if the Host is interrupted.
  for (const suffix of [/^[\da-f]{64}\.json(?:\.gz)?$/u, /^[\da-f]{64}\.ref$/u]) {
    for (const file of files.filter(file => file.isFile() && suffix.test(file.name))) {
      await relocateCacheFile(path.join(legacy, file.name), path.join(target, file.name));
    }
  }
}
