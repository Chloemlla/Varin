import React from 'react';
import type { BotSummary, ScheduledTask } from '@varin/application-client';
import { BotPanelBody } from '@/workbenches/bot/BotPanel';
import type { BotPanelModel } from '@/workbenches/bot/botPanelModel';
import { useBotLayout } from '@/workbenches/bot/botLayout';
import { stateLine, workKey, type BotNeed, type BotSessionView, type BotTimelineEvent, type BotWorkView } from '@/workbenches/bot/botPresentation';
import { BotWorkspaceNavigationContext, type BotWorkspaceNavigation } from '@/workbenches/bot/botWorkspaceViews';
import { BotNameDialog } from '@/components/sections/bots/BotNameDialog';
import { CalendarTaskEditorDialog } from '@/components/session/CalendarTaskEditorDialog';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { useUIStore } from '@/stores/useUIStore';
import { identity } from './roster';
import { fileName, isGroup, type Room } from './sample';

const ready = <T,>(value: T) => ({ status: 'ready' as const, value });
const noop = () => {};
function session(r: Room): BotSessionView {
  const id = identity(r.id);
  return { identity: id, branches: [], primary: true, running: false, waiting: r.messages.some(m => m.choices && !m.answer), unread: false,
    thread: { thread_id: r.id, main_branch_id: id.branchId, parent_thread_id: null, title: r.title, revision: 1, created_at_ms: 0, updated_at_ms: 0,
      pinned: false, archived: false, deleted_at_ms: null, activity_cursor: 0, read_cursor: 0, unread: false, bot_id: r.people[0], branches: [], observer_project_ids: [] } };
}
function sampleSchedules(bot: BotSummary): ScheduledTask[] {
  if (bot.id !== '薇琳') return [];
  return [{ id: 'rehearsal', runtime: 'agent', name: '演示彩排', execution: { prompt: '走一遍演示提纲，确认手机端可以接上。' },
    enabled: true, schedule: { kind: 'weekly', weekdays: [5], times: ['14:30'], timezone: 'Asia/Taipei' },
    target: { kind: 'existing_work', threadId: 'outline', branchId: 'main' }, state: { createdAt: 0, updatedAt: 0 } }];
}

