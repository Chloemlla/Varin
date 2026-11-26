import React from 'react';
import { Icon } from '@/components/icon/Icon';
import type { BotSummary } from '@varin/application-client';
import { BotFigure } from './BotFigure';
import { GroupAvatar } from './GroupAvatar';

export function MobilePortraits({ members }: { members: { id: string; name: string; bot?: BotSummary }[] }) {
  const shown = members.slice(0, 3);
  const size = shown.length > 1 ? 39 : 51;
  return <span className="mobile-portraits" data-count={shown.length} aria-hidden="true">
    {shown.map(member => <span key={member.id}>{member.bot
      ? <BotFigure bot={member.bot} state="idle" portrait still size={size} />
      : <GroupAvatar name={member.name} size={size} />}</span>)}
  </span>;
}

export function BotMobileTitle({ members, title, caption, label, open, onToggle }: {
  members: React.ComponentProps<typeof MobilePortraits>['members']; title: string; caption?: string;
  label: string; open: boolean; onToggle(): void;
}) {
  return <button type="button" className="mobile-chat-identity" aria-expanded={open} aria-label={label + ' · ' + title} onClick={onToggle}>
    <MobilePortraits members={members} /><span className="mobile-identity-caption"><strong>{title}</strong>
      {caption && caption !== title && <small>{caption}</small>}<Icon name="arrow-down-s" className="size-3 shrink-0" /></span>
  </button>;
}
