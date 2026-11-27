import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, test, vi } from 'vitest';
import { openSupervisorGateway } from './supervisor-gateway.js';
import { SupervisorUserInbox } from './user-inbox.js';

test('the stable gateway wakes only for foreground demand and forwards the original write once', async () => {
  const gateway = await openSupervisorGateway(0);
  const endpoint = 'http://127.0.0.1:' + gateway.port;
  const requests: unknown[] = [];
  const owner = createServer(async (req, res) => {
    let body = '';
    for await (const bytes of req) body += bytes;
    requests.push({ url: req.url, authorization: req.headers.authorization, method: req.method, body });
    res.writeHead(201).end();
  });
  try {
    await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
    const passive = await fetch(endpoint + '/api/threads/observe?cursor=2');
    expect(passive.status).toBe(503);
    await passive.body?.cancel();
    const mint = await fetch(endpoint + '/auth/url-token?observation=1', { method: 'POST' });
    expect(mint.status).toBe(503);
    await mint.body?.cancel();
    expect(await gateway.hasDemand()).toBe(false);
    const pending = fetch(endpoint + '/api/threads/submit', {
      method: 'POST', body: 'first-input', headers: { Authorization: 'Bearer test-client' },
    });
    await expect.poll(() => gateway.hasDemand()).toBe(true);
    expect(requests).toEqual([]);
    gateway.setTarget((owner.address() as AddressInfo).port);
    expect((await pending).status).toBe(201);
    expect(requests).toEqual([{ url: '/api/threads/submit', authorization: 'Bearer test-client', method: 'POST', body: 'first-input' }]);
    await expect.poll(() => gateway.hasDemand()).toBe(false);
  } finally {
    await gateway.close();
    owner.closeAllConnections();
    await new Promise<void>(resolve => owner.close(() => resolve()));
  }
});

