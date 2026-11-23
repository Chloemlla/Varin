import { getDeferredSafeStorage } from './safeStorage';

const prefix = 'varin:unsent-composer:';
// Include queued writes that the backing storage cannot enumerate until they flush.
const written = new Set<string>();

export function readUnsentComposer(key: string): string | null {
  return getDeferredSafeStorage().getItem(prefix + key);
}

export function writeUnsentComposer(key: string, value: string | null): void {
  const name = prefix + key, storage = getDeferredSafeStorage();
  if (value === null) {
    written.delete(name);
    storage.removeItem(name);
  } else {
    written.add(name);
    storage.setItem(name, value);
  }
}

export function clearUnsentComposers(): void {
  const storage = getDeferredSafeStorage();
  for (let index = 0; index < storage.length; index++) {
    const name = storage.key(index);
    if (name?.startsWith(prefix)) written.add(name);
  }
  for (const key of written) storage.removeItem(key);
  written.clear();
}
