import React from 'react';
import type { ConversationOrganizationContainer as Container, ConversationOrganizationSnapshot as Snapshot } from '@varin/application-client';
import { OrganizationRow } from '@/components/conversation/OrganizationRow';
import { OrganizationContainerIcon } from '@/components/conversation/OrganizationContainerIcon';
import { OrganizationGroupDialog, type OrganizationGroupEditor } from '@/components/conversation/OrganizationGroupDialog';
import { organizationContainerPath, organizationDropAllowed, organizationObjectKey, projectOrganization, projectRecentConversations, type OrganizationNode } from '@/components/conversation/organizationProjection';
import { useOrganizationNavigation } from '@/hooks/useOrganizationNavigation';
import { useSessionDisplayStore } from '@/stores/useSessionDisplayStore';
import { Button } from '@/components/ui/button';
import { DropdownMenuItem, DropdownMenuSeparator } from '@/components/ui/dropdown-menu';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Flyout, Glyph } from './controls';
import { container } from './work-organization';
import type { Room } from './sample';
import '@/components/conversation/organization.css';

type Props = {
  rooms: Room[]; snapshot: Snapshot; selected: string; query: string; open(id: string): void;
  menuBoundary?: HTMLElement; createTask(parentId: string | null): void; updateContainer(value: Container): void;
  updateTask(id: string, change: Partial<Pick<Room, 'containerId' | 'title' | 'pinned'>>): void;
};
const containerKey = (id: string) => organizationObjectKey({ kind: 'container', id });
const name = (node: OrganizationNode) => node.container?.name ?? node.conversation?.title ?? '';

