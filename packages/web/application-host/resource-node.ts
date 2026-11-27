/** Standalone managed live-directory node. Its coordinator owns the Agent and UI. */
import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import express from 'express';
import { ExtensionCatalogStore } from '@varin/extension-host';
import { VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID, VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID } from '@varin/extension-builtins';
import { bundledLanguageProviders, bundledTypescriptProvider, VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS } from '@varin/extension-builtins/host';
import { readProjectTrust } from '@varin/settings-store';
import { createRemoteClientAuthRuntime } from './lib/client-auth/remote-clients.js';
import { assertDataRootMayStart } from './lib/data-restore-guard.js';
import { hostEnvironment } from './lib/security/host-environment.js';
import { createDocumentRootGuard } from './lib/documents/allowed-roots.js';
import { createDocumentAuthority } from './lib/documents/authority.js';
import { bindDocumentTextCodec } from './lib/documents/inspect.js';
import { createManagedResourceTarget } from './lib/harness/managed-resource-target.js';
import { createManagedMcpTarget } from './lib/harness/managed-mcp-target.js';
import { isManagedMcpObservation } from './lib/harness/managed-remote-routes.js';
import { McpAuthority, McpCompositions } from './lib/mcp/authority.js';
import { createResourceFilesOwner } from './lib/workspace/resource-files.js';
import { createHostResourceStorage, createHostResourceExecution } from './lib/kernel/host-resource-owners.js';
import { createKernelClient } from './lib/kernel/kernel-client.js';
import { createLiveSourceOwner } from './lib/kernel/live-source.js';
import { createSourceQueryService } from './lib/kernel/source-query-service.js';
import { createManagedRecoveryService } from './lib/kernel/managed-recovery-service.js';
import { createKernelWorkspaceWorkingStateAccess } from './lib/kernel/storage-adapter.js';
import { SourceAdmissionError } from './lib/kernel/source-admission-error.js';
import { createPrincipalStore } from './lib/ui-auth/principals.js';
import { createUiAuth } from './lib/ui-auth/ui-auth.js';
import { canonicalizePathIdentity, isPathWithinRoot } from './lib/workspace/path-safety.js';
import { createPlatformEnvironmentRuntime } from './lib/platform/environment-runtime.js';
import { createTerminalRuntime } from './lib/terminal/runtime.js';
import { createManagedTerminalOwner } from './lib/terminal/managed-owner.js';
import { createPrivateProcessService } from './lib/kernel/private-process-service.js';
import { createExternalPrograms } from './lib/external-agents/programs.js';
import { createResourceExternalOwner } from './lib/external-agents/resource-owner.js';
import { createOfficeRenderer } from './lib/office/renderer.js';
import { registerGitRoutes } from './lib/git/routes.js';
import { drainWorktreeBootstraps, hasActiveWorktreeBootstrap } from './lib/git/service.js';
import { createManagedProjectManagementOwner } from './lib/projects/managed-project-management.js';
import { createHostLanguage } from './lib/lsp/host-language.js';

const liveProjectOperations = new Set([
  'git-command', 'git-branches', 'git-root-context', 'worktrees', 'worktree-create', 'worktree-validate',
  'worktree-remove', 'worktree-remote-branch-delete', 'worktree-bootstrap',
]);

interface NodeDirectories { dataDir: string; workspaceRoot: string; kernelPath?: string }
interface NodeOptions extends NodeDirectories { host?: string; port?: number; releaseId?: string }

