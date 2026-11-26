import React from 'react';
import type { MobileDocumentLink } from '@/contexts/mobile-pages';
import { useUIStore } from '@/stores/useUIStore';

type Page = { kind: 'directory' | 'chat' | 'details' } | { kind: 'document'; link: MobileDocumentLink };
type Visit = { scope: string; page: Page; owner?: string | null; previous?: Page['kind']; url: string };
const currentVisit = (): Visit | undefined => window.history.state?.varinMobileVisit;
const isDetail = (page: Page) => page.kind === 'details' || page.kind === 'document';

/** One page selection per active shell. The shared sidebar command also serves extensions and deep links. */
export function useMobilePageNavigation(scope: string, active: boolean, owner?: string | null) {
  const [page, setPage] = React.useState<Page>(() => ({ kind: useUIStore.getState().isSessionSwitcherOpen ? 'directory' : 'chat' }));
  const current = React.useRef(page);
  const commit = React.useCallback((next: Page) => {
    current.current = next;
    setPage(next);
    useUIStore.getState().setSessionSwitcherOpen(next.kind === 'directory');
  }, []);
  const navigate = React.useCallback((next: Page) => {
    if (!active) return;
    const previous = current.current;
    if (next.kind === previous.kind && next.kind !== 'document') return;
    const stamp = currentVisit();
    const url = location.href;
    const leavingPage = next.kind === 'directory' || (isDetail(previous) && next.kind === 'chat');
    const returnToPrevious = leavingPage && stamp?.scope === scope && stamp.previous === next.kind && stamp.url === url
      && (stamp.owner === owner || next.kind === 'directory');
    commit(next);
    if (returnToPrevious) { history.back(); return; }
    const visit: Visit = { scope, page: next, owner, url };
    if (leavingPage) { history.replaceState({ ...history.state, varinMobileVisit: visit }, ''); return; }
    if (stamp?.scope !== scope) history.replaceState({ ...history.state, varinMobileVisit: { scope, page: previous, owner, url } }, '');
    history.pushState({ ...history.state, varinMobileVisit: { ...visit, previous: previous.kind } }, '');
  }, [active, scope, owner, commit]);
  React.useEffect(() => {
    if (!active) return;
    const restore = () => {
      const visit = currentVisit();
      const next = visit?.scope === scope && (!isDetail(visit.page) || visit.owner === owner) ? visit.page : { kind: 'chat' } as const;
      commit(next);
    };
    if (currentVisit()?.scope === scope) restore();
    const unsubscribe = useUIStore.subscribe((state, prior) => {
      if (state.isSessionSwitcherOpen === prior.isSessionSwitcherOpen || state.isSessionSwitcherOpen === (current.current.kind === 'directory')) return;
      navigate({ kind: state.isSessionSwitcherOpen ? 'directory' : 'chat' });
    });
    window.addEventListener('popstate', restore);
    return () => { unsubscribe(); window.removeEventListener('popstate', restore); };
  }, [active, scope, owner, navigate, commit]);
  const priorOwner = React.useRef(owner);
  React.useLayoutEffect(() => {
    if (active && priorOwner.current !== owner && isDetail(current.current)) commit({ kind: 'chat' });
    priorOwner.current = owner;
  }, [active, commit, owner]);
  return { page, navigate };
}
