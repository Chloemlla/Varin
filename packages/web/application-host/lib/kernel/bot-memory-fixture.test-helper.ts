import { knowledgeStoreKeyForScope, scopeOfScopeId, threadScopeId } from '../harness/owner-scope.js';
import { createKnowledgeContextRuntime } from '../knowledge/context-runtime.js';
import { openWorkspaceKnowledge, type KnowledgeStore } from '../knowledge/store.js';
import { createBotHistory } from '../memory/bot-history.js';
import { createMemoryService } from '../memory/memory-service.js';
import type { AgentRuntimeClient } from './agent-runtime-client.js';
import { createBotMemoryOwner } from './bot-memory-owner.js';
import { createMemoryOwner } from './memory-owner.js';
import type { KernelClient } from './kernel-client.js';

export function bindFixtureMemory(kernel: KernelClient, runtime: AgentRuntimeClient, dataDir: string, hostId: string,
  context: Pick<Parameters<typeof createMemoryOwner>[0], 'personalization' | 'prepareContext'>) {
  const stores = new Map<string, Promise<KnowledgeStore>>();
  function store(scope: string) {
    let pending = stores.get(scope);
    if (!pending) {
      pending = openWorkspaceKnowledge({ dataDir, hostId, workspaceId: knowledgeStoreKeyForScope(scope), scope: scopeOfScopeId(scope), embedding: null });
      stores.set(scope, pending);
    }
    return pending;
  }
  const ownerForThread = async (id: string) => {
    const { bot_id } = await runtime.thread(id);
    if (!bot_id) throw new Error('Expected original Bot thread');
    return { scope: 'bot' as const, ownerId: bot_id };
  };
  const history = createBotHistory(runtime);
  const memory = createMemoryService({ storeForScopeId: store, userStore: () => store('user'), ownerForThread,
    threadStoreIfPresent: id => store(threadScopeId(id)), associationForThread: async id => ({ threadIds: [id] }),
    readHistorySource: async (botId, span) => (await history.read(botId, span)).text });
  const knowledge = createKnowledgeContextRuntime({ getStore: store, getUserStore: () => store('user'),
    getThreadStore: id => store(threadScopeId(id)),
    recallForThread: async ({ threadId, query }) => memory.search(await ownerForThread(threadId), query, 8, { threadId, includeShared: true }) });
  kernel.setMemoryOwner(createMemoryOwner({ ...context,
    bot: createBotMemoryOwner({ runtime, history, memory, prepareContext: context.prepareContext, knowledge: knowledge.knowledgeForThread }) }));
  return async () => { for (const pending of stores.values()) await (await pending).close(); };
}
