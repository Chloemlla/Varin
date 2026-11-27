import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders } from 'node:http';
import { parseAttachmentSelections } from '@varin/protocol';
import { parseContentReferenceInput, type ContentReferenceInput, type ThreadInboxRejection } from '@varin/application-client';
import { FULL_CONTROL_CAPABILITIES } from '../client-auth/remote-clients.js';
import { parseClientTime } from '../kernel/thread-message-time.js';
import { parseThreadMaterials } from '../kernel/thread-material-input.js';
import { inboxMethod, INBOX_ACTOR_HEADER, INBOX_RECONCILE_PATH, INBOX_REPLAY_HEADER, type InboxActor } from './user-inbox-wire.js';

/** A rejected request can contain invalid fields. Preserve the draft's
 * independently valid values using the same readers as ordinary admission. */
export function rejectedInboxDraft(input: Record<string, unknown>): NonNullable<ThreadInboxRejection['draft']> {
  const text = typeof input.text === 'string' ? input.text : '';
  function read<T>(value: () => T): T | undefined { try { return value(); } catch { return undefined; } }
  const materials = read(() => parseThreadMaterials(input.materials));
  const attachments = read(() => parseAttachmentSelections(input.attachments));
  const clientTime = read(() => parseClientTime(input.clientTime));
  return { text, ...(materials && { materials }), ...(attachments && { attachments }), ...(clientTime && { clientTime }),
    ...read(() => parseContentReferenceInput(input as ContentReferenceInput, text)) };
}

export async function requestInboxReplayProof(): Promise<string> {
  const nonce = randomUUID();
  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timeout);
      process.off('message', receive);
      process.off('disconnect', disconnected);
    };
    const disconnected = () => { cleanup(); reject(new Error('Supervisor disconnected during inbox bootstrap')); };
    const receive = (message: unknown) => {
      if (!message || typeof message !== 'object' || !('nonce' in message) || message.nonce !== nonce ||
          !('proof' in message) || typeof message.proof !== 'string') return;
      cleanup();
      resolve(message.proof);
    };
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Supervisor inbox credential request timed out'));
    }, 5000);
    process.on('message', receive);
    process.once('disconnect', disconnected);
    process.send!({ type: 'varin:inbox-proof', nonce }, error => { if (error) disconnected(); });
  });
}

export function createInboxReplayAuth(replayProof: string, isOwner: (principal: string) => Promise<boolean>) {
  const proof = Buffer.from(replayProof);
  return async (req: { method?: string | undefined; originalUrl?: string | undefined; url?: string | undefined;
    headers: IncomingHttpHeaders; socket?: { remoteAddress: string | undefined } }): Promise<{
    ok: true; principalId: string; clientId: string; client: import('../client-auth/request-context.js').VarinAuthenticatedClient;
  } | null> => {
    const presented = req.headers[INBOX_REPLAY_HEADER];
    const address = req.socket?.remoteAddress;
    if (typeof presented !== 'string' || Buffer.byteLength(presented) !== proof.byteLength
      || !timingSafeEqual(Buffer.from(presented), proof) || address !== '127.0.0.1' || req.method !== 'POST') return null;
    const route = (req.originalUrl ?? req.url)?.split('?', 1)[0];
    if (!route || route !== INBOX_RECONCILE_PATH && !inboxMethod(route)) return null;
    const header = req.headers[INBOX_ACTOR_HEADER];
    if (typeof header !== 'string') return null;
    let actor: InboxActor;
    try { actor = JSON.parse(header); } catch { return null; }
    if (!actor || typeof actor.principalId !== 'string' || typeof actor.clientId !== 'string' || !await isOwner(actor.principalId)) return null;
    return { ok: true, ...actor, client: { id: actor.clientId, principalId: actor.principalId, authMethod: 'offline',
      capabilities: [...FULL_CONTROL_CAPABILITIES], profile: 'full-control' } };
  };
}
