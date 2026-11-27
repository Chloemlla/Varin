import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { VARIN_CREDENTIALS_CAPABILITY, VARIN_EVENTS_CAPABILITY, type JsonValue, type VarinCredentialMetadata, type VarinCredentialValue } from '@varin/extension-contract';
import { receiverEventPage, type ReceiverPageContext } from '../extensions/event-page.js';
import { brokerFrame } from '../deployment/extension-sandbox-protocol.js';
import type { DurableEventInbox } from './event-inbox.js';

export const SANDBOX_RELAY = 'varin:supervised-sandbox';
export const RECEIVER_LEASE_MS = 30 * 60_000;

export interface SandboxReceiverLease extends ReceiverPageContext {
  scope: string;
  cursor: string | null;
  expiresAt: number | null;
  credentials?: { metadata: VarinCredentialMetadata; value: VarinCredentialValue };
}

/** In-memory authority for one receive invocation of one broker generation.
 * The Host is the only issuer. Neither a Sandbox frame nor a journal entry can
 * supply a principal, connection, account or extension identity. */
export function holdSandboxReceiver(lease: SandboxReceiverLease, journal: Pick<DurableEventInbox, 'accept'>, wake: () => void) {
  let previous: { input: unknown; output: JsonValue } | undefined;
  let work = Promise.resolve();
  let accepting = true;
  const ids = new Set<string>();
  return {
    call(params: Record<string, unknown>): Promise<JsonValue> {
      if (!accepting || lease.expiresAt !== null && Date.now() >= lease.expiresAt) {
        wake(); return Promise.reject(new Error('event_receiver_lease_expired'));
      }
      const task = work.then(async (): Promise<JsonValue> => {
        const args = params.params;
        const source = lease.identity.source;
        if (params.capability === VARIN_CREDENTIALS_CAPABILITY) {
          if (lease.expiresAt !== null && Date.now() >= lease.expiresAt) { wake(); throw new Error('event_receiver_lease_expired'); }
          if (lease.credentials && brokerFrame(args) && args.connectionId === source.connectionId && args.expectedAccount === source.accountId) {
            if (params.method === 'inspect') return lease.credentials.metadata as unknown as JsonValue;
            if (params.method === 'resolve') return lease.credentials.value as unknown as JsonValue;
          }
          throw new Error('event_receiver_credential_unavailable');
        }
        if (params.capability !== VARIN_EVENTS_CAPABILITY) { wake(); throw new Error('event_receiver_requires_host'); }
        if (params.method === 'assertReceiver' && brokerFrame(args) && !Object.keys(args).length) return null;
        if (params.method !== 'submit') throw new Error('event_receiver_method_invalid');
        if (previous && isDeepStrictEqual(previous.input, args)) return previous.output;
        const input = structuredClone(args);
        const page = receiverEventPage(lease, args as JsonValue);
        if (lease.cursor !== page.expectedCursor) throw new Error('event_receiver_cursor_changed');
        try { await journal.accept('sandbox:' + randomUUID(), page); }
        catch { wake(); throw new Error('event_inbox_unavailable'); }
        lease.cursor = page.nextCursor;
        lease.status = page.status;
        const accepted = new Set(page.events.map(event => JSON.stringify([event.eventId, event.objectId, event.revision])).filter(id => !ids.has(id)));
        for (const id of accepted) ids.add(id);
        const output = { cursor: lease.cursor, accepted: accepted.size, duplicates: page.events.length - accepted.size };
        previous = { input, output };
        wake();
        return output;
      });
      work = task.then(() => undefined, () => undefined);
      return task;
    },
    async seal() {
      accepting = false;
      await work;
      delete lease.credentials;
    },
  };
}
