import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { ApplicationExtensionRuntime } from '@varin/extension-host';
import { createExtensionTools } from './extension-tool-owner.js';
import { createContextComposition } from './context-composition.js';
import type { KernelClient } from './kernel-client.js';

it('publishes the bundled directory on cold and warm preparation, without starting or retaining a broker', async () => {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'varin-default-tools-'));
  const starts: string[] = [];
  const runtime = await ApplicationExtensionRuntime.create({ dataDir, varinVersion: '0.9.53', brokerScript: 'not-needed',
    transportFactory: ({owner}) => { starts.push(owner.extensionId); throw new Error('No default forwarding process'); } });
  const prepare = createExtensionTools({ runtime, kernel: {} as KernelClient, currentPolicy: async () => ({ mode: 'normal', rules: [] }) });
  const context = createContextComposition(runtime);
  try {
    await runtime.start();
    const activeCounts: number[] = [];
    for (const threadId of ['first', 'first', 'fresh-thread']) {
      const thread = { threadId, branchId: 'branch', runId: 'run', source: null };
      const scope = await prepare(thread, [], new AbortController().signal);
      try {
        const prepared = scope.initial.map(entry => entry.binding.serviceId);
        expect(prepared).toContain('varin.web.search');
        expect(prepared).toContain('varin.runtime.contract');
        expect(prepared.length).toBeGreaterThan(20);
        expect(scope.initial.every(entry => entry.lease.ownerKind === 'builtin-host')).toBe(true);
        const transforms = (await context({ threadId }))!.transforms;
        expect(transforms.flatMap(t => t.sections.map(s => s.name))).toEqual(['execution-reporting']);
        activeCounts.push(prepared.length);
        expect(starts).toEqual([]);
      } finally {
        scope.close();
        for (const entry of scope.initial) entry.lease.release();
      }
    }
    expect(new Set(activeCounts).size).toBe(1);
  } finally { await runtime.stop(); await rm(dataDir, { recursive: true, force: true }); }
});

// No network request: this is the real selected built-in/confirmation/receipt boundary,
// with a controlled Catalog for the original operation and short reference.
it('sends the resolved short reference to one Host domain and preserves its receipt', async () => {
  const { retainExtensionTool } = await import('./extension-tool-owner.js');
  const { runToolDomainCall } = await import('./tool-invocation.js');
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'varin-built-in-call-'));
  const runtime = await ApplicationExtensionRuntime.create({dataDir, varinVersion: '0.9.53', brokerScript: 'must-not-start'});
  const owner = {kind: 'external' as const, identity: 'test', epoch: 'current'};
  const short = {ref: 'read:42'}, resolved = {action: 'connections'};
  const call = {operationId: 'request:tool:call', runId: 'run', callId: 'call', name: 'websearch', schemaVersion: '',
    origin: {kind: 'model_step' as const, request_id: 'request'}, arguments: short};
  let frozen: unknown = null, calls = 0;
  const kernel = {agentRuntimeRequest: async (method: string, params: {target?: unknown}) => {
    switch (method) {
      case 'runtime.model_reference.resolve': return {reference: short.ref, kind: 'read', owner: 'host.web', target: {tool: call.name, arguments: resolved}};
      case 'runtime.model_reference.target': return params.target === undefined ? frozen : frozen = params.target;
      case 'runtime.operation.inspect': return {id: call.operationId, run_id: call.runId, phase: 'running', execution_owner: owner,
        intent: {origin: call.origin, call: {call_id: call.callId, name: call.name, schema_version: call.schemaVersion, arguments: short}}};
      case 'runtime.run.inspect': return {id: call.runId, thread_id: 'thread'};
      case 'runtime.launch.inspect': return {run_id: call.runId, selection: {source: null}};
      default: throw new Error('Unexpected Catalog call: ' + method);
    }
  }} as unknown as KernelClient;
  runtime.capabilities.register('web.materials', (method, args, context) => {
    expect(method).toBe('search'); expect(args).toEqual(resolved); calls++;
    return runToolDomainCall(context, {domain: 'web', toolName: call.name, operation: 'read', arguments: args},
      async () => ({completion: {kind: 'result', outcome: 'succeeded', effect: 'none',
        content: {data: {connections: ['fixture']}, parts: []}}, executor_stopped: true}));
  });
  try {
    await runtime.start();
    const selected = await runtime.prepareService({serviceId: 'varin.web.search', version: 2, args: [], method: 'execute'});
    const retained = await retainExtensionTool({runtime, kernel, currentPolicy: async () => ({mode: 'normal', rules: [{tool: call.name, decision: 'allow'}]})}, selected);
    try {
      call.schemaVersion = retained.binding.tool.version;
      const signal = new AbortController().signal;
      await retained.lease.authorize(call, signal);
      const receipt = await retained.lease.execute(call, signal, owner);
      expect(receipt).toMatchObject({completion: {kind: 'result', outcome: 'succeeded', effect: 'none', content: {data: {connections: ['fixture']}}}, executor_stopped: true});
      expect(calls).toBe(1); expect(call.arguments).toBe(short);
      expect((await retained.lease.execute(call, signal, owner)).completion.kind).toBe('not_dispatched');
      expect(calls).toBe(1);
    } finally { retained.lease.release(); }
  } finally { await runtime.stop(); await rm(dataDir, {recursive: true, force: true}); }
});
