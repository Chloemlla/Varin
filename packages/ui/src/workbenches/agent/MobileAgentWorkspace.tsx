import React from 'react';
import { useI18n } from '@/lib/i18n';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useWorkbenchShellActive } from '@/lib/workbench/shell-activity';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useGitStatus, useGitStore } from '@/stores/useGitStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useExternalAgentStore } from '@/stores/useExternalAgentStore';
import { usePreferencesStore } from '@/stores/usePreferencesStore';
import { useUpdateStore } from '@/stores/useUpdateStore';
import { normalizeContextPanelDirectoryKey, useUIStore } from '@/stores/useUIStore';
import { WorkbenchReplacement, WORKBENCH_REPLACEMENT_TARGETS } from '@/lib/extensions/workbench-registry';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { isCapacitorApp } from '@/lib/platform';
import { Icon } from '@/components/icon/Icon';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MobileWorkspaceFrame } from '@/components/layout/MobileWorkspaceFrame';
import { MobileServicesMenu } from '@/components/layout/MobileServicesMenu';
import { ExternalContextDetails } from '@/components/layout/ExternalContextUsage';
import { useExternalContextSnapshot } from '@/components/layout/useExternalContextSnapshot';
import { ChatView } from '@/components/views/ChatView';
import { ThreadSidebar } from '@/components/thread/ThreadSidebar';
import { DedicatedMobileAppProvider, type MobileAppActions } from '@/apps/mobileAppContext';
import { useDeepLinkHandlers } from '@/apps/deepLinkNavigation';
import { useEdgeSwipeSessionChat } from '@/apps/useEdgeSwipeSessionSwitch';

const Tree = lazyWithChunkRecovery(() => import('@/components/thread/ConversationTreePanel').then(m => ({ default: m.ConversationTreePanel })));
const Files = lazyWithChunkRecovery(() => import('@/apps/MobileFilesSurface').then(m => ({ default: m.MobileFilesSurface })));
const Changes = lazyWithChunkRecovery(() => import('@/apps/MobileChangesSurface').then(m => ({ default: m.MobileChangesSurface })));
const Terminal = lazyWithChunkRecovery(() => import('@/components/views/TerminalView').then(m => ({ default: m.TerminalView })));
const About = lazyWithChunkRecovery(() => import('@/components/sections/varin/AboutSettings').then(m => ({ default: m.AboutSettings })));
const tabs = { tree: 'chat.tree.title', files: 'mobile.menu.files', changes: 'mobile.menu.changes' } as const;
const extra = { metadata: 'mobile.header.openMetadataAria', terminal: 'mobile.menu.terminal', instances: 'mobile.menu.instances', update: 'mobile.menu.update' } as const;
type Tab = keyof typeof tabs | keyof typeof extra;

function Metadata() {
  const { t } = useI18n();
  const { git } = useRuntimeAPIs();
  const directory = useDirectoryStore(s => s.currentDirectory);
  const status = useGitStatus(directory || null);
  const { snapshot } = useExternalContextSnapshot();
  React.useEffect(() => { if (directory) void useGitStore.getState().ensureStatus(directory, git); }, [directory, git]);
  return <div className="space-y-3 p-4 typography-ui-label"><p className="flex justify-between"><span>{t('mobile.header.metadata.branch')}</span>{status?.current || t('common.unavailable')}</p>
    {snapshot && <ExternalContextDetails snapshot={snapshot} />}</div>;
}

