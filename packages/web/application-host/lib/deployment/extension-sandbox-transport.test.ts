import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import { extensionSandboxProtocolVersion } from './extension-sandbox-protocol.js';
import { extensionSandboxTransport } from './extension-sandbox-transport.js';
import type { ResourceProvider } from './resource-provider.js';

it('streams a verified artifact and routes capability requests on the selected extension channel', async () => {
  const integrity = 'sha256-' + '0'.repeat(64);
  const extensionId = 'dev.example.sandbox';
  const root = await mkdtemp(path.join(tmpdir(), 'varin-extension-transfer-'));
  await writeFile(path.join(root, 'artifact-index.json'), '{"artifact":"transferred"}');
  const upload = vi.fn();
  const requests = vi.fn<(_value: { params?: unknown }) => void>();
  const server = createServer(async (req, res) => {
    if (req.headers.authorization !== 'Bearer lease') { res.writeHead(401).end(); return; }
    if (req.method === 'PUT') {
      const chunks: Buffer[] = [];
      for await (const bytes of req) chunks.push(bytes);
      upload(req.url, Buffer.concat(chunks).toString());
      res.setHeader('X-Varin-Managed-Host', 'extension-host');
      res.writeHead(204).end();
    } else {
      res.setHeader('X-Varin-Managed-Host', 'extension-host');
      res.end(JSON.stringify({ role: 'extensions', protocolVersion: extensionSandboxProtocolVersion }));
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', peer => {
    peer.send(JSON.stringify({ kind: 'event', event: 'ready' }));
    let serviceRequest: string;
    peer.on('message', bytes => {
      const msg = JSON.parse(bytes.toString());
      requests(msg);
      const send = (value: object) => peer.send(JSON.stringify(value));
      if (msg.kind === 'stop') { send({ kind: 'exited' }); peer.close(); }
      else if (msg.method === 'service.invoke') {
        serviceRequest = msg.id;
        send({ kind: 'request', id: 'storage', method: 'storage.update', params: { value: 42 } });
      } else if (msg.id === 'storage') {
        send({ kind: 'response', id: serviceRequest, success: true, result: msg.result });
      } else send({ kind: 'response', id: msg.id, success: true, result: null });
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const release = vi.fn(async () => {});
  const provider: ResourceProvider = {
    id: 'fixtures', describe: async () => [{ id: 'sandbox', hostId: 'extension-host', role: 'extensions', label: 'Sandbox', capabilities: ['extension-broker'] }],
    acquire: async use => ({ ...use, generation: 'generation', endpoint: 'http://127.0.0.1:' + (server.address() as AddressInfo).port,
      bearer: 'lease', expiresAt: Date.now() + 60_000 }),
    release, renew: async () => { throw new Error('Unexpected renewal'); },
    status: async () => { throw new Error('Unexpected status'); },
    retire: async () => { throw new Error('Unexpected retirement'); },
  };
  const requestFromExtension = vi.fn(async () => 42);
  const onCrash = vi.fn();
  const broker = extensionSandboxTransport(provider)({
    artifact: { integrity, open: async () => ({ root, files: ['artifact-index.json'] }) },
    grants: [], owner: { extensionId, entrypointId: 'host', extensionVersion: '1', instanceKey: 'instance', generation: 1 },
    requestFromExtension, onCrash,
  });
  try {
    await broker.request('activate', { packageRoot: 'private-path', modulePath: 'private-module', storage: {} });
    expect(upload).toHaveBeenCalledWith(expect.stringContaining(integrity), expect.stringContaining('{"artifact":"transferred"}'));
    expect(requests.mock.calls[0]?.[0].params).toEqual({ storage: {} });
    expect(await broker.request('service.invoke')).toBe(42);
    expect(requestFromExtension).toHaveBeenCalledWith('storage.update', { value: 42 }, expect.any(AbortSignal));
    expect(await broker.terminate()).toEqual({ processExited: true, cleanup: 'confirmed' });
    expect(onCrash).not.toHaveBeenCalled();
    await expect.poll(() => release.mock.calls.length).toBe(1);
  } finally {
    for (const peer of wss.clients) peer.terminate();
    wss.close();
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    await rm(root, { recursive: true, force: true });
  }
});
