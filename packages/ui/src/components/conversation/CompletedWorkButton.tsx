import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';

export function CompletedWorkButton({ expanded, onToggle, durationMs }: {
  expanded: boolean; onToggle(): void; durationMs?: number;
}) {
  const { t } = useI18n();
  const seconds = durationMs !== undefined && durationMs >= 1000 ? Math.floor(durationMs / 1000) : undefined;
  const duration = seconds === undefined ? undefined : seconds < 60 ? t('common.duration.secondsCompact', { seconds })
    : seconds < 3600 ? t('common.duration.minutesSecondsCompact', { minutes: Math.floor(seconds / 60), seconds: seconds % 60 })
    : t('common.duration.hoursMinutesCompact', { hours: Math.floor(seconds / 3600), minutes: Math.floor(seconds / 60) % 60 });
  return <button type="button" aria-expanded={expanded} data-completed-work
    className="inline-flex min-h-7 items-center gap-1.5 rounded typography-meta text-muted-foreground hover:text-foreground focus-visible:ring-2"
    onClick={onToggle}>
    <Icon name="arrow-right-s" className={`size-3.5 motion-safe:transition-transform ${expanded ? 'rotate-90' : ''}`} />
    {t('chat.completedWork')}{duration && <span className="tabular-nums">· {duration}</span>}
  </button>;
}
