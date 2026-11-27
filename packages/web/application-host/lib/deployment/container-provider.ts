import { execFile } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, readFile, realpath, stat } from 'node:fs/promises';
import { createServer, request, type IncomingMessage, type ServerResponse } from 'node:http';
import type { Server } from 'node:http';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { isPathWithinRoot } from '../workspace/path-safety.js';
import type { ProviderResource, ProviderStatus } from './resource-provider.js';
import { isVarinExtensionId } from '@varin/extension-contract';
import { extensionChannelToken, parseExtensionBrokerRoute, parseExtensionIdentityRoute, extensionNodeCredential } from './extension-sandbox-protocol.js';

const execute = promisify(execFile);
const basePath = '/api/harness/managed-execution/v1';
const imageNode = { state: '/home/varin/.config/varin', workspace: '/home/varin/workspaces' };
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

interface Definition {
  resource: ProviderResource;
  image: string;
  workspace: string | undefined;
  state?: string;
  extension?: { credentialPath: string };
  network?: string;
  token: string;
  container: string;
  configuration: string;
}
interface ContainerState {
  Id: string;
  State: { Running: boolean; StartedAt: string };
  Config: { Labels: Record<string, string> };
  NetworkSettings: { Ports?: Record<string, Array<{ HostIp: string; HostPort: string }> | null> };
}
interface Allocation {
  generation: string;
  containerId: string;
  nodePort: number;
}
interface Lease {
  leaseId: string;
  resourceId: string;
  generation: string;
  bearer: string;
  extensionId?: string;
  expiresAt: number;
}
interface ResourceSlot {
  definition: Definition;
  state: ProviderStatus['state'];
  instance?: Allocation | undefined;
  lane: Promise<unknown>;
  leases: Map<string, Lease>;
  requests: number;
  needsInspection?: boolean;
  idleTimer?: ReturnType<typeof setTimeout>;
}

function object(value: unknown, name: string, allowed?: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(name + ' must be an object');
  const record = value as Record<string, unknown>;
  if (allowed && Object.keys(record).some(key => !allowed.includes(key))) throw new Error(name + ' contains an unknown field');
  return record;
}
function name(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.length || value !== value.trim()) throw new Error(field + ' must be a nonempty string');
  return value;
}
function absolute(value: unknown, field: string): string {
  const input = name(value, field);
  if (!path.isAbsolute(input)) throw new Error(field + ' must be an absolute path');
  return input;
}
async function directory(value: unknown, field: string): Promise<string> {
  const file = await realpath(absolute(value, field));
  if (!(await stat(file)).isDirectory()) throw new Error(field + ' must be a directory');
  return file;
}
async function credential(file: string): Promise<string> {
  const token = name(object(JSON.parse(await readFile(file, 'utf8')), 'provider credentials').token, 'token');
  if (/\s/u.test(token)) throw new Error('Invalid provider token');
  return token;
}
const mount = (root: string, target: string) => `type=bind,"src=${root.replaceAll('"', '""')}",dst=${target}`;

