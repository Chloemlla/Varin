import React from 'react';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Face, Flyout, Glyph, IconButton, ModeMenu } from './controls';
import { fileName, isGroup, outline, type Message, type Mode, type Room, type Person } from './sample';
import { BotDirectory, type CreateKind } from './bot-directory';
import { useRoster } from './roster';
import { ConversationPortraits } from './conversation-heading';
import type { BotAppearance } from '@varin/application-client';
import { WorkDirectory } from './work-directory';

export function Inbox({ mode, changeMode, rooms, selected, open, create, settings, createBot, createGroup, work }: {
  mode: Mode; changeMode(m: Mode): void; rooms: Room[]; selected: string; open(id: string): void; create(name?: Person): void; settings: React.MouseEventHandler<HTMLButtonElement>;
  createBot(name: string, appearance?: BotAppearance): void; createGroup(name: string, ids: string[]): void;
  work: Omit<React.ComponentProps<typeof WorkDirectory>, 'rooms' | 'selected' | 'query' | 'open'>;
}) {
  const { bots, display } = useRoster();
  const [action, setAction] = React.useState<CreateKind | null>(null);
  const [query, setQuery] = React.useState('');
  const [filter, setFilter] = React.useState('全部');
  const visible = rooms.filter(r => r.mode === 'bot' && (filter === '全部' || r.people.some(p => p === filter))
    && (r.title + r.people.map(display).join('') + r.messages.map(m => m.text).join('')).toLowerCase().includes(query.trim().toLowerCase()));
  return <section className="screen inbox">
    <header className="page-bar"><ModeMenu mode={mode} change={m => { setQuery(''); changeMode(m); }} /><div className="bar-actions"><IconButton name="settings-3" label="设置" settingsOrigin="open" onClick={settings} />
      {mode === 'bot' ? <><IconButton name="folder-add" label="新建分组" onClick={() => setAction('folder')} />
        <Flyout label="新建" trigger={<Glyph name="chat-new" />}>{close => ([
          ['chat', 'chat-new', '新建会话'], ['group', 'group', '新建群聊'],
        ] as const).map(([kind, icon, label]) => <button key={kind} className="choice" onClick={() => { close(); setAction(kind); }}><Glyph name={icon} />{label}</button>)}</Flyout></> :
        <IconButton name="chat-new" label="新建任务" onClick={() => work.createTask(null)} />}</div></header>
    <div className="list-tools">
      <label className="find"><Glyph name="search" /><input type="search" aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={e => setQuery(e.target.value)} /></label></div>
    <div className="screen-body">{mode === 'work' ? <WorkDirectory {...work} rooms={rooms} selected={selected} query={query} open={open} /> : <>
      <div className="list-heading"><span>最近</span>
      <Flyout label="筛选 Bot" trigger={<>{filter === '全部' ? '全部 Bot' : display(filter)}<Glyph name="arrow-down-s" /></>}>{close =>
        [{ id: '全部', name: '全部' }, ...bots].map(b => <button className="choice" key={b.id} onClick={() => { setFilter(b.id); close(); }}>{b.name}{b.id === filter && <Glyph name="check" />}</button>)}</Flyout></div>
      {visible.map(r => <div className="room-row" key={r.id}>
        <button onClick={() => open(r.id)} className="room-link" aria-current={r.id === selected ? 'page' : undefined}>
          <span className="list-face"><Face names={r.people} size={r.people.length > 1 ? 26 : 37} /></span>
          <span className="room-copy"><strong>{r.title}</strong><small>{r.messages.some(m => m.choices && !m.answer) && <span className="needs-reply">等你回复 · </span>}{r.messages.at(-1)?.text || '新会话'}</small></span><time>{r.time}</time></button>
      </div>)}
      {!visible.length && <p className="empty">没有匹配的会话</p>}
      <BotDirectory action={action} openCreate={() => setAction('bot')} close={() => setAction(null)} query={query} newBot={createBot} newChat={create} newGroup={createGroup}
        selectBot={id => { const existing = rooms.find(r => r.mode === 'bot' && !isGroup(r) && r.people[0] === id); if (existing) open(existing.id); else create(id); }} /></>}
    </div>
  </section>;
}

export function Services() {
  const [tab, setTab] = React.useState('用量');
  return <Flyout label="用量和 MCP" trigger={<Glyph name="stack" />}>{close => <div className="services">
    <div className="service-head"><div className="switcher">{['用量', 'MCP'].map(t => <button aria-pressed={t === tab} key={t} onClick={() => setTab(t)}>{t}</button>)}</div><IconButton name="close" label="关闭" onClick={close} /></div>
    {tab === '用量' ? <><h3>本次会话</h3><p>输入 <b>12,480</b></p><p>输出 <b>368</b></p><p>缓存读取 <b>9,216</b></p></> : <><h3>MCP 连接</h3><p><span><Glyph name="github" /> GitHub</span><small>已连接</small></p></>}
  </div>}</Flyout>;
}

export function DocumentLink({ open }: { open(): void }) {
  return <button className="doc-link" onClick={open}><span className="doc-icon"><Glyph name="file-text" /></span><span><strong>{fileName}</strong><small>Markdown 文档</small></span><Glyph name="arrow-right-s" /></button>;
}