const requiredAbsolute = (value: string | undefined, name: string) => {
  if (!value || !path.isAbsolute(value)) throw new Error(name + ' must be an explicit absolute path');
  return value;
};
async function directories(options: NodeDirectories) {
  const workspaceRoot = await canonicalizePathIdentity(requiredAbsolute(options.workspaceRoot, 'VARIN_WORKSPACE_ROOT'));
  if (!(await fs.stat(workspaceRoot)).isDirectory()) throw new Error('Shared workspace must be a directory');
  const requested = requiredAbsolute(options.dataDir, 'VARIN_DATA_DIR');
  // Never expose the auth store or the kernel data root as a resource, including through an alias.
  const dataDir = await canonicalizePathIdentity(requested, { allowMissing: true });
  if (isPathWithinRoot(dataDir, workspaceRoot) || isPathWithinRoot(workspaceRoot, dataDir)) {
    throw new Error('Node state and the shared workspace must be disjoint directories');
  }
  await assertDataRootMayStart(dataDir);
  await fs.mkdir(dataDir, { recursive: true, mode: 0o700 });
  return { dataDir, workspaceRoot };
}
async function createNodeKernel(dataDir: string, kernelPath?: string) {
  hostEnvironment.capture();
  // Both roles use the same durable identity. Native Storage owns its exclusive writer lock;
  // an offline admin command must not mutate a credential index cached by another live process.
  const { hostId } = await new ExtensionCatalogStore(dataDir).getHostIdentity();
  const version: unknown = JSON.parse(await fs.readFile(new URL('../package.json', import.meta.url), 'utf8')).version;
  if (typeof version !== 'string' || !version) throw new Error('Missing Varin build version');
  const kernel = createKernelClient({ role: 'resources', hostId, storageRoot: path.join(dataDir, 'kernel', hostId),
    buildVersion: version, kernelBuildIdentity: version, allowCargoDevRunner: false, ...(kernelPath ? { kernelPath } : {}) });
  return { hostId, kernel, version };
}
async function offlineAdmin<T>(dataDir: string, kernelPath: string | undefined, work: (clients: ReturnType<typeof openAuth>['clients']) => Promise<T>) {
  const { kernel } = await createNodeKernel(dataDir, kernelPath);
  try {
    await kernel.start();
    const { clients } = openAuth(dataDir);
    try { return await work(clients); } finally { await clients.dispose(); }
  } finally { await kernel.close(); }
}
function openAuth(dataDir: string) {
  const principals = createPrincipalStore(path.join(dataDir, 'ui-principals.json'));
  const clients = createRemoteClientAuthRuntime({ crypto, fsPromises: fs, path,
    storePath: path.join(dataDir, 'remote-clients.json'), principals });
  return { clients, principals };
}

// Local admin only. No HTTP bootstrap route, wildcard grant or bearer in normal output.
export async function pairResourceNode(options: NodeDirectories & { output: string; write?: boolean; commands?: boolean }) {
  const { dataDir, workspaceRoot } = await directories(options);
  const output = await canonicalizePathIdentity(requiredAbsolute(options.output, '--output'), { allowMissing: true });
  if (isPathWithinRoot(output, workspaceRoot) || isPathWithinRoot(output, dataDir))
    throw new Error('Store the new credential in a private file outside the shared workspace and node state directory');
  return offlineAdmin(dataDir, options.kernelPath, async clients => {
    let id: string | undefined;
    const file = await fs.open(output, 'wx', 0o600);
    let rolledBack = false;
    const created = await file.stat({ bigint: true });
    try {
      const entry = await clients.createClient({ label: 'Resource node coordinator', allowedDirectories: [workspaceRoot],
        capabilities: ['filesystem:read', ...(options.write ? ['filesystem:write'] : []),
          ...(options.commands ? ['terminal:use', 'process:control', 'logs:read'] : [])] });
      id = entry.client.id;
      await file.writeFile(JSON.stringify({ clientId: id, token: entry.token }) + '\n');
      await file.sync();
    } catch (error) {
      if (id) await clients.revokeClient(id);
      rolledBack = true;
      throw error;
    } finally {
      await file.close();
      if (rolledBack) {
        const current = await fs.lstat(output, { bigint: true }).catch(() => undefined);
        if (current?.dev === created.dev && current.ino === created.ino) await fs.unlink(output);
      }
    }
    return id;
  });
}

export async function revokeResourceNodeClient(options: NodeDirectories, clientId: string) {
  if (!clientId?.trim()) throw new Error('A client ID is required');
  const { dataDir } = await directories(options);
  await offlineAdmin(dataDir, options.kernelPath, async clients => {
    if (!(await clients.revokeClient(clientId)).revoked) throw new Error('Unknown client ID');
  });
}

