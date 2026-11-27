import type { FollowupEventReceiveParams, FollowupEventReceiveReceipt, FollowupEventSourceIdentity } from '@varin/protocol';

/** Accept the original source page durably, then replay it through its Catalog owner. */
export interface DurableEventInbox {
  accept(key: string, page: FollowupEventReceiveParams): Promise<unknown>;
  hasPendingEvents(): Promise<boolean>;
  replay(receive: (page: FollowupEventReceiveParams, signal?: AbortSignal) => Promise<FollowupEventReceiveReceipt>,
    signal?: AbortSignal, onBlocked?: (identity: FollowupEventSourceIdentity) => void): Promise<{ delivered: number; retained: number }>;
  onPending(wake: () => void, onError: () => void): () => void;
}