async function readConfig(file: string) {
  const input = object(JSON.parse(await readFile(file, 'utf8')), 'container provider', [
    'version', 'id', 'socketPath', 'credentialFile', 'engine', 'leaseDurationMs', 'startupTimeoutMs', 'idleRetentionMs', 'resources',
  ]);
  if (input.version !== 1) throw new Error('Unsupported container provider configuration version');
  const id = name(input.id, 'id');
  const engine = input.engine ?? 'docker';
  if (engine !== 'docker' && engine !== 'podman') throw new Error('engine must be docker or podman');
  const duration = (field: string) => {
    const value = input[field];
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new Error(field + ' must be a positive duration in milliseconds');
    return value;
  };
  if (!Array.isArray(input.resources)) throw new Error('resources must be an array');
  const definitions = await Promise.all(input.resources.map(async raw => {
    const entry = object(raw, 'container resource', ['id', 'hostId', 'label', 'role', 'browserId', 'desktopId', 'extensionId', 'network', 'image', 'workspace', 'state', 'credentialFile']);
    const role = entry.role ?? 'resources';
    if (role !== 'resources' && role !== 'browser' && role !== 'computer' && role !== 'extensions') throw new Error('Unknown local provider role');
    if (role !== 'resources' && entry.workspace !== undefined || role !== 'browser' && entry.browserId !== undefined
      || role !== 'computer' && entry.desktopId !== undefined
      || role === 'extensions' && entry.state !== undefined || role !== 'extensions' && entry.extensionId !== undefined
      || role !== 'resources' && role !== 'extensions' && entry.network !== undefined) {
      throw new Error('Resource configuration contains fields for another node role');
    }
    const [workspace, state, credentialPath] = await Promise.all([role === 'resources' ? directory(entry.workspace, 'workspace') : undefined,
      role !== 'extensions' ? directory(entry.state, 'state') : undefined,
      realpath(absolute(entry.credentialFile, 'credentialFile'))]);
    if (workspace && state && (isPathWithinRoot(state, workspace) || isPathWithinRoot(workspace, state) || isPathWithinRoot(credentialPath, workspace))) {
      throw new Error('Resource workspace, node state and provisioning credential must be separated');
    }
    const resourceId = name(entry.id, 'resource id'), hostId = name(entry.hostId, 'node hostId');
    const image = name(entry.image, 'image');
    if (image.startsWith('-')) throw new Error('Invalid image reference');
    const extensionId = entry.extensionId === undefined ? undefined : name(entry.extensionId, 'extensionId');
    if (extensionId && !isVarinExtensionId(extensionId)) throw new Error('Invalid sandbox extension ID');
    const network = entry.network === undefined ? undefined : name(entry.network, 'network');
    if (network === 'host' || network?.startsWith('container:') || network?.startsWith('ns:')) throw new Error('Resource sandbox needs a separate network namespace');
    const resource: ProviderResource = { id: resourceId, hostId, label: name(entry.label, 'resource label'), role,
      ...(role === 'browser'
        ? { browserId: name(entry.browserId, 'Browser Node browserId'), capabilities: ['browser', 'tabs', 'open', 'read', 'screenshot', 'act', 'activate'] }
        : role === 'computer' ? { desktopId: name(entry.desktopId, 'Computer Node desktopId'), platform: 'linux', capabilities: ['computer'] }
        : role === 'extensions' ? { ...(extensionId && { extensionId }), capabilities: ['extension-broker'] }
        : { capabilities: ['sources', 'work-location-read', 'work-location'] }) };
    return { resource, image, workspace, ...(state && { state }), token: await credential(credentialPath),
      ...(role === 'extensions' && { extension: { credentialPath } }), ...(network && { network }),
      container: 'varin-resource-' + digest([id, resourceId]).slice(0, 24),
      configuration: digest(role === 'extensions' ? [2, role, hostId, image, extensionId, credentialPath, network]
        : role === 'resources' ? [2, hostId, image, workspace, state, network] : [role, hostId, image, state, resource.browserId ?? resource.desktopId]) };
  }));
  const overlaps = (left: string, right: string) => isPathWithinRoot(left, right) || isPathWithinRoot(right, left);
  const roots = (entry: Definition) => [entry.workspace, entry.state].filter((root): root is string => !!root);
  for (const [index, definition] of definitions.entries()) {
    if (definitions.slice(0, index).some(prior => prior.resource.id === definition.resource.id ||
      prior.resource.hostId === definition.resource.hostId || definition.resource.role === 'extensions' && prior.resource.role === 'extensions' &&
      definition.resource.extensionId === prior.resource.extensionId ||
      roots(prior).some(root => roots(definition).some(other => overlaps(root, other))))) {
      throw new Error('A provider resource needs its own identity and exclusive workspace and state mounts');
    }
    const sandboxCredential = definition.extension?.credentialPath;
    if (sandboxCredential && definitions.some(candidate => candidate.workspace && isPathWithinRoot(sandboxCredential, candidate.workspace))) {
      throw new Error('Extension sandbox credentials must be outside resource workspaces');
    }
  }
  const credentialPath = await realpath(absolute(input.credentialFile, 'credentialFile'));
  if (definitions.some(definition => definition.workspace && isPathWithinRoot(credentialPath, definition.workspace))) throw new Error('Provider credentials must be outside resource workspaces');
  return { socketPath: absolute(input.socketPath, 'socketPath'), token: await credential(credentialPath), engine: engine as 'docker' | 'podman', definitions,
    leaseDurationMs: duration('leaseDurationMs'), startupTimeoutMs: duration('startupTimeoutMs'),
    idleRetentionMs: input.idleRetentionMs === undefined ? undefined : duration('idleRetentionMs') };
}

