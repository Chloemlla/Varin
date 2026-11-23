import { getSafeSessionStorage } from '@/stores/utils/safeStorage';

/** Store only manually opened turn IDs, scoped to this window and conversation. */
export function completedWorkDisclosure(session: string) {
  const storage = getSafeSessionStorage();
  const key = `varin.work-disclosure:${session}`;
  let opened = new Set<string>();
  const raw = storage.getItem(key);
  if (raw) {
    try {
      const ids: unknown = JSON.parse(raw);
      if (Array.isArray(ids)) opened = new Set(ids.filter((id): id is string => typeof id === 'string'));
    } catch { storage.removeItem(key); }
  }
  return {
    isOpen: (id: string) => opened.has(id),
    setOpen(id: string, open: boolean) {
      if (open) opened.add(id); else opened.delete(id);
      if (opened.size) storage.setItem(key, JSON.stringify([...opened]));
      else storage.removeItem(key);
    },
  };
}
