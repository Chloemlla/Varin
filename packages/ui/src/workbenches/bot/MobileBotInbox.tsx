import React from 'react';
import type { BotGroupSummary, BotSummary, ThreadIdentity } from '@varin/application-client';
import { Icon } from '@/components/icon/Icon';
import { DropdownMenu, DropdownMenuContent, DropdownMenuRadioGroup, DropdownMenuRadioItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { useI18n } from '@/lib/i18n';
import { formatSessionCompactDateLabel } from '@/lib/sessionDateLabels';
import { useThreadStore } from '@/stores/useThreadStore';
import { BotFigure } from './BotFigure';
import { GroupFaces } from './BotGroupChat';
import { botSessionTitle, isWaitingStatus, runStatus, type BotSessionView } from './botPresentation';
import { groupMemberCount } from './botGroupChatModel';

type Props = { bots: BotSummary[]; groups: BotGroupSummary[]; sessions: BotSessionView[] | null; query: string; current?: ThreadIdentity | null; currentGroup?: string | null;
  open(botId: string, identity: ThreadIdentity): void; openGroup(id: string): void };
export function MobileBotInbox({ bots, groups, sessions, query, current, currentGroup, open, openGroup }: Props) {
  const { t } = useI18n();
  const catalog = useThreadStore(state => state.threads);
  const [filter, setFilter] = React.useState('');
  const byId = new Map(bots.filter(b => !b.archived && !b.deletion).map(b => [b.id, b]));
  const chosen = byId.get(filter);
  const threads = new Map((sessions ?? []).map(view => [view.thread.thread_id, view.thread]));
  for (const thread of catalog) if (thread.bot_id && !thread.parent_thread_id) threads.set(thread.thread_id, thread);
  const needle = query.trim().toLocaleLowerCase();
  const rows = [...threads.values()].flatMap(thread => {
    const bot = byId.get(thread.bot_id ?? '');
    if (!bot || thread.archived || thread.deleted_at_ms != null || (chosen && chosen.id !== bot.id)) return [];
    const title = botSessionTitle(thread.title, bot.name);
    if (needle && ![title, bot.name].some(text => text.toLocaleLowerCase().includes(needle))) return [];
    const waiting = thread.branches.some(b => isWaitingStatus(runStatus(b.latest_run)));
    const subtitle = waiting ? t('bot.session.waiting') : thread.branches.some(b => b.active_run_id) ? t('bot.session.running') : bot.name;
    return [{ id: 't:' + thread.thread_id, title, subtitle, time: thread.updated_at_ms, selected: !currentGroup && current?.threadId === thread.thread_id,
      face: <BotFigure bot={bot} state="idle" size={36} portrait still />, open: () => open(bot.id, { runtime: 'agent', threadId: thread.thread_id, branchId: thread.main_branch_id }) }];
  });
  for (const group of groups) {
    if (chosen && !group.members.some(m => m.botId === chosen.id)) continue;
    if (needle && ![group.name, group.preview ?? '', ...group.members.map(m => m.name)].some(text => text.toLocaleLowerCase().includes(needle))) continue;
    rows.push({ id: 'g:' + group.id, title: group.name, subtitle: group.preview || groupMemberCount(group.members.length), time: group.updatedAt, selected: currentGroup === group.id,
      face: <GroupFaces group={group} bots={bots} size={27} />, open: () => openGroup(group.id) });
  }
  rows.sort((a, b) => b.time - a.time || a.id.localeCompare(b.id));
  return <section className="mobile-bot-inbox">
    <div className="mobile-list-section"><span>{t('organization.recent')}</span>
      <DropdownMenu><DropdownMenuTrigger className="mobile-filter-trigger">{chosen?.name ?? t('tasksHub.all')}<Icon name="arrow-down-s" className="size-3" /></DropdownMenuTrigger>
        <DropdownMenuContent align="end"><DropdownMenuRadioGroup value={chosen?.id ?? ''} onValueChange={setFilter}>
          <DropdownMenuRadioItem value="">{t('tasksHub.all')}</DropdownMenuRadioItem>
          {[...byId.values()].map(b => <DropdownMenuRadioItem key={b.id} value={b.id}>{b.name}</DropdownMenuRadioItem>)}
        </DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>
    </div>
    {rows.map(row => <button type="button" key={row.id} className="mobile-room-row" aria-current={row.selected ? 'page' : undefined} onClick={row.open}>
      <span className="mobile-room-face">{row.face}</span><span className="min-w-0 flex-1"><strong className="block truncate">{row.title}</strong><small className="block truncate">{row.subtitle}</small></span>
      <time>{formatSessionCompactDateLabel(row.time)}</time></button>)}
    {!rows.length && <p className="px-3 py-4 text-center typography-meta text-muted-foreground">{t(query ? 'bot.session.noMatch' : 'mobile.sessions.empty.noSessionsTitle')}</p>}
  </section>;
}
