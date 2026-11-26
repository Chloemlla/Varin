import { describe, expect, it, vi } from 'vitest';
import type { ThreadLocationDirectory } from '@varin/application-client';
import { createModelWorkLocations } from './model-work-locations.js';
import { resourceSource } from './thread-context.js';
import type { SourceToolBinding } from './protocol.generated.js';

const owner = {kind:'managed_host' as const, hostId:'original-host', connectionId:'original-peer', endpointIdentity:'private-endpoint-fingerprint'};
const local = {kind:'local' as const};
const root = {hostId:owner.hostId, rootId:'registered-root',canonicalRoot:'/logs'};
const source = {resourceOwner:owner,mode:'live_root' as const,workspaceId:'logs',executionWorkspaceId:'logs',liveRoot:root,tools:['file_read','file_write']};
const q = {runId:'run',threadId:'thread',callId:'read',origin:{kind:'model_step',request_id:'req'}};
const signal = new AbortController().signal;
const discovery = {...q,kind:'work_locations'};
const operationId = 'req:tool:read';
const selection = {...q,operationId,kind:'work_location_bind',tool:'file_read'};
function fixture(captureLocationContext?: Parameters<typeof createModelWorkLocations>[0]['captureLocationContext']) {
  const row = {id:'favorite',name:'Logs',path:'/logs',workspaceId:'logs',resourceOwner:owner};
  const workspace = {locations:[row] as ThreadLocationDirectory['locations'], projects: [] as ThreadLocationDirectory['locations']};
  const targets = [{resourceOwner:owner,label:'https://private.example/?token=secret',capabilities:['sources','work-location-read']}];
  const bound = {source:{...resourceSource(source),environment_run_id:null},physicalRoot:root,capabilities:{tools:[{name:'file_read'}],grantCapabilities:['storage.read']},
    authorityId:'read-only',resourceEpoch:'epoch',executionOwner:{kind:'external',epoch:'epoch',identity:'target-private'}};
  const client = {bind:vi.fn(async()=>bound),release:vi.fn(async()=>({phase:'retired'})),inspectScope:vi.fn(async()=>[])};
  const principalCanUseHostResources = vi.fn(async()=>true);
  const run = {id:'run',thread_id:'thread',branch_id:'branch',state:'executing',cancel_requested:false,principal_id:'principal',epoch:1};
  const thread = {parent_thread_id:null as string|null,principal_id:'principal'};
  const launch = {run_id:'run',selection:{source:{mode:'live_root'},tools:[{name:'file_read'}],extension_bindings:[]}};
  const runtime = {run:vi.fn(async(_id:string)=>run),thread:vi.fn(async()=>thread),launch:vi.fn(async(_id:string)=>launch),
    childExecutionForRun:vi.fn(async(_id:string):Promise<unknown>=>null),operation:vi.fn(async(_id:string):Promise<unknown>=>null),
    principalCanUseHostResources,managedSource:vi.fn(async()=>client),coordinatorHostId:'coordinator'};
  const directory = {list:vi.fn(async()=>({workspace,targets,unavailable:[]})),describe:vi.fn(async()=>({workspace,targets,unavailable:[]})),
    resolve:vi.fn(async()=>({resourceOwner:owner,path:'/logs',workspaceId:'logs'}))};
  const prepare = vi.fn(async()=>({source,path:'/logs'}));
  const kernel = {issueGrant:vi.fn(),scoped:vi.fn(),retireGrant:vi.fn()};
  const work = createModelWorkLocations({runtime,kernel,directory,prepare,captureLocationContext} as unknown as Parameters<typeof createModelWorkLocations>[0]);
  const discover = async () => (await work.query(discovery,signal) as {locations:{key?:unknown;name:string;device:string;path:string;unavailable?:string}[]}).locations[0]!;
  return {runtime,client,principalCanUseHostResources,run,thread,launch,workspace,targets,row,directory,work,discover,prepare,kernel};
}

