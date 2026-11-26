import React from 'react';
import { AnimatePresence, motion, useIsPresent } from 'motion/react';
import { Icon } from '@/components/icon/Icon';
import { useI18n } from '@/lib/i18n';
import { useMotionLevel } from '@/hooks/usePrefersReducedMotion';
import './mobile-conversation.css';
import { MobilePaneDivider } from './MobilePaneDivider';

export function MobileBackButton({ onClick, label }: { onClick(): void; label?: string }) {
  const { t } = useI18n();
  return <button type="button" className="mobile-page-action" onClick={onClick} aria-label={label ?? t('filesView.editor.back')}>
    <Icon name="arrow-left" className="size-5" />
  </button>;
}

function DetailPage({ title, close, children, sideBySide }: { title: string; close(): void; children: React.ReactNode; sideBySide: boolean }) {
  const level = useMotionLevel();
  const present = useIsPresent();
  const back = React.useRef<HTMLDivElement>(null);
  React.useLayoutEffect(() => { back.current?.querySelector('button')?.focus({ preventScroll: true }); }, []);
  return <motion.section className="mobile-detail-page" aria-label={title} inert={!present}
    initial={{ opacity: 0, y: level === 'full' ? 18 : 0 }} animate={{ opacity: 1, y: 0 }}
    exit={{ opacity: 0, y: level === 'full' ? 18 : 0 }} transition={{ duration: level === 'off' ? 0 : .2, ease: 'easeOut' }}>
    <div ref={back} className="mobile-detail-heading"><MobileBackButton onClick={close} /><strong>{title}</strong></div>
    <div className="mobile-detail-body">{children}</div>
    {sideBySide && <MobilePaneDivider side="right" />}
  </motion.section>;
}

/** A conversation keeps its editor and scroll owner while the directory or its detail page is shown. */
export function MobileConversationPages({ listOpen, split = false, sideBySide = false, directory, children, detail }: {
  listOpen: boolean; split?: boolean; sideBySide?: boolean; directory: React.ReactNode; children: React.ReactNode;
  detail?: { title: string; close(): void; content: React.ReactNode };
}) {
  const visibleList = split || listOpen;
  const [visited, setVisited] = React.useState(visibleList);
  const detailOpen = !!detail;
  const hideChat = (!split && listOpen) || (detailOpen && !sideBySide);
  React.useEffect(() => { if (visibleList) setVisited(true); }, [visibleList]);
  const restoreFocus = React.useRef<HTMLElement | null>(null);
  const hadDetail = React.useRef(false);
  React.useLayoutEffect(() => {
    if (detailOpen) { hadDetail.current = true; return; }
    if (!hadDetail.current) return;
    hadDetail.current = false;
    const target = restoreFocus.current;
    if (target?.isConnected && !target.closest('[inert]')) target.focus({ preventScroll: true });
    restoreFocus.current = null;
  }, [detailOpen]);
  return <div className="mobile-conversation-pages" data-list={listOpen || undefined} data-split={split || undefined} data-side-panel={sideBySide && detailOpen || undefined}>
    <nav className="mobile-directory-page" inert={!visibleList} aria-hidden={!visibleList}>{(visibleList || visited) && directory}{split && <MobilePaneDivider side="left" />}</nav>
    <section className="mobile-chat-page" inert={hideChat} aria-hidden={hideChat}
      onFocusCapture={e => { if (!detail) restoreFocus.current = e.target; }}>
      {children}
    </section>
    <AnimatePresence>{detail && <DetailPage key="details" sideBySide={sideBySide} title={detail.title} close={detail.close}>{detail.content}</DetailPage>}</AnimatePresence>
  </div>;
}
