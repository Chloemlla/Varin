import React from 'react';
import type { BotAppearance, BotSummary, ThreadIdentity } from '@varin/application-client';
import { people } from './sample';

export const identity = (id: string): ThreadIdentity => ({ runtime: 'agent', threadId: id, branchId: 'main' });
export function makeBot(id: string, name: string, appearance?: BotAppearance): BotSummary {
  const stamp = new Date().toISOString();
  return { id, name, appearance, instructions: null, model: null, coordinatorHostId: 'preview', homeDir: '', entry: identity(id),
    createdAt: stamp, updatedAt: stamp, revision: 1, archived: false };
}
export const initialBots = people.map((name, index) => makeBot(name, name, index === 0 ? { kind: 'varin', color: 'original' } :
  { kind: 'preset', character: index === 1 ? 'deepseek' : 'claude', color: 'original' }));
export const Roster = React.createContext(initialBots);
export function useRoster() {
  const bots = React.useContext(Roster);
  return { bots, display: (id: string) => bots.find(bot => bot.id === id)?.name ?? id };
}
