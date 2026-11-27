import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { prepareKernelCommand } from '../kernel/kernel-launch.js';
import { knowledgeDatabaseExistsSync } from '../knowledge/database-files.js';
import { probeKnowledgeFormat } from '../knowledge/database.js';
import { readSemanticCheckpoint } from '../knowledge/semantic/checkpoint.js';

interface StoreFormat {
  status: 'new' | 'current' | 'upgrade' | 'unsupported' | 'blocked';
  current?: number | string | null;
  target?: number | string;
  reason?: string;
}

async function entries(directory: string) {
  return readdir(directory, { withFileTypes: true }).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  });
}

async function *knowledgeDatabases(root: string) {
  const stores = new Set<string>();
  for (const item of await entries(root)) {
    if (item.isFile() && /\.tdb(?:\.(?:wal|publish))?$/.test(item.name)) stores.add(item.name.replace(/\.(?:wal|publish)$/, ''));
    if (item.isDirectory() && item.name.endsWith('.store')) stores.add(item.name.slice(0, -6) + '.tdb');
  }
  for (const name of stores) yield path.join(root, name);
  yield path.join(root, 'semantic-inference', 'ledger.tdb');
  const semantic = path.join(root, 'semantic');
  for (const scopeKind of (await entries(semantic)).filter(item => item.isDirectory())) {
    const scopeRoot = path.join(semantic, scopeKind.name);
    for (const scope of (await entries(scopeRoot)).filter(item => item.isDirectory())) {
      const spaceRoot = path.join(scopeRoot, scope.name);
      for (const space of (await entries(spaceRoot)).filter(item => item.isDirectory())) {
        const directory = path.join(spaceRoot, space.name);
        const generation = readSemanticCheckpoint(directory)?.generation ?? 'g1';
        if (generation !== path.basename(generation) || generation === '..' || generation === '.') {
          throw new Error('Invalid semantic generation in ' + directory);
        }
        yield path.join(directory, generation, 'index.tdb');
      }
    }
  }
}

export async function runUpgradePreflight(dataDir: string, buildIdentity: string) {
  // The identity producer also creates a new document if it is missing. This
  // offline command only reads the name that determines the physical stores.
  const identityFile = path.join(dataDir, 'extensions', 'identity.json');
  const identity: { hostId?: unknown } | null = await readFile(identityFile, 'utf8').then(JSON.parse).catch(error => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  });
  if (identity && (typeof identity.hostId !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(identity.hostId))) {
    throw new Error('Invalid Varin Host identity in ' + identityFile);
  }
  const hostId = identity?.hostId as string | undefined;
  if (!hostId && ((await entries(path.join(dataDir, 'kernel'))).length || (await entries(path.join(dataDir, 'knowledge'))).length)) {
    throw new Error('The existing stores have no Varin Host identity in ' + identityFile);
  }
  const kernel = await prepareKernelCommand({ kernelBuildIdentity: buildIdentity, allowCargoDevRunner: false });
  const root = path.join(dataDir, 'kernel', hostId ?? '');
  const { stdout } = await promisify(execFile)(kernel.command, [...kernel.args, '--upgrade-preflight', root], { windowsHide: true });
  const native: { storage: StoreFormat; catalog: StoreFormat } = JSON.parse(stdout);
  if (![native.storage, native.catalog].every(store => store && ['new', 'current', 'upgrade', 'unsupported', 'blocked'].includes(store.status))) {
    throw new Error('Invalid format report from the shipped Varin kernel');
  }
  const knowledge: (ReturnType<typeof probeKnowledgeFormat> & { path: string })[] = [];
  if (hostId) {
    for await (const file of knowledgeDatabases(path.join(dataDir, 'knowledge', hostId))) {
      if (knowledgeDatabaseExistsSync(file)) knowledge.push({ path: path.relative(dataDir, file), ...probeKnowledgeFormat(file) });
    }
  }
  const formats: StoreFormat[] = [native.storage, native.catalog, ...knowledge];
  return { version: 1, dataDir, status: formats.some(store => store.status === 'blocked' || store.status === 'unsupported')
    ? 'blocked' : formats.some(store => store.status === 'upgrade') ? 'upgrade' : 'ready',
  ...native, knowledge } as const;
}
