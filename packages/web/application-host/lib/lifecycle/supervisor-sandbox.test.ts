import { spawn } from 'node:child_process';
import { once, type EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket } from 'ws';
import { expect, test, vi } from 'vitest';
import type { ResourceProvider } from '../deployment/resource-provider.js';
import { createSupervisorSandbox } from './supervisor-sandbox.js';
import { SANDBOX_RELAY, type SandboxReceiverLease } from './sandbox-receiver-lease.js';
import type { FollowupEventReceiveParams } from '@varin/protocol';

test('the original sandbox receiver keeps its authenticated stream after Host exit and can only submit or read its exact lease', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const bound = server.address();
  if (typeof bound !== 'object' || !bound) throw new Error('No test port');
  const endpoint = 'http://127.0.0.1:' + bound.port;
  const provider: ResourceProvider = {
    id: 'fixture', describe: async () => [{ id: 'sandbox', hostId: 'sandbox-host', label: 'Sandbox', role: 'extensions', capabilities: [] }],
    acquire: async input => ({ ...input, generation: '1', endpoint, bearer: 'fixture', expiresAt: Date.now() + 60_000 }),
    renew: async input => ({ ...input, endpoint, bearer: 'fixture', expiresAt: Date.now() + 60_000 }),
    release: async () => {}, status: vi.fn(), retire: vi.fn(),
  };
  let durable!: () => void;
  const accept = vi.fn(async (_key: string, _page: FollowupEventReceiveParams) => {
    await new Promise<void>(resolve => { durable = resolve; });
    return { version: 1 as const, owner: 'host', digest: 'saved' };
  });
  const wake = vi.fn();
  const bridge = createSupervisorSandbox(provider, { accept }, wake);
  const host = spawn(process.execPath, ['-e', `process.once('disconnect', () => process.exit(0));
  process.on('message', message => {
    if (message.exitHost) process.exit(0);
    if (Object.hasOwn(message, 'testCommand')) process.send(message.testCommand);
    else process.send({ observed: message });
  });`], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const observed: Array<Record<string, unknown>> = [];
  host.on('message', message => {
    if (message && typeof message === 'object' && 'observed' in message) observed.push(message.observed as Record<string, unknown>);
  });
  bridge.attach(host);
  const send = (message: object) => host.send({ testCommand: { type: SANDBOX_RELAY, ...message } });
  const fixture: SandboxReceiverLease = {
    scope: 'scoped-owner', cursor: 'origin', expiresAt: Date.now() + 20_000, hostId: 'host', status: null, schema: true, recovery: 'history',
    identity: { principalId: 'user', source: { extensionId: 'plugin', sourceId: 'inbound', connectionId: 'connection', accountId: 'account' } },
    credentials: { metadata: { kind: 'api-key', connected: true, account: 'account', generation: 1 }, value: { kind: 'api-key', key: 'scoped-test-key' } },
  };
  let peer: WebSocket | undefined;
  const observe = (emitter: EventEmitter, event: string, stage: string) =>
    once(emitter, event, { signal: AbortSignal.timeout(4_000) }).catch(error => { throw new Error(stage, { cause: error }); });
  try {
    const connected = observe(server, 'connection', 'Sandbox connection');
    send({ kind: 'open', channel: 'transport', resourceId: 'sandbox', hostId: 'sandbox-host', generation: '1', extensionId: 'dev.example.plugin', integrity: 'sha256-' + '1'.repeat(64) });
    [peer] = await connected;
    await vi.waitFor(() => expect(observed.some(message => message.kind === 'open')).toBe(true));
    const brokerCall = observe(peer!, 'message', 'Original receiver invocation');
    send({ kind: 'frame', channel: 'transport', frame: { kind: 'request', id: 'original-receiver', method: 'service.invoke', params: { hostScopeId: fixture.scope, invocationId: 'worker-scope' } } });
    expect(JSON.parse(String((await brokerCall)[0]))).toMatchObject({ params: { invocationId: 'worker-scope' } });
    send({ kind: 'control', id: 'freeze', op: 'freeze', token: 'reservation', scopes: [fixture.scope] });
    await vi.waitFor(() => expect(observed.find(message => message.id === 'freeze')?.ok).toBe(true));
    send({ kind: 'control', id: 'commit', op: 'commit', token: 'reservation', leases: [fixture] });
    await vi.waitFor(() => expect(observed.some(message => message.kind === 'transferred')).toBe(true));
    const exit = observe(host, 'exit', 'Host IPC exit');
    host.send({ exitHost: true });
    await exit;
    const call = (id: string, capability: string, method: string, params: object, invocationId = 'worker-scope') =>
      peer!.send(JSON.stringify({ kind: 'request', id, method: 'capability.call', params: { invocationId, capability, method, params } }));
    let response = observe(peer!, 'message', 'Denied wrong connection');
    call('credential-scope', 'varin.credentials', 'resolve', { connectionId: 'different', expectedAccount: 'account' });
    expect(JSON.parse(String((await response)[0]))).toMatchObject({ id: 'credential-scope', success: false });
    response = observe(peer!, 'message', 'Denied wrong invocation');
    call('other-invocation', 'varin.credentials', 'resolve', { connectionId: 'connection', expectedAccount: 'account' }, 'unrelated');
    expect(JSON.parse(String((await response)[0]))).toMatchObject({ id: 'other-invocation', success: false });
    wake.mockClear();
    response = observe(peer!, 'message', 'Durable page receipt');
    call('page', 'varin.events', 'submit', { expectedCursor: 'origin', nextCursor: 'next',
      events: [{ eventId: 'event', occurredAtMs: 10, attributes: {}, content: { data: null, parts: [] } }] });
    await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
    expect(accept.mock.calls[0]).toEqual([expect.stringMatching(/^sandbox:/u), expect.objectContaining({ identity: fixture.identity })]);
    expect(wake).not.toHaveBeenCalled();
    durable();
    expect(JSON.parse(String((await response)[0]))).toMatchObject({ id: 'page', success: true, result: { cursor: 'next', accepted: 1 } });
    expect(wake).toHaveBeenCalledTimes(1);
    peer!.on('message', data => { if (JSON.parse(data.toString()).kind === 'stop') { peer!.send(JSON.stringify({ kind: 'exited' })); peer!.close(); } });
    await bridge.returnReceivers();
  } finally {
    durable?.();
    if (host.connected) host.disconnect();
    if (host.exitCode === null) host.kill();
    peer?.terminate();
    await bridge.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
