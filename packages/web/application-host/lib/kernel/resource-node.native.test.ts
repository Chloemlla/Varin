import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it as test } from 'vitest';
import { ExtensionCatalogStore } from '@varin/extension-host';
import { pairResourceNode, revokeResourceNodeClient, startResourceNode } from '../../resource-node.js';
import { toolOperationId, type AgentResourceSnapshot, type NodeBinding } from './protocol.generated.js';
import { resourceSource } from './thread-context.js';
import { encodeScriptFrame, SCRIPT_PROTOCOL_VERSION } from '@varin/script-runtime';
import type { ThreadPreparedSource } from '@varin/application-client';
import type { ManagedRemoteIdentity, ManagedSourceBinding, ManagedSourceReceipt, ManagedSourceResolveReceipt } from '../harness/managed-remote-types.js';
import { createSocketResourceProvider } from '../deployment/resource-provider.js';
import { createManagedRemoteTargetRegistry } from '../harness/managed-remote-client.js';
import type { ManagedMcpAction, ManagedMcpReply } from '../harness/managed-mcp-contract.js';
import type { McpAuthorityTool } from '../mcp/authority.js';

const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? fileURLToPath(new URL(
  '../../../../../kernel/target/release/' + (process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'), import.meta.url));
const available = await fs.stat(kernelPath).then(() => true, () => false);
if (!available && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Resource node acceptance requires a release kernel');
const it = test.skipIf(!available);

it('discovers a dormant provider workspace and reads it after the Resource Node address changes', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-provider-'));
  const dataDir = path.join(dir, 'state'), workspaceRoot = path.join(dir, 'shared'), output = path.join(dir, 'worker.json');
  const options = { dataDir, workspaceRoot, port: 0, kernelPath };
  const socketPath = process.platform === 'win32'
    ? '\\\\.\\pipe\\varin-provider-' + randomUUID() : path.join(dir, 'provider.sock');
  const leases = new Set<string>();
  let node: Awaited<ReturnType<typeof startResourceNode>> | undefined;
  let generation = 0;
  let acquired = 0;
  let alternate: ReturnType<typeof createServer> | undefined;
  await fs.mkdir(workspaceRoot);
  await pairResourceNode({ ...options, output, write: true, commands: true });
  const { token } = JSON.parse(await fs.readFile(output, 'utf8')) as { token: string };
  const { hostId } = await new ExtensionCatalogStore(dataDir).getHostIdentity();
  const server = createServer(async (req, res) => {
    try {
      if (req.headers.authorization !== 'Bearer provider-test') { res.writeHead(401).end(); return; }
      let raw = '';
      for await (const chunk of req) raw += String(chunk);
      const input = JSON.parse(raw) as { resourceId: string; leaseId: string; generation?: string };
      if (req.url === '/v1/resources/describe') {
        res.end(JSON.stringify([{ id: 'workspace', hostId, label: 'Managed test workspace', role: 'resources', capabilities: ['sources'] }]));
      } else if (req.url === '/v1/resources/acquire') {
        acquired++;
        if (!node) { node = await startResourceNode(options); generation++; }
        leases.add(input.leaseId);
        res.end(JSON.stringify({ ...input, generation: String(generation), endpoint: 'http://127.0.0.1:' + node.port,
          bearer: token, expiresAt: Date.now() + 60_000 }));
      } else if (req.url === '/v1/resources/release') {
        if (!leases.delete(input.leaseId)) { res.writeHead(409).end(); return; }
        res.writeHead(204).end();
      } else res.writeHead(404).end();
    } catch { res.writeHead(500).end(); }
  });
  try {
    await new Promise<void>((resolve, reject) => server.once('error', reject).listen(socketPath, resolve));
    const coordinatorHostId = 'provider-coordinator';
    const registry = createManagedRemoteTargetRegistry({ coordinatorHostId, readSettings: async () => ({}),
      kernel: {} as never, resources: {} as never,
      provider: createSocketResourceProvider({ id: 'operator', socketPath, bearer: 'provider-test' }) });
    const first = (await registry.describeSourceTargets()).targets[0]!;
    expect(first.label).toBe('Managed test workspace');
    expect((await registry.sourceTargets()).targets[0]).toEqual(first);
    expect(acquired).toBe(0);
    const { source, resolved, binding } = await registry.withSourceUse(first.resourceOwner, async () => {
      const source = await registry.source(first.resourceOwner);
      const resolved = await source.resolve({ coordinatorHostId, path: workspaceRoot });
      const prepared = await source.prepare({ coordinatorHostId, input: {
        runtime: 'agent', threadId: 'thread:provider', branchId: 'branch:provider', key: 'prepare',
        resourceOwner: first.resourceOwner, workspaceId: resolved.workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [],
      } });
      const binding = await source.bind({ coordinatorHostId, source: prepared.source, scope: { kind: 'source_read',
        threadId: 'thread:provider', branchId: 'branch:provider', key: 'provider-read' }, purpose: 'read', retention: 'caller' });
      return { source, resolved, binding };
    });
    expect(acquired).toBe(1);
    expect(leases.size).toBe(1);
    await source.release({ coordinatorHostId, authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch, mode: 'retire' });
    await expect.poll(() => leases.size).toBe(0);
    const originalPort = node!.port;
    await node!.close();
    node = undefined;
    alternate = createServer();
    await new Promise<void>((resolve, reject) => alternate!.once('error', reject).listen(originalPort, '127.0.0.1', resolve));
    const reopened = await registry.source(first.resourceOwner);
    expect((await reopened.resolve({ coordinatorHostId, path: workspaceRoot })).workspaceId).toBe(resolved.workspaceId);
    expect(node!.port).not.toBe(originalPort);
    expect((await registry.describeSourceTargets()).targets[0]?.resourceOwner).toEqual(first.resourceOwner);
    await expect(source.resolve({ coordinatorHostId, path: workspaceRoot })).rejects.toThrow('original provider instance ended');
    await expect.poll(() => leases.size).toBe(0);
  } finally {
    await node?.close();
    if (alternate) await new Promise<void>(resolve => alternate!.close(() => resolve()));
    await new Promise<void>(resolve => server.close(() => resolve()));
    await fs.rm(dir, { recursive: true, force: true });
  }
});

it('pairs offline, serves an actual original live file and process, and reopens the same resource-only node', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-standalone-node-'));
  const workspaceRoot = path.join(dir, 'shared'), dataDir = path.join(dir, 'state');
  const options = { workspaceRoot, dataDir, port: 0, kernelPath, releaseId: 'test-artifact' };
  const creds = async (name: string, write: boolean, commands: boolean) => {
    const output = path.join(dir, name + '.json');
    await pairResourceNode({ ...options, output, write, commands });
    return JSON.parse(await fs.readFile(output, 'utf8')) as { token: string; clientId: string };
  };
  let node: Awaited<ReturnType<typeof startResourceNode>> | undefined;
  try {
    await fs.mkdir(workspaceRoot);
    await fs.writeFile(path.join(workspaceRoot, 'note.txt'), 'original node bytes');
    await fs.writeFile(path.join(workspaceRoot, 'symbols.ts'), 'export function onlyOnNode(): number { return 42; }\n');
    await fs.writeFile(path.join(workspaceRoot, 'AGENTS.md'), 'Instructions from the resource workspace.');
    await fs.writeFile(path.join(dir, 'AGENTS.md'), 'Outside workspace instructions.');
    const reader = await creds('read', false, false), worker = await creds('work', true, true);
    node = await startResourceNode(options);
    const origin = () => 'http://127.0.0.1:' + node!.port;
    const api = (route: string, token?: string, input?: unknown) => fetch(origin() + '/api/harness/managed-execution/v1' + route, {
      method: input === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), 'content-type': 'application/json' },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    });
    const accepted = async <T = unknown>(request: Promise<Response>): Promise<T> => {
      const res = await request;
      const body = await res.json();
      expect(res.status, JSON.stringify(body)).toBe(200);
      return body as T;
    };
    expect(await accepted(fetch(origin() + '/health'))).toEqual({ status: 'ok', role: 'resources', control: 'ready', releaseId: 'test-artifact' });
    expect([401, 403]).toContain((await api('/identity')).status);
    const identity = await accepted<ManagedRemoteIdentity>(api('/identity', reader.token));
    expect(identity.capabilities).toContain('sources');
    for (const absent of ['remote-shell', 'storage', 'materials', 'attachment-stream']) expect(identity.capabilities).not.toContain(absent);
    expect((await api('/shell/exec', worker.token, {})).status).toBe(404);
    expect((await fetch(origin() + '/api/threads')).status).toBe(404);
    expect((await fetch(origin() + '/api/git/status')).status).toBe(404);
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: true });
    const coordinatorHostId = 'cloud-coordinator', threadId = 'thread:node', runId = 'run:node';
    const remote = { kind: 'managed_host', hostId: identity.hostId, connectionId: 'this-connection', endpointIdentity: 'this-endpoint' };
    const source = (name: string, token: string, body: object) => api('/sources/' + name, token, { coordinatorHostId, ...body });
    expect((await source('resolve', reader.token, { path: dataDir })).ok).toBe(false);
    const { workspaceId } = await accepted<ManagedSourceResolveReceipt>(source('resolve', reader.token, { path: workspaceRoot }));
    execFileSync('git', ['init', '--quiet'], { cwd: workspaceRoot });
    const stage = { projectId: 'node-project', workspaceId, command: { action: 'git-command', input: {
      operation: 'stageGitFile', args: [workspaceRoot, 'note.txt'], selection: { mode: 'live_root' },
    } } };
    expect((await source('projectManagement', reader.token, stage)).ok).toBe(false);
    await accepted(source('projectManagement', worker.token, stage));
    expect(execFileSync('git', ['diff', '--cached', '--name-only'], { cwd: workspaceRoot, encoding: 'utf8' }).trim()).toBe('note.txt');
    const prepare = async (token: string) => (await accepted<ThreadPreparedSource>(source('prepare', token, { input: {
      runtime: 'agent', threadId, branchId: 'main', key: randomUUID(), resourceOwner: remote,
      workspaceId, mode: 'live_root', content: { mode: 'saved-files' }, captureScopes: [],
    } }))).source;
    const readonly = await prepare(reader.token);
    expect(readonly.tools).toContain('file_read');
    expect(readonly.tools).not.toContain('file_write');
    expect(readonly.tools).not.toContain('process_spawn');
    const scope = { kind: 'run', threadId, runId, epoch: 1 };
    expect((await source('bind', reader.token, { source: { ...readonly, tools: ['file_write'] },
      scope, purpose: 'source', retention: 'run' })).ok).toBe(false);
    const prepared = await prepare(worker.token);
    expect(prepared.tools).toContain('process_spawn');
    expect(prepared.tools).not.toContain('code_retrieval');
    const binding = await accepted<ManagedSourceBinding>(source('bind', worker.token, {
      source: { ...prepared, tools: ['file_read', 'file_write', 'process_spawn'] }, scope, purpose: 'source', retention: 'run',
    }));
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: false, authorities: 1 });
    const address = { authorityId: binding.authorityId, resourceEpoch: binding.resourceEpoch };
    const originalDocument = await accepted<{ bytesBase64: string; fileObservation: { path: string; readVersion: string } }>(
      source('service', worker.token, { ...address, requestId: 'document-capture',
        operation: { kind: 'document_read', operationId: 'document-capture', path: 'note.txt' } }));
    expect(Buffer.from(originalDocument.bytesBase64, 'base64').toString('utf8')).toBe('original node bytes');
    expect(originalDocument.fileObservation).toEqual({ path: 'note.txt', readVersion: expect.any(String) });
    const symbols = await accepted(source('service', worker.token, { ...address, requestId: 'language-symbols',
      operation: { kind: 'language', query: { method: 'document_symbols', path: 'symbols.ts' } } }));
    expect(symbols).toMatchObject({ status: 'ready', items: expect.arrayContaining([expect.objectContaining({ name: 'onlyOnNode' })]) });
    const execute = async (name: string, args: unknown) => {
      const declaration = binding.capabilities.tools.find(tool => tool.name === name);
      if (!declaration) throw new Error(`The node did not admit ${name}`);
      const callId = randomUUID(), origin = { kind: 'model_step' as const, request_id: 'request:node-native' };
      const call = { runId, callId, origin, operationId: toolOperationId(origin, callId), name, arguments: args, schemaVersion: declaration.version };
      await accepted(source('authorize', worker.token, { ...address, call }));
      return accepted<ManagedSourceReceipt>(source('execute', worker.token, { ...address, call,
        ...(name === 'file_write' || name === 'process_spawn' ? { journal: { executionId: 'execution:node-native', threadId,
          branchId: 'main', runId, entryId: 'entry:node-native', epoch: scope.epoch } } : {}),
        ...(name === 'process_spawn' && binding.executionEnvironment ? { executionEnvironment: binding.executionEnvironment } : {}),
      }));
    };
    const { result } = await execute('file_read', { path: 'note.txt' });
    expect(result).toMatchObject({ completion: { outcome: 'succeeded', content: { data: { readVersion: expect.any(String) } } } });
    const read = (result as { completion: { content: { data: { content: { text: string }; readVersion: string } } } }).completion.content.data;
    expect(read.content.text).toBe('original node bytes');
    await execute('file_write', { path: 'note.txt', readVersion: read.readVersion, content: 'updated on node' });
    expect(await fs.readFile(path.join(workspaceRoot, 'note.txt'), 'utf8')).toBe('updated on node');
    const spawned = await execute('process_spawn', { cwd: '', command: process.execPath, mode: 'pipe',
      args: ['-e', 'require("node:fs").writeFileSync("process.txt", "ran on node")'] });
    expect(spawned.accepted).toBe(true);
    await expect.poll(async () => (await accepted<ManagedSourceReceipt>(source('observe', worker.token,
      { ...address, operationId: spawned.operationId }))).executorStopped).toBe(true);
    expect(await fs.readFile(path.join(workspaceRoot, 'process.txt'), 'utf8')).toBe('ran on node');
    await accepted(source('release', worker.token, { ...address, mode: 'retire' }));
    const branchId = 'branch:node';
    const context = await accepted<ManagedSourceBinding>(source('bind', worker.token, { source: prepared,
      scope: { kind: 'source_read', threadId, branchId, key: 'prepare-instructions' }, purpose: 'read', retention: 'caller' }));
    const contextAddress = { authorityId: context.authorityId, resourceEpoch: context.resourceEpoch };
    const snapshot = await accepted<AgentResourceSnapshot>(source('service', worker.token, { ...contextAddress, requestId: randomUUID(),
      operation: { kind: 'resources_prepare', identity: { runtime: 'agent', threadId, branchId },
        admitted: { mode: 'agent', threadRole: 'main', projectId: null } },
    }));
    expect(snapshot.instructions.map(instruction => instruction.reference.path)).toEqual(['AGENTS.md']);
    expect(snapshot.capturedFiles.find(file => file.reference.path === 'AGENTS.md')?.content.trim()).toBe('Instructions from the resource workspace.');
    await accepted(source('release', worker.token, { ...contextAddress, mode: 'retire' }));
    const scriptSource = resourceSource(prepared);
    expect((await source('scriptBinding', reader.token, { source: scriptSource })).ok).toBe(false);
    const evaluator = await accepted<NodeBinding>(source('scriptBinding', worker.token, { source: scriptSource }));
    const processId = 'script:node';
    const script = await accepted<ManagedSourceBinding>(source('bind', worker.token, {
      source: { ...prepared, tools: [] }, scope, purpose: 'script_environment', operationId: processId, retention: 'caller',
    }));
    const scriptAddress = { authorityId: script.authorityId, resourceEpoch: script.resourceEpoch, processId };
    expect(await accepted(source('scriptSpawn', worker.token, { ...scriptAddress, node: evaluator, cwd: '' })))
      .toMatchObject({ processId, mode: 'pipe' });
    const frames = [
      encodeScriptFrame({ type: 'initialize', v: SCRIPT_PROTOCOL_VERSION, environmentId: processId, bindingIdentity: evaluator.configuration_identity }),
      encodeScriptFrame({ type: 'eval', v: SCRIPT_PROTOCOL_VERSION, environmentId: processId, cellId: 'node-script',
        script: 'await (await import("node:fs/promises")).writeFile("script.txt", "executed on node")' }),
    ];
    await accepted(source('processWrite', worker.token, { ...scriptAddress, operationId: randomUUID(),
      bytesBase64: Buffer.from(frames.join('')).toString('base64') }));
    await expect.poll(() => fs.readFile(path.join(workspaceRoot, 'script.txt'), 'utf8').catch(() => null)).toBe('executed on node');
    const control = (stop: boolean) => source('scriptControl', worker.token, { threadId, runId, processId, source: scriptSource, stop });
    await accepted(control(true));
    await expect.poll(async () => accepted(control(false))).toMatchObject({ executorStopped: true });
    await accepted(source('release', worker.token, { ...scriptAddress, mode: 'retire' }));
    const mcp = await accepted<ManagedSourceBinding>(source('bind', worker.token, {
      source: prepared, scope, purpose: 'mcp_owner', retention: 'run',
    }));
    const mcpAddress = { authorityId: mcp.authorityId, resourceEpoch: mcp.resourceEpoch };
    const requestMcp = (action: ManagedMcpAction, requestId = randomUUID()) => accepted<ManagedMcpReply>(source('service', worker.token,
      { ...mcpAddress, requestId, operation: { kind: 'mcp', action } }));
    const view = { kind: 'snapshot', handleId: 'node-view', creationRequestId: randomUUID() } as const;
    expect(await requestMcp(view, view.creationRequestId)).toMatchObject({ ok: false, error: { code: 'mcp_source_authority_denied' } });
    const mcpServer = `
      const fs = require('node:fs');
      const replies = {
        initialize: ({ protocolVersion }) => ({ protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }),
        'tools/list': () => ({ tools: [{ name: 'record', description: 'Record execution location', inputSchema: { type: 'object' } }] }),
        'tools/call': () => {
          fs.writeFileSync('mcp.txt', process.cwd());
          return { content: [{ type: 'text', text: 'recorded' }] };
        },
      };
      require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
        const { id, method, params } = JSON.parse(line);
        if (id === undefined) return;
        const response = replies[method]
          ? { result: replies[method](params) }
          : { error: { code: -32601, message: 'Unknown method' } };
        console.log(JSON.stringify({ jsonrpc: '2.0', id, ...response }));
      });
    `;
    await fs.writeFile(path.join(workspaceRoot, 'mcp-fixture.cjs'), mcpServer);
    await fs.writeFile(path.join(workspaceRoot, '.mcp.json'), JSON.stringify({ mcpServers: {
      fixture: { command: process.execPath, args: ['mcp-fixture.cjs'], exposure: 'direct' },
    } }));
    await fs.writeFile(path.join(dataDir, 'project-trust.json'), JSON.stringify({ [await fs.realpath(workspaceRoot)]: true }));
    const trustedView = { ...view, creationRequestId: randomUUID() };
    const trustedReply = await requestMcp(trustedView, trustedView.creationRequestId);
    expect(trustedReply.ok, JSON.stringify(trustedReply)).toBe(true);
    const discovery = await requestMcp({ kind: 'discover', handleId: view.handleId, server: 'fixture' });
    expect(discovery.ok, JSON.stringify(discovery)).toBe(true);
    if (!discovery.ok) throw new Error('MCP fixture tools were not discovered');
    const [record] = discovery.value as McpAuthorityTool[];
    expect(record).toBeDefined();
    expect(await requestMcp({ kind: 'call', handleId: view.handleId, name: record!.name, schemaVersion: record!.schemaVersion, arguments: {} }))
      .toMatchObject({ ok: true });
    expect(await fs.realpath(await fs.readFile(path.join(workspaceRoot, 'mcp.txt'), 'utf8'))).toBe(await fs.realpath(workspaceRoot));
    await accepted(source('release', worker.token, { ...mcpAddress, mode: 'retire' }));
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: true });
    const terminal = (command: object) => source('terminal', worker.token, { sessionId: 'resource-node-terminal', command });
    const shell = process.platform === 'win32' ? 'cmd' : 'sh';
    expect(await accepted(terminal({ action: 'create', options: { cwd: workspaceRoot, shell } }))).toMatchObject({ status: 'running' });
    expect(await accepted(api('/retention', worker.token))).toMatchObject({ retireReady: false, activeProcess: true });
    await accepted(terminal({ action: 'write', inputId: 'terminal-effect', data: `"${process.execPath}" -e "require('node:fs').writeFileSync('pty.txt','resource-terminal')"\r` }));
    await expect.poll(() => fs.readFile(path.join(workspaceRoot, 'pty.txt'), 'utf8').catch(() => null)).toBe('resource-terminal');
    expect(await accepted(terminal({ action: 'close', force: true }))).toMatchObject({ status: 'exited' });
    await expect.poll(() => accepted(api('/retention', worker.token))).toMatchObject({ retireReady: true });
    await node.close();
    await revokeResourceNodeClient(options, worker.clientId);
    node = await startResourceNode(options);
    expect((await accepted<ManagedRemoteIdentity>(api('/identity', reader.token))).hostId).toBe(identity.hostId);
    expect((await accepted<ManagedSourceResolveReceipt>(source('resolve', reader.token, { path: workspaceRoot }))).workspaceId).toBe(workspaceId);
    expect([401, 403]).toContain((await api('/identity', worker.token)).status);
    await expect(fs.stat(path.join(dataDir, 'kernel', node.hostId, 'agent-runtime'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally {
    await node?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
}, 60_000);