type EngineRunner = (engine: 'docker' | 'podman', args: string[]) => Promise<string>;
const runEngine: EngineRunner = async (engine, args) => (await execute(engine, args, { windowsHide: true })).stdout;

function driver(engine: 'docker' | 'podman', startupTimeoutMs: number, invoke: EngineRunner) {
  const run = async (...args: string[]) => {
    // The helper is the only process with engine access. Calls never run a
    // shell or pass model/user arguments to the engine.
    try { return (await invoke(engine, args)).trim(); }
    catch { throw new Error(`Container engine ${args[0]} failed`); }
  };
  const inspect = async (definition: Definition): Promise<ContainerState | null> => {
    // Listing succeeds on absence and fails distinctly when the daemon is down.
    const ids = (await run('ps', '-a', '--filter', `name=${definition.container}`, '--format', '{{.Names}}')).split(/\r?\n/u);
    if (!ids.includes(definition.container)) return null;
    const [instance] = JSON.parse(await run('inspect', definition.container)) as ContainerState[];
    if (!instance || instance.Config.Labels?.['io.varin.provider.configuration'] !== definition.configuration) {
      throw new Error('Existing resource container belongs to a different configuration');
    }
    return instance;
  };
  const allocate = async (definition: Definition): Promise<Allocation> => {
    let instance = await inspect(definition);
    if (instance && !instance.State.Running) {
      // Removing the stopped container is the engine's detach point. Mount
      // directories are never removed, and the name cannot be reused earlier.
      await run('rm', instance.Id);
      instance = null;
    }
    if (!instance) {
      const sandbox = definition.extension;
      const id = await run('create', '--name', definition.container, '--label', 'io.varin.provider.configuration=' + definition.configuration,
        ...(definition.workspace ? ['--mount', mount(definition.workspace, imageNode.workspace)] : []),
        ...(definition.state ? ['--mount', mount(definition.state, imageNode.state)] : []),
        ...(sandbox ? ['--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,mode=1777',
          '--security-opt=no-new-privileges', '--cap-drop=ALL', '--cap-add=SETUID', '--cap-add=SETGID', '--cap-add=CHOWN', '--cap-add=KILL', '--cap-add=DAC_OVERRIDE',
          '--mount', mount(sandbox.credentialPath, extensionNodeCredential) + ',readonly',
          ...(definition.resource.extensionId ? ['--env', 'VARIN_EXTENSION_ID=' + definition.resource.extensionId] : []),
          '--env', 'VARIN_EXTENSION_HOST_ID=' + definition.resource.hostId] : definition.resource.role === 'resources'
          ? ['--security-opt=no-new-privileges', '--cap-drop=ALL'] : []),
        ...(definition.network ? ['--network=' + definition.network] : []),
        '--publish', '127.0.0.1::3000', definition.image);
      await run('start', id);
      instance = await inspect(definition);
    }
    const port = Number(instance?.NetworkSettings.Ports?.['3000/tcp']?.find(entry => entry.HostIp === '127.0.0.1')?.HostPort);
    if (!instance?.State.Running || !Number.isInteger(port) || port <= 0) throw new Error('Resource container has no loopback service endpoint');
    const signal = AbortSignal.timeout(startupTimeoutMs);
    for (;;) {
      signal.throwIfAborted();
      const response = await fetch(`http://127.0.0.1:${port}${basePath}/identity`, {
        headers: { Authorization: 'Bearer ' + definition.token }, signal, redirect: 'error',
      }).catch(() => null);
      if (response?.ok) {
        const identity = object(await response.json(), 'node identity');
        if (identity.hostId !== definition.resource.hostId || identity.role !== definition.resource.role || identity.requestHostIdentity !== true
          || definition.extension && identity.extensionId !== definition.resource.extensionId
          || response.headers.get('x-varin-managed-host') !== definition.resource.hostId) throw new Error('Container does not own the declared Node identity');
        return { containerId: instance.Id, generation: digest([instance.Id, instance.State.StartedAt]), nodePort: port };
      }
      await response?.body?.cancel();
      if (response?.status === 401 || response?.status === 403) throw new Error('Resource Node pairing credential is unavailable');
      await delay(100, undefined, { signal });
    }
  };
  const stop = async (definition: Definition, expected: Allocation) => {
    const instance = await inspect(definition);
    if (!instance || instance.Id !== expected.containerId || digest([instance.Id, instance.State.StartedAt]) !== expected.generation) {
      throw new Error('Original container generation is no longer confirmed');
    }
    if (instance.State.Running) {
      const response = await fetch(`http://127.0.0.1:${expected.nodePort}${basePath}/retention`, {
        headers: { Authorization: 'Bearer ' + definition.token }, signal: AbortSignal.timeout(startupTimeoutMs), redirect: 'error',
      });
      if (!response.ok || response.headers.get('x-varin-managed-host') !== definition.resource.hostId) {
        await response.body?.cancel();
        throw new Error('Node retention is unavailable');
      }
      if (object(await response.json(), 'node retention').retireReady !== true) return false;
      await run('stop', instance.Id);
    }
    const stopped = await inspect(definition);
    if (stopped?.Id !== instance.Id || stopped.State.Running) throw new Error('Container exit is unconfirmed');
    await run('rm', stopped.Id);
    if (await inspect(definition)) throw new Error('Container volume detach is unconfirmed');
    return true;
  };
  const stillRunning = async (definition: Definition, previous: Allocation) => {
    const found = await inspect(definition);
    return !!found && found.State.Running && digest([found.Id, found.State.StartedAt]) === previous.generation;
  };
  return { allocate, stop, stillRunning };
}

