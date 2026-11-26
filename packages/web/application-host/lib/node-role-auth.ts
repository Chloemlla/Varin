import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Express, Request, RequestHandler } from 'express';
import { MANAGED_REMOTE_PROTOCOL_VERSION, type ManagedRemoteIdentity } from './harness/managed-remote-types.js';
import { ExtensionCatalogStore } from '@varin/extension-host';
import { createRemoteClientAuthRuntime } from './client-auth/remote-clients.js';
import { assertDataRootMayStart } from './data-restore-guard.js';
import { createKernelClient } from './kernel/kernel-client.js';
import { createPrincipalStore } from './ui-auth/principals.js';
import { canonicalizePathIdentity, isPathWithinRoot } from './workspace/path-safety.js';

export function nodeRoleAbsolute(value: string | undefined, name: string): string {
  if (!value || !path.isAbsolute(value)) throw new Error(name + ' must be an explicit absolute path');
  return value;
}

export async function nodeRoleDataDirectory(input: string): Promise<string> {
  const root = await canonicalizePathIdentity(nodeRoleAbsolute(input, 'VARIN_DATA_DIR'), { allowMissing: true });
  await assertDataRootMayStart(root);
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  return root;
}

export async function createNodeRoleKernel(dataDir: string, kernelPath?: string) {
  const { hostId } = await new ExtensionCatalogStore(dataDir).getHostIdentity();
  const version: unknown = JSON.parse(await fs.readFile(new URL('../../package.json', import.meta.url), 'utf8')).version;
  if (typeof version !== 'string' || !version) throw new Error('Missing Varin build version');
  // Native Storage's exclusive writer lock also fences offline administration against a running role.
  const kernel = createKernelClient({ role: 'resources', hostId, storageRoot: path.join(dataDir, 'kernel', hostId),
    buildVersion: version, kernelBuildIdentity: version, allowCargoDevRunner: false, ...(kernelPath ? { kernelPath } : {}) });
  return { hostId, kernel, version };
}

type NodeRoleClients = ReturnType<typeof createRemoteClientAuthRuntime>;
export function openNodeRoleAuth(dataDir: string): { clients: NodeRoleClients } {
  const principals = createPrincipalStore(path.join(dataDir, 'ui-principals.json'));
  const clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path,
    storePath: path.join(dataDir, 'remote-clients.json'), principals });
  return { clients };
}

export async function withNodeRoleState<T>(dataDir: string, kernelPath: string | undefined,
  work: (clients: NodeRoleClients) => Promise<T>): Promise<T> {
  const { kernel } = await createNodeRoleKernel(dataDir, kernelPath);
  try {
    await kernel.start();
    const { clients } = openNodeRoleAuth(dataDir);
    try { return await work(clients); } finally { await clients.dispose(); }
  } finally { await kernel.close(); }
}

export async function pairNodeRoleClient(dataDir: string, kernelPath: string | undefined, outputPath: string,
  options: { label: string; capabilities: string[]; deniedDirectories?: string[] }): Promise<string> {
  dataDir = await nodeRoleDataDirectory(dataDir);
  const output = await canonicalizePathIdentity(nodeRoleAbsolute(outputPath, '--output'), { allowMissing: true });
  if ([dataDir, ...(options.deniedDirectories ?? [])].some(root => isPathWithinRoot(output, root))) {
    throw new Error('Store the new credential in a private file outside node state and shared resource directories');
  }
  if (!options.capabilities.length) throw new Error('At least one explicit node capability is required');
  return withNodeRoleState(dataDir, kernelPath, async clients => {
    const file = await fs.open(output, 'wx', 0o600);
    const created = await file.stat({ bigint: true });
    let id: string | undefined;
    let committed = false;
    try {
      const entry = await clients.createClient({ label: options.label, allowedDirectories: [], capabilities: options.capabilities });
      id = entry.client.id;
      await file.writeFile(JSON.stringify({ clientId: id, token: entry.token }) + '\n');
      await file.sync();
      committed = true;
      return id;
    } catch (error) {
      if (id) await clients.revokeClient(id);
      throw error;
    } finally {
      try { await file.close(); }
      finally {
        if (!committed) {
          const current = await fs.lstat(output, { bigint: true }).catch(() => undefined);
          if (current?.dev === created.dev && current.ino === created.ino) await fs.unlink(output);
        }
      }
    }
  });
}

export async function revokeNodeRoleClient(dataDir: string, kernelPath: string | undefined, clientId: string) {
  if (!clientId?.trim()) throw new Error('A client ID is required');
  await withNodeRoleState(await nodeRoleDataDirectory(dataDir), kernelPath, async clients => {
    if (!(await clients.revokeClient(clientId)).revoked) throw new Error('Unknown client ID');
  });
}

export function nodeRoleBearerAuth(clients: NodeRoleClients, capability: string): {
  requireAuth: RequestHandler; clientId(request: Request): Promise<string | undefined>;
} {
  const callers = new WeakMap<Request, string>();
  const requireAuth: RequestHandler = async (request, response, next) => {
    try {
      const authorization = request.headers.authorization;
      const token = typeof authorization === 'string' ? /^Bearer ([^\s,]{1,1024})$/i.exec(authorization)?.[1] : undefined;
      const verified = token ? await clients.authenticateBearerToken(token, request) : undefined;
      if (!verified) { response.status(401).json({ error: 'A paired role credential is required' }); return; }
      if (!verified.client.capabilities.includes(capability)) { response.status(403).json({ error: 'This role is not granted' }); return; }
      callers.set(request, verified.clientId);
      next();
    } catch (error) { next(error); }
  };
  return { requireAuth, clientId: async (request: Request) => callers.get(request) };
}

/** Same authenticated receipt consumed by configured Host peers, without file or process routes. */
export function registerNodeRoleIdentity(app: Express, options: {
  role: 'browser' | 'computer'; hostId: string; capabilities: string[];
  requireAuth: RequestHandler;
  clientId(request: Request): Promise<string | undefined>;
}) {
  app.get('/api/harness/managed-execution/v1/identity', options.requireAuth, async (request, response, next) => {
    try {
      response.setHeader('Cache-Control', 'no-store');
      if (!await options.clientId(request)) { response.status(403).json({ error: 'A paired role credential is required' }); return; }
      const target = request.headers['x-varin-managed-target'];
      if (target !== undefined && target !== options.hostId) {
        response.status(409).json({ error: 'Managed target identity changed', code: 'target-identity-changed' }); return;
      }
      const identity: ManagedRemoteIdentity = {
        protocolVersion: MANAGED_REMOTE_PROTOCOL_VERSION, requestHostIdentity: true, hostId: options.hostId,
        role: options.role, capabilities: options.capabilities,
        machine: { machineId: 'local', kind: options.role, state: 'available',
          connection: { status: 'connected', checkedAt: Date.now() }, commitments: [], queued: [] },
      };
      response.setHeader('X-Varin-Managed-Host', options.hostId);
      response.json(identity);
    } catch (error) { next(error); }
  });
}
