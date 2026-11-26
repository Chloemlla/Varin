import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { openKnowledgeDatabase } from './database.js';
import { knowledgeDatabaseExists } from './database-files.js';
import { createSemanticStoreEngine } from './semantic/store-engine.js';
import { createHashEmbedder } from './semantic/embedder.js';
import { semanticGenerationDir, spaceIdOf, workspaceScope } from './semantic/identity.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const options = { dim: 8, syncMode: 'full' as const, autoBuildQuiver: false, loadTextIndex: false, payloadCacheMb: 0 };
function installFileGroup(fixtureName: string, directory: string, filename = 'knowledge.tdb') {
  const fixture = new URL(`./fixtures/${fixtureName}.json`, import.meta.url);
  const files: Record<string, string> = JSON.parse(readFileSync(fixture, 'utf8'));
  for (const [name, data] of Object.entries(files)) writeFileSync(join(directory, name.replace('knowledge.tdb', filename)), Buffer.from(data, 'base64'));
  return files;
}

it.each(['0.8.10', '0.9.0', '0.9.1'])('recovers a %s checkpoint and its acknowledged WAL before publishing a new checkpoint', async version => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-checkpoint-')); roots.push(root);
  const files = installFileGroup(`trivium-${version}-checkpoint-wal`, root);
  const file = join(root, 'knowledge.tdb');
  const db = openKnowledgeDatabase(file, options);
  try {
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: 'checkpoint' });
    expect(db.get(2)).toMatchObject({ payload: { type: 'knowledge', content: 'pending WAL' }, vector: Array(8).fill(0.25) });
    expect(db.get(1)?.edges).toContainEqual(expect.objectContaining({ targetId: 2, label: 'related' }));
    db.updatePayload(2, { type: 'knowledge', content: 'after upgrade' });
  } finally { db.close(); }
  // A restored installation can contain only the active migrated directory.
  for (const [name, data] of Object.entries(files)) {
    expect(readFileSync(join(root, name))).toEqual(Buffer.from(data, 'base64'));
    unlinkSync(join(root, name));
  }
  expect(await knowledgeDatabaseExists(file)).toBe(true);
  const reader = openKnowledgeDatabase(file, { ...options, accessMode: 'readOnly' });
  try {
    expect(reader.getPayload(2)).toEqual({ type: 'knowledge', content: 'after upgrade' });
    expect(reader.get(1)?.edges).toContainEqual(expect.objectContaining({ targetId: 2, label: 'related' }));
  } finally { reader.close(); }
});

it('publishes a readable immutable semantic generation after migrating its writer', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'varin-tdb-semantic-')); roots.push(dataDir);
  const scope = workspaceScope('project');
  const space = { ...createHashEmbedder().space, dim: 8 };
  const directory = semanticGenerationDir(dataDir, 'host', scope, spaceIdOf(space), 'g1');
  mkdirSync(directory, { recursive: true });
  installFileGroup('trivium-0.9.1-checkpoint-wal', directory, 'index.tdb');
  const store = createSemanticStoreEngine({ dataDir, hostId: 'host', scope, space });
  try {
    const reader = await store.retainPublished();
    expect(reader).toBeTruthy();
    expect(await store.listDocumentStatesPinned(reader!.token)).toEqual([]);
  } finally { await store.close(); }
});

it('directs WAL-only stores to Varin 0.9.53 without changing the file group', () => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-wal-')); roots.push(root);
  const file = join(root, 'knowledge.tdb');
  const files = installFileGroup('trivium-0.8.10-wal-only', root);
  for (const accessMode of ['readWrite', 'readOnly', 'immutable'] as const) {
    expect(() => openKnowledgeDatabase(file, { ...options, accessMode })).toThrow(expect.objectContaining({
      code: 'VARIN_KNOWLEDGE_CHECKPOINT_REQUIRED',
      message: expect.stringContaining(file + '.wal'),
    }));
    expect(readdirSync(root).sort()).toEqual(Object.keys(files).sort());
    expect(readFileSync(file + '.wal')).toEqual(Buffer.from(files['knowledge.tdb.wal']!, 'base64'));
  }
});

it('automatically migrates the same WAL after a writable open and normal close in Varin 0.9.53', () => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-bridged-')); roots.push(root);
  // Frozen output of v0.9.53's openKnowledgeDatabase on the WAL-only fixture above.
  installFileGroup('varin-0.9.53-recovered-wal', root);
  const db = openKnowledgeDatabase(join(root, 'knowledge.tdb'), options);
  try {
    expect(db.getPayload(1)).toEqual({ type: 'knowledge', content: 'pending WAL' });
    expect(db.get(1)?.vector).toEqual(Array(8).fill(0.25));
  } finally { db.close(); }
});

it('preserves corruption and orphaned sidecars instead of prescribing a bridge for a damaged checkpoint', () => {
  const root = mkdtempSync(join(tmpdir(), 'varin-tdb-damage-')); roots.push(root);
  installFileGroup('trivium-0.8.10-checkpoint-wal', root);
  const file = join(root, 'knowledge.tdb');
  const damaged = Buffer.from('damaged 0.8 checkpoint');
  writeFileSync(file, damaged);
  const wal = readFileSync(file + '.wal');
  expect(() => openKnowledgeDatabase(file, options)).toThrow(expect.objectContaining({ code: 'TDB_CORRUPTED_FILE' }));
  expect(readFileSync(file)).toEqual(damaged);
  unlinkSync(file);
  expect(() => openKnowledgeDatabase(file, options)).toThrow(expect.objectContaining({ code: 'TDB_MIGRATION_REQUIRED' }));
  expect(readFileSync(file + '.wal')).toEqual(wal);
  expect(readdirSync(root)).not.toContain('knowledge.store');
});
