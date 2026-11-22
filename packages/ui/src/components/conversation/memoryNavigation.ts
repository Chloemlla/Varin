import React from 'react';
import type { BotMemoryOwner } from '@varin/application-client';

export function memoryFocusId(owner: BotMemoryOwner, id: number): string {
  if (typeof owner === 'object') return 'session:' + owner.threadId + ':' + id;
  return owner === 'user' ? 'user:' + id : String(id);
}
export function memoryFocusTarget(key?: string): { owner: BotMemoryOwner; id: number } | undefined {
  if (!key) return;
  const parts = key.split(':');
  const id = Number(parts.at(-1));
  if (!Number.isSafeInteger(id) || id <= 0) return;
  if (parts.length === 1) return { owner: 'bot', id };
  if (parts.length === 2 && parts[0] === 'user') return { owner: 'user', id };
  if (parts.length >= 3 && parts[0] === 'session') {
    const threadId = parts.slice(1, -1).join(':');
    if (threadId) return { owner: { threadId }, id };
  }
}

/**
 * Where a memory written in the conversation can be looked at. The Bot workbench provides this
 * to open its memory tab on the written item (docs/design/bot-ui.md §4); elsewhere it is absent.
 */
export interface MemoryNavigation {
  /** `id` is the memory row when the receipt names one. */
  open(id: string | null): void;
  label: string;
}

export const MemoryNavigationContext = React.createContext<MemoryNavigation | null>(null);
