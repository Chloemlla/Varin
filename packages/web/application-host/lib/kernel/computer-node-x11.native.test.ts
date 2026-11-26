import { spawnSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import type { ComputerActor, ComputerDesktop, ComputerDesktopFrame } from '@varin/protocol';
import { expectOk as json } from '../computer/role-http.test-helper.js';
import { pairComputerNode, startComputerNode } from '../../computer-node.js';
import { createComputerService, type DesktopViewEvent } from '../computer/computer-service.js';
import { computerDriverDir, localDriverSpawnSpec } from '../computer/driver-host.js';
import { createNodeRoleKernel, nodeRoleDataDirectory } from '../node-role-auth.js';

const optedIn = process.env.VARIN_TEST_COMPUTER_X11 === '1';

function assertFixturePixels(frame: ComputerDesktopFrame) {
  const png = Buffer.from(frame.base64, 'base64');
  expect(frame.mime).toBe('image/png');
  expect(frame.bounds).toEqual({ x: 0, y: 0, width: 320, height: 240 });
  const result = spawnSync('python3', ['-c', [
    'import sys, gi',
    'gi.require_version("GdkPixbuf", "2.0")',
    'from gi.repository import GdkPixbuf',
    'loader = GdkPixbuf.PixbufLoader.new_with_type("png")',
    'loader.write(sys.stdin.buffer.read())',
    'loader.close()',
    'p = loader.get_pixbuf()',
    'assert (p.get_width(), p.get_height()) == (320, 240)',
    'offset = 120 * p.get_rowstride() + 160 * p.get_n_channels()',
    'print(list(p.get_pixels()[offset:offset+3]))',
  ].join('\n')], { input: png, encoding: 'utf8', timeout: 5_000 });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toEqual([48, 96, 192]);
}

it.skipIf(!optedIn)('captures a real isolated X11 desktop through a separate coordinator before and after role restart', async () => {
  const kernelPath = process.env.VARIN_TEST_KERNEL_PATH;
  if (process.platform !== 'linux' || !kernelPath || !process.env.DISPLAY ||
      !process.env.XAUTHORITY || !process.env.DBUS_SESSION_BUS_ADDRESS || process.env.XDG_SESSION_TYPE !== 'x11' ||
      process.env.WAYLAND_DISPLAY) throw new Error('Run through scripts/test-computer-role-x11.sh');
  const driverDir = computerDriverDir();
  expect(localDriverSpawnSpec('linux', driverDir), 'expected the source Linux driver beneath ' + driverDir).toMatchObject({
    command: 'python3', args: [path.join(driverDir, 'linux', 'driver-host.py')],
  });
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'vx-'));
  const options = { kernelPath, driverDir, dataDir: path.join(root, 'role'), port: 0 };
  let role: Awaited<ReturnType<typeof startComputerNode>> | undefined;
  let coordinatorKernel: Awaited<ReturnType<typeof createNodeRoleKernel>> | undefined;
  let coordinator: ReturnType<typeof createComputerService> | undefined;
  const work = { runtime: 'agent' as const, threadId: 'x11-coordinator', branchId: 'main' };
  const execution = { work, runId: 'x11-run' };
  const actor: ComputerActor = { execution, rootWork: work, rootExecution: execution, label: 'X11 fixture' };
  const url = () => 'http://127.0.0.1:' + role!.port;
  const api = '/api/computers/desktops/local-console';
  const origin = 'fixture-isolated-coordinator';
  try {
    const output = path.join(root, 'paired.json');
    await pairComputerNode({ ...options, output, control: true });
    const { token } = JSON.parse(await fs.readFile(output, 'utf8')) as { token: string };
    role = await startComputerNode(options);
    const request = (route: string, payload?: object, lease?: string) => fetch(url() + route, {
      method: payload ? 'POST' : 'GET',
      headers: { Authorization: 'Bearer ' + token, ...(payload ? { 'Content-Type': 'application/json' } : {}),
        ...(lease ? { 'X-Varin-Computer-Lease': lease } : {}) },
      ...(payload ? { body: JSON.stringify(payload) } : {}),
      signal: AbortSignal.timeout(10_000),
    });
    const identity = '/api/harness/managed-execution/v1/identity';
    const hostId = role.hostId;
    expect(await json(request(identity))).toMatchObject({ hostId, role: 'computer' });

    const dataDir = await nodeRoleDataDirectory(path.join(root, 'coord'));
    coordinatorKernel = await createNodeRoleKernel(dataDir, kernelPath);
    await coordinatorKernel.kernel.start();
    expect(coordinatorKernel.hostId).not.toBe(hostId);
    coordinator = createComputerService({ client: coordinatorKernel.kernel, hostId: coordinatorKernel.hostId, dataDir,
      resolveActor: async () => actor,
      remoteHosts: async () => [{ id: 'separate-x11-role', label: 'X11 role', apiUrl: url(), clientToken: token }] });
    const catalog = async () => {
      const item = (await coordinator!.list({ refresh: true })).desktops.find(row => row.remote?.hostId === hostId);
      expect(item, 'coordinator must discover original role identity').toBeDefined();
      return item!;
    };
    const claim = () => json<{ token: string }>(request(api + '/assignment', { origin, assignmentId: 'fixture-control',
      access: 'control', actor, op: 'claim' }));

    async function capture(desktopId: string) {
      const controller = new AbortController();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let stop: (() => void) | undefined;
      let onEvent!: (event: DesktopViewEvent) => void;
      const next = new Promise<ComputerDesktopFrame>((resolve, reject) => {
        onEvent = event => {
          if (event.type === 'frame') resolve(event.frame);
          else if (event.type === 'error' && event.terminal) reject(new Error(event.error));
        };
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('No real X11 frame from remote role within 15 seconds'));
        }, 15_000);
      });
      // Handle the asynchronous subscription and frame deadline together, so a
      // broken transport cannot leave a pending stream or unhandled rejection.
      try {
        const [frame] = await Promise.all([next, coordinator!.subscribeFrames(desktopId, 'x11-fixture-viewer',
          onEvent, { signal: controller.signal }).then(close => { stop = close; })]);
        assertFixturePixels(frame);
      } finally {
        clearTimeout(timer);
        stop?.();
        controller.abort();
      }
    }
    expect((await json<{ desktop: ComputerDesktop }>(request(api + '/probe', {}))).desktop.capabilities).toMatchObject({ platform: 'linux', sessionType: 'x11', screenshot: true });
    const original = await catalog();
    await capture(original.id);
    const lease = (await claim()).token as string;
    await role.close();
    role = await startComputerNode(options);
    expect(role.hostId).toBe(hostId);
    expect(await json(request(identity))).toMatchObject({ hostId, role: 'computer' });

    // This action is intentionally invalid even if a lease check regresses:
    // it cannot emit input. A stale lease must fail *before* action validation.
    const invalid = { action: { kind: 'fixture-never-dispatch' } };
    const stale = await request(api + '/act', invalid, lease);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ computerExecution: { inputWriterStopped: true, receipt: { effect: 'none' } } });
    const replacement = (await claim()).token as string;
    expect(replacement).not.toBe(lease);
    const admitted = await request(api + '/act', invalid, replacement);
    expect(admitted.status).toBe(400);
    expect(await admitted.json()).toMatchObject({
      code: 'invalid-params',
      error: 'computer.act requires action.app or an observed target',
    });
    const recovered = await catalog();
    expect(recovered.id).toBe(original.id);
    await capture(recovered.id);
  } finally {
    await coordinator?.dispose();
    await coordinatorKernel?.kernel.close();
    await role?.close();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 65_000);
