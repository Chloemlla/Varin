import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

// Import through the same virtual module path as Electron main. The store owner
// itself forks its physical worker, exercising that worker's real dependency closure.
const root = path.resolve(process.argv[2]);
const { openWorkspaceKnowledge } = await import(pathToFileURL(path.join(root, 'server/lib/knowledge/store.js')).href);
const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-packaged-knowledge-'));
const knowledgeDir = path.join(dataDir, 'knowledge', 'native-smoke');
async function installFixture(name, workspace) {
  const url = new URL(`../../web/application-host/lib/knowledge/fixtures/${name}.json`, import.meta.url);
  const files = JSON.parse(await fs.readFile(url, 'utf8'));
  for (const [filename, bytes] of Object.entries(files)) {
    await fs.writeFile(path.join(knowledgeDir, filename.replace('knowledge.tdb', workspace + '.tdb')), Buffer.from(bytes, 'base64'));
  }
}
let store;
try {
  store = await openWorkspaceKnowledge({ dataDir, hostId: 'native-smoke', workspaceId: 'ws', embedding: null });
  const id = await store.putKnowledge({ scope: 'workspace', status: 'accepted', content: 'Native release verification', trigger: 'release verification' });
  assert.equal((await store.recall('release verification', 5))[0]?.node.id, id);
  await store.close(); store = null;
  const require = createRequire(path.join(root, 'package.json'));
  await installFixture('trivium-0.8.10-wal-only', 'wal-only');
  await assert.rejects(openWorkspaceKnowledge({ dataDir, hostId: 'native-smoke', workspaceId: 'wal-only', embedding: null }),
    { code: 'VARIN_KNOWLEDGE_CHECKPOINT_REQUIRED', message: /Varin 0\.9\.53/ });
  await installFixture('varin-0.9.53-recovered-wal', 'legacy');
  store = await openWorkspaceKnowledge({ dataDir, hostId: 'native-smoke', workspaceId: 'legacy', embedding: null });
  const upgradedId = await store.putKnowledge({ scope: 'workspace', status: 'accepted', content: 'Upgraded release verification', trigger: 'release verification' });
  assert.equal(upgradedId, 2);
  assert.equal((await store.recall('release verification', 5))[0]?.node.id, upgradedId);
  await store.close(); store = null;
  const { TriviumDB } = require('triviumdb');
  const reader = new TriviumDB(path.join(knowledgeDir, 'legacy.store/current/database.tdb'), { dim: 8, accessMode: 'readOnly' });
  try { assert.equal(reader.getPayload(1).content, 'pending WAL'); }
  finally { reader.close(); }
} finally { await store?.close(); await fs.rm(dataDir, { recursive: true, force: true }); }
console.log('[electron] verified the private packaged knowledge process');
