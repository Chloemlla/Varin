import React from 'react';
import { applyBotOrganizationChange, botOrganizationSections, emptyBotOrganization, type BotAppearance, type BotOrganization, type BotSummary } from '@varin/application-client';
import { BotNameDialog } from '@/components/sections/bots/BotNameDialog';
import { BotOrganizationList } from '@/workbenches/bot/BotOrganizationList';
import { BotOrganizationDialog, type BotOrganizationDialogState } from '@/workbenches/bot/BotOrganizationDialog';
import type { BotOrganizationController } from '@/workbenches/bot/useBotOrganization';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Face, Glyph, IconButton } from './controls';
import { useRoster } from './roster';

export type CreateKind = 'chat' | 'bot' | 'folder' | 'group';
export function BotDirectory({ action, close, query, newBot, newChat, newGroup, selectBot, openCreate }: {
  action: CreateKind | null; close(): void; query: string; newBot(name: string, appearance?: BotAppearance): void;
  openCreate(): void;
  newChat(id: string): void; newGroup(title: string, ids: string[]): void; selectBot(id: string): void;
}) {
  const { bots } = useRoster();
  const [org, setOrg] = React.useState<BotOrganization>(() => JSON.parse(sessionStorage.getItem('design.organization') ?? 'null') ?? emptyBotOrganization());
  const [dialog, setDialog] = React.useState<BotOrganizationDialogState | null>(null);
  const createFolder = React.useMemo<BotOrganizationDialogState>(() => ({ kind: 'create' }), []);
  const [name, setName] = React.useState('');
  const [members, setMembers] = React.useState<string[]>([]);
  const lastPicker = React.useRef<'group' | 'chat'>('chat');
  if (action === 'group' || action === 'chat') lastPicker.current = action;
  const pickingGroup = lastPicker.current === 'group';
  const [error, setError] = React.useState<string | null>(null);
  React.useEffect(() => { setName(''); setMembers([]); setError(null); }, [action, dialog]);
  const controller: BotOrganizationController = {
    value: org, sections: botOrganizationSections(bots, org), pending: false, ready: true, error, refresh: async () => {},
    async change(change) {
      try {
        const next = applyBotOrganizationChange(org, change, bots.map(b => b.id));
        sessionStorage.setItem('design.organization', JSON.stringify(next)); setOrg(next); return true;
      } catch (e) { setError(String(e)); return false; }
    },
  };
  const row = (bot: BotSummary) => <div className="directory-row">
    <button onClick={() => selectBot(bot.id)}><Face names={[bot.id]} size={28} />{bot.name}</button>
    <IconButton name="folder-received" label={'移动分组：' + bot.name} onClick={() => setDialog({ kind: 'move', bot })} />
  </div>;
  return <section className="bot-directory"><div className="list-heading"><h3>助手</h3>
    <Button variant="ghost" size="sm" onClick={openCreate}><Glyph name="add" />新建 Bot</Button></div>
    <BotOrganizationList bots={bots} organization={controller} selectedId={null} query={query} scope="mobile-design" renderBot={row} onDialog={setDialog} />
    <BotOrganizationDialog organization={controller} value={action === 'folder' ? createFolder : dialog} onClose={() => { setDialog(null); close(); }} />
    <BotNameDialog mode="create" open={action === 'bot'} name={name} onNameChange={setName} title="新建 Bot" submitLabel="创建"
      onOpenChange={opened => { if (!opened) close(); }} onSubmit={(n, a) => { newBot(n, a); close(); }} />
    <Dialog open={action === 'chat' || action === 'group'} onOpenChange={v => { if (!v) close(); }}>
      <DialogContent className="max-w-sm"><DialogHeader><DialogTitle>{pickingGroup ? '新建群聊' : '和谁开始会话？'}</DialogTitle></DialogHeader>
        {pickingGroup && <Input value={name} onChange={e => setName(e.target.value)} placeholder="群聊名称" aria-label="群聊名称" />}
        <div>{bots.map(bot => pickingGroup ? <label key={bot.id} className="member-pick"><Face names={[bot.id]} size={25} />{bot.name}
          <input type="checkbox" checked={members.includes(bot.id)} onChange={e => setMembers(e.target.checked ? [...members, bot.id] : members.filter(id => id !== bot.id))} /></label> :
          <button className="member-pick" key={bot.id} onClick={() => { close(); newChat(bot.id); }}><Face names={[bot.id]} size={25} />{bot.name}<Glyph name="arrow-right-s" /></button>)}</div>
        {pickingGroup && <Button disabled={!name.trim() || !members.length} onClick={() => { newGroup(name.trim(), members); close(); }}>创建群聊</Button>}
      </DialogContent>
    </Dialog>
  </section>;
}
