import { watch } from 'node:fs';
import type { FollowupEventReceiveParams, FollowupEventReceiveReceipt } from '@varin/protocol';
import type { SupervisorJournal } from './supervisor-journal.js';

export function startSupervisorInbox(
  journal: SupervisorJournal,
  receive: (page: FollowupEventReceiveParams, signal?: AbortSignal) => Promise<FollowupEventReceiveReceipt>,
  onUnavailable: () => void,
) {
  const stop = new AbortController();
  let work: Promise<void> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let dirty = false;
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
          const result = await journal.replay(receive, stop.signal);
          if (result.retained) scheduleRetry();
        } catch {
          if (!stop.signal.aborted) { onUnavailable(); scheduleRetry(); }
        }
      }
    })().finally(() => { work = undefined; if (dirty) wake(); });
  };
  // Arm before the initial scan; observe atomic final names, not temp contents.
  const watcher = watch(journal.directory, { persistent: false }, (_event, name) => {
    if (!name || /^[a-f0-9]{64}\.pending$/.test(name)) wake();
  });
  watcher.on('error', () => { onUnavailable(); scheduleRetry(); });
  // A separately supervised writer or a platform file watcher can lose a
  // notification. Only the opt-in inbox has this low-frequency recovery scan.
  const fallback = setInterval(wake, 5000);
  fallback.unref();
  wake();
  return {
    async close() {
      stop.abort();
      watcher.close();
      clearInterval(fallback);
      if (timer) clearTimeout(timer);
      await work;
    },
  };
}
