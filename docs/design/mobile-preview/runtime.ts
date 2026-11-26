import { createWebAPIs } from '@web/api';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import type { BotMemoryItem, BotMemoryMaintenance, BotsAPI } from '@varin/application-client';

// Supply local data through the same API the production memory pane consumes.
const seed: BotMemoryItem = { id: 1, content: '合作演示先用手机连桌面，再演示群聊分工。', trigger: '', sourceKind: null, createdAt: Date.now(), revision: '1' };
type Shelf = { items: BotMemoryItem[]; history: Record<number, BotMemoryItem[]> };
const key = (bot: string, owner: unknown) => 'design.memory.' + JSON.stringify([owner === 'user' ? null : bot, owner ?? 'bot']);
function read(bot: string, owner: unknown): Shelf {
  return JSON.parse(sessionStorage.getItem(key(bot, owner)) ?? 'null') ?? {
    items: bot === '薇琳' && (!owner || owner === 'bot') ? [seed] : [], history: {},
  };
}
const jobs = new Map<string, BotMemoryMaintenance>();
const memory: BotsAPI['memory'] = {
  async list(bot, _signal, inactive, owner) { return read(bot, owner).items.filter(i => inactive || !i.inactive); },
  async history(bot, id, _signal, owner) { return read(bot, owner).history[id] ?? []; },
  async source() { return []; },
  async update(bot, item, action, content, owner) {
    const shelf = read(bot, owner);
    (shelf.history[item.id] ??= []).unshift(item);
    shelf.items = shelf.items.map(i => i.id === item.id ? { ...i, content: content ?? i.content, inactive: action !== 'correct', revision: crypto.randomUUID() } : i);
    sessionStorage.setItem(key(bot, owner), JSON.stringify(shelf));
  },
  async restore(bot, current, previous, owner) { await memory.update(bot, current, 'correct', previous.content, owner); },
  async clearHistory(bot, ids, owner) {
    const shelf = read(bot, owner);
    ids.forEach(id => delete shelf.history[id]);
    sessionStorage.setItem(key(bot, owner), JSON.stringify(shelf));
  },
  async organize(bot, input) {
    const job = { key: crypto.randomUUID(), status: 'reviewed-empty' as const, updatedAt: Date.now(),
      maintenance: { mode: 'selection' as const, ids: input.ids ?? [], reason: input.reason ?? '', cancelled: false } };
    jobs.set(bot, job); return job;
  },
  async maintenance(bot) { const job = jobs.get(bot); return job ? [job] : []; },
};
export const previewRuntime = createWebAPIs();
previewRuntime.bots!.memory = memory;
registerRuntimeAPIs(previewRuntime);
