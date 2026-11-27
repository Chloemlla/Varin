/** Dedicated, paired control plane for browsers provisioned by this deployment. */
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { createSettingsFileStore } from '@varin/settings-store';
import { registerManagedBrowserRoutes } from './lib/browser/browser-managed.js';
import { BrowserResources } from './lib/browser/browser-resources.js';
import { createBrowserSettings } from './lib/browser/browser-settings.js';
import { createNodeRoleKernel, nodeRoleAbsolute, nodeRoleBearerAuth, nodeRoleDataDirectory, openNodeRoleAuth,
  pairNodeRoleClient, registerNodeRoleIdentity, revokeNodeRoleClient } from './lib/node-role-auth.js';
import { canonicalizePathIdentity, isPathWithinRoot } from './lib/workspace/path-safety.js';

interface BrowserNodeOptions {
  dataDir: string;
  kernelPath?: string;
  host?: string;
  port?: number;
  releaseId?: string;
  endpoint?: string;
  scratchDirectory?: string;
}
const useBrowser = 'browser:use';

async function browserPaths(options: BrowserNodeOptions) {
  const dataDir = await nodeRoleDataDirectory(options.dataDir);
  const scratchDirectory = options.scratchDirectory === undefined ? undefined
    : await canonicalizePathIdentity(nodeRoleAbsolute(options.scratchDirectory, 'VARIN_BROWSER_CDP_SCRATCH_DIRECTORY'), { allowMissing: true });
  if (scratchDirectory && (isPathWithinRoot(dataDir, scratchDirectory) || isPathWithinRoot(scratchDirectory, dataDir))) {
    throw new Error('Browser state and shared transfer directories must be disjoint');
  }
  return { dataDir, scratchDirectory };
}

