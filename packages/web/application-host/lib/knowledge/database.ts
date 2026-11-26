/** Native opens and offline conversions run in the private storage owner. */
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, statfsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TriviumDBOptions } from 'triviumdb';
import { knowledgeDatabasePath, knowledgeMigrationRoot, knowledgeMigrationTarget, LEGACY_CHECKPOINT_REQUIRED } from './database-files.js';

const require = createRequire(import.meta.url);
const { TriviumDB } = require('triviumdb') as typeof import('triviumdb');
// A read-only open reports a missing main file before inspecting the WAL.
// A leftover checkpoint sidecar can also mean damage; preserve that diagnostic.
function isLoneLegacyWal(file: string): boolean {
  const wal = file + '.wal';
  if (!lstatSync(wal, { throwIfNoEntry: false })?.isFile()) return false;
  const base = basename(file);
  if (readdirSync(dirname(file)).some(name => name.startsWith(base + '.') && name !== base + '.wal' && name !== base + '.lock')) return false;
  const fd = openSync(wal, 'r');
  try {
    const header = Buffer.alloc(6);
    return readSync(fd, header, 0, header.length, 0) === header.length
      && header.toString('ascii', 0, 4) === 'TVWL' && header.readUInt16LE(4) === 3;
  } finally { closeSync(fd); }
}

function migrate(file: string, options: TriviumDBOptions) {
  const target = knowledgeMigrationTarget(file);
  mkdirSync(knowledgeMigrationRoot(file), { recursive: true });
  const executable = process.env.VARIN_TDB_MIGRATOR_PATH || fileURLToPath(new URL(
    './native/triviumdb-migrate' + (process.platform === 'win32' ? '.exe' : ''), import.meta.url));
  // The native tool computes required scratch space and checks actual free disk.
  // Use the source volume's capacity for its CLI budgets instead of imposing a
  // fixed 1 GiB limit on existing Varin data.
  const volume = statfsSync(dirname(file), { bigint: true });
  const capacityMiB = ((volume.blocks * volume.bsize) / 1048576n + 1n).toString();
  const result = spawnSync(executable, ['--execute', '--source', file, '--destination', target,
    '--source-dtype', options.dtype ?? 'f32', '--storage', options.storageMode ?? 'mmap',
    '--max-source-mib', capacityMiB, '--max-work-mib', capacityMiB], { encoding: 'utf8', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    let failure;
    try { failure = JSON.parse(result.stderr).error; } catch { /* Non-JSON process failure. */ }
    throw Object.assign(new Error(`Knowledge migration failed for ${file}: ${failure?.message || result.stderr.trim() || result.signal || result.status}`),
      failure && { code: failure.code, phase: failure.phase, outcome: failure.outcome, details: failure.details });
  }
  return new TriviumDB(join(target, 'database.tdb'), options);
}

export function openKnowledgeDatabase(file: string, options: TriviumDBOptions) {
  const writable = options.accessMode !== 'readOnly' && options.accessMode !== 'immutable';
  const current = knowledgeDatabasePath(file);
  if (current !== file) {
    if (writable && existsSync(current + '.migration')) return migrate(file, options);
    if ((!existsSync(current) && !existsSync(current + '.publish')) || !existsSync(join(dirname(current), 'migration-report.json'))) {
      throw new Error(`Incomplete migrated knowledge database at ${current}`);
    }
    return new TriviumDB(current, options);
  }
  try { return new TriviumDB(file, options); }
  catch (error) {
    const diagnostic = error as { code?: string; details?: { component?: string; found?: number } };
    const needsMigration = diagnostic.code === 'TDB_MIGRATION_REQUIRED';
    const readOnlyMissingFile = !writable && diagnostic.code === 'TDB_INVALID_INPUT';
    if (!needsMigration && !readOnlyMissingFile) throw error;
    if (!lstatSync(file, { throwIfNoEntry: false })) {
      const legacyWal = diagnostic.details?.component === 'wal' && diagnostic.details.found === 3;
      if ((legacyWal || readOnlyMissingFile) && isLoneLegacyWal(file)) {
        throw Object.assign(new Error(`TriviumDB 0.8 WAL: ${file}.wal\n` +
          '请先停止 Varin 并备份完整数据目录。用 Varin 0.9.53 在可写副本上打开对应的知识库，正常关闭后，再用当前版本打开该副本。\n' +
          'Stop Varin and back up the data directory. Open this store on a writable copy with Varin 0.9.53, close it normally, then reopen the copy with the current version.',
        { cause: error }), { code: LEGACY_CHECKPOINT_REQUIRED });
      }
      throw error;
    }
    if (!writable) throw error;
    return migrate(file, options);
  }
}
