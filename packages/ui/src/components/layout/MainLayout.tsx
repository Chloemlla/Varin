import React from 'react';
import { MobileWorkspaceFrame } from './MobileWorkspaceFrame';
import { varinSurfaceRuntime } from '@/lib/extensions/surface-runtime';
import { useI18n } from '@/lib/i18n';
import { Header } from './Header';
import { useSettingsTransition } from './useSettingsTransition';
import { Sidebar } from './Sidebar';
import { ProjectContextPanel } from './RightSidebarTabs';
import { ContextPanel } from './ContextPanel';
import { ContextPanelRail } from './ContextPanelRail';
import { ErrorBoundary } from '../ui/ErrorBoundary';
import { CommandPalette } from '../ui/CommandPalette';
import { HelpDialog } from '../ui/HelpDialog';
import { ThreadSidebar } from '@/components/thread/ThreadSidebar';
import { ScheduledTasksDialog } from '@/components/session/ScheduledTasksDialog';
import type { BotGroupSummary } from '@varin/application-client';
import { DirectoryExplorerDialog } from '@/components/session/DirectoryExplorerDialog';
import { ArchiveView } from '@/components/views/ArchiveView';
import { WorktreesView } from '@/components/views/WorktreesView';
import { DiffWorkerProvider } from '@/contexts/DiffWorkerProvider';
import { MultiRunLauncher } from '@/components/multirun';
import { TerminalView } from '@/components/views/TerminalView';
import { WorkspaceOverlays } from '@/components/workspace/WorkspaceOverlays';
import {
    WorkbenchContributionSlot,
    WorkbenchReplacement,
    WORKBENCH_REPLACEMENT_TARGETS,
} from '@/lib/extensions/workbench-registry';

import { useUIStore } from '@/stores/useUIStore';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useDeviceInfo } from '@/lib/device';
import { cn } from '@/lib/utils';
import { lazyWithChunkRecovery } from '@/lib/chunkLoadRecovery';
import { workspaceEvents } from '@/lib/workspaceEvents';
import { useWorkbenchShellActive } from '@/lib/workbench/shell-activity';

import { RegularChatView } from '@/components/views/RegularChatView';

// Keep TerminalView eager: the bottom dock reserves its height immediately, so
// suspending here leaves a large blank panel on slower machines.
// Other heavy views stay on-demand: Files can load Monaco and Diff loads its
// renderer; Plan's embedded CodeMirror is also irrelevant until selected.
const PlanView = lazyWithChunkRecovery(() => import('@/components/views/PlanView').then(m => ({ default: m.PlanView })));
const GitView = lazyWithChunkRecovery(() => import('@/components/views/GitView').then(m => ({ default: m.GitView })));
const DiffView = lazyWithChunkRecovery(() => import('@/components/views/DiffView').then(m => ({ default: m.DiffView })));
const FilesView = lazyWithChunkRecovery(() => import('@/components/views/FilesView').then(m => ({ default: m.FilesView })));
const DiagramView = lazyWithChunkRecovery(() => import('@/components/views/DiagramView').then(m => ({ default: m.DiagramView })));

interface MainLayoutProps {
    renderConversation?: (active: boolean) => React.ReactNode;
    renderNavigator?: (isVisible: boolean) => React.ReactNode;
    /**
     * A workbench's own secondary panel. On desktop it replaces the context panel and its rail
     * and must render an aside beside the main canvas. Mobile shows the same content on its detail page.
     */
    renderSecondaryPanel?: (placement: 'docked' | 'drawer', visible: boolean) => React.ReactNode;
    secondaryPanelFocus?: string | null;
    onMobileDetailClose?(): void;
    /** Accessible names for that panel and its mobile header toggle. */
    secondaryPanelLabel?: string;
    navigationTitle?: string;
    mobileConversationKey?: string | null;
    mobileIdentity?: import('@varin/application-client').ThreadIdentity | null;
    navigationSubtitle?: string;
    headerPanelControl?: React.ReactNode;
    sidebarAttention?: 'info' | 'warn' | null;
    /** The sidebar opens over the work area; pressing outside it closes it. */
    floatingSidebar?: boolean;
    /** Conversation identity and its entry to details on mobile. */
    renderMobileTitle?: (panel: { open: boolean; toggle(): void }) => React.ReactNode;
    scheduledTasksGroup?: BotGroupSummary;
}

