import React from 'react';
import { useI18n } from '@/lib/i18n';
import { getSafeStorage } from '@/stores/utils/safeStorage';

/** Change the grid track directly while dragging. Persist only the settled tablet width. */
export function MobilePaneDivider({ side }: { side: 'left' | 'right' }) {
  const { t } = useI18n();
  const ref = React.useRef<HTMLDivElement>(null);
  const start = React.useRef<{ id: number; x: number; width: number } | null>(null);
  const key = side === 'left' ? 'varin.ipad.leftSidebarWidth' : 'varin.ipad.rightSidebarWidth';
  const property = side === 'left' ? '--mobile-list-size' : '--mobile-panel-size';
  React.useLayoutEffect(() => {
    const root = ref.current?.closest<HTMLElement>('.mobile-conversation-pages');
    const saved = Number(getSafeStorage().getItem(key));
    if (root && saved > 0) root.style.setProperty(property, saved + 'px');
  }, [key, property]);
  const adjust = (node: HTMLElement, width: number) => {
    const root = node.closest<HTMLElement>('.mobile-conversation-pages');
    root?.style.setProperty(property, width + 'px');
  };
  const widthOf = (node: HTMLElement) => node.parentElement!.getBoundingClientRect().width;
  const save = (node: HTMLElement) => getSafeStorage().setItem(key, String(Math.round(widthOf(node))));
  return <div ref={ref} role="separator" tabIndex={0} aria-orientation="vertical" aria-label={t(side === 'left' ? 'sidebar.resize.leftPanelAria' : 'sidebar.resize.rightPanelAria')}
    className="mobile-pane-divider" data-side={side}
    onPointerDown={e => { if (e.button !== 0) return; start.current = { id: e.pointerId, x: e.clientX, width: widthOf(e.currentTarget) }; e.currentTarget.setPointerCapture(e.pointerId); }}
    onPointerMove={e => { const drag = start.current; if (drag?.id === e.pointerId) adjust(e.currentTarget, drag.width + (side === 'left' ? 1 : -1) * (e.clientX - drag.x)); }}
    onLostPointerCapture={e => { if (start.current) save(e.currentTarget); start.current = null; }}
    onKeyDown={e => { if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return; e.preventDefault();
      adjust(e.currentTarget, widthOf(e.currentTarget) + ((e.key === 'ArrowRight') === (side === 'left') ? 16 : -16)); save(e.currentTarget); }} />;
}
