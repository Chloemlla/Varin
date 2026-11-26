import { create } from 'zustand';
import { threadHostKey } from '@/stores/useThreadStore';
import { emptyGroupDraft, type GroupDraft, type GroupDraftFile, type GroupQuote } from './botGroupChatModel';

type Draft = { message: GroupDraft; files: GroupDraftFile[]; quote?: GroupQuote; sending?: string; retryId?: string };
const empty: Draft = { message: emptyGroupDraft, files: [] };
const drafts = create<{ entries: Record<string, Draft> }>(() => ({ entries: {} }));

/** An unsent group message belongs to the group on its Host, including while its page is unmounted. */
export function useGroupChatDraft(id: string) {
  const key = JSON.stringify([threadHostKey(), id]);
  const value = drafts(state => state.entries[key] ?? empty);
  const read = () => drafts.getState().entries[key] ?? empty;
  function write(next: Draft) {
    drafts.setState(state => {
      const entries = { ...state.entries };
      if (next.message.text || next.files.length || next.quote || next.sending) entries[key] = next;
      else delete entries[key];
      return { entries };
    });
  }
  function edit(change: Partial<Pick<Draft, 'message' | 'files' | 'quote'>>) {
    const current = read();
    if (!current.sending) write({ ...current, ...change, retryId: undefined });
  }
  return { ...value, edit,
    begin() {
      const current = read();
      if (current.sending) return null;
      const sending = current.retryId ?? crypto.randomUUID();
      write({ ...current, sending, retryId: sending });
      return sending;
    },
    finish(id: string, sent: boolean) {
      const current = read();
      if (current.sending === id) write(sent ? empty : { ...current, sending: undefined });
    },
    clear() { write(empty); },
  };
}