export function WorkDirectory({ rooms, snapshot, selected, query, open, createTask, updateContainer, updateTask, menuBoundary }: Props) {
  const [pref, update] = useOrganizationNavigation('mobile-design-workbench');
  const grouping = useSessionDisplayStore(s => s.sessionGroupingMode);
  const setGrouping = useSessionDisplayStore(s => s.setSessionGroupingMode);
  const recent = pref.view === 'recent';
  const [group, setGroup] = React.useState<OrganizationGroupEditor | null>(null);
  const [project, setProject] = React.useState<{ parent: string | null; name: string } | null>(null);
  const [moving, setMoving] = React.useState<OrganizationNode | null>(null);
  const [renaming, setRenaming] = React.useState<{ id: string; title: string } | null>(null);
  const [target, setTarget] = React.useState('');
  const byId = new Map(rooms.map(r => [r.id, r]));
  const selectedPath = snapshot.conversations.find(entry => entry.conversation.id === selected)?.path ?? [];
  const location = (id: string | null) => organizationContainerPath(snapshot, id).map(c => c.name).join(' / ');
  const reveal = (id: string | null) => update({ view: 'classified', expanded: Object.fromEntries(organizationContainerPath(snapshot, id).map(c => [containerKey(c.id), true])) });
  const editGroup = (parentId: string | null) => setGroup({ id: crypto.randomUUID(), parentId, name: '', icon: 'stack', color: '' });
  const addContainer = (value: Container) => { updateContainer(value); reveal(value.parentId); };
  const startMove = (node: OrganizationNode) => { setMoving(node); setTarget(node.parentId ?? ''); };
  const move = () => {
    if (!moving) return;
    const parentId = target || null;
    if (moving.container) updateContainer({ ...moving.container, parentId });
    else updateTask(moving.object.id, { containerId: parentId });
    setMoving(null); reveal(parentId);
  };
  const roots = recent ? projectRecentConversations(snapshot) : projectOrganization(snapshot, { flat: grouping === 'flat' });
  const needle = query.trim().toLocaleLowerCase();
  function search(nodes: OrganizationNode[]): OrganizationNode[] {
    if (!needle) return nodes;
    return nodes.flatMap(node => {
      const hit = name(node).toLocaleLowerCase().includes(needle);
      const children = hit && node.container ? node.children : search(node.children);
      const body = byId.get(node.object.id)?.messages.some(m => m.text.toLocaleLowerCase().includes(needle));
      return hit || body || children.length ? [{ ...node, children }] : [];
    });
  }
  function row(node: OrganizationNode): React.ReactNode {
    const c = node.container;
    const expandable = !!(c || node.children.length);
    const expanded = !!needle || (pref.expanded[node.key] ?? (!!c && (c.kind === 'project' || selectedPath.includes(c.id))));
    const toggle = () => { if (!needle) update({ expanded: { [node.key]: !expanded } }); };
    const activate = () => c ? toggle() : open(node.object.id);
    const label = name(node);
    const menu = <>
      {c ? <>
        <DropdownMenuItem onClick={() => { reveal(c.id); createTask(c.id); }}><Glyph name="chat-new" />新建会话</DropdownMenuItem>
        <DropdownMenuItem onClick={() => editGroup(c.id)}><Glyph name="folder-add" />新建分组</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setProject({ name: '', parent: c.id })}><Glyph name="code-box" />添加项目</DropdownMenuItem>
        <DropdownMenuSeparator />
      </> : <>
        <DropdownMenuItem onClick={() => setRenaming({ id: node.object.id, title: label })}><Glyph name="pencil-ai" />重命名</DropdownMenuItem>
        <DropdownMenuItem onClick={() => updateTask(node.object.id, { pinned: !node.conversation?.pinned })}>
          <Glyph name={node.conversation?.pinned ? 'unpin' : 'pushpin'} />{node.conversation?.pinned ? '取消置顶' : '置顶'}
        </DropdownMenuItem>
      </>}
      <DropdownMenuItem onClick={() => startMove(node)}><Glyph name="folder-received" />移动到…</DropdownMenuItem>
    </>;
    return <div key={node.key}><OrganizationRow id={node.key} title={label}
      icon={c ? <OrganizationContainerIcon container={c} /> : <Glyph name={byId.get(node.object.id)?.parent ? 'git-branch' : 'chat-thread'} />}
      container={!!c} active={!c && selected === node.object.id} expandable={expandable} expanded={expanded} recent={recent}
      time={byId.get(node.object.id)?.time} path={!c && (recent || grouping === 'flat' || !!needle) ? location(node.parentId) || '未分类' : undefined}
      selecting={false} selected={false} pinned={node.conversation?.pinned} menu={menu} menuBoundary={menuBoundary} onSelect={activate} onOpen={activate} onToggle={toggle}
      onKeyDown={e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); activate(); } }} />
      {expanded && expandable && <div role="group" className={c ? 'organization-children' : 'organization-task-children'}>
        {node.children.length ? <>{node.children.filter(child => child.container).map(row)}{node.children.filter(child => !child.container).map(row)}</> :
          <p className="work-directory-empty">暂无会话</p>}
      </div>}</div>;
  }
  const visible = search(roots);
  const containers = visible.filter(n => n.container);
  const threads = visible.filter(n => !n.container);
  return <section className="work-directory" data-touch-directory>
    <header><div className="organization-tabs" role="tablist" aria-label="工作台会话视图">
      {(['recent', 'classified'] as const).map(v => <button key={v} type="button" role="tab" aria-selected={pref.view === v} onClick={() => update({ view: v })}>{v === 'recent' ? '最近' : '分类'}</button>)}
    </div><div className="bar-actions">
      {!recent && <Flyout label="列表样式" trigger={<Glyph name={grouping === 'flat' ? 'list-unordered' : 'node-tree'} />}>{close =>
        (['by-worktree', 'flat'] as const).map(v => <button key={v} className="choice" onClick={() => { setGrouping(v); close(); }}>
          {v === 'flat' ? '平铺列表' : '树状列表'}{grouping === v && <Glyph name="check" />}</button>)}</Flyout>}
      <Flyout label="添加分组或项目" trigger={<Glyph name="folder-add" />}>{close => <>
        <button className="choice" onClick={() => { close(); editGroup(null); }}>新建分组</button>
        <button className="choice" onClick={() => { close(); setProject({ parent: null, name: '' }); }}>添加项目</button></>}</Flyout>
    </div></header>
    <div role="tree" aria-label="工作台会话">{containers.map(row)}
      {!recent && threads.length > 0 && <h3>未分类</h3>}{threads.map(row)}</div>
    {!visible.length && <p className="empty">{needle ? '没有匹配的会话' : '暂无会话'}</p>}
    <OrganizationGroupDialog value={group} onChange={setGroup} location={location(group?.parentId ?? null) || '全部分类'} pending={false} onSubmit={() => {
      if (!group) return;
      addContainer({ ...container(group.id, 'group', group.name.trim(), group.parentId, snapshot.containers.length), icon: group.icon, color: group.color || null }); setGroup(null);
    }} />
    <Dialog open={project !== null} onOpenChange={v => { if (!v) setProject(null); }}><DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>添加项目</DialogTitle></DialogHeader>{project && <form className="grid gap-4" onSubmit={e => {
        e.preventDefault(); if (!project.name.trim()) return;
        addContainer(container(crypto.randomUUID(), 'project', project.name.trim(), project.parent, snapshot.containers.length)); setProject(null);
      }}><Input autoFocus aria-label="项目名称" placeholder="项目名称" value={project.name} onChange={e => setProject({ ...project, name: e.target.value })} />
        <DialogFooter><Button type="submit" disabled={!project.name.trim()}>添加项目</Button></DialogFooter></form>}</DialogContent></Dialog>
    <Dialog open={!!renaming} onOpenChange={v => { if (!v) setRenaming(null); }}><DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>重命名</DialogTitle></DialogHeader>{renaming && <form className="grid gap-4" onSubmit={e => {
        e.preventDefault(); const title = renaming.title.trim(); if (!title) return;
        updateTask(renaming.id, { title }); setRenaming(null);
      }}><Input autoFocus aria-label="会话名称" value={renaming.title} onChange={e => setRenaming({ ...renaming, title: e.target.value })} />
        <DialogFooter><Button type="submit" disabled={!renaming.title.trim()}>保存</Button></DialogFooter></form>}</DialogContent></Dialog>
    <Dialog open={!!moving} onOpenChange={v => { if (!v) setMoving(null); }}><DialogContent className="max-w-sm">
      <DialogHeader><DialogTitle>移动到…</DialogTitle></DialogHeader>{moving && <><label>{name(moving)}
        <select className="bot-group-select" aria-label="目标分类" value={target} onChange={e => setTarget(e.target.value)}>
          <option value="">未分类</option>{snapshot.containers.filter(c => organizationDropAllowed(snapshot, [moving], { parentId: c.id, before: null })).map(c => <option key={c.id} value={c.id}>{location(c.id)}</option>)}
        </select></label><DialogFooter><Button onClick={move}>移动到这里</Button></DialogFooter></>}</DialogContent></Dialog>
  </section>;
}