export async function startBrowserNode(options: BrowserNodeOptions) {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid browser node port');
  const { dataDir, scratchDirectory } = await browserPaths(options);
  const { hostId, kernel, version } = await createNodeRoleKernel(dataDir, options.kernelPath);
  const stops: (() => Promise<unknown> | void)[] = [() => kernel.close()];
  let closing: Promise<void> | undefined;
  let draining = false;
  const close = () => {
    draining = true;
    return closing ??= (async () => {
      const errors = [];
      for (const stop of stops.splice(0).reverse()) {
        try { await stop(); } catch (error) { errors.push(error); }
      }
      if (errors.length) throw new AggregateError(errors, 'Browser node shutdown incomplete');
    })();
  };
  try {
    await kernel.start();
    const { clients } = openNodeRoleAuth(dataDir);
    stops.push(() => clients.dispose());
    const auth = nodeRoleBearerAuth(clients, useBrowser);
    const resources = new BrowserResources();
    let disposal: Promise<void> | undefined;
    const disposeResources = () => disposal ??= resources.dispose();
    stops.push(disposeResources);
    const store = createSettingsFileStore({ filePath: path.join(dataDir, 'browser-node-settings.json') });
    const settings = createBrowserSettings({ resources, read: () => store.read(), update: change => store.update(change),
      environment: { endpoint: options.endpoint, scratchDirectory } });

    // Validate all owner-provisioned transfer roots without connecting to a browser.
    const deployment = await settings.read();
    for (const connection of deployment.connections) {
      if (!connection.scratchDirectory) continue;
      const configured = await canonicalizePathIdentity(nodeRoleAbsolute(connection.scratchDirectory, 'Browser transfer directory'), { allowMissing: true });
      if (!scratchDirectory || !isPathWithinRoot(configured, scratchDirectory)) {
        throw new Error('Configured browser transfer directories must lie inside the deployment transfer root');
      }
    }
    if (!deployment.connections.length) throw new Error('Provision a Browser CDP connection before starting the Browser node');
    await settings.refresh(); // Inventory only; selected Acquire explicitly connects to the real peer.
    const app = express();
    app.disable('x-powered-by');
    let probe: Promise<boolean> | undefined;
    app.get('/health', async (_req, res) => {
      if (!draining && kernel.handshake?.capabilities.includes('resourcesOnly')) {
        probe ??= kernel.probeControl(AbortSignal.timeout(1500)).catch(() => false)
          .finally(() => { probe = undefined; });
      }
      const ready = await probe === true && !draining;
      res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', role: 'browser',
        control: ready ? 'ready' : 'unavailable', releaseId: options.releaseId ?? version });
    });
    app.use((_req, res, next) => {
      if (draining) { res.status(503).json({ code: 'host-draining' }); return; }
      next();
    });
    // Peers can operate on provisioned browsers, never turn the role into an arbitrary CDP
    // connection broker or retrieve the deployment's upstream credentials / scratch paths.
    registerNodeRoleIdentity(app, { role: 'browser', hostId, capabilities: ['browser'], ...auth });
    app.get('/api/harness/managed-execution/v1/retention', auth.requireAuth, (_req, res) => {
      const activity = resources.activity();
      res.setHeader('X-Varin-Managed-Host', hostId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ retireReady: !Object.values(activity).some(Boolean) });
    });
    registerManagedBrowserRoutes(app, { hostId, resources, allowProbe: false,
      parseRequestBody: express.json({ limit: '64mb' }), ...auth });
    const fail: express.ErrorRequestHandler = (error, _req, res, _next) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
      res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Browser node request failed' });
    };
    app.use(fail);
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    stops.push(() => new Promise<void>((resolve, reject) => {
      // Allow in-flight mutations to report their result. A hung upstream does
      // not keep this node alive forever: disconnect that owner (never close
      // Chromium) and let its existing unknown-effect response reach the peer.
      const disconnect = setTimeout(() => { void disposeResources().catch(() => undefined); }, 5_000);
      const force = setTimeout(() => server.closeAllConnections(), 8_000);
      disconnect.unref(); force.unref();
      server.close(error => {
        clearTimeout(disconnect); clearTimeout(force);
        if (error) reject(error); else resolve();
      });
    }));
    const found = server.address();
    if (!found || typeof found === 'string') throw new Error('Browser node failed to bind TCP');
    return { hostId, port: found.port, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

async function main(args: string[]) {
  const options = {
    dataDir: nodeRoleAbsolute(process.env.VARIN_DATA_DIR, 'VARIN_DATA_DIR'),
    ...(process.env.VARIN_KERNEL_PATH?.trim() ? { kernelPath: process.env.VARIN_KERNEL_PATH.trim() } : {}),
    ...(process.env.VARIN_BROWSER_CDP_ENDPOINT?.trim() ? { endpoint: process.env.VARIN_BROWSER_CDP_ENDPOINT.trim() } : {}),
    ...(process.env.VARIN_BROWSER_CDP_SCRATCH_DIRECTORY?.trim() ? { scratchDirectory: process.env.VARIN_BROWSER_CDP_SCRATCH_DIRECTORY.trim() } : {}),
  };
  if (args[0] === 'pair' && args[1] === '--output' && args[2] && args.length === 3) {
    const { dataDir, scratchDirectory } = await browserPaths(options);
    await pairNodeRoleClient(dataDir, options.kernelPath, args[2],
      { label: 'Browser node coordinator', capabilities: [useBrowser], deniedDirectories: scratchDirectory ? [scratchDirectory] : [] });
  } else if (args[0] === 'revoke' && args.length === 2) {
    await revokeNodeRoleClient(options.dataDir, options.kernelPath, args[1]!);
  } else if (args.length) throw new Error('Usage: browser-node.js [pair --output /private/client.json | revoke CLIENT_ID]');
  else {
    const node = await startBrowserNode({ ...options, host: process.env.VARIN_HOST?.trim() || '127.0.0.1',
      port: process.env.VARIN_PORT === undefined ? 3000 : Number(process.env.VARIN_PORT),
      ...(process.env.VARIN_RELEASE_ID ? { releaseId: process.env.VARIN_RELEASE_ID } : {}) });
    const close = () => { void node.close().catch(() => { console.error('[BrowserNode] Shutdown incomplete'); process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}
if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error('[BrowserNode]', error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1;
  });
}