describe('model location admission',()=>{
  it('resolves unbookmarked directories and projects on their own device before choosing the next default', async () => {
    const f = fixture();
    f.targets[0]!.label = 'Test machine';
    f.workspace.projects.push({ ...f.row, id: 'project:build', name: 'Build project' });
    const projects = await f.work.query({ ...discovery, query: 'Build project' }, signal) as { locations: Array<{ name: string; key: unknown }> };
    expect(projects.locations).toMatchObject([{ name: 'Build project' }]);
    const resolved = await f.work.query({ ...discovery, device: owner, path: '/logs' }, signal) as { locations: Array<{ key: unknown }> };
    expect(resolved.locations).toMatchObject([{ path: '/logs', device: 'Test machine', key: { workspaceId: 'logs' } }]);
    const prepared = await f.work.query({ ...selection, kind: 'work_location_switch', key: resolved.locations[0]!.key }, signal);
    expect(f.directory.resolve).toHaveBeenLastCalledWith({ resourceOwner: owner, path: '/logs' }, signal);
    expect(prepared).toMatchObject({ source: { resource_owner: owner, workspace_id: 'logs' }, device: 'Test machine' });
    expect(f.client.bind).not.toHaveBeenCalled();
    expect(f.launch.selection.source).toEqual({ mode: 'live_root' });
  });
  it('discovers safe labels and borrows exactly one target read, never the launch source',async()=>{
    const f=fixture();
    const row=await f.discover();
    expect(row.device).toBe('Managed Host');
    expect(row.name).toBe('Logs');
    expect(f.client.bind).not.toHaveBeenCalled();
    expect(f.directory.describe).toHaveBeenCalledOnce();
    expect(f.directory.list).not.toHaveBeenCalled();
    expect(f.directory.resolve).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
    const binding=await f.work.query({...selection,key:row.key},signal) as SourceToolBinding;
    expect(binding.enabledTools).toEqual(['file_read']);
    expect(binding.resourceOwner).toEqual(owner);
    expect(f.client.bind).toHaveBeenCalledWith({coordinatorHostId:'coordinator',scope:{kind:'run',threadId:'thread',runId:'run',epoch:1},
      operationId,retention:'caller',purpose:'work_location_read',source:{...source,tools:['file_read']}});
    expect(f.kernel.issueGrant).not.toHaveBeenCalled();
    await expect(f.work.query({...q,operationId,kind:'work_location_release',binding:{...binding,grantId:'primary'}},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    await f.work.query({...q,operationId,kind:'work_location_release',binding},signal);
    expect(f.client.release).toHaveBeenCalledWith({coordinatorHostId:'coordinator',authorityId:'read-only',resourceEpoch:'epoch',mode:'retire'});
    await f.work.releaseRun('run'); expect(f.client.release).toHaveBeenCalledTimes(1);
    expect(f.launch.selection.source).toEqual({mode:'live_root'});
  });
  it('probes configured devices only on an explicit refresh',async()=>{
    const f=fixture();
    await f.work.query({...discovery,refresh:true},signal);
    expect(f.directory.list).toHaveBeenCalledOnce();
    expect(f.directory.describe).not.toHaveBeenCalled();
    expect(f.directory.resolve).not.toHaveBeenCalled();
    expect(f.prepare).not.toHaveBeenCalled();
  });
  it('keeps an unregistered saved path dormant until a selected operation resolves it',async()=>{
    const f=fixture();
    f.workspace.locations=[{id:'new',name:'Saved path',resourceOwner:owner,path:'/logs'}];
    const row=await f.discover();
    expect(row.key).toEqual({id:'new',resourceOwner:owner,path:'/logs'});
    expect(f.directory.resolve).not.toHaveBeenCalled();
    await f.work.query({...selection,key:row.key},signal);
    expect(f.directory.resolve).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
  });
  it('uses the durable lazy default without probing the directory, and rejects a substituted key',async()=>{
    const f=fixture();
    Object.assign(f.launch.selection,{source:null,lazy_work_location:{resource_owner:owner,path:'/logs',workspace_id:'logs'}});
    await expect(f.work.query({...selection,default:true,key:{id:'favorite'}},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    expect(f.directory.resolve).not.toHaveBeenCalled();
    const binding=await f.work.query({...selection,default:true},signal);
    expect(binding).toMatchObject({workspaceId:'logs',resourceOwner:owner});
    expect(f.directory.list).not.toHaveBeenCalled();
    expect(f.directory.resolve).toHaveBeenCalledWith({resourceOwner:owner,path:'/logs'},signal);
  });
  it('publishes new default-directory instructions without issuing a grant until the matching revision is reissued',async()=>{
    let content = 'Check the deployed version before editing.';
    const reference = {domainId:'project',viewId:'snapshot',path:'AGENTS.md',canonicalId:'/logs/AGENTS.md',version:'v1'};
    const capture = vi.fn(async(_run:unknown,_source:unknown,_signal:AbortSignal,_directories:string[])=>({system:null,appendSystem:null,
      instructions:[],instructionScopes:[{directory:'src',instructions:[{origin:'project',kind:'project-instruction',appliesTo:'src',reference}]}],
      capturedFiles:[{reference,content}]}));
    const f = fixture(capture as unknown as Parameters<typeof createModelWorkLocations>[0]['captureLocationContext']);
    Object.assign(f.launch.selection,{source:null,lazy_work_location:{resource_owner:owner,path:'/logs'}});
    const request = {...selection,default:true,instructionDirectories:['src','src']};
    const offered = await f.work.query(request,signal) as {kind:string;instructions:string;revision:string};
    expect(offered).toMatchObject({kind:'work_location_context_required'});
    expect(offered.instructions).toContain(content);
    expect(capture).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.any(AbortSignal),['src']);
    expect(f.client.bind).not.toHaveBeenCalled();
    await expect(f.work.query({...request,instructionDirectories:['../outside']},signal)).rejects.toThrow();
    content = 'Check deployment and permissions first.';
    const updated = await f.work.query({...request,resourceContext:offered.revision},signal) as typeof offered;
    expect(updated.revision).not.toEqual(offered.revision);
    expect(updated.instructions).toContain(content);
    expect(f.client.bind).not.toHaveBeenCalled();
    expect(await f.work.query({...request,resourceContext:updated.revision},signal)).toMatchObject({grantId:'read-only'});
  });
  it('borrows only the recorded default of the exact native child dispatch and rejects changed lineage before resolution',async()=>{
    const f=fixture();
    const lazy = {resource_owner:owner,path:'/logs',workspace_id:'logs'};
    Object.assign(f.launch.selection,{source:null,lazy_work_location:lazy});
    f.thread.parent_thread_id='parent-thread';
    const parent={...f.run,id:'parent-run',thread_id:'parent-thread',branch_id:'parent-branch'};
    f.runtime.run.mockImplementation(async id=>id==='parent-run' ? parent : f.run);
    f.runtime.launch.mockImplementation(async id=>id==='parent-run' ? {...f.launch,run_id:id} : f.launch);
    const child={
      trigger:{kind:'dispatch'},child_operation_id:'parent-dispatch',parent_run_id:parent.id,parent_thread_id:parent.thread_id,parent_branch_id:parent.branch_id,
      child_thread_id:f.run.thread_id,child_branch_id:f.run.branch_id,receipt:{run_id:f.run.id},report:null,cancel_requested:false,resources_released:false,
      source:{kind:'absent'},launch:f.launch.selection,
    };
    f.runtime.childExecutionForRun.mockResolvedValue(child);
    f.runtime.operation.mockResolvedValue({id:'parent-dispatch',run_id:parent.id,cancel_requested:false});
    await expect(f.work.query({...selection,key:{id:'favorite'}},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    await expect(f.work.query({...selection,default:true,toolVersion:'3'},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    child.parent_branch_id='different-branch';
    await expect(f.work.query({...selection,default:true,toolVersion:'4'},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    expect(f.directory.resolve).not.toHaveBeenCalled();
    child.parent_branch_id=parent.branch_id;
    expect(await f.work.query({...selection,default:true,toolVersion:'4'},signal)).toMatchObject({grantId:'read-only',resourceOwner:owner});
    expect(f.directory.resolve).toHaveBeenCalledOnce();
  });
  it('rejects changed, removed, offline and newly same-named targets; never resolves a path on the coordinator',async()=>{
    const f=fixture(); const {key}=await f.discover();
    f.row.resourceOwner={...owner,endpointIdentity:'replacement'};
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_changed'});
    f.row.resourceOwner=owner; f.targets.length=0;
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_unavailable'});
    expect(await f.discover()).not.toHaveProperty('key');
    f.workspace.locations=[];
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_changed'});
    expect(f.prepare).not.toHaveBeenCalled(); expect(f.runtime.managedSource).not.toHaveBeenCalled();
  });
  it('denies guests, child tasks, non-model calls, isolated launches and disallowed tools before any discovery',async()=>{
    const f=fixture();
    for(const origin of [{kind:'driver'},{kind:'nested_call'},{kind:'policy_action'}]) {
      await expect(f.work.query({...discovery,origin},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    }
    f.principalCanUseHostResources.mockResolvedValueOnce(false);
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    f.thread.parent_thread_id='parent';
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    f.thread.parent_thread_id=null; f.launch.selection.source.mode='materialized';
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    f.launch.selection.source.mode='live_root'; f.launch.selection.tools=[];
    await expect(f.discover()).rejects.toMatchObject({code:'source_authority_denied'});
    expect(f.directory.list).not.toHaveBeenCalled();
  });
  it('fails closed on old nodes, forged locators, and stale registrations',async()=>{
    const f=fixture(); const {key}=await f.discover();
    f.targets[0]!.capabilities=['sources'];
    expect(await f.discover()).toMatchObject({unavailable:'Original Host requires an update'});
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_unavailable'});
    f.targets[0]!.capabilities.push('work-location-read');
    for (const bad of [{...selection,tool:'file_write',key},{...selection,operationId:'other',key},
      {...selection,key:{...f.row,resourceOwner:local}},{...selection,key:{...f.row,path:'/other'}}]) await expect(f.work.query(bad,signal)).rejects.toThrow();
    f.directory.resolve.mockResolvedValueOnce({resourceOwner:owner,path:'/logs',workspaceId:'changed'});
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_changed'});
    expect(f.client.bind).not.toHaveBeenCalled();
  });
  it('retires the exact authority when cancellation overtakes remote bind',async()=>{
    const f=fixture();const {key}=await f.discover();
    const bound=await f.client.bind(); f.client.bind.mockImplementationOnce(async()=>{f.run.cancel_requested=true;return bound;});
    await expect(f.work.query({...selection,key},signal)).rejects.toMatchObject({code:'source_authority_denied'});
    expect(f.client.release).toHaveBeenCalledWith({coordinatorHostId:'coordinator',authorityId:'read-only',resourceEpoch:'epoch',mode:'retire'});
  });
  it('shares live-root preparation but not the admitted tool grant when a waiter cancels',async()=>{
    const f=fixture(); const {key}=await f.discover();
    let finish!:()=>void;
    const held = new Promise<void>(resolve=>{finish=resolve;});
    f.prepare.mockImplementationOnce(async()=>{await held; return {source,path:'/logs'};});
    const first=new AbortController(), second=new AbortController();
    const firstCall=f.work.query({...selection,key},first.signal);
    const firstResult=firstCall.catch(error=>error);
    const otherOperation='req:tool:other';
    const other=f.work.query({...selection,callId:'other',operationId:otherOperation,key},second.signal);
    await vi.waitFor(()=>expect(f.directory.resolve).toHaveBeenCalledTimes(2));
    expect(f.prepare).toHaveBeenCalledOnce();
    first.abort();
    expect(await firstResult).toMatchObject({name:'AbortError'});
    finish();
    await expect(other).resolves.toMatchObject({grantId:'read-only'});
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.client.bind).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({operationId:otherOperation}));
  });
});

it('prepares only the dormant script Operation’s recorded local default; returns changed instructions before any grant', async () => {
  let instructions = 'Use the original project source';
  const ref = {domainId:'project',viewId:'snapshot',path:'AGENTS.md',canonicalId:'/logs/AGENTS.md',version:'v1'};
  const capture = vi.fn(async () => ({system:null,appendSystem:null,instructions:[{origin:'project',kind:'project-instruction',appliesTo:'src',reference:ref}],capturedFiles:[{reference:ref,content:instructions}]}));
  const f = fixture(capture as unknown as Parameters<typeof createModelWorkLocations>[0]['captureLocationContext']);
  Object.assign(f.launch.selection, {source:null,lazy_work_location:{resource_owner:local,path:'/logs',workspace_id:'logs'},
    extension_bindings:[{extensionId:'varin.builtin.scripts',serviceId:'varin.script.open',configurationIdentity:'deferred-local-script-v1',tool:{name:'script_open'}}]});
  f.directory.resolve.mockResolvedValue({resourceOwner:local as never,workspaceId:'logs',path:'/logs'});
  const live = {...source,resourceOwner:local,liveRoot:{...root,hostId:'local-owner'},tools:['file_read','process_spawn']};
  f.prepare.mockResolvedValue({source:live as never,path:'/logs'});
  const executorOwner = {kind:'external' as const,identity:'script',epoch:'epoch'};
  const op = {id:'req:tool:script',run_id:'run',phase:'running',executor:'script_open',execution_owner:executorOwner};
  f.runtime.operation.mockResolvedValue(op);
  const authority = {runId:'run',threadId:'thread',operationId:op.id,invocationId:'invocation',callId:'script',
    origin:{kind:'model_step' as const,request_id:'req'},source:null,executorOwner,
    operation:'effect' as const,completion:'job' as const,toolName:'script_open',configurationIdentity:'deferred-local-script-v1',arguments:{cwd:'src'}};
  const first = await f.work.prepareScriptDefault(authority,undefined,signal);
  expect(first).toMatchObject({kind:'work_location_context_required'});
  if (first.kind !== 'work_location_context_required') throw new Error('Expected context');
  expect(first.instructions).toContain(instructions);
  expect(capture).toHaveBeenCalledWith(expect.anything(),expect.anything(),expect.anything(),['src']);
  instructions = 'Use the new project instructions';
  const next = await f.work.prepareScriptDefault(authority,first.revision,signal);
  expect(next).toMatchObject({kind:'work_location_context_required'});
  if (next.kind !== 'work_location_context_required') throw new Error('Expected revision');
  expect(next.revision).not.toBe(first.revision);
  expect(await f.work.prepareScriptDefault(authority,next.revision,signal)).toEqual({kind:'source',source:resourceSource(live)});
  expect(f.kernel.issueGrant).not.toHaveBeenCalled();
  expect(f.client.bind).not.toHaveBeenCalled();
  f.directory.resolve.mockResolvedValueOnce({resourceOwner:local as never,workspaceId:'logs',path:'/symlink-target'});
  await expect(f.work.prepareScriptDefault(authority,next.revision,signal)).rejects.toMatchObject({code:'source_changed'});
  f.runtime.operation.mockResolvedValue({...op,execution_owner:{...executorOwner,epoch:'stale'}});
  const probes = f.directory.resolve.mock.calls.length;
  await expect(f.work.prepareScriptDefault(authority,next.revision,signal)).rejects.toMatchObject({code:'source_authority_denied'});
  expect(f.directory.resolve.mock.calls.length).toBe(probes);
});