export function MobileAgentWorkspace({ instances }: { instances(close: () => void): React.ReactNode }) {
  const { t } = useI18n();
  const active = useWorkbenchShellActive();
  const identity = useThreadStore(s => s.selectedIdentity);
  const title = useThreadStore(s => s.threads.find(row => row.thread_id === s.selectedIdentity?.threadId)?.title);
  const externalId = useExternalAgentStore(s => s.selectedId);
  const externalTitle = useExternalAgentStore(s => s.conversations.find(c => c.id === s.selectedId)?.title);
  const key = normalizeContextPanelDirectoryKey(useDirectoryStore(s => s.currentDirectory));
  const treeRequested = useUIStore(s => { const panel = s.contextPanelByDirectory[key];
    return !!panel?.isOpen && panel.tabs.some(tab => tab.id === panel.activeTabId && tab.mode === 'tree'); });
  const [tab, setTab] = React.useState<Tab>('tree');
  const [focus, requestFocus] = React.useReducer(n => n + 1, 0);
  const [diff, setDiff] = React.useState<{ path?: string | null; staged?: boolean }>({});
  const [services, setServices] = React.useState(false);
  const [serviceTab, setServiceTab] = React.useState<'usage' | 'mcp'>('usage');
  const [settingsStage, setSettingsStage] = React.useState<'nav' | 'page-content'>('nav');
  const update = useUpdateStore(s => s.available && (s.runtimeType === 'desktop' || s.runtimeType === 'web'));
  const autoCheck = usePreferencesStore(s => s.settingsAutoUpdateChecksEnabled);
  const openTab = React.useCallback((next: Tab) => { setTab(next); requestFocus(); }, []);
  const openSettings = React.useCallback((section?: string) => {
    const ui = useUIStore.getState();
    if (section) ui.setSettingsPage(section as Parameters<typeof ui.setSettingsPage>[0]);
    setSettingsStage(section ? 'page-content' : 'nav'); ui.setSettingsDialogOpen(true);
  }, []);
  const closeTree = React.useCallback(() => { if (treeRequested) useUIStore.getState().closeContextPanel(key); }, [treeRequested, key]);
  React.useEffect(() => { if (treeRequested && active) openTab('tree'); }, [treeRequested, active, openTab]);
  const mobileActions = React.useMemo<MobileAppActions>(() => ({ openFiles: () => openTab('files'), openSettings,
    openChanges: ({ diffPath, staged } = {}) => { setDiff({ path: diffPath, staged }); openTab('changes'); } }), [openTab, openSettings]);
  const deepLinks = React.useMemo(() => ({
    openSessions: () => useUIStore.getState().setSessionSwitcherOpen(true),
    openSettings, openChanges: ({ path, staged }: { path?: string; staged?: boolean } = {}) => mobileActions.openChanges({ diffPath: path, staged }),
    openView: (target: 'files' | 'mcp' | 'instances' | 'update') => { if (target === 'mcp') { useUIStore.getState().setSessionSwitcherOpen(false); setServiceTab('mcp'); setServices(true); } else openTab(target); },
  }), [mobileActions, openSettings, openTab]);
  useDeepLinkHandlers(deepLinks);
  const chat = React.useRef<HTMLElement>(null), contents = React.useRef<HTMLDivElement>(null);
  useEdgeSwipeSessionChat(chat, contents, identity?.threadId ?? null);
  const detail = (_visible: boolean, close: () => void) => <div className="flex h-full min-h-0 flex-col">
    <div className="mobile-work-tabs"><div role="tablist" aria-label={t('conversationTools.title')}>
      {(Object.keys(tabs) as (keyof typeof tabs)[]).map(id => <button key={id} type="button" role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{t(tabs[id])}</button>)}
    </div><DropdownMenu><DropdownMenuTrigger asChild><button type="button" className="mobile-page-action" aria-label={t('mobile.header.openMenuAria')}><Icon name="more" className="size-5" /></button></DropdownMenuTrigger>
      <DropdownMenuContent align="end">{(Object.keys(extra) as (keyof typeof extra)[]).filter(id => (id !== 'instances' || isCapacitorApp()) && (id !== 'update' || (autoCheck && update))).map(id =>
        <DropdownMenuItem key={id} onClick={() => setTab(id)}>{t(extra[id])}</DropdownMenuItem>)}</DropdownMenuContent></DropdownMenu></div>
    <div className="min-h-0 flex-1 overflow-auto"><ErrorBoundary><React.Suspense fallback={null}>
      {tab === 'tree' ? <Tree onRevealTurn={close} /> : tab === 'files' ? <Files quoteTarget={externalId ? null : identity} onQuoted={close} /> : tab === 'changes' ? <Changes initialDiffPath={diff.path} initialDiffStaged={diff.staged} /> :
        tab === 'terminal' ? <Terminal visible /> : tab === 'metadata' ? <Metadata /> : tab === 'instances' ? instances(close) : <About initialUpdateDialogOpen />}
    </React.Suspense></ErrorBoundary></div>
  </div>;
  const label = (externalId ? externalTitle : title) || t(identity || externalId ? 'mobile.sessions.untitled' : 'organization.newConversation');
  return <DedicatedMobileAppProvider actions={mobileActions}><MobileWorkspaceFrame scope="workbench" conversationKey={externalId ?? (identity && JSON.stringify([identity.threadId, identity.branchId]))} identity={externalId ? null : identity} initialSettingsStage={settingsStage}
    directory={visible => <WorkbenchReplacement target={WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator} fallback={<ThreadSidebar mobileVariant isVisible={visible} />} />}
    title={panel => <button type="button" className="mobile-work-title" onClick={panel.toggle} aria-label={t('conversationTools.title') + ' · ' + label} aria-expanded={panel.open}>
      <Icon name="workbench-agent" className="size-4 shrink-0" /><strong className="truncate">{label}</strong><Icon name="arrow-down-s" className="size-3 shrink-0" /></button>}
    actions={<MobileServicesMenu open={services} onOpenChange={setServices} tab={serviceTab} setTab={setServiceTab} />}
    beforeBack={() => { if (!services) return false; setServices(false); return true; }}
    detailLabel={t(tab in extra ? extra[tab as keyof typeof extra] : 'conversationTools.title')} detail={detail} detailFocus={focus ? String(focus) : null} onDetailClose={closeTree}>
    <main ref={chat} className="relative isolate min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true"><div ref={contents} className="h-full w-full"><ErrorBoundary><ChatView /></ErrorBoundary></div></main>
  </MobileWorkspaceFrame></DedicatedMobileAppProvider>;
}
