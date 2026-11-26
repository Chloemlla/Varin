import React from 'react';
import { Popover } from '@base-ui/react/popover';
import { Icon, type IconProps } from '@/components/icon/Icon';
import { Button } from '@/components/ui/button';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger, DropdownMenuRadioGroup, DropdownMenuRadioItem } from '@/components/ui/dropdown-menu';
import { useRoster } from './roster';
import { ComposerEditor, type ComposerEditorHandle } from '@/components/chat/composer/editor/ComposerEditor';
import { ModelLogo } from '@/components/ui/ModelLogo';
import { isGroup, people, type Mode, type Person, type Room } from './sample';

export function Glyph({ name }: { name: IconProps['name'] }) {
  return <Icon name={name} className="size-4" />;
}

export function Face({ names, size = 32 }: { names: Person[]; size?: number }) {
  const { bots } = useRoster();
  return <span className="group-chat-faces">{names.slice(0, 2).map(name =>
    <span key={name} className="group-chat-avatar" style={{ width: size, height: size }}>
      <BotFigure appearance={bots.find(b => b.id === name)?.appearance} state="idle" size={size} portrait still />
    </span>)}</span>;
}

export function ModeMenu({ mode, change }: { mode: Mode; change(value: Mode): void }) {
  const label = (value: Mode) => value === 'bot' ? 'Varin' : '工作台';
  const icon = (value: Mode) => value === 'bot' ? <VarinLogo decorative width={16} height={16} /> : <Glyph name="workbench-agent" />;
  return <DropdownMenu><DropdownMenuTrigger asChild>
    <Button variant="ghost" size="sm" data-varin-workbench-switcher="" className="h-7 gap-1.5 rounded-md bg-interactive-hover px-2 typography-meta font-medium" aria-label={'切换模式：' + label(mode)}>
      {icon(mode)}{label(mode)}<Icon name="arrow-down-s" className="size-3.5 opacity-60" />
    </Button></DropdownMenuTrigger><DropdownMenuContent align="start" className="min-w-44">
      <DropdownMenuRadioGroup value={mode} onValueChange={value => change(value as Mode)}>
        {(['bot', 'work'] as const).map(value => <DropdownMenuRadioItem key={value} value={value} closeOnClick>{icon(value)}{label(value)}</DropdownMenuRadioItem>)}
      </DropdownMenuRadioGroup></DropdownMenuContent></DropdownMenu>;
}

export function IconButton({ name, label, onClick, settingsOrigin }: {
  name: IconProps['name']; label: string; onClick: React.MouseEventHandler<HTMLButtonElement>; settingsOrigin?: 'open' | 'return';
}) {
  return <Button type="button" variant="ghost" size="icon" data-varin-settings-origin={settingsOrigin} aria-label={label} title={label} onClick={onClick}><Glyph name={name} /></Button>;
}

export function Flyout({ label, trigger, children, align = 'end', side = 'bottom' }: {
  label: string; trigger: React.ReactNode; children(close: () => void): React.ReactNode;
  align?: 'start' | 'end'; side?: 'bottom' | 'top';
}) {
  const [open, setOpen] = React.useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="fly-trigger" title={label} aria-label={label}>{trigger}</Popover.Trigger>
    <Popover.Portal><Popover.Positioner className="fly-position" align={align} side={side} sideOffset={6}
      collisionBoundary={document.querySelector<HTMLElement>('.device') ?? undefined} collisionPadding={8}>
      <Popover.Popup aria-label={label} className="fly-popup">
        {children(() => setOpen(false))}
      </Popover.Popup>
    </Popover.Positioner></Popover.Portal>
  </Popover.Root>;
}

export function Choices({ label, values, selected, onSelect, trigger, side, align }: {
  label: string; values: string[]; selected?: string; onSelect(value: string): void; trigger: React.ReactNode;
  side?: 'top' | 'bottom'; align?: 'start' | 'end';
}) {
  return <Flyout {...{ label, trigger, side, align }}>{close => values.map(value =>
    <button className="choice" key={value} onClick={() => { onSelect(value); close(); }}>
      {value}{value === selected && <Glyph name="check" />}
    </button>)}</Flyout>;
}

