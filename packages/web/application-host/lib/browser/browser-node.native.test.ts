import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it as test } from 'vitest';
import { WebSocketServer } from 'ws';
import type { BrowserResource } from '@varin/protocol';
import { startBrowserNode } from '../../browser-node.js';
import { pairNodeRoleClient, revokeNodeRoleClient } from '../node-role-auth.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import { ManagedBrowserPeers } from './browser-managed.js';
import { BrowserResources } from './browser-resources.js';

const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? fileURLToPath(new URL(
  '../../../../../kernel/target/release/' + (process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'), import.meta.url));
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Browser node acceptance requires a release kernel');
const it = test.skipIf(!available);

it('discovers a dormant browser through its paired role, then reacquires a fresh session on the same durable node', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-browser-node-'));
  const dataDir = path.join(root, 'state');
  let instance = 'first', connected = 0;
  const cdp = new WebSocketServer({ noServer: true });
  const upstream = http.createServer((request, response) => {
    if (request.url !== '/json/version') { response.writeHead(404).end(); return; }
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify({ webSocketDebuggerUrl: `ws://${request.headers.host}/devtools/browser/${instance}` }));
  });
  upstream.on('upgrade', (request, socket, head) => cdp.handleUpgrade(request, socket, head, peer => {
    connected++;
    peer.on('message', bytes => {
      const { id, method } = JSON.parse(bytes.toString());
      const result = method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'tab', type: 'page', title: 'Original tab', url: 'about:blank' }] } : {};
      peer.send(JSON.stringify({ id, result }));
    });
  }));
  await new Promise<void>((resolve, reject) => {
    upstream.once('error', reject);
    upstream.listen(0, '127.0.0.1', resolve);
  });
  const address = upstream.address();
  if (!address || typeof address === 'string') throw new Error('CDP fixture failed to bind TCP');
  const options = { dataDir, kernelPath, port: 0, endpoint: 'http://127.0.0.1:' + address.port };
  let node: Awaited<ReturnType<typeof startBrowserNode>> | undefined;
  const issue = async (capability: string) => {
    const output = path.join(root, capability.replace(':', '-') + '.json');
    await pairNodeRoleClient(dataDir, kernelPath, output, { label: 'Native acceptance coordinator', capabilities: [capability] });
    return JSON.parse(await fs.readFile(output, 'utf8')) as { clientId: string; token: string };
  };
  try {
    const browser = await issue('browser:use'), other = await issue('filesystem:read');
    node = await startBrowserNode(options);
    const origin = () => 'http://127.0.0.1:' + node!.port;
    const request = (route: string, token?: string, input?: object) => fetch(origin() + '/api/harness/managed-execution/v1' + route, {
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(input ? { 'content-type': 'application/json' } : {}) },
      ...(input ? { method: 'POST', body: JSON.stringify(input) } : {}),
    });
    expect(await (await fetch(origin() + '/health')).json()).toMatchObject({ role: 'browser', control: 'ready' });
    expect([401, 403]).toContain((await request('/identity')).status);
    expect((await request('/identity', other.token)).status).toBe(403);
    const id = await request('/identity', browser.token);
    expect(id.headers.get('x-varin-managed-host')).toBe(node.hostId);
    expect(await id.json()).toMatchObject({ hostId: node.hostId, capabilities: ['browser'], role: 'browser' });
    expect((await request('/sources/resolve', browser.token, { path: root })).status).toBe(404);
    expect((await request('/browser/probe', browser.token, { endpoint: options.endpoint })).status).toBe(404);
    expect((await request('/browser/configuration', browser.token)).ok).toBe(false);

    const catalog = new BrowserResources();
    const targets = createManagedRemoteTargetRegistry({ coordinatorHostId: 'coordinator', kernel: {} as never,
      resources: {} as never, readSettings: async () => ({ desktopHosts: [{ id: 'browser', label: 'Browser',
        apiUrl: origin(), clientToken: browser.token }] }) });
    const peers = new ManagedBrowserPeers('coordinator', catalog, targets);
    await peers.refresh();
    const [dormant] = await catalog.list();
    expect(dormant?.state).toBe('disconnected');
    expect(connected).toBe(0);
    const first = await catalog.acquire(dormant!.browserId);
    expect(first.state).toBe('online');
    expect(first.capabilities).not.toContain('upload');
    expect(connected).toBe(1);
    const hostId = node.hostId;
    const listing = (resource: { instanceId?: string }) => request('/browser/call', browser.token, {
      coordinatorHostId: 'coordinator', browserId: 'configured-cdp', instanceId: resource.instanceId, method: 'list', args: [],
    });
    expect(await (await listing(first)).json()).toMatchObject({ value: [{ pageId: 'tab' }] });

    await node.close();
    instance = 'restarted-browser';
    node = await startBrowserNode(options);
    expect(node.hostId).toBe(hostId);
    expect(connected).toBe(1);
    const acquire = await request('/browser/resources/configured-cdp/acquire', browser.token, {});
    expect(acquire.status).toBe(200);
    const { resources: [second] } = await acquire.json() as { resources: [BrowserResource] };
    expect(second.instanceId).not.toBe(first.instanceId);
    expect(second.browserId).toBe('configured-cdp');
    expect((await listing(first)).status).toBe(409);
    expect((await listing(second)).status).toBe(200);
    await node.close(); node = undefined;
    await revokeNodeRoleClient(dataDir, kernelPath, browser.clientId);
    node = await startBrowserNode(options);
    expect([401, 403]).toContain((await request('/identity', browser.token)).status);
  } finally {
    await node?.close();
    for (const peer of cdp.clients) peer.terminate();
    cdp.close();
    await new Promise<void>(resolve => upstream.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  }
}, 60_000);
