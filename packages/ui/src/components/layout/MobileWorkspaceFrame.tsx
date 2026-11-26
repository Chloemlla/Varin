import React from 'react';
import { useMobileLayoutInfo, useMobileLayoutRootAttributes } from '@/lib/mobileLayoutTier';
import { activationPoint } from '@/lib/motion/pointer';
import { Icon } from '@/components/icon/Icon';
import { useWorkbenchShellActive } from '@/lib/workbench/shell-activity';
import { useI18n } from '@/lib/i18n';
import { useSettingsTransition } from './useSettingsTransition';
import { MobileBackButton, MobileConversationPages } from './MobileConversationPages';
import { useMobilePageNavigation } from './useMobilePageNavigation';
import { WorkbenchReplacement, WORKBENCH_REPLACEMENT_TARGETS } from '@/lib/extensions/workbench-registry';
import { MobilePageContext, type MobileDocumentLink } from '@/contexts/mobile-pages';
import type { BotGroupSummary, ThreadIdentity } from '@varin/application-client';
import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { MobileTaskSurfaces } from './MobileTaskSurfaces';
import { useNativeAndroidBackButton } from '@/apps/useNativeAndroidBackButton';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { requestSettingsNavigation } from '@/lib/settings/drafts';

const SettingsView = lazyWithChunkRecovery(() => import('@/components/views/SettingsView').then(m => ({ default: m.SettingsView })));
const Files = lazyWithChunkRecovery(() => import('@/apps/MobileFilesSurface').then(m => ({ default: m.MobileFilesSurface })));

type Navigation = { open: boolean; toggle(): void };
export function MobileWorkspaceFrame({ scope, conversationKey, identity, directory, title, actions, detail, detailLabel, detailFocus, onDetailClose, children, scheduledGroup, beforeBack, initialSettingsStage }: {
  scope: 'bot' | 'workbench'; conversationKey?: string | null; identity?: ThreadIdentity | null; directory(visible: boolean): React.ReactNode; title(panel: Navigation): React.ReactNode;
  actions?: React.ReactNode; detail(visible: boolean, close: () => void): React.ReactNode; detailLabel: string; detailFocus?: string | null; onDetailClose?(): void;
  children: React.ReactNode; scheduledGroup?: BotGroupSummary; beforeBack?(): boolean;
  initialSettingsStage?: 'nav' | 'page-content';
}) {
  const active = useWorkbenchShellActive();
  const { t } = useI18n();
  const layout = useMobileLayoutInfo();
  useMobileLayoutRootAttributes(layout, active);
  const wide = layout.isTablet && layout.viewportWidth >= 760;
  const [rail, setRail] = React.useState(true);
  const split = wide && rail;
  const settings = useSettingsTransition(active, 'page');
  const settingsBack = React.useRef<(() => void) | null>(null);
  const host = useThreadStore(s => s.hostKey);
  const { page, navigate } = useMobilePageNavigation(JSON.stringify([host, scope]), active && !settings.open, conversationKey);
  const list = page.kind === 'directory';
  const details = page.kind === 'details' || page.kind === 'document';
  const documentLink = page.kind === 'document' ? page.link : null;
  const setPanel = React.useCallback((open: boolean) => navigate({ kind: open ? 'details' : 'chat' }), [navigate]);
  const previousDetails = React.useRef(details);
  React.useEffect(() => {
    if (previousDetails.current && !details) onDetailClose?.();
    previousDetails.current = details;
  }, [details, onDetailClose]);
  const lastFocus = React.useRef<string | null | undefined>(undefined);
  React.useEffect(() => {
    if (active && detailFocus && lastFocus.current !== detailFocus) setPanel(true);
    lastFocus.current = detailFocus;
  }, [detailFocus, setPanel, active]);
  useNativeAndroidBackButton(active, () => {
    if (settings.open) { if (settingsBack.current) settingsBack.current(); else requestSettingsNavigation(() => settings.close()); return true; }
    if (beforeBack?.()) return true;
    const ui = useUIStore.getState();
    if (ui.isScheduledTasksDialogOpen || ui.isArchivePageOpen || ui.worktreesPageProjectId || ui.isMultiRunLauncherOpen) { ui.closeMainSurfaces(); return true; }
    if (details) { setPanel(false); return true; }
    if (!split && !list) { navigate({ kind: 'directory' }); return true; }
    return false;
  });
  const navigation = React.useMemo(() => ({ showDetails: setPanel, openDocument: (link: MobileDocumentLink) => navigate({ kind: 'document', link }) }), [setPanel, navigate]);
  return <MobilePageContext.Provider value={navigation}><div className="mobile-workspace-frame varin-mobile-app-shell main-content-safe-area" data-mobile-layout-tier={layout.tier} data-mobile-layout-kind={layout.kind} data-page-scroll-lock="true">
    <div className="mobile-workspace-content" hidden={settings.open} inert={settings.open}>
      <MobileConversationPages listOpen={list} split={split} sideBySide={wide && layout.isLandscape && layout.viewportWidth >= (split ? 1100 : 900)} directory={directory(split || list)}
        detail={details ? { title: documentLink ? t('mobile.menu.files') : detailLabel, close: () => setPanel(false),
          content: documentLink ? <ErrorBoundary><React.Suspense fallback={null}><Files initialFile={documentLink} quoteTarget={identity}
            onQuoted={() => setPanel(false)} /></React.Suspense></ErrorBoundary> : detail(true, () => setPanel(false)) } : undefined}>
        <header className="mobile-chat-heading">
          <div>{wide ? <button type="button" className="mobile-page-action" aria-expanded={rail} aria-label={t('mobile.sessions.openSheetAria')}
            onClick={() => { if (list) navigate({ kind: 'chat' }); setRail(v => !v); }}><Icon name="layout-left" className="size-5" /></button>
            : <MobileBackButton label={t('mobile.sessions.openSheetAria')} onClick={() => navigate({ kind: 'directory' })} />}</div>
          {title({ open: details, toggle: () => setPanel(!details) })}
          <div>{actions}</div>
        </header>
        {children}
      </MobileConversationPages>
      <ErrorBoundary><MobileTaskSurfaces group={scheduledGroup} /></ErrorBoundary>
    </div>
    {settings.open && <div className="mobile-workspace-settings">
      {wide && <button className="mobile-page-action" aria-label={t('settings.view.actions.closeSettings')} data-varin-settings-origin="return"
        onClick={event => { const point = activationPoint(event); requestSettingsNavigation(() => settings.close(point)); }}><Icon name="arrow-left" className="size-5" /></button>}
      <div className="min-h-0 flex-1"><ErrorBoundary><WorkbenchReplacement target={WORKBENCH_REPLACEMENT_TARGETS.settings}
      fallback={<React.Suspense fallback={null}><SettingsView forceMobile={!wide} initialMobileStage={initialSettingsStage} backActionRef={settingsBack}
        onClose={settings.close} /></React.Suspense>} /></ErrorBoundary></div></div>}
    {settings.layer}
  </div></MobilePageContext.Provider>;
}