export const MainLayout: React.FC<MainLayoutProps> = ({ renderConversation, renderNavigator, renderSecondaryPanel, secondaryPanelLabel, secondaryPanelFocus, onMobileDetailClose, navigationTitle, navigationSubtitle, headerPanelControl, sidebarAttention, floatingSidebar = false, renderMobileTitle, scheduledTasksGroup, mobileConversationKey, mobileIdentity }) => {
    const shellActive = useWorkbenchShellActive();
    const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
    const isContextRailOpen = useUIStore((state) => state.isContextRailOpen);
    const activeMainTab = useUIStore((state) => state.activeMainTab);
    const setIsMobile = useUIStore((state) => state.setIsMobile);
    const isMultiRunLauncherOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
    const setMultiRunLauncherOpen = useUIStore((state) => state.setMultiRunLauncherOpen);
    const multiRunLauncherPrefillPrompt = useUIStore((state) => state.multiRunLauncherPrefillPrompt);
    const isScheduledTasksPageOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
    const isArchivePageOpen = useUIStore((state) => state.isArchivePageOpen);
    const worktreesPageProjectId = useUIStore((state) => state.worktreesPageProjectId);
    // Any full-page surface replacing the chat area. While open, the chat and
    // secondary views are fully hidden (not just covered) so none of their
    // floating chrome bleeds through, and selecting a session / draft / main
    // tab anywhere closes the surface.
    const isSurfacePageOpen = isScheduledTasksPageOpen || isArchivePageOpen || Boolean(worktreesPageProjectId) || isMultiRunLauncherOpen;

    React.useEffect(() => {
        if (!shellActive) return;
        const closeSurfacePages = () => useUIStore.getState().closeMainSurfaces();
        const unsubscribeSession = useThreadStore.subscribe((state, prev) => {
            const sessionSelected = Boolean(state.selectedIdentity) && state.selectedIdentity !== prev.selectedIdentity;
            if (sessionSelected) closeSurfacePages();
        });
        const unsubscribeTab = useUIStore.subscribe((state, prev) => {
            if (state.activeMainTab !== prev.activeMainTab) closeSurfacePages();
        });
        return () => {
            unsubscribeSession();
            unsubscribeTab();
        };
    }, [shellActive]);
    const { t } = useI18n();
    const device = useDeviceInfo();
    const isMobile = device.isMobile || varinSurfaceRuntime.surface === 'mobile';
    const settings = useSettingsTransition(shellActive && !isMobile);
    const [directoryDialogOpen, setDirectoryDialogOpen] = React.useState(false);

    useUpdatePolling(shellActive);

    React.useEffect(() => shellActive ? workspaceEvents.onDirectoryRequest(() => {
        setDirectoryDialogOpen(true);
    }) : undefined, [shellActive]);

    React.useEffect(() => {
        if (!shellActive) return;
        const previous = useUIStore.getState().isMobile;
        if (previous !== isMobile) {
            setIsMobile(isMobile);
        }
    }, [shellActive, isMobile, setIsMobile]);


    const secondaryView = React.useMemo(() => {
        // Desktop surfaces live in the context panel; the only full-view
        // overlays left there are the terminal (promoted by project actions)
        // and the diagram viewer. Mobile keeps the full tab set.
        if (!isMobile && activeMainTab !== 'terminal' && activeMainTab !== 'diagram') {
            return null;
        }
        switch (activeMainTab) {
            case 'plan':
                return <React.Suspense fallback={null}><PlanView /></React.Suspense>;
            case 'git':
                return <React.Suspense fallback={null}><GitView isActive /></React.Suspense>;
            case 'diff':
                return <React.Suspense fallback={null}><DiffView /></React.Suspense>;
            case 'terminal':
                return <TerminalView />;
            case 'files':
                return <React.Suspense fallback={null}><FilesView /></React.Suspense>;
            case 'context':
                return <React.Suspense fallback={null}><ProjectContextPanel /></React.Suspense>;
            case 'diagram':
                return <React.Suspense fallback={null}><DiagramView /></React.Suspense>;
            default:
                return null;
        }
    }, [activeMainTab, isMobile]);

    const isChatActive = activeMainTab === 'chat';
    // Desktop settings is an overlay: keep the conversation and editor alive
    // underneath it. Mobile settings replaces the page and can suspend it.
    const conversationActive = shellActive && isChatActive && !isSurfacePageOpen;
    const conversation = renderConversation
        ? renderConversation(conversationActive)
        : <RegularChatView active={conversationActive} />;

    return (
        <DiffWorkerProvider>
            <div
                data-page-scroll-lock="true"
                data-workbench-chrome={isMobile ? undefined : 'agent'}
                className={cn(
                    'main-content-safe-area',
                    isMobile ? 'relative flex h-[100dvh] flex-col' : 'workbench-frame relative flex h-[100dvh] flex-col',
                    'bg-background'
                )}
            >
                <CommandPalette />
                <HelpDialog />
                <WorkspaceOverlays />
                <WorkbenchContributionSlot kind="panel" slot="workbench.overlay" />
                <DirectoryExplorerDialog
                    open={directoryDialogOpen}
                    onOpenChange={setDirectoryDialogOpen}
                />

                {isMobile ? (
                <MobileWorkspaceFrame scope={renderNavigator ? "bot" : "workbench"} conversationKey={mobileConversationKey} identity={mobileIdentity} scheduledGroup={scheduledTasksGroup} actions={headerPanelControl} detailFocus={secondaryPanelFocus} onDetailClose={onMobileDetailClose}
                    title={panel => renderMobileTitle?.(panel) ?? <strong className="truncate">{navigationTitle}</strong>}
                    directory={visible => <ErrorBoundary><WorkbenchReplacement target={WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator}
                        fallback={renderNavigator ? renderNavigator(visible) : <ThreadSidebar mobileVariant />} /></ErrorBoundary>}
                    detailLabel={secondaryPanelLabel ?? t('mobile.menu.files')}
                    detail={() => <ErrorBoundary>{renderSecondaryPanel ? renderSecondaryPanel('drawer', true) : <React.Suspense fallback={null}><GitView isActive /></React.Suspense>}</ErrorBoundary>}>
                      <main className="relative isolate min-h-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
                        <div className={cn('absolute inset-0', (!isChatActive || isSurfacePageOpen) && 'invisible')}><ErrorBoundary>{conversation}</ErrorBoundary></div>
                        {secondaryView && <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}><ErrorBoundary>{secondaryView}</ErrorBoundary></div>}
                      </main>
                </MobileWorkspaceFrame>
            ) : (
                <>
                    <Header navigationTitle={navigationTitle} navigationSubtitle={navigationSubtitle} panelControl={headerPanelControl} sidebarAttention={sidebarAttention} settingsVisible={settings.open} />
                    {/* Desktop navigation and work area share the row below the titlebar. */}
                    <div style={settings.open ? { display: 'none' } : undefined} inert={settings.open} className="agent-workspace-row relative flex min-h-0 min-w-0 flex-1 overflow-hidden" data-page-scroll-lock="true">
                        {floatingSidebar && isSidebarOpen ? (
                            <div aria-hidden="true" className="absolute inset-0 z-20 bg-black/10" onPointerDown={() => useUIStore.getState().setSidebarOpen(false)} />
                        ) : null}
                        <Sidebar
                            isOpen={isSidebarOpen}
                            isMobile={isMobile}
                            floating={floatingSidebar}
                            className="border-border"
                        >
                            <WorkbenchReplacement
                                target={WORKBENCH_REPLACEMENT_TARGETS.sessionNavigator}
                                fallback={renderNavigator ? renderNavigator(isSidebarOpen) : <ThreadSidebar isVisible={isSidebarOpen} />}
                            />
                        </Sidebar>
                        <div className="agent-workspace-area relative flex flex-1 min-w-0 flex-col overflow-hidden" data-page-scroll-lock="true">
                            <div className="agent-surface-layout relative flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                <div className="agent-content-row relative flex flex-1 min-w-0 flex-col overflow-hidden" data-page-scroll-lock="true">
                                    <div className="flex flex-1 min-h-0 overflow-hidden" data-page-scroll-lock="true">
                                        <div className="relative flex flex-1 min-h-0 min-w-0 overflow-hidden" data-page-scroll-lock="true">
                                            <main className="agent-conversation-canvas min-w-0 flex-1 overflow-hidden bg-background relative" data-page-scroll-lock="true">
                                                <div className={cn('absolute inset-0', (!isChatActive || isSurfacePageOpen) && 'invisible')}>
                                                    <ErrorBoundary>{conversation}</ErrorBoundary>
                                                </div>
                                                {secondaryView && (
                                                    <div className={cn('absolute inset-0', isSurfacePageOpen && 'invisible')}>
                                                        <ErrorBoundary>{secondaryView}</ErrorBoundary>
                                                    </div>
                                                )}
                                                {isMultiRunLauncherOpen && (
                                                    <div className="absolute inset-0 z-10 bg-background">
                                                        <ErrorBoundary>
                                                            {/* isWindowed: the app Header already shows the surface
                                                                title, so skip the launcher's own title bar. */}
                                                            <MultiRunLauncher
                                                                isWindowed
                                                                initialPrompt={multiRunLauncherPrefillPrompt}
                                                                onCreated={() => setMultiRunLauncherOpen(false)}
                                                                onCancel={() => setMultiRunLauncherOpen(false)}
                                                            />
                                                        </ErrorBoundary>
                                                    </div>
                                                )}
                                                <ErrorBoundary><ScheduledTasksDialog activeGroup={scheduledTasksGroup} /></ErrorBoundary>
                                                <ErrorBoundary><ArchiveView /></ErrorBoundary>
                                                <ErrorBoundary><WorktreesView /></ErrorBoundary>
                                            </main>
                                            <WorkbenchContributionSlot kind="panel" slot="workbench.secondary.before" />
                                            {renderSecondaryPanel ? <ErrorBoundary>{renderSecondaryPanel('docked', true)}</ErrorBoundary> : <WorkbenchReplacement
                                                target={WORKBENCH_REPLACEMENT_TARGETS.workspaceExplorer}
                                                fallback={<ContextPanel />}
                                            />}
                                            <WorkbenchContributionSlot kind="panel" slot="workbench.secondary.after" />
                                        </div>
                                    </div>
                                </div>
                                <div data-page-scroll-lock="true">
                                    <WorkbenchContributionSlot kind="panel" slot="workbench.bottom.before" />
                                    {renderSecondaryPanel ? null : <div className="workbench-rail-reveal" data-open={isContextRailOpen} aria-hidden={!isContextRailOpen} inert={!isContextRailOpen}>
                                        <ErrorBoundary><ContextPanelRail /></ErrorBoundary>
                                    </div>}
                                    <WorkbenchContributionSlot kind="panel" slot="workbench.bottom.after" />
                                </div>
                            </div>
                        </div>
                    </div>

                    {settings.content}
                    {settings.layer}
                </>
            )}

        </div>
    </DiffWorkerProvider>
    );
};
