/** Standalone Computer owner. No Agent, file-source, browse-connect or UI routes. */
import http, { type IncomingMessage } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import {
  openNodeRoleAuth, nodeRoleDataDirectory, createNodeRoleKernel, pairNodeRoleClient, revokeNodeRoleClient, registerNodeRoleIdentity,
} from './lib/node-role-auth.js';
import { createComputerService, type ComputerServiceOptions } from './lib/computer/computer-service.js';
import {
  COMPUTER_NODE_CONTROL, COMPUTER_NODE_OBSERVE, COMPUTER_NODE_SYSTEM, mountComputerNodeRole,
} from './lib/computer/computer-node-role.js';

interface StateOptions { dataDir: string; kernelPath?: string }
interface ComputerNodeOptions extends StateOptions {
  host?: string; port?: number; releaseId?: string;
  driverDir?: string;
  /** Install-time and integration-test selection, never an HTTP input. */
  platform?: ComputerServiceOptions['platform'];
  createDriver?: ComputerServiceOptions['createDriver'];
}

export async function pairComputerNode(options: StateOptions & { output: string; control?: boolean; system?: boolean }) {
  if (options.system && !options.control) throw new Error('--allow-system also requires --allow-control');
  return pairNodeRoleClient(options.dataDir, options.kernelPath, options.output, {
    label: 'Computer node coordinator',
    capabilities: [COMPUTER_NODE_OBSERVE, ...(options.control ? [COMPUTER_NODE_CONTROL] : []), ...(options.system ? [COMPUTER_NODE_SYSTEM] : [])],
  });
}

export async function revokeComputerNodeClient(options: StateOptions, clientId: string) {
  return revokeNodeRoleClient(options.dataDir, options.kernelPath, clientId);
}

export async function startComputerNode(options: ComputerNodeOptions) {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid node port');
  if (options.driverDir && !path.isAbsolute(options.driverDir)) throw new Error('Computer driver directory must be an absolute path');
  const dataDir = await nodeRoleDataDirectory(options.dataDir);
  const { kernel, hostId, version } = await createNodeRoleKernel(dataDir, options.kernelPath);
  let draining = false, closing: Promise<void> | undefined;
  const cleanup: Array<() => unknown|Promise<unknown>> = [() => kernel.close()];
  const close = () => {
    draining = true;
    return closing ??= (async () => {
      const failures = [];
      for (const stop of cleanup.splice(0).reverse()) try { await stop(); } catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, 'Computer node shutdown incomplete');
    })();
  };
  try {
    await kernel.start();
    const { clients } = openNodeRoleAuth(dataDir);
    cleanup.push(() => clients.dispose());
    const computers = createComputerService({ client: kernel, dataDir, hostId, appVersion: version,
      ...(options.platform ? { platform: options.platform } : {}),
      ...(options.driverDir ? { driverDir: options.driverDir } : {}),
      ...(options.createDriver ? { createDriver: options.createDriver } : {}),
      // Remote work IDs are not local Thread IDs. The assignment lane accepts
      // only authenticated, owner-issued remote grants; no Agent client runs here.
    });
    cleanup.push(() => computers.dispose());
    const app = express(); app.disable('x-powered-by');
    const server = http.createServer(app);
    let health: Promise<boolean> | undefined;
    app.get('/health', async (_req, res) => {
      if (!draining && kernel.handshake?.capabilities.includes('resourcesOnly')) {
        health ??= kernel.probeControl(AbortSignal.timeout(1_500)).catch(() => false).finally(() => { health = undefined; });
      }
      const responsive = await health;
      const ready = !draining && responsive === true;
      res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', role: 'computer',
        control: ready ? 'ready' : 'unavailable', releaseId: options.releaseId ?? version });
    });
    app.use(express.json({ limit: '4mb' }));
    const authenticate = async (req: IncomingMessage) => {
      const authorization = req.headers.authorization;
      const bearer = typeof authorization === 'string' ? /^Bearer ([^\s,]{1,1024})$/i.exec(authorization)?.[1] : undefined;
      if (!bearer) return undefined;
      const auth = await clients.authenticateBearerToken(bearer, req);
      return auth ? { clientId: auth.clientId, capabilities: auth.client.capabilities } : undefined;
    };
    const identityAuth: Parameters<typeof registerNodeRoleIdentity>[1] = { role: 'computer', hostId, capabilities: ['computer'],
      requireAuth: (_req, res, next) => { if (draining) res.status(503).json({ code: 'host-draining' }); else next(); },
      clientId: async req => {
        const credential = await authenticate(req);
        return credential?.capabilities.includes(COMPUTER_NODE_OBSERVE) ? credential.clientId : undefined;
      },
    };
    registerNodeRoleIdentity(app, identityAuth);
    const role = mountComputerNodeRole({ app, server, computers, hostId, isDraining: () => draining, authenticate });
    cleanup.push(role.closeObservers);
    app.get('/api/harness/managed-execution/v1/retention', identityAuth.requireAuth, async (req, res) => {
      if (!await identityAuth.clientId(req)) { res.status(401).json({ code: 'computer-peer-required' }); return; }
      const retireReady = await role.canRetire();
      res.setHeader('X-Varin-Managed-Host', hostId);
      res.setHeader('Cache-Control', 'no-store');
      res.json({ retireReady: !draining && retireReady });
    });
    const errorHandler: express.ErrorRequestHandler = (error, _req, res, _next) => {
      if (res.headersSent) { res.destroy(); return; }
      const code = typeof error?.status === 'number' && error.status >= 400 && error.status < 500 ? error.status : 500;
      res.status(code).json({ error: code === 413 ? 'Request body too large' : 'Computer node request failed' });
    };
    app.use(errorHandler);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanup.push(() => new Promise<void>((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      role.closeObservers();
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Computer node failed to bind TCP');
    return { hostId, port: address.port, close };
  } catch (error) { await close(); throw error; }
}

async function main(args: string[]) {
  const dataDir = process.env.VARIN_DATA_DIR;
  if (!dataDir || !path.isAbsolute(dataDir)) throw new Error('VARIN_DATA_DIR must be an explicit absolute path');
  const kernelPath = process.env.VARIN_KERNEL_PATH?.trim();
  const options = { dataDir, ...(kernelPath ? { kernelPath } : {}) };
  if (args[0] === 'pair' && args[1] === '--output' && args[2] && args.slice(3).every(arg => ['--allow-control', '--allow-system'].includes(arg))) {
    await pairComputerNode({ ...options, output: args[2], control: args.includes('--allow-control'), system: args.includes('--allow-system') });
  } else if (args[0] === 'revoke' && args.length === 2) {
    await revokeComputerNodeClient(options, args[1]!);
  } else if (args.length) {
    throw new Error('Usage: computer-node.js [pair --output /private/client.json [--allow-control] [--allow-system] | revoke CLIENT_ID]');
  } else {
    const port = process.env.VARIN_PORT === undefined ? 3000 : Number(process.env.VARIN_PORT);
    const driverDir = process.env.VARIN_COMPUTER_DRIVER_DIR?.trim();
    const node = await startComputerNode({ ...options, port, host: process.env.VARIN_HOST?.trim() || '127.0.0.1',
      ...(driverDir ? { driverDir } : {}), ...(process.env.VARIN_RELEASE_ID ? { releaseId: process.env.VARIN_RELEASE_ID } : {}) });
    const close = () => { void node.close().catch(() => { console.error('[ComputerNode] Shutdown incomplete'); process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => {
    console.error('[ComputerNode]', error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1;
  });
}
