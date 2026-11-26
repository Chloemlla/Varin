import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it as test } from 'vitest';
import type { ComputerActor, ComputerDesktop, ComputerListResult } from '@varin/protocol';
import { expectOk } from '../computer/role-http.test-helper.js';
import { pairComputerNode, revokeComputerNodeClient, startComputerNode } from '../../computer-node.js';
import { computerDriverFixture } from '../computer/driver-fixture.test-helper.js';
import { createComputerService } from '../computer/computer-service.js';
import { createNodeRoleKernel, nodeRoleDataDirectory } from '../node-role-auth.js';

const kernelPath = process.env.VARIN_TEST_KERNEL_PATH ?? fileURLToPath(new URL(
  '../../../../../kernel/target/release/' + (process.platform === 'win32' ? 'varin-kernel.exe' : 'varin-kernel'), import.meta.url));
const binary = await fs.stat(kernelPath).then(() => true, () => false);
if (!binary && process.env.VARIN_REQUIRE_RELEASE_KERNEL === '1') throw new Error('Computer node acceptance requires a release kernel');
const it = test.skipIf(!binary);

it('runs a dedicated Computer node, scopes peer work/leases, and recovers the same desktop metadata after restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-computer-node-'));
  const dataDir = path.join(dir, 'desktop'), calls: string[] = [];
  const driverDir = computerDriverFixture(dir);
  const options = { kernelPath, dataDir, driverDir, port: 0, platform: 'windows' as const };
  let node: Awaited<ReturnType<typeof startComputerNode>> | undefined;
  let coordinator: ReturnType<typeof createComputerService> | undefined;
  let coordinatorKernel: Awaited<ReturnType<typeof createNodeRoleKernel>> | undefined;
  const start = () => startComputerNode({ ...options, createDriver: spec => {
    calls.push('spawn:' + spec.env?.VARIN_DRIVER_ROLE);
    let alive = true;
    return { capabilities: null, alive: () => alive, cancel: () => false,
      dispose: () => { alive = false; },
      request: async op => {
        calls.push(String(op.tool));
        if (op.tool === 'capabilities') return { id: 'caps', ok: true, capabilities: {
          platform: 'windows', driver: 'fixture-driver', status: 'ready', observeTree: true,
        } };
        if (op.tool === 'get_app_state') return { id: 'observe', ok: true, snapshot: {
          app: { name: 'fixture-editor', pid: 55, windowTitle: 'Original node desktop' },
          windowBounds: { x: 0, y: 0, width: 80, height: 40 }, treeLines: ['0 Edit'], elements: [{ index: 0, name: 'Edit' }],
        } };
        return { id: 'request', ok: true };
      },
    };
  } });
  const paired = async (name: string, control = false) => {
    const output = path.join(dir, name + '.json');
    await pairComputerNode({ ...options, output, control });
    return JSON.parse(await fs.readFile(output, 'utf8')) as { clientId: string; token: string };
  };
  try {
    const observer = await paired('observer'), other = await paired('other', true);
    node = await start();
    const url = () => 'http://127.0.0.1:' + node!.port;
    const request = (route: string, token?: string, body?: unknown, headers?: Record<string,string>) => fetch(url() + route, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const api = '/api/computers', desktop = api + '/desktops/local-console';
    expect(await expectOk(request('/health'))).toMatchObject({ role: 'computer', control: 'ready' });
    expect((await request(api)).status).toBe(401);
    const identity = '/api/harness/managed-execution/v1/identity';
    expect(await expectOk(request(identity, observer.token))).toMatchObject({ hostId: node.hostId, role: 'computer', capabilities: ['computer'] });
    expect((await request(identity, observer.token, undefined, { 'X-Varin-Managed-Target': 'other-host' })).status).toBe(409);
    expect((await request('/api/threads', other.token)).status).toBe(404);
    expect((await request('/api/harness/managed-execution/v1/shell/exec', other.token, {})).status).toBe(404);
    expect((await request(api + '/vms', other.token)).status).toBe(404);
    const initial = await expectOk<ComputerListResult>(request(api, observer.token));
    expect(initial.desktops[0]).toMatchObject({ id: 'local-console', status: 'unavailable' });
    expect(calls).toEqual([]);
    expect((await request(desktop + '/input', observer.token, { holderId: 'first' })).status).toBe(403);
    expect((await request(desktop + '/open', other.token, { command: 'anything' })).status).toBe(403);
    expect((await request(desktop + '/browser', observer.token, { op: 'status', binary: '/not/a/role/input' })).status).toBe(403);
    expect(calls).toEqual([]);
    const firstProbe = await expectOk<{ desktop: ComputerDesktop }>(request(desktop + '/probe', observer.token, {}));
    expect(firstProbe.desktop).toMatchObject({ status: 'available', capabilities: { driver: 'fixture-driver', observeTree: true } });
    const work = { runtime: 'agent' as const, threadId: 'coordinator-thread', branchId: 'main' };
    const execution = { work, runId: 'coordinator-run' };
    const actor: ComputerActor = { execution, rootWork: work, rootExecution: execution, label: 'coordinator' };
    const assignment = { origin: 'coordinator-host:fixture', assignmentId: 'same-visible-assignment', access: 'observe', actor };
    const firstLease = (await expectOk<{ token: string }>(request(desktop + '/assignment', observer.token, { ...assignment, op: 'claim' }))).token;
    const forged = await request(desktop + '/observe', other.token, { app: 'fixture-editor' }, { 'X-Varin-Computer-Lease': firstLease });
    expect(forged.status).toBe(409);
    expect(await forged.json()).toMatchObject({ computerExecution: { inputWriterStopped: true, receipt: { effect: 'none' } } });
    expect((await request(desktop + '/assignment', observer.token, { ...assignment, access: 'control', op: 'claim' })).status).toBe(403);
    const observation = await expectOk(request(desktop + '/observe', observer.token, { app: 'fixture-editor' }, { 'X-Varin-Computer-Lease': firstLease }));
    expect(JSON.stringify(observation)).toContain('Original node desktop');
    await expectOk(request(desktop + '/assignment', observer.token, { ...assignment, op: 'drop' }));

    // Separate Computer owner/storage in the coordinating Host, using the
    // production remote catalog, assignment guard and public operation route.
    const coordinatorDir = await nodeRoleDataDirectory(path.join(dir, 'coordinator'));
    coordinatorKernel = await createNodeRoleKernel(coordinatorDir, kernelPath);
    await coordinatorKernel.kernel.start();
    coordinator = createComputerService({ client: coordinatorKernel.kernel, hostId: coordinatorKernel.hostId, dataDir: coordinatorDir,
      resolveActor: async () => actor, remoteHosts: async () => [{ id: 'installed-node', label: 'Computer node', apiUrl: url(), clientToken: observer.token }] });
    const mirror = (await coordinator.list({ refresh: true })).desktops.find(item => item.remote)!;
    expect(mirror.remote?.hostId).toBe(node.hostId);
    const remote = await coordinator.automation.authorize(work, 'observe', mirror.id, () =>
      coordinator!.observe({ desktopId: mirror.id, app: 'fixture-editor' }), execution);
    expect(remote.desktopId).toBe(mirror.id);
    expect(remote.app.windowTitle).toBe('Original node desktop');
    await coordinator.dispose(); coordinator = undefined;
    await coordinatorKernel.kernel.close(); coordinatorKernel = undefined;

    const host = node.hostId;
    await node.close(); node = undefined;
    calls.length = 0;
    node = await start();
    expect(node.hostId).toBe(host);
    const cached = await expectOk<ComputerListResult>(request(api, observer.token));
    expect(cached.desktops[0]).toMatchObject({ id: 'local-console', status: 'available', probedAt: firstProbe.desktop.probedAt });
    expect(calls).toEqual([]);
    expect((await request(desktop + '/observe', observer.token, { app: 'fixture-editor' }, { 'X-Varin-Computer-Lease': firstLease })).status).toBe(409);
    await node.close(); node = undefined;
    await revokeComputerNodeClient(options, observer.clientId);
    node = await start();
    expect((await request(api, observer.token)).status).toBe(401);
    expect((await request(api, other.token)).status).toBe(200);
  } finally {
    await coordinator?.dispose();
    await coordinatorKernel?.kernel.close();
    await node?.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