const send = (res: ServerResponse, status: number, value?: unknown) => {
  if (value === undefined) { res.writeHead(status).end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }).end(JSON.stringify(value));
};
const listen = (server: Server, start: (ready: () => void) => void) => new Promise<void>((resolve, reject) => {
  const fail = (error: Error) => reject(error);
  server.once('error', fail);
  start(() => { server.off('error', fail); resolve(); });
});
const close = (server: Server) => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
const secretMatches = (actual: unknown, expected: string): boolean => {
  if (typeof actual !== 'string') return false;
  const a = Buffer.from(actual), b = Buffer.from(expected);
  return a.byteLength === b.byteLength && timingSafeEqual(a, b);
};

/** Independent operator process. Short-lived lease tokens terminate here; the
 * Node's offline pairing credential never reaches the Application Host. */
export async function startContainerResourceProvider(file: string, invoke: EngineRunner = runEngine) {
  const config = await readConfig(absolute(file, 'provider config'));
  const engine = driver(config.engine, config.startupTimeoutMs, invoke);
  const slots = new Map<string, ResourceSlot>(config.definitions.map(definition => [definition.resource.id, {
    definition, state: 'cold', lane: Promise.resolve(), leases: new Map(), requests: 0,
  }]));
  const sweep = (slot: ResourceSlot) => {
    for (const [key, lease] of slot.leases) if (lease.expiresAt <= Date.now()) slot.leases.delete(key);
  };
  let closing = false;
  async function retire(slot: ResourceSlot, generation: string) {
    sweep(slot);
    if (!slot.instance || generation !== slot.instance.generation || slot.leases.size || slot.requests) return false;
    slot.state = 'retiring';
    try {
      if (!await engine.stop(slot.definition, slot.instance)) { slot.state = 'ready'; return false; }
      slot.instance = undefined;
      slot.state = 'cold';
      return true;
    } catch (error) { slot.state = 'unavailable'; throw error; }
  }
  function planIdle(slot: ResourceSlot) {
    clearTimeout(slot.idleTimer);
    const idle = config.idleRetentionMs;
    if (closing || idle === undefined || slot.state !== 'ready' || !slot.instance || slot.requests) return;
    sweep(slot);
    const generation = slot.instance.generation;
    const lastExpiry = Math.max(Date.now(), ...[...slot.leases.values()].map(lease => lease.expiresAt));
    slot.idleTimer = setTimeout(() => {
      const work = slot.lane.then(() => retire(slot, generation));
      slot.lane = work.catch(() => {});
      void work.then(() => planIdle(slot), () => {});
    }, Math.min(2_147_483_647, lastExpiry - Date.now() + idle));
    slot.idleTimer.unref?.();
  }
  const desktopMediaPath = /^\/api\/computers\/desktops\/[^/]+\/vnc$/u;
  const resolveDataRequest = (req: IncomingMessage, upgrade: boolean) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const match = /^\/resources\/id-([^/]+)(\/.*)$/u.exec(url.pathname);
    let id: string;
    try { id = decodeURIComponent(match?.[1] ?? ''); } catch { return { status: 400 } as const; }
    const slot = slots.get(id);
    if (!match || slot?.state !== 'ready' || !slot.instance) return { status: 404 } as const;
    const api = match[2]!, computer = slot.definition.resource.role === 'computer';
    const extension = slot.definition.resource.role === 'extensions';
    const broker = extension ? parseExtensionBrokerRoute(api) : undefined;
    const extensionId = broker?.extensionId ?? (extension ? parseExtensionIdentityRoute(api) : undefined);
    const allowed = extension ? (upgrade ? broker : broker || extensionId !== undefined && req.method === 'GET')
      : upgrade ? computer && desktopMediaPath.test(api)
      : api.startsWith(basePath + '/') || computer && (api === '/api/computers' || api.startsWith('/api/computers/'));
    if (!allowed) return { status: 404 } as const;
    sweep(slot);
    const lease = [...slot.leases.values()].find(candidate => secretMatches(req.headers.authorization, 'Bearer ' + candidate.bearer));
    if (!lease || lease.generation !== slot.instance.generation
      || extensionId && lease.extensionId !== extensionId) return { status: 401 } as const;
    return { slot, instance: slot.instance, api, path: extension ? api : api + url.search, lease, extensionId };
  };
  const beginRequest = (slot: ResourceSlot) => {
    // Count upstream lifetime as well as the downstream socket. A pending
    // operation on the Node remains accounted for after a reader disconnects.
    slot.requests++;
    let retained = true;
    return () => { if (retained) { retained = false; slot.requests--; planIdle(slot); } };
  };
  const proxyHeaders = (req: IncomingMessage, slot: ResourceSlot, port: number, extensionId?: string) => {
    const headers = { ...req.headers };
    for (const key of ['origin', 'connection', 'keep-alive', 'upgrade', 'transfer-encoding', 'proxy-authorization']) delete headers[key];
    return { ...headers, host: `127.0.0.1:${port}`, authorization: 'Bearer ' + (extensionId ? extensionChannelToken(slot.definition.token, extensionId) : slot.definition.token) };
  };
  const data = createServer((req, res) => {
    const target = resolveDataRequest(req, false);
    if ('status' in target) { send(res, target.status); return; }
    const { slot, instance, api, path, extensionId } = target;
    const settle = beginRequest(slot);
    const observation = slot.definition.resource.role === 'computer' && req.method === 'GET' && api.endsWith('/stream');
    const outbound = request({ hostname: '127.0.0.1', port: instance.nodePort, path,
      method: req.method ?? 'GET', headers: proxyHeaders(req, slot, instance.nodePort, extensionId) }, upstream => {
      if (res.destroyed) upstream.resume();
      else {
        const headers = { ...upstream.headers };
        for (const key of ['connection', 'keep-alive', 'upgrade', 'transfer-encoding']) delete headers[key];
        res.writeHead(upstream.statusCode ?? 502, headers);
        upstream.pipe(res);
      }
      upstream.once('close', settle);
      upstream.once('error', error => { if (!res.destroyed) res.destroy(error); });
    });
    if (observation) res.once('close', () => { if (!res.writableFinished) outbound.destroy(); });
    outbound.once('error', () => {
      if (!req.aborted && !(observation && res.destroyed) && slot.instance === instance) slot.needsInspection = true;
      settle();
      if (!res.headersSent && !res.destroyed) send(res, 502);
      else if (!res.destroyed) res.destroy();
    });
    req.once('aborted', () => { if (!req.complete) outbound.destroy(); });
    req.pipe(outbound);
  });
  const mediaSockets = new Set<Duplex>();
  const extensionSockets = new Map<string, Set<Duplex>>();
  data.on('upgrade', (req, downstream, head) => {
    const target = resolveDataRequest(req, true);
    const reject = (status: number) => downstream.end(`HTTP/1.1 ${status} Upgrade refused\r\nConnection: close\r\n\r\n`);
    if ('status' in target) { reject(target.status); return; }
    if (req.headers.upgrade?.toLowerCase() !== 'websocket') { reject(400); return; }
    const { slot, instance, path, lease, extensionId } = target;
    const settle = beginRequest(slot);
    mediaSockets.add(downstream);
    let upstreamSocket: Duplex | undefined;
    let leaseTimer: ReturnType<typeof setTimeout> | undefined;
    const checkLease = () => {
      const current = slot.leases.get(lease.leaseId);
      if (current?.generation !== lease.generation || current.expiresAt <= Date.now()) { downstream.destroy(); return; }
      leaseTimer = setTimeout(checkLease, Math.min(2_147_483_647, current.expiresAt - Date.now()));
      leaseTimer.unref();
    };
    if (slot.definition.extension) checkLease();
    if (slot.definition.extension) {
      const peers = extensionSockets.get(lease.bearer) ?? new Set<Duplex>();
      peers.add(downstream);
      extensionSockets.set(lease.bearer, peers);
      downstream.once('close', () => {
        peers.delete(downstream);
        if (!peers.size) extensionSockets.delete(lease.bearer);
      });
    }
    const outbound = request({ hostname: '127.0.0.1', port: instance.nodePort, path, method: 'GET',
      headers: { ...proxyHeaders(req, slot, instance.nodePort, extensionId), connection: 'Upgrade', upgrade: 'websocket' } });
    downstream.once('error', () => downstream.destroy());
    downstream.once('close', () => {
      clearTimeout(leaseTimer);
      mediaSockets.delete(downstream);
      if (upstreamSocket) upstreamSocket.destroy();
      else { outbound.destroy(); settle(); }
    });
    outbound.once('response', response => { response.resume(); reject(response.statusCode ?? 502); });
    outbound.once('error', () => {
      if (!downstream.destroyed) {
        if (slot.instance === instance) slot.needsInspection = true;
        reject(502);
      }
    });
    outbound.once('upgrade', (response, upstream, upstreamHead) => {
      if (downstream.destroyed) { upstream.destroy(); return; }
      upstreamSocket = upstream;
      const headers = response.rawHeaders.flatMap((name, i) => i % 2 === 0 ? [`${name}: ${response.rawHeaders[i + 1]}\r\n`] : []).join('');
      downstream.write('HTTP/1.1 101 Switching Protocols\r\n' + headers + '\r\n');
      if (upstreamHead.length) downstream.write(upstreamHead);
      if (head.length) upstream.write(head);
      upstream.once('close', () => { downstream.destroy(); settle(); });
      upstream.once('error', () => upstream.destroy());
      downstream.pipe(upstream).pipe(downstream);
    });
    outbound.end();
  });
  let dataOrigin = '';
  const control = createServer((req: IncomingMessage, res: ServerResponse) => {
    if (req.method !== 'POST' || !secretMatches(req.headers.authorization, 'Bearer ' + config.token)) {
      send(res, 401); return;
    }
    const action = req.url?.replace(/^\/v1\/resources\//u, '');
    if (action === 'describe') { req.resume(); send(res, 200, config.definitions.map(entry => entry.resource)); return; }
    void (async () => {
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const input = object(JSON.parse(raw), 'resource request');
      const resourceId = name(input.resourceId, 'resourceId');
      const slot = slots.get(resourceId);
      if (!slot) { send(res, 404); return; }
      if (action === 'status') { send(res, 200, { resourceId, state: slot.state, ...(slot.instance && { generation: slot.instance.generation }) }); return; }
      const step = slot.lane.then(async () => {
        sweep(slot);
        if (action === 'retire') {
          const generation = name(input.generation, 'generation');
          if (await retire(slot, generation)) send(res, 200, { resourceId, generation, processExited: true, volumeDetached: true });
          else send(res, 409);
          return;
        }
        const leaseId = name(input.leaseId, 'leaseId');
        const prior = slot.leases.get(leaseId);
        const resource = slot.definition.resource;
        const extensionId = input.extensionId;
        if (resource.role === 'extensions'
          ? typeof extensionId !== 'string' || !isVarinExtensionId(extensionId) || !!resource.extensionId && resource.extensionId !== extensionId
          : extensionId !== undefined) { send(res, 403); return; }
        if (prior && prior.extensionId !== extensionId) { send(res, 409); return; }
        if (action === 'release') {
          if (prior && prior.generation === input.generation) {
            slot.leases.delete(leaseId);
            for (const peer of extensionSockets.get(prior.bearer) ?? []) peer.destroy();
          }
          send(res, 204); return;
        }
        if (slot.instance && slot.needsInspection && (action === 'renew' || action === 'acquire')) {
          if (!await engine.stillRunning(slot.definition, slot.instance)) slot.state = 'unavailable';
          slot.needsInspection = false;
        }
        if (action === 'renew' && (!prior || prior.generation !== input.generation || slot.state !== 'ready')) { send(res, 409); return; }
        if (action !== 'acquire' && action !== 'renew') { send(res, 404); return; }
        if (!slot.instance || slot.state !== 'ready') {
          slot.state = 'preparing';
          try {
            const next = await engine.allocate(slot.definition);
            if (slot.instance?.generation !== next.generation) slot.leases.clear();
            slot.instance = next;
            slot.state = 'ready';
          } catch (error) { slot.state = 'unavailable'; throw error; }
        }
        if (prior && prior.generation !== slot.instance.generation) { send(res, 409); return; }
        const lease = { resourceId, leaseId, generation: slot.instance.generation, bearer: prior?.bearer ?? randomBytes(32).toString('base64url'),
          ...(typeof extensionId === 'string' && { extensionId }), expiresAt: Date.now() + config.leaseDurationMs };
        slot.leases.set(leaseId, lease);
        send(res, 200, { ...lease, endpoint: `${dataOrigin}/resources/id-${encodeURIComponent(resourceId)}` });
      });
      slot.lane = step.catch(() => {});
      try { await step; } finally { planIdle(slot); }
    })().catch(() => { if (!res.headersSent && !res.destroyed) send(res, 503, { code: 'provider-unavailable' }); });
  });
  await listen(data, ready => data.listen(0, '127.0.0.1', ready));
  const address = data.address();
  if (!address || typeof address === 'string') { await close(data); throw new Error('Provider data listener has no address'); }
  dataOrigin = 'http://127.0.0.1:' + address.port;
  try {
    await listen(control, ready => control.listen(config.socketPath, ready));
    if (process.platform !== 'win32') await chmod(config.socketPath, 0o600);
  } catch (error) {
    await Promise.allSettled([close(control), close(data)]);
    throw error;
  }
  return { async close() {
    closing = true;
    for (const slot of slots.values()) clearTimeout(slot.idleTimer);
    for (const socket of mediaSockets) socket.destroy();
    await Promise.all([close(control), close(data)]);
    await Promise.all([...slots.values()].map(slot => slot.lane));
  } };
}
