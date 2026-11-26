import React from 'react';
import { BotFigure } from '@/workbenches/bot/BotFigure';
import { Glyph, IconButton } from './controls';
import { useRoster } from './roster';
import { isGroup, type Room } from './sample';

/** Keep the same member order in the conversation and the members page. */
export function ConversationPortraits({ ids, group = false }: { ids: string[]; group?: boolean }) {
  const { bots } = useRoster();
  const members = ids.slice(0, group ? 3 : 1);
  return <span className="conversation-portraits" data-group={group || undefined} data-count={members.length} aria-hidden="true">
    {members.map(id => <span className="conversation-portrait" key={id}>
      <BotFigure appearance={bots.find(b => b.id === id)?.appearance} state="idle" portrait still size={group ? 39 : 51} />
    </span>)}
  </span>;
}

export function ConversationHeading({ room, back, details, services }: {
  room: Room; back?: () => void; details(): void; services?: React.ReactNode;
}) {
  const { display } = useRoster();
  const group = isGroup(room);
  const work = room.mode === 'work';
  const label = group ? '群聊详情' : work ? '会话详情' : 'Bot 面板';
  const captionId = React.useId();
  const botName = display(room.people[0]);
  return <header className="conversation-heading" data-work={work || undefined}>
    <div className="heading-edge">{back && <IconButton name="arrow-left" label="返回" onClick={back} />}</div>
    <button type="button" className="heading-identity" onClick={details} aria-label={label} aria-describedby={captionId} title={label}>
      {work ? <Glyph name="workbench-agent" /> : <ConversationPortraits ids={room.people} group={group} />}
      <span className="heading-caption" id={captionId}>
        {!group && !work && botName !== room.title && <small>{botName}</small>}
        <strong>{room.title}</strong>{group && <small>{room.people.length} 人</small>}
        <Glyph name="arrow-down-s" />
      </span>
    </button>
    <div className="heading-edge">{services}</div>
  </header>;
}
