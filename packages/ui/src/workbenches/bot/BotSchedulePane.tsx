import React from 'react';
import type { ScheduledTask } from '@varin/application-client';
import type { CalendarOccurrence } from '@varin/protocol';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { formatSchedule } from '@/components/session/scheduleFormat';
import { getCurrentIntlLocale, useI18n } from '@/lib/i18n';
import { useUIStore } from '@/stores/useUIStore';
import { useMobilePages } from '@/contexts/mobile-pages';
import { useBotPanel } from './botPanelModel';
import { clockTime, dayLabel, occurrenceTime } from './botPresentation';
import { useFlash, useScrollIntoFocus } from './botFocus';
import { BotScheduleResult } from './BotScheduleResult';

function ScheduleRow({ task, open, onToggle, locale, onEdit, onResult }: {
  task: ScheduledTask;
  open: boolean;
  onToggle(): void;
  locale: string;
  onEdit(button: HTMLButtonElement): void;
  onResult(record: CalendarOccurrence, button: HTMLButtonElement): void;
}) {
  const { t } = useI18n();
  const model = useBotPanel();
  const id = React.useId();
  const definition = task.calendar?.definition;
  const next = definition?.next_at_ms ?? null;
  const focused = model.focus?.tab === 'schedule' && model.focus.id === task.id;
  const token = model.focus?.token;
  const occurrenceFocus = focused ? model.focus?.occurrenceId : undefined;
  const flash = useFlash(focused, token);
  const ref = React.useRef<HTMLDivElement>(null);
  const recordFocus = React.useRef<HTMLButtonElement>(null);
  useScrollIntoFocus(ref, focused && !occurrenceFocus, token);
  React.useEffect(() => {
    if (!open || !occurrenceFocus || !recordFocus.current) return;
    recordFocus.current.scrollIntoView?.({ block: 'nearest' });
    recordFocus.current.focus({ preventScroll: true });
  }, [open, occurrenceFocus, token]);

  const target = definition?.target ?? task.target;
  const targetText = target.kind === 'new_work' ? t('bot.schedule.newWork') :
    model.sessions.some(session => session.identity.threadId === target.threadId)
      ? t('bot.schedule.continueIn', { title: model.sessionTitle(target.threadId) })
      : t('calendar.target.existing');
  const nextDay = next === null ? null : dayLabel(new Date(next).setHours(0, 0, 0, 0), Date.now(), locale);
  const dateText = nextDay === null ? '' : 'key' in nextDay ? t(nextDay.key) : new Intl.DateTimeFormat(locale, { month: 'numeric', day: 'numeric' }).format(next!);
  const nextNote = !task.enabled ? t('bot.schedule.paused') : definition?.calculation_failure ? t('bot.schedule.calculationFailed')
    : definition?.calculation_pending ? t('bot.schedule.calculating') : t('bot.schedule.noNext');
  const records = React.useMemo(() => [...(task.calendar?.occurrences ?? [])].sort((a, b) =>
    occurrenceTime(b) - occurrenceTime(a) || b.observed_at_ms - a.observed_at_ms), [task.calendar?.occurrences]);
  const dateFormat = React.useMemo(() => new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric' }), [locale]);
  return <div ref={ref} className={`bot-schedule ${flash ?? ''}`} data-open={open} data-paused={!task.enabled || undefined}>
    <button type="button" className="bot-schedule-trigger" aria-expanded={open} aria-controls={id} onClick={onToggle}>
      <span className="bot-schedule-when">{task.enabled && next !== null
        ? <><b>{clockTime(next, locale)}</b><small>{dateText}</small></>
        : <><Icon name="calendar-schedule" className="size-4" /><small>{nextNote}</small></>}</span>
      <span className="grid min-w-0 flex-1">
        <b className="bot-schedule-name truncate text-[13.5px] font-medium">{task.name}</b>
        <small className="truncate" title={formatSchedule(task, t)}>{t(`calendar.schedule.${task.schedule.kind}`)} · {targetText}</small>
      </span>
      <Icon name="arrow-right-s" className="bot-schedule-chevron size-4 shrink-0" />
    </button>
    <div className="bot-fold" id={id} data-open={open} inert={!open}><div>
      <div className="bot-schedule-records">
        <header>
          <span>{t('bot.schedule.records')}</span>
          <Button type="button" size="sm" variant="ghost" onClick={event => onEdit(event.currentTarget)}>{t('bot.schedule.editTitle')}</Button>
        </header>
        {task.loopError && <p role="status" className="px-1 pb-2 typography-meta text-destructive">{task.loopError}</p>}
        {!records.length ? <p className="px-1 pb-2 typography-meta text-muted-foreground">{t('bot.schedule.emptyRecords')}</p>
          : records.map(record => {
            const when = occurrenceTime(record);
            return <button type="button" className="bot-schedule-record" key={record.id}
              ref={occurrenceFocus === record.id ? recordFocus : undefined} onClick={event => onResult(record, event.currentTarget)}>
              <time dateTime={new Date(when).toISOString()}>{dateFormat.format(when)} <span>{clockTime(when, locale)}</span></time>
              <span className="bot-schedule-record-state" data-state={record.state}><i />{t(`bot.schedule.state.${record.state}`)}</span>
              <Icon name="arrow-right-s" className="size-4 shrink-0 text-muted-foreground" />
            </button>;
          })}
      </div>
    </div></div>
  </div>;
}

export function BotSchedulePane() {
  const { t } = useI18n();
  const model = useBotPanel();
  const mobile = useMobilePages();
  const locale = getCurrentIntlLocale();
  const focus = model.focus;
  const [openId, setOpenId] = React.useState<string | null>(() => focus?.tab === 'schedule' ? focus.id : null);
  const [result, setResult] = React.useState<{ taskId: string; recordId: string; open: boolean } | null>(null);
  const pageOpen = useUIStore(state => state.isScheduledTasksDialogOpen && Boolean(state.scheduledTasksConversation?.botPage));
  const pageOrigin = React.useRef<HTMLButtonElement | null>(null);
  const resultOrigin = React.useRef<HTMLButtonElement | null>(null);
  React.useEffect(() => { if (focus?.tab === 'schedule') setOpenId(focus.id); }, [focus]);
  React.useLayoutEffect(() => {
    if (pageOpen || !pageOrigin.current) return;
    if (pageOrigin.current.isConnected && !pageOrigin.current.closest('[inert]')) pageOrigin.current.focus({ preventScroll: true });
    pageOrigin.current = null;
  }, [pageOpen]);
  const read = model.facts.tasks;
  const identity = model.scheduleIdentity ?? model.session?.identity ?? model.bot.entry;
  const tasks = [...(read.value ?? [])].sort((a, b) => (
    (a.enabled ? a.calendar?.definition.next_at_ms ?? Infinity : Infinity) -
    (b.enabled ? b.calendar?.definition.next_at_ms ?? Infinity : Infinity) || a.name.localeCompare(b.name, locale)
  ));
  const selectedTask = result && tasks.find(task => task.id === result.taskId);
  const selectedRecord = selectedTask && result && selectedTask.calendar?.occurrences.find(record => record.id === result.recordId);
  const openEditor = (task: ScheduledTask | null, button: HTMLButtonElement) => {
    pageOrigin.current = button;
    const destinations = model.sessions.flatMap(session => [session.identity, ...session.branches].map((identity, index) => ({
      identity, label: index ? t('bot.schedule.destinationBranch', { title: model.sessionTitle(identity.threadId), index }) : model.sessionTitle(identity.threadId),
    })));
    useUIStore.getState().setScheduledTasksDialogOpen(true, {
      identity, model: model.bot.model ?? undefined,
      botPage: { kind: 'editor', project: { id: `bot:${model.bot.id}`, path: model.bot.homeDir, label: model.bot.name }, task, destinations },
    });
  };
  const openRecord = (task: ScheduledTask, record: CalendarOccurrence, button: HTMLButtonElement) => {
    const target = record.target_kind ?? (record.thread_id === `thread:${record.id}` ? 'new_work' : 'existing_work');
    if (target === 'existing_work' && record.history_item_id && record.run_id && (record.state === 'delivered' || record.state === 'completed') && model.openScheduleTurn) {
      model.openScheduleTurn(task.id, record, () => mobile?.showDetails(false));
      return;
    }
    resultOrigin.current = button;
    setResult({ taskId: task.id, recordId: record.id, open: true });
  };
  return <div inert={pageOpen || undefined}>
    {read.status === 'failed' ? <div role="alert" className="mx-2 my-2 flex gap-2 typography-meta text-destructive">
      <span className="min-w-0 flex-1 break-words">{read.error}</span>
      <button type="button" className="shrink-0 text-foreground hover:underline" onClick={model.facts.retryTasks}>{t('common.retry')}</button>
    </div> : null}
    {read.status === 'loading' && !read.value ? <p role="status" className="px-4 py-6 text-center typography-meta text-muted-foreground">{t('common.loading')}</p> : null}
    {tasks.length ? <section aria-label={t('bot.schedule.upcoming')}>
      <p className="bot-section-label">{t('bot.schedule.upcoming')}</p>
      {tasks.map(task => <ScheduleRow key={task.id} task={task} locale={locale} open={openId === task.id}
        onToggle={() => setOpenId(current => current === task.id ? null : task.id)}
        onEdit={button => openEditor(task, button)} onResult={(record, button) => openRecord(task, record, button)} />)}
    </section> : null}
    {read.status === 'ready' && !tasks.length ? <p className="px-4 py-7 text-center text-[13px] leading-loose text-muted-foreground">{t('bot.schedule.empty')}</p> : null}
    <footer className="bot-schedule-actions">
      <Button type="button" size="sm" variant="ghost" className="gap-1 px-1 text-muted-foreground" onClick={event => {
        pageOrigin.current = event.currentTarget;
        useUIStore.getState().setScheduledTasksDialogOpen(true, { identity, botPage: { kind: 'arrangements' } });
      }}>{t('arrangements.title')}<Icon name="arrow-right-s" className="size-3.5" /></Button>
      <Button type="button" size="sm" variant="outline" className="gap-1.5" onClick={event => openEditor(null, event.currentTarget)}>
        <Icon name="add" className="size-3.5" />{t('bot.schedule.new')}
      </Button>
    </footer>
    {selectedTask && selectedRecord && result && <BotScheduleResult key={selectedRecord.id} name={selectedTask.name} record={selectedRecord} locale={locale}
      open={result.open} onClose={() => setResult(current => current && ({ ...current, open: false }))} finalFocus={() => resultOrigin.current} />}
  </div>;
}
