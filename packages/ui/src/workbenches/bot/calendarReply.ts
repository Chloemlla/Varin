import type { ThreadFamilyAPI, ThreadIdentity } from '@varin/application-client';
import type { FamilyReadQuery } from '@varin/protocol';
import { historyParts, type ThreadContentPart } from '@/lib/agent-runtime/thread-content';

export interface CalendarReplyItem {
  itemId: string;
  anchor: string;
  parts: ThreadContentPart[];
}

/** Read the final visible response on this Run's anchored history cut. A
 * response can have multiple items, and a tool preamble is part of the work. */
export async function readCalendarReply(api: ThreadFamilyAPI, identity: ThreadIdentity, runId: string, signal: AbortSignal): Promise<CalendarReplyItem[]> {
  const scope = { threadId: identity.threadId, branchId: identity.branchId, runId };
  const query: FamilyReadQuery = { kind: 'recent' };
  let cursor: string | undefined;
  let response: string | undefined;
  const reply: { item: CalendarReplyItem; final: boolean }[] = [];
  const finalReply = () => {
    const explicit = reply.some(part => part.final);
    return reply.filter(part => !explicit || part.final).reverse().map(part => part.item);
  };
  do {
    const page = await api.read(identity, { ...scope, query, cursor }, signal);
    for (const item of page.items.slice().reverse()) {
      if (item.runId !== runId || item.source !== 'assistant') continue;
      if (item.kind === 'tool_call') return finalReply();
      if (item.assistantPhase === 'commentary' || !['text', 'output', 'media'].includes(item.kind)) continue;
      const responseId = item.assistantResponse ?? item.id;
      if (response !== undefined && response !== responseId) return finalReply();
      let body = item.body;
      if (item.bodyTruncated) {
        const chunks = [];
        let offset: number | undefined;
        do {
          const original = await api.item(identity, { ...scope, anchor: page.anchor, itemId: item.id, offset }, signal);
          chunks.push(original.text);
          offset = original.nextOffset ?? undefined;
        } while (offset !== undefined);
        body = JSON.parse(chunks.join(''));
      }
      const parts = historyParts(body, item.source).filter(part => part.kind === 'text' ? part.text.trim() : part.kind === 'output' ? part.output.parts.length : part.kind === 'media');
      if (!parts.length) continue;
      response = responseId;
      reply.push({ item: { itemId: item.id, anchor: page.anchor, parts }, final: item.assistantPhase === 'final_answer' });
    }
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  return finalReply();
}