type Draft = { text: string; quote?: string; attachment?: string };
export type { Draft };
const language = { inputMode: 'normal' as const, knownAgentNames: new Set(people), confirmedMentions: new Set<string>(), knownSlashNames: new Set<string>(), attachmentFilenames: [] };

export function Compose({ editor, room, draft, change, send, model, setModel, effort, setEffort }: {
  editor: React.RefObject<ComposerEditorHandle | null>;
  room: Room; draft: Draft; change(value: Draft): void; send(): void;
  model: string; setModel(value: string): void; effort: string; setEffort(value: string): void;
}) {
  const input = React.useRef<HTMLInputElement>(null);
  const group = isGroup(room);
  const { display } = useRoster();
  const members = room.people.map(display);
  const [permission, setPermission] = React.useState('先问我');
  function mention(name: string) {
    const control = editor.current;
    if (!control) return;
    const end = control.getSelection().end;
    const typed = /@[^\s@]*$/u.exec(control.getValue().slice(0, end));
    control.replaceRange(typed ? end - typed[0].length : end, end, '@' + name + ' ');
    control.focus();
  }
  const [cursor, setCursor] = React.useState(0);
  const query = group && /@([^\s@]*)$/u.exec(draft.text.slice(0, cursor));
  const matches = query ? room.people.filter(p => display(p).startsWith(query[1])) : [];
  return <div className="compose-wrap">
    <div className="compose-box rounded-composer bg-muted border border-border" data-conversation-composer-input-frame="true">
      {matches.length > 0 && <div className="mention-list">{matches.map(p => <button key={p} onClick={() => mention(display(p))}><Face names={[p]} size={23} />{display(p)}</button>)}</div>}
      {(['quote', 'attachment'] as const).map(key => draft[key] && <div className="draft-ref" key={key}><Glyph name={key === 'quote' ? 'chat-quote' : 'attachment-2'} /><span>{draft[key]}</span><IconButton name="close" label="移除" onClick={() => change({ ...draft, [key]: undefined })} /></div>)}
      <ComposerEditor ref={editor} draftKey={room.id} value={draft.text} onChange={c => { change({ ...draft, text: c.value }); setCursor(c.selection.end); }}
        onSelectionChange={s => setCursor(s.end)} languageContext={language} maxLines={4} className="compose-editor" aria-label="消息"
        placeholder={group ? '发消息，@ 群成员…' : '描述你想做的事…'} />
      <div className="conversation-composer-footer compose-tools" data-mobile-model-toolbar="">
        <div className="conversation-composer-options">
          <input type="file" ref={input} hidden onChange={e => { const f = e.target.files?.[0]; if (f) change({ ...draft, attachment: f.name }); e.target.value = ''; }} />
          <IconButton name="add" label="附加文件" onClick={() => input.current?.click()} />
          {!group && <Choices label="确认模式" trigger={<Glyph name="shield-user" />} values={['先问我', '智能判断', '直接执行']} selected={permission} onSelect={setPermission} side="top" align="start" />}
          {group && <Choices label="提及成员" trigger="@" values={members} onSelect={mention} side="top" align="start" />}
        </div>
        <div className="conversation-composer-models">
          {group ? <small>{members.filter(p => draft.text.includes('@' + p)).map(p => '@' + p).join('、') || (draft.quote ? '回复消息' : '仅记录')}</small> : <>
            <Choices label="思考强度" trigger={<><Glyph name="brain" />{effort}</>} values={['低', '中', '高']} selected={effort} onSelect={setEffort} side="top" />
            <Choices label="选择模型" trigger={<><ModelLogo modelId={model} className="size-4 shrink-0" /><span className="choice-label">{model}</span></>} values={['DeepSeek V4.1 Flash', 'GPT-6.2']} selected={model} onSelect={setModel} side="top" />
          </>}
        </div>
        <div className="conversation-composer-actions"><Button size="icon" variant="ghost" disabled aria-label="语音输入（仅预览布局）"><Glyph name="mic" /></Button>
          <Button size="icon" className="send" aria-label="发送" disabled={!draft.text.trim() && !draft.attachment} onClick={send}><Glyph name="arrow-up" /></Button>
        </div>
      </div>
    </div>
  </div>;
}
