import { parseConversationContent } from '@varin/application-client';
import type { ChatAssistantMessage, ChatSessionEntry, ChatTextContent } from '@/components/conversation/types';
import type { UiCardProjection } from '@/components/conversation/ConversationContext';
export interface UiEmbedPlacement { sessionId: string; primaryKey: string; sourceEntryId: string; ref: string }
interface ParsedEmbeds { text: string; streaming: boolean; embeds: Array<{ start: number; ref: string }> }
// HistoryPresentation retains immutable text parts while new stream frames arrive.
// Cache only parsed offsets/references, not placement or tool ownership. Weak keys
// release the derived data with its message and never retain a second text history.
const parsedEmbeds = new WeakMap<ChatTextContent, ParsedEmbeds>();
function embedReferences(part: ChatTextContent, streaming: boolean) {
  const cached = parsedEmbeds.get(part);
  if (cached?.text === part.text && cached.streaming === streaming) return cached.embeds;
  const embeds = parseConversationContent(part.text, { role: 'assistant', streaming }).flatMap(fragment =>
    fragment.kind === 'ui' && fragment.node.type === 'embed' ? [{ start: fragment.start, ref: fragment.node.ref }] : []);
  parsedEmbeds.set(part, { text: part.text, streaming, embeds });
  return embeds;
}
type Pending = { key: string; ref: string; entryId: string };
type Cards = Record<string, UiCardProjection>;

function collect(entryId: string, message: ChatAssistantMessage, cards: Cards, pending: Pending[], owners: Map<string, string>) {
  message.content.forEach((part, index) => {
    if (part.type === 'toolCall') {
      const projection = cards[part.id], receipt = projection?.result?.details as { ref?: string } | undefined;
      if (receipt?.ref && !projection?.compact) owners.set(receipt.ref, part.id);
    }
    if (part.type !== 'text') return;
    for (const { start, ref } of embedReferences(part, message.stopReason === 'pending')) {
      pending.push({ key: part.id ? `${part.id}:offset:${start}` : `${entryId}:${part.contentIndex ?? index}:offset:${start}`, ref, entryId });
    }
  });
}
type Placement = { embeds: Record<string, UiEmbedPlacement>; targets: Record<string, string> };
function place(turn: string, pending: Pending[], owners: Map<string,string>, out: Placement) {
  const first = new Map<string, UiEmbedPlacement>();
  for (const item of pending) {
    const placement = first.get(item.ref) ?? { sessionId: owners.get(item.ref) ?? `embed:${turn}:${item.ref}`, primaryKey: item.key, sourceEntryId: item.entryId, ref: item.ref };
    first.set(item.ref, placement); out.embeds[item.key] = placement; out.targets[placement.sessionId] = placement.primaryKey;
  }
}
/** A projection belongs to a specific immutable committed history + card snapshot.
 * Live text only visits the active assistant. Keep placement identity when prose
 * grows around already-visible embeds, so the timeline does not rebind old cards. */
export function prepareUiEmbeds(entries: readonly ChatSessionEntry[], cards: Cards) {
  const complete: Placement = { embeds: {}, targets: {} };
  let turn = 'history', pending: Pending[] = [], owners = new Map<string,string>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    if (entry.message.role === 'user') { place(turn, pending, owners, complete); turn = entry.id; pending = []; owners = new Map(); }
    if (entry.message.role === 'assistant') collect(entry.id, entry.message, cards, pending, owners);
  }
  let previous: Placement | undefined, signature: string | undefined;
  return (live?: ChatAssistantMessage) => {
    const tail: Pending[] = [], tailOwners = new Map<string,string>();
    if (live) collect(live.id, live, cards, tail, tailOwners);
    const next = tail.length || tailOwners.size ? JSON.stringify([tail, [...tailOwners]]) : '';
    if (signature === next && previous) return previous;
    const out = { embeds: { ...complete.embeds }, targets: { ...complete.targets } };
    place(turn, pending.concat(tail), new Map([...owners, ...tailOwners]), out);
    signature = next; previous = out;
    return out;
  };
}

export function projectUiEmbeds(entries: readonly ChatSessionEntry[], cards: Cards, live?: ChatAssistantMessage) {
  return prepareUiEmbeds(entries, cards)(live);
}
