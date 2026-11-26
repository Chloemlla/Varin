import express from 'express';
import request from 'supertest';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
import { createDrainingAdmission, createThreadWriteAdmission } from '../draining-admission.js';
import { registerThreadRoutes } from './thread-routes.js';
import { createThreadPrincipalMiddleware } from './request-principal.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ThreadAdapter } from './thread-adapter.js';

const input = { runtime:'agent',threadId:'alice-thread',branchId:'branch',key:'original-key',
  text:'text',expectedHead:null,model:{providerId:'p',modelId:'m'} };
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
function fixture(auth = Promise.resolve(), acknowledge = Promise.resolve()) {
  const authenticated = gate(), began = gate();
  const app = express();
  let draining = false;
  const admission = createThreadWriteAdmission(() => draining);
  const ownershipResolve = vi.fn(async () => ({ threads:[{id:input.threadId,principalId:'alice'}],runs:[],inputs:[],operations:[] }));
  const submit = vi.fn(async (command: typeof input) => {
    began.resolve(); await acknowledge;
    return {key:command.key};
  });
  app.use(createDrainingAdmission(() => draining));
  app.use(express.json());
  app.use('/api/threads', createThreadPrincipalMiddleware({ownershipResolve} as unknown as AgentRuntimeClient,
    async req => ({principalId:req.get('authorization')})));
  registerThreadRoutes(app, {submit} as unknown as ThreadAdapter, async (req, res, next) => {
    if (req.get('authorization') !== 'alice') { res.sendStatus(401); return; }
    authenticated.resolve(); await auth; next();
  }, undefined, undefined, undefined, undefined, undefined, admission);
  return {app,admission,submit,authenticated,began,seal:()=>{ draining=true; },
    send:()=>Promise.resolve(request(app).post('/api/threads/submit').set('Authorization','alice').send(input))};
}

it('rejects an authenticated submission that was still before the owner gate when the Host fenced admission', async () => {
  const pending = gate();
  const f = fixture(pending.promise);
  const result = f.send();
  await f.authenticated.promise;
  f.seal(); pending.resolve();
  const response = await result;
  expect(response.status).toBe(503);
  expect(response.body).toMatchObject({code:'host-draining',admission:'not_started'});
  expect(f.submit).not.toHaveBeenCalled();
  expect(f.admission.count()).toBe(0);
});

it('retains an accepted Thread mutation as Host demand until the original owner replies', async () => {
  const pending = gate();
  const f = fixture(undefined,pending.promise);
  const result = f.send();
  await f.began.promise;
  f.seal();
  expect(f.admission.count()).toBe(1);
  expect((await f.send()).status).toBe(503);
  expect(f.admission.count()).toBe(1);
  pending.resolve();
  const response = await result;
  expect(response.status).toBe(200);
  expect(response.body).toEqual({key:input.key});
  expect(f.submit).toHaveBeenCalledOnce();
  expect(f.admission.count()).toBe(0);
});

it('does not mistake a client disconnect for a settled Thread write', async () => {
  const pending = gate();
  const f = fixture(undefined,pending.promise);
  const server = f.app.listen(0,'127.0.0.1');
  await once(server,'listening');
  const controller = new AbortController();
  try {
    const result = fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/api/threads/submit`,{
      method:'POST',headers:{Authorization:'alice','Content-Type':'application/json'},body:JSON.stringify(input),signal:controller.signal,
    }).catch(error => error);
    await f.began.promise;
    f.seal(); controller.abort();
    expect(await result).toMatchObject({name:'AbortError'});
    expect(f.admission.count()).toBe(1);
    pending.resolve();
    await vi.waitFor(() => expect(f.admission.count()).toBe(0));
  } finally {
    controller.abort(); pending.resolve(); server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