export function PreviewBotPanel({ bot, room, rooms, open, newChat, updateBot, openFile }: {
  bot: BotSummary; room: Room; rooms: Room[]; open(id: string): void; newChat(): void; updateBot(bot: BotSummary): void; openFile(): void;
}) {
  const [profile, setProfile] = React.useState(false);
  const [name, setName] = React.useState(bot.name);
  const [resources, setResources] = React.useState<'files' | 'devices' | null>(null);
  const scheduleList = useUIStore(s => s.isScheduledTasksDialogOpen);
  const setScheduleList = useUIStore(s => s.setScheduledTasksDialogOpen);
  const [editing, setEditing] = React.useState<ScheduledTask | 'new' | null>(null);
  const scheduleKey = 'design.schedules.' + bot.id;
  const [tasks, setTasks] = React.useState<ScheduledTask[]>(() => JSON.parse(sessionStorage.getItem(scheduleKey) ?? 'null') ?? sampleSchedules(bot));
  const own = rooms.filter(r => !isGroup(r) && r.mode === 'bot' && r.people[0] === bot.id);
  const sessions = own.map(session);
  const needs: BotNeed[] = own.flatMap(r => {
    const m = r.messages.find(m => m.choices && !m.answer);
    return m ? [{ identity: identity(r.id), key: r.id, kind: 'question', session: true, name: r.title, avatar: null, lead: true, preview: m.text }] : [];
  });
  const work: BotWorkView[] = bot.id === '薇琳' ? [{ key: workKey(identity('review')), identity: identity('review'), sessionThreadId: 'outline',
    task: '走查手机配对和群聊', name: '演示前走查', lead: true, avatar: null, status: bot.activity?.state === 'asleep' ? 'paused' : 'running', updatedAtMs: 0 }] : [];
  const when = new Date().setHours(10, 42, 0, 0);
  const timeline: BotTimelineEvent[] = work.map(item => ({ id: item.key, kind: 'dispatch', name: item.name, task: item.task,
    atMs: when, target: item.identity, sessionThreadId: 'outline' }));
  const figure = bot.activity?.state === 'asleep' ? 'sleeping' : needs.length ? 'waiting' : work.length ? 'working' : 'idle';
  const model: BotPanelModel = {
    bot, figure, stage: null, line: stateLine(bot, figure, { needs, working: work }), sessions,
    session: sessions.find(s => s.identity.threadId === room.id) ?? null, work, timeline, needs, matters: [], threads: undefined, readOnly: figure === 'sleeping', busy: false, focus: null,
    sessionTitle: id => rooms.find(r => r.id === id)?.title ?? id, newSession: newChat, openSession: i => open(i.threadId), openWork: i => open(i.threadId),
    openNeed: n => open(n.identity.threadId), openProfile: () => { setName(bot.name); setProfile(true); },
    focusTab: tab => useBotLayout.getState().setTab(tab), archiveMatter: noop,
    changeState: action => updateBot({ ...bot, activity: { state: action === 'sleep' ? 'asleep' : 'awake', operationId: '', planned: true, work: [], machines: [], error: null } }),
    facts: { activity: ready({ events: [], participants: [], before: null }), memory: ready([]), tasks: ready(tasks), arrangements: ready([]), eventSources: ready([]),
      arrangementIdentity: undefined, earlier: { loading: false, error: null }, retryActivity: noop, retryMemory: noop, retryTasks: noop, retryArrangements: noop,
      retryEventSources: noop, refreshMemory: noop, refreshSchedules: noop, loadEarlier: noop },
  };
  const navigation: BotWorkspaceNavigation = { views: [], activeKey: null, focusRevision: 0, error: null, computers: null,
    sources: { targets: [{ resourceOwner: { kind: 'local' }, label: '本机', capabilities: [] }], unavailable: [] },
    open: v => { if (v.kind === 'work') open(v.identity.threadId); }, select: noop, close: noop, refresh: noop, files: () => setResources('files'),
    connections: () => setResources('devices'), computer: () => setResources('devices'), cite: async () => {} };
  return <div className="preview-bot-panel">
    <BotWorkspaceNavigationContext.Provider value={navigation}><BotPanelBody model={model} /></BotWorkspaceNavigationContext.Provider>
    <BotNameDialog mode="rename" title="Bot 档案" open={profile} name={name} onNameChange={setName} onOpenChange={setProfile}
      onSubmit={v => { updateBot({ ...bot, name: v }); setProfile(false); }} />
    <Dialog open={!!resources} onOpenChange={v => { if (!v) setResources(null); }}><DialogContent><DialogTitle>{resources === 'files' ? '当前 Varin 服务 · 文件' : '工作设备'}</DialogTitle>
      {resources === 'files' ? <Button variant="outline" onClick={() => { setResources(null); openFile(); }}>{fileName}</Button> : <p>本机 · 设计预览</p>}
    </DialogContent></Dialog>
    <Dialog open={scheduleList && !editing} onOpenChange={v => setScheduleList(v)}><DialogContent><DialogTitle>日程</DialogTitle>
      {tasks.map(task => <Button variant="ghost" key={task.id} onClick={() => setEditing(task)}>{task.name}</Button>)}
      <Button onClick={() => setEditing('new')}>新建日程</Button>
    </DialogContent></Dialog>
    {editing && <CalendarTaskEditorDialog open projectId={'bot:' + bot.id} fixedDestination={editing !== 'new' && editing.target.kind === 'existing_work' ? model.sessionTitle(editing.target.threadId) : room.title}
      initialTarget={model.session?.identity} task={editing === 'new' ? null : editing} onOpenChange={v => { if (!v) setEditing(null); }}
      onSave={async patch => {
        if (!patch.id || !patch.target || !patch.name || !patch.schedule || !patch.execution) return;
        const now = Date.now();
        const task: ScheduledTask = { runtime: 'agent', id: patch.id, target: patch.target, name: patch.name, schedule: patch.schedule, execution: patch.execution,
          enabled: !!patch.enabled, missedPolicy: patch.missedPolicy, state: { createdAt: editing === 'new' ? now : editing.state.createdAt, updatedAt: now } };
        const next = [...tasks.filter(t => t.id !== task.id), task]; setTasks(next); sessionStorage.setItem(scheduleKey, JSON.stringify(next));
      }} />}
  </div>;
}
