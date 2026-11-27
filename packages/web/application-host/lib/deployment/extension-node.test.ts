import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { create as archive } from 'tar';
import { ApplicationExtensionRuntime, ExtensionArtifactStore } from '@varin/extension-host';
import { expect, test } from 'vitest';
import { receiveExtensionArtifact, startExtensionNode } from '../../extension-node.js';
import { extensionSandboxTransport } from './extension-sandbox-transport.js';
import type { ResourceProvider } from './resource-provider.js';
import { extensionChannelToken, extensionNodeBase } from './extension-sandbox-protocol.js';

test('only the exact artifact and extension identity enter the executing store', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-sandbox-artifact-'));
  const extensionId = 'dev.example.isolated';
  const host = new ExtensionArtifactStore({ dataDir: path.join(root, 'host'), varinVersion: '1.0.0' });
  const guest = new ExtensionArtifactStore({ dataDir: path.join(root, 'sandbox'), varinVersion: '1.0.0' });
  const specifier = path.join(root, 'src');
  try {
    await mkdir(specifier);
    await mkdir(guest.directory, { recursive: true });
    const code = 'module.exports.activate = () => {};\n';
    await writeFile(path.join(specifier, 'host.cjs'), code);
    await writeFile(path.join(specifier, 'varin.extension.json'), JSON.stringify({
      schemaVersion: 1, id: extensionId, version: '1.0.0', engines: { varin: '*' },
      entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
    }));
    const { integrity } = await host.prepare({ display: 'Fixture', kind: 'local', specifier });
    const stream = async () => {
      const { root, files } = await host.openBrokeredArtifact(integrity);
      return Readable.from(archive({ cwd: root, portable: true, noDirRecurse: true, strict: true }, files));
    };
    await expect(receiveExtensionArtifact(guest, 'dev.example.other', integrity, await stream())).rejects.toThrow('does not belong');
    const view = await host.openBrokeredArtifact(integrity);
    const altered = path.join(view.root, 'package', 'host.cjs');
    await writeFile(altered, 'module.exports.activate = () => { throw new Error("altered"); };');
    await expect(receiveExtensionArtifact(guest, extensionId, integrity, await stream())).rejects.toThrow('integrity failed');
    await writeFile(altered, code);
    const received = await receiveExtensionArtifact(guest, extensionId, integrity, await stream());
    expect(await readFile(received.modulePath, 'utf8')).toContain('activate');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test.runIf(process.platform === 'linux' && process.getuid?.() === 0)('isolates two installed extensions in one Node and keeps storage Host-owned', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'varin-sandbox-acceptance-'));
  const extensionId = 'dev.example.isolated';
  const otherExtension = 'dev.example.other';
  const state = path.join(root, 'host');
  const secret = path.join(root, 'host-private.txt');
  const credentials = { hostId: 'fixture', token: 'isolated-node-token' };
  await writeFile(secret, 'private Host data', { mode: 0o600 });
  const makePackage = async (id: string) => {
    const packageRoot = path.join(root, id);
    await mkdir(packageRoot);
    await writeFile(path.join(packageRoot, 'varin.extension.json'), JSON.stringify({
      schemaVersion: 1, id, version: '1.0.0', engines: { varin: '*' }, storage: { schemaVersion: 1 },
      entrypoints: { host: { file: 'host.cjs', mode: 'brokered', activation: ['service-request'] } },
      provides: { services: [{ id, version: 1 }] },
    }));
    await writeFile(path.join(packageRoot, 'host.cjs'), `
      const fs = require('node:fs');
      const path = require('node:path');
      module.exports = { activate(context) {
        context.services.provide({ id: '${id}', version: 1 }, {
          async save([otherFile]) {
            const file = path.join(process.env.HOME, 'scratch.txt');
            fs.writeFileSync(file, 'owned by this worker');
            await context.storage.update({ saved: true });
            return { uid: process.getuid(), readOtherFile: fs.existsSync(otherFile), temporaryHome: process.cwd() === process.env.HOME, mode: fs.statSync(file).mode & 0o777, file };
          },
          async read() { return (await context.storage.refresh()).document.data.saved; },
        });
      } };
    `);
    return packageRoot;
  };
  const firstPackage = await makePackage(extensionId);
  const secondPackage = await makePackage(otherExtension);
  const sandbox = await startExtensionNode({ hostId: credentials.hostId, token: credentials.token });
  const endpoint = 'http://127.0.0.1:' + sandbox.port;
  const provider: ResourceProvider = {
    id: 'fixtures', describe: async () => [{ id: 'isolated', label: 'Extension', role: 'extensions',
      hostId: credentials.hostId, capabilities: ['extension-broker'] }],
    acquire: async identity => ({ ...identity, generation: 'generation', endpoint, bearer: extensionChannelToken(credentials.token, identity.extensionId!), expiresAt: Date.now() + 60_000 }),
    release: async () => {}, renew: async () => { throw new Error('Unexpected renewal'); },
    status: async () => { throw new Error('Unexpected status'); }, retire: async () => { throw new Error('Unexpected retirement'); },
  };
  const create = () => ApplicationExtensionRuntime.create({
    dataDir: state, varinVersion: '1.0.0', brokerScript: 'unused',
    sandboxTransportFactory: extensionSandboxTransport(provider),
  });
  let runtime: ApplicationExtensionRuntime | undefined;
  try {
    runtime = await create();
    const initial = await runtime.start();
    const first = await runtime.installOrStage({ expectedRevision: initial.catalog.revision,
      source: { display: 'First sandbox fixture', kind: 'local', specifier: firstPackage } });
    await runtime.installOrStage({ expectedRevision: first.revision,
      source: { display: 'Second sandbox fixture', kind: 'local', specifier: secondPackage } });
    const original = await runtime.invokeService({ serviceId: extensionId, version: 1, method: 'save', args: [secret] }) as { uid: number; file: string };
    expect(original).toMatchObject({ uid: 10000, readOtherFile: false, temporaryHome: true, mode: 0o600 });
    expect(await runtime.invokeService({ serviceId: otherExtension, version: 1, method: 'save', args: [original.file] }))
      .toMatchObject({ uid: 10001, readOtherFile: false, temporaryHome: true, mode: 0o600 });
    await runtime.stop();
    const retention = await fetch(endpoint + extensionNodeBase + '/retention', { headers: { Authorization: 'Bearer ' + credentials.token } });
    expect(await retention.json()).toEqual({ retireReady: true });
    runtime = await create();
    await runtime.start();
    expect(await runtime.invokeService({ serviceId: extensionId, version: 1, method: 'read', args: [] })).toBe(true);
  } finally {
    try { await runtime?.stop(); }
    finally {
      await sandbox.stop();
      await rm(root, { recursive: true, force: true });
    }
  }
});
