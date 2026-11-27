import { fork } from 'node:child_process';
import { timingSafeEqual } from 'node:crypto';
import { chmod, chown, mkdir, mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { extract } from 'tar';
import WebSocket, { WebSocketServer } from 'ws';
import { isVarinExtensionId } from '@varin/extension-contract';
import { ExtensionArtifactStore } from '@varin/extension-host';
import { brokerFrame, extensionChannelToken, parseExtensionBrokerRoute, parseExtensionIdentityRoute, extensionIntegrity, extensionNodeBase, extensionNodeCredential, extensionSandboxProtocolVersion } from './lib/deployment/extension-sandbox-protocol.js';

async function makeArtifactReadable(directory: string): Promise<void> {
  // The relay owns this tree. The extension UID has read access and can write only to its own scratch.
  await Promise.all((await readdir(directory, { withFileTypes: true })).map(async entry => {
    const file = path.join(directory, entry.name);
    if (entry.isDirectory()) await makeArtifactReadable(file);
    else await chmod(file, (await stat(file)).mode & 0o111 ? 0o755 : 0o644);
  }));
  await chmod(directory, 0o755);
}

export async function receiveExtensionArtifact(store: ExtensionArtifactStore, extensionId: string, integrity: string, input: Readable) {
  if (!extensionIntegrity.test(integrity)) throw new Error('Invalid sandbox artifact identity');
  const directory = path.join(store.directory, integrity.slice(7));
  await mkdir(directory, { mode: 0o700 });
  try {
    let invalid = false;
    const upload = extract({ cwd: directory, strict: true, preserveOwner: false, filter: (name, entry) => {
      const valid = 'type' in entry && entry.type === 'File' &&
        !name.split('/').some(part => !part || part === '..' || part === '.') && !/[\\:\0]/u.test(name);
      if (!valid) invalid = true;
      return valid;
    } });
    await pipeline(input, upload);
    if (invalid) throw new Error('Extension artifact contains an invalid archive entry');
    const artifact = await store.verifyBrokeredArtifact(integrity, extensionId);
    await makeArtifactReadable(directory);
    return artifact;
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function startExtensionNode(options: {
  extensionId?: string; hostId: string; token: string; host?: string; port?: number;
}) {
  const { extensionId, hostId } = options;
  if (process.platform !== 'linux' || process.getuid?.() !== 0) throw new Error('Extension Node requires a Linux supervisor with a separate worker UID');
  if (extensionId !== undefined && !isVarinExtensionId(extensionId) || !hostId || !options.token || /\s/u.test(options.token)) {
    throw new Error('Extension Node identity or worker account is invalid');
  }
  const version = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version as string;
  const permitted = (owner: string) => extensionId === undefined || owner === extensionId;
  const authorized = (request: IncomingMessage, owner?: string) => {
    if (owner !== undefined && !permitted(owner)) return false;
    const expected = Buffer.from('Bearer ' + (owner === undefined ? options.token : extensionChannelToken(options.token, owner)));
    const header = Buffer.from(request.headers.authorization ?? '');
    const target = request.headers['x-varin-managed-target'];
    return header.length === expected.length && timingSafeEqual(header, expected) && (target === undefined || target === hostId);
  };
  const root = await mkdtemp(path.join(tmpdir(), 'varin-extension-'));
  await chmod(root, 0o711);
  const broker = fileURLToPath(new URL('../broker/broker-child.mjs', import.meta.resolve('@varin/extension-host')));
  const owners = new Map<string, Promise<{ uid: number; directory: string; store: ExtensionArtifactStore;
    artifacts: Map<string, Promise<{ modulePath: string; packageRoot: string }>> }>>();
  let nextUid = 10000;
  const openOwner = (id: string) => {
    const existing = owners.get(id);
    if (existing) return existing;
    const uid = nextUid++;
    const work = (async () => {
      const directory = await mkdtemp(path.join(root, 'owner-'));
      await chown(directory, 0, uid);
      await chmod(directory, 0o710);
      const store = new ExtensionArtifactStore({ dataDir: directory, varinVersion: version });
      await mkdir(store.directory, { recursive: true, mode: 0o755 });
      return { uid, directory, store, artifacts: new Map<string, Promise<{ modulePath: string; packageRoot: string }>>() };
    })().catch(error => { owners.delete(id); throw error; });
    owners.set(id, work);
    return work;
  };
  const running = new Set<Promise<void>>();
  const respond = (value: object) => JSON.stringify(value);
  let preparing = 0;
  let closing = false;
  const stopWorkers = new Set<() => void>();
  const sockets = new WebSocketServer({ noServer: true });
  const server = createServer(async (request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'GET' && request.url === '/health') {
      response.setHeader('Content-Type', 'application/json');
      response.end(respond({ status: 'ok', ready: !closing, role: 'extensions' }));
      return;
    }
    const route = parseExtensionBrokerRoute(request.url);
    const identityOwner = parseExtensionIdentityRoute(request.url);
    if (!authorized(request, route?.extensionId ?? identityOwner)) { response.writeHead(401).end(); return; }
    if (closing) { response.writeHead(503).end(); return; }
    response.setHeader('X-Varin-Managed-Host', hostId);
    if (request.method === 'GET' && (request.url === extensionNodeBase + '/identity' || identityOwner)) {
      response.setHeader('Content-Type', 'application/json');
      response.end(respond({ requestHostIdentity: true, protocolVersion: extensionSandboxProtocolVersion, role: 'extensions', hostId, extensionId, capabilities: ['extension-broker'] }));
      return;
    }
    if (request.method === 'GET' && request.url === extensionNodeBase + '/retention') {
      response.setHeader('Content-Type', 'application/json');
      response.end(respond({ retireReady: running.size === 0 && !preparing }));
      return;
    }
    if (request.method !== 'PUT' || !route) { response.writeHead(404).end(); return; }
    const { extensionId: owner, integrity } = route;
    preparing++;
    try {
      const { store, artifacts } = await openOwner(owner);
      let work = artifacts.get(integrity);
      if (!work) {
        work = receiveExtensionArtifact(store, owner, integrity, request)
          .catch(error => { artifacts.delete(integrity); throw error; });
        artifacts.set(integrity, work);
      } else request.resume();
      await work;
      response.writeHead(204).end();
    } catch { if (!response.destroyed) response.writeHead(422).end(); }
    finally { preparing--; }
  });

  server.on('upgrade', (request, socket, head) => {
    const reject = (status: number) => socket.end(`HTTP/1.1 ${status} Upgrade refused\r\nConnection: close\r\n\r\n`);
    const route = parseExtensionBrokerRoute(request.url);
    if (!route) { reject(404); return; }
    if (!authorized(request, route.extensionId)) { reject(401); return; }
    if (closing) { reject(503); return; }
    const owner = owners.get(route.extensionId);
    if (!owner) { reject(404); return; }
    sockets.handleUpgrade(request, socket, head, peer => {
      // The relay owns the control credential and WebSocket. No worker receives either.
      const work = (async () => {
        const { uid, directory, artifacts } = await owner;
        const paths = await artifacts.get(route.integrity);
        if (!paths) { peer.close(1008); return; }
        const scratch = await mkdtemp(path.join(directory, 'scratch-'));
        try {
          await chown(scratch, uid, uid);
          if (peer.readyState !== WebSocket.OPEN || closing) return;
          const child = fork(broker, [], { uid, gid: uid, detached: true,
            execArgv: ['--import', 'data:text/javascript,process.umask(0o077)'], cwd: scratch,
            env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, LANG: 'C.UTF-8' },
            serialization: 'json', stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
          const signal = (name: NodeJS.Signals) => {
            if (!child.pid) return;
            try { process.kill(-child.pid, name); }
            catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') child.kill(name); }
          };
          const terminate = () => signal('SIGKILL');
          stopWorkers.add(terminate);
          const exited = new Promise<void>(resolve => child.once('close', () => resolve()));
          child.on('error', terminate);
          child.on('disconnect', terminate);
          child.on('message', value => {
            if (brokerFrame(value) && ['request', 'response', 'cancel', 'event'].includes(String(value.kind)) &&
              peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify(value));
          });
          peer.once('close', terminate);
          peer.on('error', terminate);
          peer.on('message', (payload, binary) => {
            if (!child.connected) return;
            try {
              const value: unknown = binary ? null : JSON.parse(payload.toString());
              if (!brokerFrame(value)) { terminate(); return; }
              if (value.kind === 'stop') { signal(value.force === true ? 'SIGKILL' : 'SIGTERM'); return; }
              if (!['request', 'response', 'cancel'].includes(String(value.kind))) { terminate(); return; }
              if (value.kind === 'request' && ['activate', 'migrate'].includes(String(value.method))) {
                value.params = { ...(brokerFrame(value.params) ? value.params : {}), ...paths };
              }
              child.send(value, error => { if (error) terminate(); });
            } catch { terminate(); }
          });
          await exited;
          stopWorkers.delete(terminate);
          terminate();
        } finally { await rm(scratch, { recursive: true, force: true }); }
        if (peer.readyState === WebSocket.OPEN) peer.send(JSON.stringify({ kind: 'exited' }), () => peer.close());
      })().catch(() => peer.close(1011)).finally(() => { running.delete(work); });
      running.add(work);
    });
  });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(options.port ?? 0, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
  } catch (error) { await rm(root, { recursive: true, force: true }); throw error; }
  let stopped: Promise<void> | undefined;
  return {
    port: (server.address() as AddressInfo).port,
    stop() {
      return stopped ??= (async () => {
        closing = true;
        const closed = new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
        for (const terminate of stopWorkers) terminate();
        for (const peer of sockets.clients) peer.terminate();
        server.closeAllConnections();
        await closed;
        await Promise.allSettled(running);
        await Promise.allSettled([...owners.values()].map(async owner => Promise.allSettled((await owner).artifacts.values())));
        await rm(root, { recursive: true, force: true });
      })();
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { token }: {token: string} = JSON.parse(await readFile(extensionNodeCredential, 'utf8'));
  const node = await startExtensionNode({
    ...(process.env.VARIN_EXTENSION_ID && { extensionId: process.env.VARIN_EXTENSION_ID }),
    hostId: process.env.VARIN_EXTENSION_HOST_ID!, token,
    host: process.env.VARIN_HOST ?? '127.0.0.1', port: Number(process.env.VARIN_PORT ?? 3000),
  });
  const stop = () => { void node.stop().catch(() => { process.exitCode = 1; }); };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  process.send?.({ type: 'varin:ready', port: node.port });
}