export async function startResourceNode(options: NodeOptions) {
  const port = options.port ?? 3000;
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error('Invalid node port');
  const { dataDir, workspaceRoot } = await directories(options);
  const { kernel, version, hostId } = await createNodeKernel(dataDir, options.kernelPath);
  const cleanup: (() => Promise<unknown> | void)[] = [];
  let closing: Promise<void> | undefined;
  let draining = false;
  const close = () => {
    draining = true;
    return closing ??= (async () => {
      const errors = [];
      for (const stop of cleanup.splice(0).reverse()) try { await stop(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, 'Resource node shutdown incomplete');
    })();
  };
  try {
    cleanup.push(() => kernel.close());
    await kernel.start();
    const { clients, principals } = openAuth(dataDir);
    cleanup.push(() => clients.dispose());
    const auth = createUiAuth({ principals, dataDir, requireClientAuth: true, clientAuthController: clients,
      getServerId: async () => hostId });
    cleanup.push(auth.dispose, bindDocumentTextCodec(kernel));
    const deployment = createDocumentRootGuard({ workspace: { root: workspaceRoot, lockdown: true }, fsPromises: fs, pathModule: path });
    // A replaced root alias may go offline, but cannot retarget this running node to another directory.
    const guard = async (root: string) => isPathWithinRoot(root, workspaceRoot) && await deployment(root);
    const documents = createDocumentAuthority({ hostId, dataDir, isAllowedRoot: guard, isTrusted: guard });
    cleanup.push(() => documents.dispose());
    const storage = createHostResourceStorage({ kernel, documents: () => documents,
      resolveWorkspaceRoot: async id => (await documents.admitWorkspaceRegistration(id)).canonicalPath });
    cleanup.push(() => storage.kernelStorageAdapter.dispose());
    documents.bindDurableMutationStorage(async (id, work) => work(await storage.kernelRecoveryStore.workspaceStorageContext(id)));
    const execution = createHostResourceExecution(kernel, documents, () => console.error('[ResourceNode] Native process observation unavailable'));
    cleanup.push(() => execution.kernelProcesses.dispose(), () => execution.kernelCompute.dispose());
    const language = createHostLanguage({ kernel, hostId, dataDir, documents, isTrusted: guard, processes: execution.kernelProcesses });
    cleanup.push(() => language.tools.dispose(), () => language.servers.dispose(), () => language.supervisor.dispose());
    // Resource Nodes use the shipped language assets without starting a full extension Host.
    const typescriptRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(VARIN_BUILTIN_TYPESCRIPT_LANGUAGE_EXTENSION_ID)!;
    const languageRoot = VARIN_BUILTIN_EXTENSION_PACKAGE_ROOTS.get(VARIN_BUILTIN_LANGUAGE_SERVERS_EXTENSION_ID)!;
    for (const descriptor of [bundledTypescriptProvider(file => path.join(typescriptRoot, file)),
      ...bundledLanguageProviders(file => path.join(languageRoot, file))]) {
      language.supervisor.registerProvider({ ...descriptor, source: 'host' });
    }
    const documentReadingDirectory = path.join(dataDir, 'document-reading');
    await fs.mkdir(documentReadingDirectory, { recursive: true });
    const documentProcesses = createPrivateProcessService(kernel, `document-reading:${hostId}`, documentReadingDirectory);
    cleanup.push(() => documentProcesses.dispose());
    const office = createOfficeRenderer({ spawn: documentProcesses.spawn, temporaryRoot: documentReadingDirectory,
      command: () => process.env.VARIN_LIBREOFFICE_COMMAND });
    const environment = createPlatformEnvironmentRuntime();
    const externalDirectory = path.join(dataDir, 'external-agents');
    const externalProcesses = createPrivateProcessService(kernel, `external-agents:${hostId}`, externalDirectory);
    const externalPrograms = createExternalPrograms({ directory: externalDirectory, environment, spawn: externalProcesses.spawn });
    cleanup.push(() => externalProcesses.dispose(), externalPrograms.close);
    const terminal = createTerminalRuntime({ fs: fsSync, path, documents,
      buildAugmentedPath: environment.buildAugmentedPath, searchPathFor: environment.searchPathFor, isExecutable: environment.isExecutable,
      loadPtyProvider: async () => execution.kernelProcesses.ptyProvider });
    cleanup.push(() => terminal.shutdown());
    const liveSources = createLiveSourceOwner({ documents, kernel });
    const projectTrusted = (cwd: string) => readProjectTrust(dataDir, cwd) === true;
    const sourceQuery = createSourceQueryService({
      kernel, documents, storage: storage.kernelStorageAdapter, validateLiveSource: liveSources.validate,
      languageSupervisor: language.supervisor,
      resourceOwners: {
        dataDirectory: dataDir, projectOnly: true, homeDir: workspaceRoot, documents,
        workingStates: createKernelWorkspaceWorkingStateAccess(storage.kernelStorageAdapter),
        validateLiveSource: liveSources.validate, projectTrusted,
        configuration: async () => ({ packages: [] }),
        withSourceRead: storage.kernelStorageAdapter.withResourceRead.bind(storage.kernelStorageAdapter),
      },
    });
    cleanup.push(() => sourceQuery.dispose());
    const mcpAuthority = new McpAuthority({
      deployment: { transports: ['stdio'], stdioPlacement: 'managed' },
      adaptTransport: (scope, transport) => mcp.adaptTransport(scope, transport),
      interactions: (input, scope) => mcp.receiveInteraction(scope, input),
      sampling: (input, scope) => mcp.receiveSampling(scope, input),
      interactionErrors: (input, scope) => mcp.receiveInteractionError(scope, input),
    });
    const mcp = createManagedMcpTarget({ kernel, documents, authority: mcpAuthority,
      compositions: new McpCompositions(mcpAuthority, code => console.error('[ResourceNode MCP]', code)), agentDir: dataDir, hostId,
      projectTrusted,
      onError: () => console.error('[ResourceNode] Managed MCP process observation unavailable'),
    });
    cleanup.push(() => mcpAuthority.close(), () => mcp.close(), kernel.subscribeExit(() => { void mcp.close(); }));
    const target = createManagedResourceTarget({ kernel, liveSourceOnly: true, storageAvailable: false,
      onError: () => console.error('[ResourceNode] Managed resource observation unavailable') });
    cleanup.push(drainWorktreeBootstraps, () => target.dispose());
    const projects = createManagedProjectManagementOwner({ kernel, documents, gitDispatch: registerGitRoutes(undefined, { documents }) });
    let activeProjectOperations = 0;
    target.attachSources({ documents, deviceFileAccess: false, validateLiveSource: liveSources.validate,
      ...createResourceExternalOwner(dataDir, externalPrograms), prepareExternalLiveSource: liveSources.prepare,
      async projectManagement(principal, request, signal) {
        if (!liveProjectOperations.has(request.command?.action)) throw new SourceAdmissionError('source_unavailable');
        activeProjectOperations++;
        try { return await projects(principal, request, signal); }
        finally { activeProjectOperations--; }
      },
      ...mcp.continuations,
      serviceOperation: (scope, operation, signal) => operation.kind === 'mcp'
        ? mcp.request(scope, operation.action, signal) : sourceQuery(scope, operation, signal),
      async releaseSource(scope, retention) {
        const [, receipt] = await Promise.all([sourceQuery.release(scope), mcp.release(scope, retention)]);
        return { mcpExecutorStopped: receipt.executorStopped, mcpTaskControlsDrained: receipt.taskControlsDrained };
      },
      cleanupSource: sourceQuery.cleanup,
      recovery: createManagedRecoveryService({ kernel, hostId, documents, deviceFileAccess: false,
        storage: storage.kernelStorageAdapter, store: storage.kernelRecoveryStore, validateLiveSource: liveSources.validate }).handle,
      terminal: createManagedTerminalOwner({ terminal: () => terminal, documents }),
      workspaceFiles: createResourceFilesOwner(documents, storage.kernelRecoveryFileResources, { restrictedRoot: workspaceRoot }),
      async prepareSource(input, signal) {
        if (input.mode !== 'live_root' || input.resourceOwner.kind !== 'local' || input.selection?.mode === 'native_workspace')
          throw new SourceAdmissionError('source_unavailable');
        const { workspaceId, threadId, resourceOwner } = input;
        const liveRoot = await liveSources.prepare(workspaceId, workspaceId, threadId, signal);
        // The paired source owner supplies the caller's actual allowed tools, after local preparation.
        return { path: liveRoot.canonicalRoot, source: { mode: 'live_root', resourceOwner, workspaceId,
          executionWorkspaceId: workspaceId, liveRoot, tools: [] } };
      } });
    const app = express();
    app.disable('x-powered-by');
    const observers = new Set<http.ServerResponse>();
    let controlProbe: Promise<boolean> | undefined;
    app.get('/health', async (_req, res) => {
      if (!draining && kernel.handshake?.capabilities.includes('resourcesOnly')) {
        controlProbe ??= kernel.probeControl(AbortSignal.timeout(1500)).catch(() => false)
          .finally(() => { controlProbe = undefined; });
      }
      const responsive = await controlProbe;
      const ready = !draining && responsive === true;
      res.status(ready ? 200 : 503).json({ status: ready ? 'ok' : 'unavailable', role: 'resources',
        control: ready ? 'ready' : 'unavailable', releaseId: options.releaseId ?? version });
    });
    app.get('/api/harness/managed-execution/v1/retention', auth.requireAuth, async (_req, res) => {
      res.setHeader('x-varin-managed-host', hostId);
      res.setHeader('Cache-Control', 'no-store');
      if (draining) { res.status(503).json({ code: 'host-draining' }); return; }
      const retention = await kernel.sourceRequest<Record<string, unknown>>('source.retention', {});
      const writingProject = activeProjectOperations > 0 || hasActiveWorktreeBootstrap();
      res.json(writingProject ? { ...retention, retireReady: false } : retention);
    });
    app.use((_req, res, next) => {
      if (draining) {
        res.setHeader('x-varin-managed-host', hostId);
        res.status(503).json({ code: 'host-draining' });
        return;
      }
      next();
    });
    app.use(express.json({ limit: '4mb' }));
    app.use('/api/harness/managed-execution/v1/sources', (req, res, next) => {
      if (['/processSubscribe', '/terminalStream'].includes(req.path) || req.path === '/service' && isManagedMcpObservation(req.body?.operation)) {
        observers.add(res); res.once('close', () => observers.delete(res));
      }
      next();
    });
    target.mount(app, { documents, office, requireAuth: auth.requireAuth, resolveAuthContext: auth.resolveAuthContext, isDraining: () => draining });
    // Body parser and middleware failures must not echo request fragments, bearer data or stack traces.
    const fail: express.ErrorRequestHandler = (error, _req, res, _next) => {
      if (res.headersSent) { res.destroy(); return; }
      const status = typeof error?.status === 'number' && error.status >= 400 && error.status < 600 ? error.status : 500;
      res.status(status).json({ error: status === 413 ? 'Request body too large' : 'Resource node request failed' });
    };
    app.use(fail);
    const server = http.createServer(app);
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, options.host ?? '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    cleanup.push(() => new Promise<void>((done, reject) => {
      server.close(error => error ? reject(error) : done());
      for (const observer of observers) observer.destroy();
    }));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Resource node failed to bind TCP');
    return { hostId, port: address.port, close };
  } catch (error) { await close(); throw error; }
}

