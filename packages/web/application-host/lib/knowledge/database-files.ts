import { statSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

export const LEGACY_CHECKPOINT_REQUIRED = 'VARIN_KNOWLEDGE_CHECKPOINT_REQUIRED';

// The migrator publishes a whole directory. Keep its staging and coordination
// files private to this store, outside the original .tdb file group.
export const knowledgeMigrationRoot = (file: string) => join(dirname(file), basename(file, '.tdb') + '.store');
export const knowledgeMigrationTarget = (file: string) => join(knowledgeMigrationRoot(file), 'current');
export function knowledgeDatabasePath(file: string): string {
  const target = knowledgeMigrationTarget(file);
  return statSync(target, { throwIfNoEntry: false }) ? join(target, 'database.tdb') : file;
}

const storeArtifacts = (file: string) => [file, file + '.wal', file + '.publish', knowledgeMigrationTarget(file)];
export const knowledgeDatabaseExistsSync = (file: string) =>
  storeArtifacts(file).some(candidate => statSync(candidate, { throwIfNoEntry: false }) !== undefined);

export async function knowledgeDatabaseExists(file: string): Promise<boolean> {
  for (const candidate of storeArtifacts(file)) {
    try { await stat(candidate); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  return false;
}
