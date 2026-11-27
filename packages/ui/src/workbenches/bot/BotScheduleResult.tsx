import React from 'react';
import { getRuntimeEndpointGeneration, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import type { CalendarOccurrence } from '@varin/protocol';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ThreadContent } from '@/components/thread/ThreadContent';
import { CalendarFailure } from '@/components/session/CalendarTaskStatus';
import { useI18n } from '@/lib/i18n';
import { BotFigure } from './BotFigure';
import { useBotPanel } from './botPanelModel';
import { occurrenceTime } from './botPresentation';
import { readCalendarReply, type CalendarReplyItem } from './calendarReply';

export function BotScheduleResult({ name, record, locale, open, onClose, finalFocus }: {
  name: string;
  record: CalendarOccurrence;
  locale: string;
  open: boolean;
  onClose(): void;
  finalFocus(): HTMLElement | null;
}) {
  const { t } = useI18n();
  const { bot, threads } = useBotPanel();
  const { thread_id: threadId, branch_id: branchId, run_id: runId } = record;
  const ready = record.state === 'completed' && Boolean(runId);
  const [result, setResult] = React.useState<{ reply?: CalendarReplyItem[]; failed?: true }>();
  const [retry, retryRead] = React.useReducer(value => value + 1, 0);
  const dismiss = React.useEffectEvent(onClose);
  React.useEffect(() => subscribeRuntimeEndpointWillChange(() => dismiss()), []);
  React.useEffect(() => {
    if (!open || !ready || !runId) return;
    if (!threads?.family) { setResult({ failed: true }); return; }
    setResult(undefined);
    const controller = new AbortController();
    const host = getRuntimeEndpointGeneration();
    const current = () => !controller.signal.aborted && host === getRuntimeEndpointGeneration();
    void readCalendarReply(threads.family, { runtime: 'agent', threadId, branchId }, runId, controller.signal)
      .then(reply => { if (current()) setResult({ reply }); }, () => { if (current()) setResult({ failed: true }); });
    return () => controller.abort();
  }, [open, ready, runId, threadId, branchId, threads, retry]);
  const identity = { runtime: 'agent' as const, threadId, branchId };
  const date = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }).format(occurrenceTime(record));
  return <Dialog open={open} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="max-h-[min(82dvh,720px)] max-w-[660px] overflow-y-auto" finalFocus={finalFocus}>
      <div className="space-y-1 border-b border-border pb-3">
        <DialogTitle className="pr-6">{name}</DialogTitle>
        <DialogDescription>{date} · {t(`bot.schedule.state.${record.state}`)}</DialogDescription>
      </div>
      {record.failure_message ? <div role="status" className="space-y-2 text-sm">
        <p>{record.failure_message}</p>
        {record.failure_code && <details>
          <summary className="cursor-pointer typography-meta">{t('calendar.failure.details')}</summary>
          <code className="break-all">{record.failure_code}</code>
        </details>}
      </div> : record.failure_code
        ? <CalendarFailure code={record.failure_code} />
        : record.state === 'failed' ? <p role="status">{t('calendar.failure.generic')}</p> : null}
      {ready && (result?.failed
        ? <div role="alert" className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t('bot.schedule.resultUnavailable')}</span>
          <Button type="button" size="sm" variant="ghost" onClick={retryRead}>{t('common.retry')}</Button>
        </div>
        : !result ? <p role="status" className="text-sm text-muted-foreground">{t('common.loading')}</p>
          : result.reply?.length && threads ? <article className="min-w-0 space-y-3 break-words text-sm">
            <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <BotFigure bot={bot} state="idle" size={20} still />{bot.name}
            </div>
            {result.reply.map(item => <ThreadContent key={item.itemId} api={threads} identity={identity} messageId={item.itemId} parts={item.parts}
              holder={{ kind: 'family', threadId, branchId, runId: runId!, anchor: item.anchor, itemId: item.itemId }} />)}
          </article> : <p className="text-sm text-muted-foreground">{t('bot.schedule.noReply')}</p>)}
      {!ready && !record.failure_code && !record.failure_message && record.state !== 'failed' && <p className="text-sm text-muted-foreground">
        {t(record.state === 'completed' || record.state === 'cancelled' || record.state === 'skipped' ? 'bot.schedule.noReply' : 'bot.schedule.noResult')}
      </p>}
    </DialogContent>
  </Dialog>;
}