test('stages files and ordered inputs while recovering a lost Catalog acknowledgment', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'varin-ingress-'));
  let inbox = new SupervisorUserInbox(directory);
  const authorize = async (auth: string | undefined) => auth?.startsWith('Bearer ') ?
    { principalId: auth.slice(7), clientId: auth.slice(7) } : null;
  let gateway = await openSupervisorGateway(0, { inbox, authenticate: authorize });
  const receipts = new Map<string, object>();
  const order: string[] = [];
  const owner = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const bytes of req) parts.push(bytes);
    const raw = Buffer.concat(parts);
    if (req.url?.startsWith('/api/threads/attachments/upload?')) {
      order.push('file:' + raw.toString('hex'));
      res.writeHead(200).end('{}');
      return;
    }
    const input = raw.length ? JSON.parse(raw.toString()) : {};
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/api/threads/inbox/reconcile') {
      if (input.result) receipts.set(input.key, input.result);
      res.end(JSON.stringify({ result: receipts.get(input.key) }));
    } else if (req.url === '/api/threads/submit') {
      order.push(input.key);
      receipts.set(input.key, { status: 200, body: { input_id: input.key } });
      req.socket.destroy();
    } else if (req.url === '/api/threads/enqueue') {
      order.push(input.key + ':' + input.mode);
      res.end(JSON.stringify({ input_id: input.key, mode: input.mode }));
    } else { order.push('foreground'); res.end('{}'); }
  });
  const actorHeaders = { Authorization: 'Bearer alice', 'Content-Type': 'application/json' };
  const endpoint = () => 'http://127.0.0.1:' + gateway.port;
  const identity = { runtime: 'agent', threadId: 'thread:one', branchId: 'branch:one' };
  const submit = (key: string, body = key) => fetch(endpoint() + '/api/threads/submit', {
    method: 'POST', headers: actorHeaders, body: JSON.stringify({ ...identity, key, text: body }),
  });
  const status = (id: string, authorization = actorHeaders.Authorization) =>
    fetch(endpoint() + '/api/threads/inbox/status?inboxId=' + id, { headers: { Authorization: authorization } });
  try {
    await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
    const query = new URLSearchParams({ ...identity, key: 'file', byteLength: '3', filename: 'example.txt', mimeType: 'text/plain' });
    const staged = await fetch(endpoint() + '/api/threads/attachments/upload?' + query, {
      method: 'POST', headers: { ...actorHeaders, 'Content-Type': 'application/octet-stream' }, body: new Uint8Array([1, 2, 3]),
    });
    expect(staged.status).toBe(202);
    expect(await staged.json()).toMatchObject({ filename: 'example.txt' });
    const first = await submit('first');
    const firstReceipt = await first.json() as { inboxId: string };
    expect(first.status).toBe(202);
    expect(await (await submit('first')).json()).toEqual(firstReceipt);
    expect((await submit('first', 'different intent')).status).toBe(409);
    const secondReceipt = await (await submit('second')).json() as { inboxId: string };
    expect((await status(firstReceipt.inboxId, 'Bearer second-owner')).status).toBe(404);
    expect(order).toEqual([]);

    await gateway.close();
    inbox.close();
    inbox = new SupervisorUserInbox(directory);
    gateway = await openSupervisorGateway(0, { inbox, authenticate: authorize });
    const port = (owner.address() as AddressInfo).port;
    const signal = AbortSignal.timeout(5_000);
    const foreground = fetch(endpoint() + '/api/threads/cancel', { method: 'POST', signal });
    const observed = status(secondReceipt.inboxId);
    gateway.activate(port, 'launch-proof', signal);
    expect((await foreground).status).toBe(200);
    expect(await (await observed).json()).toMatchObject({ result: { body: { input_id: 'second', mode: 'next_run' } } });
    expect(await (await status(firstReceipt.inboxId)).json()).toMatchObject({ result: { body: { input_id: 'first' } } });
    expect(order.filter(entry => entry !== 'foreground')).toEqual(['file:010203', 'first', 'second:next_run']);
    const storage = new DatabaseSync(path.join(directory, 'user-inputs.sqlite'), { readOnly: true });
    try { expect(storage.prepare('SELECT count(*) AS count FROM ingress_payloads').get()?.count).toBe(0); }
    finally { storage.close(); }
  } finally {
    await gateway.close();
    inbox.close();
    owner.closeAllConnections();
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('an uncertain replay preserves branch order until the Catalog recovers or expires the input', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'varin-ingress-isolation-'));
  const inbox = new SupervisorUserInbox(directory);
  const gateway = await openSupervisorGateway(0, { inbox, authenticate: async () => ({ principalId: 'owner', clientId: 'gateway' }) });
  const delivered: string[] = [];
  const rejected = new Map<string, unknown>();
  const drafts = new Map<string, unknown>();
  let attemptedExpired = false;
  const owner = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    const input = JSON.parse(body || '{}');
    if (req.url?.endsWith('/reconcile')) {
      if (input.result && !rejected.has(input.key)) {
        rejected.set(input.key, input.result);
        drafts.set(input.key, input.draft);
      }
      res.end(JSON.stringify({ result: rejected.get(input.key) }));
    } else if (input.key === 'uncertain' || input.key === 'expired') {
      if (input.key === 'expired') attemptedExpired = true;
      res.writeHead(500).end(JSON.stringify({ code: 'unexpected-host-error' }));
    } else if (input.key === 'invalid') {
      res.writeHead(400).end(JSON.stringify({ code: 'invalid-params' }));
    } else {
      if (input.key) delivered.push(input.key);
      res.end(JSON.stringify({ input_id: input.key }));
    }
  });
  try {
    await new Promise<void>(resolve => owner.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + gateway.port;
    const submit = async (branchId: string, key: string) => {
      const response = await fetch(base + '/api/threads/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ runtime: 'agent', threadId: branchId, branchId, key, text: key }) });
      expect(response.status).toBe(202);
      const receipt = await response.json() as { inboxId: string };
      return receipt.inboxId;
    };
    const blocked = await submit('one', 'uncertain');
    const next = await submit('one', 'second');
    const invalid = await submit('two', 'invalid');
    const independent = await submit('two', 'separate');
    const expired = await submit('three', 'expired');
    const afterExpired = await submit('three', 'after-expired');
    const port = (owner.address() as AddressInfo).port;
    gateway.activate(port, 'proof', new AbortController().signal);
    expect((await fetch(base + '/api/version')).status).toBe(200);
    await expect.poll(() => inbox.status('owner', independent)).toMatchObject({ status: 200 });
    expect(inbox.status('owner', invalid)).toMatchObject({ status: 400 });
    expect(inbox.status('owner', blocked)).toBeNull();
    expect(inbox.status('owner', next)).toBeNull();
    await expect.poll(() => attemptedExpired).toBe(true);
    expect(inbox.status('owner', expired)).toBeNull();
    expect(inbox.status('owner', afterExpired)).toBeNull();
    expect(delivered).toEqual(['separate']);
    expect((await submit('one', 'third'))).toBeTruthy();
    rejected.set('uncertain', { status: 200, body: { input_id: 'original-receipt' } });
    await new Promise(resolve => setTimeout(resolve, 2100));
    const leap = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 120_001);
    try {
      gateway.activate(port, 'proof', new AbortController().signal);
      await expect.poll(() => inbox.status('owner', afterExpired)).toMatchObject({ status: 200 });
      expect(inbox.status('owner', expired)).toMatchObject({ status: 409, body: { code: 'inbox-replay-expired' } });
      expect(drafts.get('expired')).toMatchObject({ text: 'expired' });
    } finally { leap.mockRestore(); }
    await expect.poll(() => inbox.status('owner', next)).toMatchObject({ status: 200 });
    expect(inbox.status('owner', blocked)).toMatchObject({ body: { input_id: 'original-receipt' } });
    await expect.poll(() => gateway.quietFor()).toBeGreaterThan(0);
  } finally {
    await gateway.close();
    inbox.close();
    owner.closeAllConnections();
    await new Promise<void>(resolve => owner.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