async function main(args: string[]) {
  const options = { dataDir: requiredAbsolute(process.env.VARIN_DATA_DIR, 'VARIN_DATA_DIR'),
    workspaceRoot: requiredAbsolute(process.env.VARIN_WORKSPACE_ROOT, 'VARIN_WORKSPACE_ROOT'),
    ...(process.env.VARIN_KERNEL_PATH?.trim() ? { kernelPath: process.env.VARIN_KERNEL_PATH.trim() } : {}) };
  if (args[0] === 'pair' && args[1] === '--output' && args[2] && args.slice(3).every(arg => ['--allow-write', '--allow-commands'].includes(arg))) {
    await pairResourceNode({ ...options, output: args[2], write: args.includes('--allow-write'), commands: args.includes('--allow-commands') });
  } else if (args[0] === 'revoke' && args.length === 2) {
    await revokeResourceNodeClient(options, args[1]!);
  } else if (args.length) {
    throw new Error('Usage: resource-node.js [pair --output /private/client.json [--allow-write] [--allow-commands] | revoke CLIENT_ID]');
  } else {
    const port = process.env.VARIN_PORT === undefined ? 3000 : Number(process.env.VARIN_PORT);
    const node = await startResourceNode({ ...options, host: process.env.VARIN_HOST?.trim() || '127.0.0.1', port,
      ...(process.env.VARIN_RELEASE_ID ? { releaseId: process.env.VARIN_RELEASE_ID } : {}) });
    const close = () => { void node.close().catch(() => { console.error('[ResourceNode] Shutdown incomplete'); process.exitCode = 1; }); };
    process.once('SIGINT', close); process.once('SIGTERM', close);
  }
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error('[ResourceNode]', error instanceof Error ? error.message : 'Startup failed'); process.exitCode = 1; });
}
