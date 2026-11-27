import type { FollowupEventReceiveParams, FollowupEventReceiveReceipt, FollowupEventSourceIdentity } from '@varin/protocol';
import type { DurableEventInbox } from './event-inbox.js';

export function startSupervisorInbox(
  journal: DurableEventInbox,
  receiveDurably: (page: FollowupEventReceiveParams, signal?: AbortSignal) => Promise<FollowupEventReceiveReceipt>,
  onUnavailable: () => void,
  onReceiverAvailability: () => void = () => {},
) {
  const stop = new AbortController();
  let work: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
  let blocked = new Set<string>();
  const key = ({ principalId, source }: FollowupEventSourceIdentity) => JSON.stringify([
    principalId, source.extensionId, source.sourceId, source.connectionId, source.accountId, source.host ?? null,
  ]);
  const scheduleRetry = () => {
    if (timer || stop.signal.aborted) return;
    timer = setTimeout(() => { timer = undefined; wake(); }, 2000);
    timer.unref();
  };
  const wake = () => {
    if (stop.signal.aborted) return;
    dirty = true;
    if (work) return;
    work = (async () => {
      while (dirty && !stop.signal.aborted) {
        dirty = false;
        try {
          const next = new Set<string>();
          const result = await journal.replay(receiveDurably, stop.signal, identity => next.add(key(identity)));
          if (next.size !== blocked.size || [...next].some(item => !blocked.has(item))) {
            blocked = next;
            onReceiverAvailability();
          }
          if (result.retained) scheduleRetry();
        } catch {
          if (!stop.signal.aborted) { onUnavailable(); scheduleRetry(); }
        }
      }
    })().finally(() => { work = undefined; if (dirty) wake(); });
  };
  // Subscribe before replay so acceptance during startup cannot be missed.
  const unsubscribe = journal.onPending(wake, () => { onUnavailable(); scheduleRetry(); });
  // A separately supervised writer or a platform file watcher can lose a
  // notification. Only the opt-in inbox has this low-frequency recovery scan.
  const fallback = setInterval(wake, 5000);
  fallback.unref();
  wake();
  const initialReplay = work!;
  return {
    initialReplay,
    blocksReceiver: (identity: FollowupEventSourceIdentity) => blocked.has(key(identity)),
    async close() {
      stop.abort();
      unsubscribe();
      clearInterval(fallback);
      if (timer) clearTimeout(timer);
      await work;
    },
  };
}
