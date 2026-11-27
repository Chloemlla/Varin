import { parseVarinEventBatch, type JsonValue } from '@varin/extension-contract';
import type { FollowupEventReceiveParams, FollowupEventSourceIdentity, FollowupEventSourceStatus } from '@varin/protocol';
import { compileToolJsonSchema } from '../models/schema.js';

export interface ReceiverPageContext {
  identity: FollowupEventSourceIdentity;
  hostId: string;
  recovery: 'realtime' | 'history';
  schema: Parameters<typeof compileToolJsonSchema>[0];
  status: FollowupEventSourceStatus | null;
}

/** Both live and parked receivers admit the same extension event contract. */
export function receiverEventPage(context: ReceiverPageContext, raw: JsonValue): FollowupEventReceiveParams {
  const batch = parseVarinEventBatch(raw);
  const validate = compileToolJsonSchema(context.schema);
  if (batch.events.some(event => !validate(event.attributes))) throw new Error('event_attributes_invalid');
  const now = Date.now();
  const coverage = context.recovery === 'realtime'
    ? { kind: 'from' as const, fromMs: Math.max(context.status?.coverage?.fromMs ?? now, batch.coverage?.fromMs ?? 0) }
    : batch.coverage ? { kind: batch.coverage.kind, fromMs: batch.coverage.fromMs ?? null } : context.status?.coverage ?? null;
  return {
    identity: context.identity, expectedCursor: batch.expectedCursor, nextCursor: batch.nextCursor,
    status: { code: null, message: null, coverage, lastConnectedAtMs: context.status?.lastConnectedAtMs ?? now },
    events: batch.events.map(event => ({
      ...event, objectId: event.objectId ?? null, senderId: event.senderId ?? null, revision: event.revision ?? null, files: event.files ?? [],
      echoOf: event.echoOf ? { ...event.echoOf, ownerHostId: event.echoOf.ownerHostId === context.hostId ? null : event.echoOf.ownerHostId ?? null } : null,
    })),
  };
}
