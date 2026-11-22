import { expect, it, vi } from 'vitest';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import type { ExistingHostCredentialOwner } from './credential-owner.js';
import type { ColdBotWork } from './protocol.generated.js';
import { ThreadAdapter, type ThreadModelAuthority } from './thread-adapter.js';
import type { ContextPreparer } from './thread-context.js';

it.each([false, true])('prepares cold work using the receiving conversation location (Bot: %s)', async bot => {
  const work: ColdBotWork = { ...(bot ? { botId: 'receiver' } : {}), threadId: 'thread:receiver', branchId: 'branch:receiver', inputId: 'input:request', revision: 1, ownerEpoch: 1 };
  const receivingIdentity = { runtime: 'agent', threadId: work.threadId, branchId: work.branchId };
  const configuration = { providerId: 'local-model' } as Awaited<ReturnType<ThreadModelAuthority['resolveModel']>>['configuration'];
  const credentialScope = { reference: 'scope', authority: 'fixture', account: 'receiver', generation: 1 };
  const release = vi.fn();
  const credentialOwner = { scope: vi.fn(async () => credentialScope), release } as unknown as ExistingHostCredentialOwner;
  const runtime = {
    pendingBotWork: vi.fn(async () => [work]),
    thread: vi.fn(async () => ({ principal_id: 'receiver', branches: [{ branch_id: work.branchId, workspace_default: null }] })),
    principalCanUseHostResources: vi.fn(async () => bot),
    admitBotWork: vi.fn(async () => ({ run_id: 'run:receiver' })),
  };
  const initial = { effectiveSystemPrompt: 'receiver context', instructionSources: [], memoryCheckpoint: 'checkpoint' };
  const main = vi.fn(async () => initial);
  const prepareContext = Object.assign(vi.fn(async () => initial), { main }) as ContextPreparer;
  const admitSource = vi.fn();
  const onError = vi.fn();
  const models = { resolveModel: vi.fn(async () => ({ configuration, credentialOwner })), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, admitSource, onError, undefined, prepareContext);
  const source = { resourceOwner: { kind: 'local' as const }, mode: 'live_root' as const, workspaceId: 'workspace', executionWorkspaceId: 'workspace',
    tools: ['file_read', 'process_spawn'], liveRoot: { hostId: 'host', rootId: 'root', canonicalRoot: '/workspaces' } };
  const defaultSource = vi.fn(async () => source);
  adapter.bindDefaultDeviceSource(defaultSource);
  adapter.bindConversationWorkModel(async () => ({ providerId: 'receiver-provider', modelId: 'receiver-model' }));
  adapter.bindBotWorkModel(async () => ({ providerId: 'bot-provider', modelId: 'bot-model' }));
  const launch = vi.spyOn(adapter, 'continueLaunch').mockResolvedValue(undefined);
  const { signal } = new AbortController();

  await adapter.recoverBotWork(signal);
  await vi.waitFor(() => expect(launch).toHaveBeenCalledWith('run:receiver', { credentialOwner, signal }));

  expect(runtime.principalCanUseHostResources).toHaveBeenCalledWith('receiver');
  if (bot) {
    expect(defaultSource).toHaveBeenCalledOnce();
    expect(prepareContext).toHaveBeenCalledWith(receivingIdentity, source, { mode: 'bot', threadRole: 'main', projectId: 'bot:receiver' }, signal);
    expect(admitSource).toHaveBeenCalledWith(source, receivingIdentity, undefined, signal);
  } else {
    expect(defaultSource).not.toHaveBeenCalled();
    expect(admitSource).not.toHaveBeenCalled();
    expect(main).toHaveBeenCalledWith(receivingIdentity, null, signal);
  }
  expect(runtime.admitBotWork).toHaveBeenCalledExactlyOnceWith({
    work, configuration, initialContext: initial,
    launch: { inheritSource: false, source: bot ? expect.objectContaining({ workspaceId: source.workspaceId, liveRoot: source.liveRoot }) : null,
      enabledTools: bot ? source.tools : [], credentialScope },
  }, signal);
  expect(release).toHaveBeenCalledOnce();
  expect(onError).not.toHaveBeenCalled();
});

it('reads the saved model and thinking for a cold Bot wake with no composer attached', async () => {
  const work: ColdBotWork = { botId: 'bot', threadId: 'thread:receiver', branchId: 'branch:receiver', inputId: 'input:wake', revision: 1, ownerEpoch: 1 };
  const preference = { providerId: 'chosen', modelId: 'sol', thinkingLevel: 'high' as const };
  const runtime = {
    pendingBotWork: async () => [work], holdColdWork: vi.fn(),
    thread: async () => ({ model_preference: preference, branches: [{ branch_id: work.branchId }] }),
  };
  const models = { resolveModel: vi.fn().mockRejectedValue(new Error('test provider offline')), rebindModel: vi.fn() };
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, vi.fn(), vi.fn(), undefined, vi.fn() as unknown as ContextPreparer);
  adapter.bindBotWorkModel(async (_id, _signal, choice) => choice ?? { providerId: 'default', modelId: 'other' });
  await adapter.recoverBotWork(new AbortController().signal);
  await vi.waitFor(() => expect(runtime.holdColdWork).toHaveBeenCalledOnce());
  expect(models.resolveModel).toHaveBeenCalledExactlyOnceWith(preference);
});

it('keeps a cold request queued when no receiving model is available', async () => {
  const work: ColdBotWork = { threadId: 'thread:receiver', branchId: 'branch:receiver', inputId: 'input:request', revision: 5, ownerEpoch: 1 };
  const runtime = {
    pendingBotWork: vi.fn(async () => [work]),
    holdColdWork: vi.fn(async () => null),
    admitBotWork: vi.fn(),
  };
  const models = { resolveModel: vi.fn(), rebindModel: vi.fn() };
  const prepareContext = vi.fn() as unknown as ContextPreparer;
  const onError = vi.fn();
  const adapter = new ThreadAdapter(runtime as unknown as AgentRuntimeClient, models, vi.fn(), onError, undefined, prepareContext);
  adapter.bindConversationWorkModel(async () => null);
  const { signal } = new AbortController();

  await adapter.recoverBotWork(signal);
  await vi.waitFor(() => expect(runtime.holdColdWork).toHaveBeenCalledExactlyOnceWith({
    inputId: work.inputId, revision: work.revision, reason: 'model_unavailable',
  }, signal));
  expect(runtime.admitBotWork).not.toHaveBeenCalled();
  expect(models.resolveModel).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
});
