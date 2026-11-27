import React from 'react';
import { motion, useIsPresent } from 'motion/react';
import { createScheduledTasksHttpAPI, subscribeRuntimeEndpointWillChange } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import { useI18n } from '@/lib/i18n';
import type { CalendarConversationContext } from '@/stores/useUIStore';
import { CalendarTaskEditorDialog } from './CalendarTaskEditorDialog';
import { ScheduledTaskLoopEditorDialog } from './ScheduledTaskLoopEditorDialog';

const schedules = createScheduledTasksHttpAPI();
type Page = NonNullable<CalendarConversationContext['botPage']>;

export function BotSchedulePage({ page, conversation, onClose, children }: {
  page: Page;
  conversation: CalendarConversationContext;
  onClose(): void;
  children?: React.ReactNode;
}) {
  const { t } = useI18n();
  const level = useMotionLevel();
  const present = useIsPresent();
  const heading = React.useRef<HTMLHeadingElement>(null);
  const titleId = React.useId();
  const close = React.useEffectEvent(onClose);
  const loop = page.kind === 'editor' && Boolean(page.task?.loopFile);
  const title = t(page.kind === 'arrangements' ? 'arrangements.title' : page.task ? 'bot.schedule.editTitle' : 'bot.schedule.new');
  React.useLayoutEffect(() => { heading.current?.focus({ preventScroll: true }); }, []);
  React.useEffect(() => present ? subscribeRuntimeEndpointWillChange(() => close()) : undefined, [present]);
  return <motion.section className="bot-schedule-page absolute inset-0 z-10 overflow-y-auto overscroll-contain bg-background"
    aria-labelledby={titleId} aria-hidden={!present || undefined} inert={!present}
    initial={{ opacity: 0, x: level === 'full' ? 22 : 0 }} animate={{ opacity: 1, x: 0 }}
    exit={{ opacity: 0, x: level === 'full' ? 22 : 0 }}
    transition={{ duration: level === 'off' ? 0 : level === 'reduced' ? .13 : .24, ease: [.22, 1, .36, 1] }}
    onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented || loop) return;
      event.preventDefault(); event.stopPropagation(); onClose();
    }}>
    <header className="sticky top-0 z-10 flex h-12 items-center border-b border-border/60 bg-background px-3">
      <Button type="button" variant="ghost" size="sm" className="gap-1.5" onClick={onClose}>
        <Icon name="arrow-left" className="size-4" />{t('bot.schedule.back')}
      </Button>
    </header>
    <div className={page.kind === 'editor' ? 'mx-auto w-full max-w-xl px-5 py-7 sm:px-8 sm:py-9' : 'mx-auto w-full max-w-3xl px-5 py-7 sm:px-8 sm:py-9'}>
      <div className={page.kind === 'editor' ? 'mb-6 space-y-1.5' : 'sr-only'}>
        <h1 ref={heading} tabIndex={-1} id={titleId} className="text-xl font-semibold tracking-tight outline-none">{title}</h1>
        {page.kind === 'editor' && <p className="typography-meta text-muted-foreground">{t('calendar.description')}</p>}
      </div>
      {page.kind === 'arrangements'
        ? children
        : loop ? <ScheduledTaskLoopEditorDialog open={present} projectID={page.project.id} task={page.task} onOpenChange={value => { if (!value) onClose(); }} onSaved={async () => {}} />
          : <CalendarTaskEditorDialog open={present} page projectId={page.project.id} project={page.project} task={page.task}
            conversation={conversation} destinations={page.destinations} onOpenChange={value => { if (!value) onClose(); }}
            onSave={async draft => { await schedules.upsert(page.project.id, draft); }} />}
    </div>
  </motion.section>;
}
