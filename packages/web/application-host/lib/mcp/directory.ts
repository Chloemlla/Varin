/** Rebuildable discovery data. A directory entry never carries execution authority. */
import { createSettingsFileStore } from '@varin/settings-store';
import type { Tool, Resource, ResourceTemplate } from './client.js';
import { object } from '../models/configuration.js';
import { relocateCacheDocument } from '../deployment/derived-cache.js';

export interface McpDirectorySnapshot {
  tools: Tool[];
  resources: Resource[];
  resourceTemplates: ResourceTemplate[];
  prompts: { name: string; description?: string; arguments?: unknown[] }[];
  updatedAt: string;
}
export class McpDirectory {
  #store;
  readonly #entries = new Map<string, McpDirectorySnapshot>();
  readonly #pending = new Map<string, McpDirectorySnapshot>();
  #loading: Promise<void> | undefined;
  #writing: Promise<void> | undefined;
  readonly #migration: Promise<void> | undefined;
  constructor(path: string, readonly report: (error: unknown) => void, legacy?: string) {
    this.#store = createSettingsFileStore({ filePath: path });
    this.#migration = legacy && legacy !== path ? relocateCacheDocument(legacy, path).catch(error => {
      this.report(error);
      this.#store = createSettingsFileStore({ filePath: legacy });
    }) : undefined;
  }
  async get(key: string) {
    if (this.#migration) await this.#migration;
    this.#loading ??= this.#store.read().then(document => {
      if (!object(document.entries)) return;
      for (const [key, value] of Object.entries(document.entries)) {
        if (object(value) && Array.isArray(value.tools) && Array.isArray(value.resources) && Array.isArray(value.resourceTemplates)
          && value.tools.every(tool => object(tool) && typeof tool.name === 'string' && object(tool.inputSchema))
          && Array.isArray(value.prompts) && typeof value.updatedAt === 'string' && !this.#entries.has(key)) this.#entries.set(key, value as unknown as McpDirectorySnapshot);
      }
    }).catch(this.report);
    await this.#loading;
    const entry = this.#entries.get(key); return entry ? structuredClone(entry) : undefined;
  }
  async update(key: string, value: Partial<Omit<McpDirectorySnapshot, 'updatedAt'>>) {
    await this.get(key);
    // Merge after loading, against the latest in-memory commit. Independent directories
    // finishing in the same turn must not overwrite one another with an earlier snapshot.
    this.put(key, { tools: [], resources: [], resourceTemplates: [], prompts: [], ...this.#entries.get(key), ...value, updatedAt: new Date().toISOString() });
  }
  put(key: string, value: McpDirectorySnapshot) {
    const snapshot = structuredClone(value); this.#entries.set(key, snapshot); this.#pending.set(key, snapshot);
    this.#writing ??= Promise.resolve().then(async () => {
      if (this.#migration) await this.#migration;
      await this.#loading;
      while (this.#pending.size) {
        const batch = [...this.#pending]; this.#pending.clear();
        await this.#store.transact(document => {
          const entries = object(document.entries) ? { ...document.entries } : {};
          for (const [key, value] of batch) Object.defineProperty(entries, key, { value, configurable: true, enumerable: true, writable: true });
          return { document: { version: 1, entries }, result: undefined };
        });
      }
    }).catch(this.report).finally(() => { this.#writing = undefined; if (this.#pending.size) { const entry = this.#pending.entries().next().value!; this.put(...entry); } });
  }
  async close() {
    if (this.#migration) await this.#migration;
    while (this.#writing) await this.#writing;
  }
}
