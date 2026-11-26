import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { expect, it } from 'vitest';
import type { ComputerActor, ComputerControlResult, ComputerDesktop, ComputerListResult } from '@varin/protocol';
import { expectOk as ok } from './role-http.test-helper.js';
import type { KernelRecordResult } from '../kernel/protocol.generated.js';
import { computerDriverFixture } from './driver-fixture.test-helper.js';
import { createComputerService } from './computer-service.js';
import { mountComputerNodeRole } from './computer-node-role.js';

const store = () => {
  const entries = new Map<string, KernelRecordResult>();
  return { issueGrant: async () => ({ grantId: 'fixture' }), scoped: () => ({
    getRecord: async (_workspace: string, id: string) => entries.get(id) ?? null,
    listRecords: async ({ recordType }: { recordType: string }) => ({ records: [...entries.values()].filter(row => row.recordType === recordType), nextCursor: null }),
    putRecord: async (params: Omit<KernelRecordResult, 'createdAt'|'updatedAt'|'recordRevision'>) => {
      const stored = { ...params, createdAt: 1, updatedAt: 1, recordRevision: (entries.get(params.recordId)?.recordRevision ?? 0) + 1 };
      entries.set(params.recordId, stored); return stored;
    },
  }) } as never;
};

it('actual remote Computer owner scopes a loopback coordinator, driver and viewer without unrelated Host APIs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'varin-computer-loopback-'));
  const driverDir = computerDriverFixture(dir);
  const calls: string[] = [];
  const desktop = createComputerService({ client: store(), hostId: 'actual-target', dataDir: dir, platform: 'windows', driverDir,
    createDriver: spec => {
      calls.push('spawn:' + spec.env?.VARIN_DRIVER_ROLE);
      let alive = true;
      return { capabilities: null, alive: () => alive, cancel: () => false, dispose: () => { alive = false; }, request: async op => {
        calls.push(String(op.tool));
        if (op.tool === 'capabilities') return { id: 'caps', ok: true, capabilities: { platform: 'windows', driver: 'target-driver', status: 'ready', observeTree: true } };
        if (op.tool === 'get_app_state') return { id: 'snap', ok: true, snapshot: {
          app: { name: 'editor', pid: 7, windowTitle: 'Dedicated desktop' },
          windowBounds: { x: 0, y: 0, width: 200, height: 100 }, treeLines: ['0 Edit'], elements: [{ index: 0, name: 'Edit' }],
        } };
        return { id: 'ok', ok: true };
      } };
    } });
  const app = express(); app.use(express.json());
  const server = http.createServer(app);
  const role = mountComputerNodeRole({ app, server, computers: desktop, hostId: 'actual-target', isDraining: () => false, authenticate: async request => {
    const credential = request.headers.authorization?.slice('Bearer '.length);
    return credential === 'observer' || credential === 'first' || credential === 'second' ? { clientId: credential,
      capabilities: ['computer:observe', ...(credential === 'observer' ? [] : ['computer:control'])] } : undefined;
  } });
  const work = { runtime: 'agent' as const, threadId: 'local-thread', branchId: 'main' };
  const execution = { work, runId: 'local-run' }, actor: ComputerActor = { execution, rootWork: work, rootExecution: execution, label: 'Coordinator' };
  const base = '/api/computers', local = base + '/desktops/local-console';
  let coordinator: ReturnType<typeof createComputerService> | undefined;
  const viewer = [new AbortController(), new AbortController()];
  try {
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('HTTP fixture missing port');
    const uri = `http://127.0.0.1:${addr.port}`;
    const req = (p: string, bearer?: string, body?: unknown, headers?: Record<string,string>, signal?: AbortSignal) => fetch(uri + p, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { ...(bearer ? { Authorization: 'Bearer ' + bearer } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), ...(signal ? { signal } : {}),
    });
    expect((await req(base)).status).toBe(401);
    expect((await req(base + '/default-target', 'first', { desktopId: 'local-console' })).status).toBe(404);
    expect((await req('/api/harness/managed-execution/v1/shell/exec', 'first', {})).status).toBe(404);
    expect((await req(local + '/open', 'first', { command: 'arbitrary-command' })).status).toBe(403);
    expect((await req(local + '/browser', 'observer', { op: 'status', profile: '/ungranted/path' })).status).toBe(403);
    expect((await req(local + '/office', 'observer', { op: 'act', act: { kind: 'save' } })).status).toBe(403);
    const firstRead = await ok<ComputerListResult>(req(base, 'observer'));
    expect(firstRead.desktops[0]?.status).toBe('unavailable');
    expect(calls).toEqual([]);
    const probed = await ok<{ desktop: ComputerDesktop }>(req(local + '/probe', 'observer', {}));
    expect(probed.desktop.capabilities?.driver).toBe('target-driver');
    const claim = { actor, origin: 'same-named-host', assignmentId: 'same-name', access: 'observe' };
    const lease1 = (await ok<{ token: string }>(req(local + '/assignment', 'observer', { ...claim, op: 'claim' }))).token;
    const lease2 = (await ok<{ token: string }>(req(local + '/assignment', 'second', { ...claim, op: 'claim' }))).token;
    expect(lease1).not.toBe(lease2);
    const denied = await req(local + '/observe', 'second', { app: 'editor' }, { 'X-Varin-Computer-Lease': lease1 });
    expect(denied.status).toBe(409);
    expect(await denied.json()).toMatchObject({ computerExecution: { inputWriterStopped: true, receipt: { effect: 'none' } } });
    await ok(req(local + '/assignment', 'second', { ...claim, op: 'drop' }));
    expect(JSON.stringify(await ok(req(local + '/observe', 'observer', { app: 'editor' }, { 'X-Varin-Computer-Lease': lease1 })))).toContain('Dedicated desktop');
    await ok(req(local + '/assignment', 'observer', { ...claim, op: 'drop' }));
    coordinator = createComputerService({ client: store(), hostId: 'separate-coordinator', dataDir: path.join(dir, 'coordinator'),
      resolveActor: async () => actor, remoteHosts: async () => [{ id: 'paired', label: 'External desktop', apiUrl: uri, clientToken: 'observer' }] });
    const remote = (await coordinator.list({ refresh: true })).desktops.find(item => item.remote)!;
    expect(remote.remote?.hostId).toBe('actual-target');
    const scene = await coordinator.automation.authorize(work, 'observe', remote.id, () =>
      coordinator!.observe({ desktopId: remote.id, app: 'editor' }), execution);
    expect(scene).toMatchObject({ desktopId: remote.id, app: { windowTitle: 'Dedicated desktop' } });

    // Two clients can use the same visible viewer label, without sharing control.
    for (const [i, peer] of ['first', 'second'].entries()) {
      const r = await req(local + '/stream?viewer=identical-name&frames=0', peer, undefined, undefined, viewer[i]!.signal);
      expect(r.status).toBe(200);
      const reader = r.body!.getReader(); await reader.read(); reader.releaseLock();
    }
    const takeover = await ok<ComputerControlResult>(req(local + '/takeover', 'first', { holderId: 'identical-name' }));
    expect(takeover.control.holderId).toBe('identical-name');
    expect((await ok<ComputerControlResult>(req(local + '/control', 'second'))).control).not.toHaveProperty('holderId');
    expect((await req(local + '/input', 'second', { holderId: 'identical-name', controlEpoch: takeover.control.automationEpoch, input: { kind: 'text', text: 'must not dispatch' } })).status).toBe(409);
    expect(calls).not.toContain('inject_input');
    await ok(req(local + '/handback', 'first', { holderId: 'identical-name' }));
  } finally {
    viewer.forEach(item => item.abort()); role.closeObservers();
    await coordinator?.dispose();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    await desktop.dispose();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