export function Timeline({ room, openFile, quote, branch, answer }: {
  room: Room; openFile(): void; quote(m: Message): void; branch(index: number): void; answer(index: number, value: string): void;
}) {
  const group = isGroup(room);
  const { display } = useRoster();
  const initialCount = React.useRef(room.messages.length);
  if (!room.messages.length) return null;
  return <div className="timeline"><div className="day">{room.time.includes(':') ? '今天' : room.time}</div>
    {room.messages.map((m, i) => {
      const self = m.who === '我';
      const consecutive = group && i > 0 && room.messages[i - 1].who === m.who;
      return <article key={i} data-new={i >= initialCount.current || undefined} data-consecutive={consecutive || undefined}
        className={'turn ' + (self ? 'own' : '') + (group ? ' group-turn' : '')}>
        {!self && !consecutive && <div className="byline"><Face names={[m.who]} size={group ? 29 : 20} />{display(m.who)}</div>}
        {m.process && <details className="process"><summary><Glyph name="arrow-right-s" />工作过程</summary>{m.process.map(step => <p key={step}><Glyph name="check" />{step}</p>)}</details>}
        <ContextMenu><ContextMenuTrigger render={<div className={group ? 'group-chat-bubble message' : 'message'} tabIndex={0} />}>
          {m.quote && <blockquote>{m.quote}</blockquote>}{m.text}{m.attachment && <small className="sent-file"><Glyph name="attachment-2" />{m.attachment}</small>}
        </ContextMenuTrigger><ContextMenuContent><ContextMenuItem onClick={() => quote(m)}><Glyph name="chat-quote" />引用回复</ContextMenuItem>
          <ContextMenuItem onClick={() => void navigator.clipboard.writeText(m.text)}><Glyph name="clipboard" />复制</ContextMenuItem>
          {!group && <ContextMenuItem onClick={() => branch(i)}><Glyph name="git-branch" />从这里分支</ContextMenuItem>}
        </ContextMenuContent></ContextMenu>
        {m.file && <DocumentLink open={openFile} />}
        {m.choices && !m.answer && <div className="answer-choices">{m.choices.map(v => <Button variant="outline" size="sm" key={v} onClick={() => answer(i, v)}>{v}</Button>)}</div>}
      </article>;
    })}
  </div>;
}

export function RoomDetails({ room, open, openFile, files, setFiles, selectedTab, selectTab, mention, projectName }: {
  room: Room; open(id: string): void; openFile(): void; files: boolean; setFiles(v: boolean): void;
  mention(id: string): void;
  projectName: string | undefined;
  selectedTab?: string; selectTab(tab: string): void;
}) {
  const group = isGroup(room);
  const { display } = useRoster();
  const tabs = group ? ['成员', '协作', '日程'] : ['任务', '文件', '改动'];
  const tab = selectedTab && tabs.includes(selectedTab) ? selectedTab : tabs[0];
  return <div className="detail-body">
    <div className="profile">{group ? <ConversationPortraits ids={room.people} group /> : <Face names={room.people} size={42} />}<h2>{room.title}</h2>
      <small>{group ? room.people.length + ' 位成员' : projectName ?? '未选择项目'}</small></div>
    <div className="switcher detail-tabs">{tabs.map(t => <button key={t} aria-pressed={t === tab} onClick={() => selectTab(t)}>{t}</button>)}</div>
    {tab === '成员' ? room.people.map(p => <div key={p} className="person-row"><Face names={[p]} size={30} /><strong>{display(p)}</strong><small>提及时接收</small>
      <Button variant="ghost" size="icon" aria-label={'提及' + display(p)} onClick={() => mention(p)}>@</Button></div>) :
      !['outline', 'group', 'check', 'review'].includes(room.id) ? <p className="empty">暂无{tab}</p> :
      tab === '日程' ? <div className="info-row"><Glyph name="calendar" /><span>合作方演示彩排<small>今天 14:30</small></span></div> :
      tab === '改动' ? <><button className="info-row" aria-expanded={files} onClick={() => setFiles(!files)}><Glyph name="git-branch" /><span>{fileName}</span><Glyph name={files ? 'arrow-down-s' : 'arrow-right-s'} /></button>
        {files && <div className="diff"><del>− 先演示群聊分工</del><ins>+ 先用手机连接桌面</ins></div>}</> : tab === '文件' ? <DocumentLink open={openFile} /> :
      <><button className="info-row" onClick={() => open(room.id === 'check' ? 'review' : 'check')}><Glyph name="task" /><span>{room.id === 'check' ? '演示前走查' : '群聊走查'}<small>{room.id === 'check' ? '所属任务' : '蓝汐 · 已完成'}</small></span><Glyph name="arrow-right-s" /></button>
        {group && <button className="info-row" onClick={() => open('outline')}><Glyph name="chat-1" /><span>合作演示<small>关联会话</small></span><Glyph name="arrow-right-s" /></button>}</>}
  </div>;
}

export function DocumentPage({ reply }: { reply(text: string): void }) {
  return <div className="document"><div className="paper"><small>Markdown</small><h1>合作演示提纲</h1>
    {outline.map(([title, body]) => <section key={title}><h2>{title}</h2><p>{body}</p></section>)}</div>
    <Button variant="outline" onClick={() => reply(window.getSelection()?.toString().trim() || fileName)}><Glyph name="chat-quote" />引用到对话</Button>
  </div>;
}
