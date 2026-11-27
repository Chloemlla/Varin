import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { startContainerResourceProvider } from './container-provider.js';
import { createSocketResourceProvider } from './resource-provider.js';
import { extensionBrokerRoute, extensionChannelToken, extensionIdentityRoute, extensionNodeCredential } from './extension-sandbox-protocol.js';

it.each(['resources', 'browser', 'computer', 'extensions', 'shared-extensions'])('starts a %s container only on acquire and retires its original generation after release and detach', async kind => {
  const role = kind === 'shared-extensions' ? 'extensions' : kind;
  const dedicated = kind === 'extensions';
  const root = await mkdtemp(path.join(os.tmpdir(), 'varin-provider-helper-'));
  const socketPath = process.platform === 'win32' ? '\\\\.\\pipe\\varin-provider-' + randomUUID() : path.join(root, 'control.sock');
  const workspace = path.join(root, 'workspaces'), state = path.join(root, 'state');
  const controlFile = path.join(root, 'control.json'), nodeFile = path.join(root, 'node.json'), file = path.join(root, 'provider.json');
  const hostId = 'resource-host';
  const resourceId = '..';
  const desktopId = 'managed-linux';
  const extensionId = 'dev.example.sandbox';
  const integrity = 'sha256-' + 'a'.repeat(64);
  const otherExtension = 'dev.example.other';
  const mediaPath = role === 'extensions' ? extensionBrokerRoute(extensionId, integrity) : `/api/computers/desktops/${desktopId}/vnc`;
  const streamPath = `/api/computers/desktops/${desktopId}/stream`;
  let observationClosed: Promise<unknown> | undefined;
  let nodeReadyToRetire = false;
  const node = createServer((req, res) => {
    if (req.headers.authorization !== 'Bearer ' + (req.url === extensionIdentityRoute(extensionId)
      ? extensionChannelToken('original-node-token', extensionId) : 'original-node-token')) { res.writeHead(401).end(); return; }
    res.setHeader('x-varin-managed-host', hostId);
    if (req.url === streamPath) {
      observationClosed = once(res, 'close');
      res.setHeader('Content-Type', 'text/event-stream');
      res.write('data: frame\n\n');
      return;
    }
    if (req.url?.endsWith('/retention')) { res.end(JSON.stringify({ retireReady: nodeReadyToRetire })); return; }
    res.end(JSON.stringify({ hostId, role, requestHostIdentity: true, ...(dedicated && { extensionId }) }));
  });
  const media = new WebSocketServer({ noServer: true });
  node.on('upgrade', (req, socket, head) => {
    expect(req.url).toBe(mediaPath);
    expect(req.headers.authorization).toBe('Bearer ' + (role === 'extensions'
      ? extensionChannelToken('original-node-token', extensionId) : 'original-node-token'));
    media.handleUpgrade(req, socket, head, ws => {
      ws.on('message', (data, binary) => ws.send(data, { binary }));
    });
  });
  await new Promise<void>(resolve => node.listen(0, '127.0.0.1', resolve));
  const port = (node.address() as { port: number }).port;
  await Promise.all([mkdir(workspace), mkdir(state), writeFile(controlFile, '{"token":"control-token"}'),
    writeFile(nodeFile, '{"token":"original-node-token"}')]);
  await writeFile(file, JSON.stringify({ version: 1, id: 'local', socketPath, credentialFile: controlFile,
    leaseDurationMs: 60_000, startupTimeoutMs: 10_000, idleRetentionMs: 500,
    resources: [{ id: resourceId, hostId, label: 'Local work', role,
      ...(role === 'extensions' ? { ...(dedicated && { extensionId }) } : {
        state, ...(role === 'browser' ? { browserId: 'configured-cdp' } : role === 'computer' ? { desktopId } : { workspace }),
      }), credentialFile: nodeFile, image: 'varin-node:fixture' }],
  }));

  let instance: { Id: string; State: { Running: boolean; StartedAt: string }; Config: { Labels: Record<string, string> };
    NetworkSettings: { Ports: { '3000/tcp': Array<{ HostIp: string; HostPort: string }> } } } | undefined;
  let containerName: string | undefined;
  const operations: string[] = [];
  let failDetach = true;
  const helper = await startContainerResourceProvider(file, async (engine, args) => {
    expect(engine).toBe('docker');
    const [operation, ...rest] = args;
    operations.push(operation!);
    if (operation === 'ps') return instance ? containerName! : '';
    if (operation === 'inspect') return JSON.stringify([instance]);
    if (operation === 'create') {
      expect(instance).toBeUndefined();
      expect(rest.some(arg => arg.includes('dst=/home/varin/workspaces'))).toBe(role === 'resources');
      if (role === 'extensions') {
        expect(rest).toContain('--read-only');
        expect(rest.includes('VARIN_EXTENSION_ID=' + extensionId)).toBe(dedicated);
        expect(rest.filter(arg => arg.includes('dst='))).toEqual([expect.stringContaining(extensionNodeCredential + ',readonly')]);
      }
      if (role === 'resources') expect(rest).toEqual(expect.arrayContaining(['--cap-drop=ALL', '--security-opt=no-new-privileges']));
      containerName = rest[rest.indexOf('--name') + 1]!;
      const [label, value] = rest[rest.indexOf('--label') + 1]!.split('=');
      instance = { Id: randomUUID(), State: { Running: false, StartedAt: new Date().toISOString() },
        Config: { Labels: { [label!]: value! } }, NetworkSettings: { Ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: String(port) }] } } };
      return instance.Id;
    }
    if (operation === 'start') { instance!.State.Running = true; return ''; }
    if (operation === 'stop') { instance!.State.Running = false; return ''; }
    if (operation === 'rm') {
      expect(instance!.State.Running).toBe(false);
      if (failDetach) throw new Error('Volume held');
      instance = undefined;
      return '';
    }
    throw new Error('Unexpected test engine command');
  });
  const provider = createSocketResourceProvider({ id: 'local', socketPath, bearer: 'control-token' });
  const acquireLease = (leaseId: string, id = extensionId) => provider.acquire({ resourceId, leaseId, ...(role === 'extensions' && { extensionId: id }) });
  const observation = new AbortController();
  try {
    expect(await provider.describe()).toMatchObject([{ id: resourceId, role, ...(role === 'browser' && { browserId: 'configured-cdp' }),
      ...(role === 'computer' && { desktopId }), ...(dedicated && { extensionId }) }]);
    expect(await provider.status(resourceId)).toMatchObject({ state: 'cold' });
    expect(operations).toEqual([]);
    const [first, second] = await Promise.all([acquireLease('one'), acquireLease('two')]);
    expect(first.generation).toBe(second.generation);
    expect(operations.filter(operation => operation === 'create')).toHaveLength(1);
    const endpoint = first.endpoint + (role === 'extensions'
      ? extensionIdentityRoute(extensionId) : '/api/harness/managed-execution/v1/identity');
    const identity = (bearer: string) => fetch(endpoint, { headers: { authorization: 'Bearer ' + bearer } });
    expect((await identity('original-node-token')).status).toBe(401);
    expect((await identity(first.bearer)).status).toBe(200);
    const computer = await fetch(first.endpoint + '/api/computers', { headers: { authorization: 'Bearer ' + first.bearer } });
    expect(computer.status).toBe(role === 'computer' ? 200 : 404);
    await computer.body?.cancel();
    let viewer: WebSocket | undefined;
    if (role === 'computer') {
      const frames = await fetch(first.endpoint + streamPath, {
        headers: { authorization: 'Bearer ' + first.bearer }, signal: observation.signal,
      });
      const reader = frames.body!.getReader();
      expect(new TextDecoder().decode((await reader.read()).value)).toBe('data: frame\n\n');
      reader.releaseLock();
    }
    if (role === 'computer' || role === 'extensions') {
      viewer = new WebSocket(first.endpoint.replace(/^http/u, 'ws') + mediaPath,
        { headers: { authorization: 'Bearer ' + first.bearer } });
      await once(viewer, 'open');
      const frame = once(viewer, 'message');
      viewer.send(Buffer.from('frame round trip'));
      expect(String((await frame)[0])).toBe('frame round trip');
    }
    const claim = ({ resourceId, leaseId, generation, extensionId }: typeof first) =>
      ({ resourceId, leaseId, generation, ...(extensionId && { extensionId }) });
    if (role === 'extensions') {
      if (dedicated) await expect(acquireLease('other', otherExtension)).rejects.toThrow('403');
      else {
        const other = await acquireLease('other', otherExtension);
        expect(other.generation).toBe(first.generation);
        expect(other.bearer).not.toBe(first.bearer);
        expect((await identity(other.bearer)).status).toBe(401);
        await provider.release(claim(other));
      }
    }
    expect(await provider.renew(claim(first))).toMatchObject(claim(first));
    await expect(provider.retire(resourceId, first.generation)).rejects.toThrow('409');
    const revoked = role === 'extensions' ? once(viewer!, 'close') : undefined;
    await provider.release(claim(first));
    if (revoked) {
      await revoked;
      await expect.poll(() => media.clients.size).toBe(0);
      viewer = undefined;
    }
    expect((await identity(first.bearer)).status).toBe(401);
    expect(await provider.status(resourceId)).toMatchObject({ state: 'ready' });
    await provider.release(claim(second));
    if (viewer) {
      nodeReadyToRetire = true;
      await expect(provider.retire(resourceId, first.generation)).rejects.toThrow('409');
      expect(operations).not.toContain('stop');
      const closed = once(viewer, 'close');
      viewer.close(); await closed;
      await expect.poll(() => media.clients.size).toBe(0);
      await expect(provider.retire(resourceId, first.generation)).rejects.toThrow('409');
      observation.abort();
      await observationClosed;
      nodeReadyToRetire = false;
    }
    await expect(provider.retire(resourceId, first.generation)).rejects.toThrow('409');
    expect(operations).not.toContain('stop');
    nodeReadyToRetire = true;
    await expect(provider.retire(resourceId, first.generation)).rejects.toThrow('503');
    expect(await provider.status(resourceId)).toMatchObject({ state: 'unavailable', generation: first.generation });
    failDetach = false;
    expect(await provider.retire(resourceId, first.generation)).toMatchObject({ processExited: true, volumeDetached: true });
    const replacement = await acquireLease('replacement');
    expect(replacement.generation).not.toBe(first.generation);
    await provider.release(claim(replacement));
    await expect.poll(async () => (await provider.status(resourceId)).state).toBe('cold');
  } finally {
    observation.abort();
    for (const ws of media.clients) ws.terminate();
    media.close();
    await helper.close();
    await new Promise<void>(resolve => node.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
