import React, { useEffect } from 'react';

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';

import { useUIStore, type ContextPanelMode } from '@/stores/useUIStore';
import { ContextPanelControls } from './ContextPanelControls';
import { useThreadStore } from '@/stores/useThreadStore';
import { useSelectedThreadWorkspace } from '@/hooks/useSelectedThreadWorkspace';
import { ExternalContextUsage } from './ExternalContextUsage';
import { ContextUsageDisplay } from '@/components/ui/ContextUsageDisplay';
import { contextUsageKey, useThreadContextUsageStore } from '@/stores/useThreadContextUsageStore';
import { contextPhaseLabels } from '@/lib/contextPresentation';
import { useOpenThreadContext } from '@/lib/openThreadContext';
import { threadSubtreeIds } from '@/lib/agent-runtime/thread-tree';
import { useDirectoryStore } from '@/stores/useDirectoryStore';
import { useRuntimeAPIs } from '@/hooks/useRuntimeAPIs';
import { useProjectActionsContext } from '@/hooks/useProjectActionsContext';
import { useProjectsStore } from '@/stores/useProjectsStore';
import { useGitBranchLabel } from '@/stores/useGitStore';
import { useProjectGit } from '@/hooks/useProjectGit';
import { streamPerfCount } from '@/stores/utils/streamDebug';

import { useTitlebarLeftInset } from '@/hooks/useTitlebarLeftInset';
import { useDesktopWindowControlsLayout } from '@/hooks/useDesktopWindowControlsLayout';
import { WindowsWindowControls } from '@/components/desktop/WindowsWindowControls';
import { cn } from '@/lib/utils';
import { eventMatchesShortcut, getEffectiveShortcutCombo } from '@/lib/shortcuts';

import { OpenInAppButton } from '@/components/desktop/OpenInAppButton';
import { ProjectActionsButton } from '@/components/layout/ProjectActionsButton';
import { TitlebarLeftControls } from '@/components/layout/TitlebarLeftControls';
import { SettingsTitlebar } from '@/components/layout/SettingsTitlebar';
import { BotDelegatedNote, BotReturnChip } from '@/workbenches/bot/BotReturnChip';
import { ThreadSwitcherDropdown } from '@/components/thread/ThreadSwitcherDropdown';
import { isDesktopShell, startDesktopWindowDrag } from '@/lib/desktop';
import { Icon } from "@/components/icon/Icon";
import { SwapText } from '@/components/motion/SwapText';
import { recentSwitchDirection } from '@/lib/motion/switchDirection';
import { useI18n } from '@/lib/i18n';
import { shouldResetDesktopMainTabToChat } from '@/components/layout/mainTabGuards';
import { toast } from '@/components/ui';
import { copyTextToClipboard } from '@/lib/clipboard';
import { buildExportFilename, downloadAsMarkdown, saveAsMarkdownDesktop } from '@/lib/agent-runtime/markdownExport';
import { exportThreadMarkdown } from '@/lib/agent-runtime/exportThread';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { WorkbenchServices } from './WorkbenchServices';

const DESKTOP_HEADER_ICON_BUTTON_CLASS = 'app-region-no-drag inline-flex h-8 w-8 items-center justify-center gap-2 rounded-md typography-ui-label font-medium text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary disabled:pointer-events-none disabled:opacity-50 hover:bg-interactive-hover transition-colors';

const normalize = (value: string): string => {
  if (!value) return '';
  const replaced = value.replace(/\\/g, '/');
  return replaced === '/' ? '/' : replaced.replace(/\/+$/, '');
};

const getActiveContextMode = (panelState: {
  isOpen: boolean;
  activeTabId: string | null;
  tabs: Array<{ id: string; mode: ContextPanelMode }>;
} | undefined): ContextPanelMode | null => {
  if (!panelState?.isOpen || !Array.isArray(panelState.tabs) || panelState.tabs.length === 0) {
    return null;
  }

  const activeTab = panelState.tabs.find((tab) => tab.id === panelState.activeTabId) ?? panelState.tabs[panelState.tabs.length - 1];
  return activeTab?.mode ?? null;
};



interface HeaderProps {
  navigationTitle?: string;
  settingsVisible?: boolean;
  /** A second line under a workbench-owned title (the Bot conversation's Bot). */
  navigationSubtitle?: string;
  /** Replaces the context panel controls for a workbench that owns its own secondary panel. */
  panelControl?: React.ReactNode;
  /** A dot on the sidebar toggle while the sidebar is closed and something in it changed. */
  sidebarAttention?: 'info' | 'warn' | null;
}

export const Header: React.FC<HeaderProps> = ({
  navigationTitle,
  settingsVisible,
  navigationSubtitle,
  panelControl,
  sidebarAttention,
}) => {
  streamPerfCount('ui.header.render');
  const { t } = useI18n();
  const openThreadContext = useOpenThreadContext();
  const isSidebarOpen = useUIStore((state) => state.isSidebarOpen);
  const openContextPlan = useUIStore((state) => state.openContextPlan);
  const closeContextPanel = useUIStore((state) => state.closeContextPanel);
  const activeMainTab = useUIStore((state) => state.activeMainTab);
  const setActiveMainTab = useUIStore((state) => state.setActiveMainTab);
  const shortcutOverrides = useUIStore((state) => state.shortcutOverrides);


  const { threads: threadAPI } = useRuntimeAPIs();
  const identity = useThreadStore(state => state.selectedIdentity);
  const contextUsage = useThreadContextUsageStore(state => identity ? state.views[contextUsageKey(identity)]?.usage : null);
  const contextPhase = useThreadContextUsageStore(state => identity ? state.views[contextUsageKey(identity)]?.phase : undefined);
  const currentSessionId = identity?.threadId ?? null;
  // A draft that has just become a thread: its title arrives rather than appearing.
  const [titleArrives, setTitleArrives] = React.useState(false);
  const titleSession = React.useRef(currentSessionId);
  React.useLayoutEffect(() => {
    const before = titleSession.current;
    titleSession.current = currentSessionId;
    setTitleArrives(before === null && currentSessionId !== null);
  }, [currentSessionId]);
  const currentSessionSummary = useThreadStore(state => state.threads.find(thread => thread.thread_id === state.selectedIdentity?.threadId));
  const threadCatalog = useThreadStore(state => state.threads);
  const archiveSession = React.useCallback((threadId: string) => useThreadStore.getState().updateThread(threadId, { archived: true }), []);
  const deleteSession = useThreadStore(state => state.deleteThread);
  const renameSession = React.useCallback((threadId: string, title: string) => useThreadStore.getState().updateThread(threadId, { title }), []);
  const navigationDirectory = useDirectoryStore(state => state.currentDirectory);
  const conversationWorkspace = useSelectedThreadWorkspace();
  const sessionDirectory = conversationWorkspace.composerKey ? conversationWorkspace.directory ?? '' : navigationDirectory;
  const activeProject = conversationWorkspace.project;
  const activeProjectLabel = React.useMemo(() => {
    if (!activeProject) {
      return conversationWorkspace.composerKey && sessionDirectory ? sessionDirectory.split(/[\\/]/).filter(Boolean).at(-1) ?? null : null;
    }

    const trimmedLabel = activeProject.label?.trim();
    if (trimmedLabel) {
      return trimmedLabel;
    }

    const pathSegments = activeProject.path.split(/[\\/]/).filter(Boolean);
    return pathSegments[pathSegments.length - 1] ?? null;
  }, [activeProject, conversationWorkspace.composerKey, sessionDirectory]);


  const headerRef = React.useRef<HTMLElement | null>(null);

  const [isDesktopApp, setIsDesktopApp] = React.useState<boolean>(() => {
    if (typeof window === 'undefined') {
      return false;
    }
    return isDesktopShell();
  });
  const titlebarLeftInset = useTitlebarLeftInset();
  const settingsRequested = useUIStore((state) => state.isSettingsDialogOpen);
  const settingsOpen = settingsVisible ?? settingsRequested;

  const isMacPlatform = React.useMemo(() => {
    if (typeof navigator === 'undefined') {
      return false;
    }
    return /Macintosh|Mac OS X/.test(navigator.userAgent || '');
  }, []);

  const { usesFramelessChrome, side: windowControlsSide } = useDesktopWindowControlsLayout();

  const macosMajorVersion = React.useMemo(() => {
    if (typeof window === 'undefined') {
      return null;
    }

    const injected = (window as unknown as { __VARIN_MACOS_MAJOR__?: unknown }).__VARIN_MACOS_MAJOR__;
    if (typeof injected === 'number' && Number.isFinite(injected) && injected > 0) {
      return injected;
    }

    // Fallback: WebKit reports "Mac OS X 10_15_7" format where 10 is legacy prefix
    if (typeof navigator === 'undefined') {
      return null;
    }
    const match = (navigator.userAgent || '').match(/Mac OS X (\d+)[._](\d+)/);
    if (!match) {
      return null;
    }
    const first = Number.parseInt(match[1], 10);
    const second = Number.parseInt(match[2], 10);
    if (Number.isNaN(first)) {
      return null;
    }
    return first === 10 ? second : first;
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }
    setIsDesktopApp(isDesktopShell());
  }, []);

  const openDirectory = React.useMemo(() => {
    return sessionDirectory || normalize(activeProject?.path || '');
  }, [activeProject?.path, sessionDirectory]);
  const activeContextMode = useUIStore(React.useCallback((state) => {
    return openDirectory ? getActiveContextMode(state.contextPanelByDirectory[openDirectory]) : null;
  }, [openDirectory]));

  const currentBranchLabel = useGitBranchLabel(useProjectGit().directory ?? null);

  const currentSessionTitle = currentSessionSummary?.title || (identity ? t('sessions.sidebar.session.untitled') : activeProjectLabel ?? 'Varin');
  const [isRenamingHeaderSession, setIsRenamingHeaderSession] = React.useState(false);
  const [isHeaderSessionMenuOpen, setIsHeaderSessionMenuOpen] = React.useState(false);
  const pendingHeaderRenameRef = React.useRef(false);
  const [headerSessionTitleDraft, setHeaderSessionTitleDraft] = React.useState('');
  const [pendingHeaderRetentionAction, setPendingHeaderRetentionAction] = React.useState<'archive' | 'delete' | null>(null);
  const headerRenameFormRef = React.useRef<HTMLFormElement | null>(null);

  React.useEffect(() => {
    pendingHeaderRenameRef.current = false;
    setIsHeaderSessionMenuOpen(false);
    setIsRenamingHeaderSession(false);
    setHeaderSessionTitleDraft('');
    setPendingHeaderRetentionAction(null);
  }, [currentSessionId]);

  const beginHeaderSessionRename = React.useCallback(() => {
    if (!currentSessionId) return;
    setHeaderSessionTitleDraft(currentSessionTitle);
    setIsRenamingHeaderSession(true);
  }, [currentSessionId, currentSessionTitle]);

  const saveHeaderSessionRename = React.useCallback(async () => {
    if (!currentSessionId) return;
    const title = headerSessionTitleDraft.trim();
    try {
      if (title && (title !== currentSessionTitle || currentSessionSummary?.title_mode !== 'manual')) {
        await renameSession(currentSessionId, title);
      }
      setIsRenamingHeaderSession(false);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error));
    }
  }, [currentSessionId, currentSessionTitle, currentSessionSummary?.title_mode, headerSessionTitleDraft, renameSession]);

  React.useEffect(() => {
    if (!isRenamingHeaderSession) return;
    const handleDocumentMouseDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target || !headerRenameFormRef.current?.contains(target)) {
        void saveHeaderSessionRename();
      }
    };
    document.addEventListener('mousedown', handleDocumentMouseDown);
    return () => document.removeEventListener('mousedown', handleDocumentMouseDown);
  }, [isRenamingHeaderSession, saveHeaderSessionRename]);

  const copyCurrentSessionId = React.useCallback(() => {
    if (!currentSessionId) return;
    void copyTextToClipboard(currentSessionId).then((result) => {
      toast[result.ok ? 'success' : 'error'](t(result.ok
        ? 'sessions.sidebar.session.copyId.success'
        : 'sessions.sidebar.session.copyId.error'));
    }).catch(() => toast.error(t('sessions.sidebar.session.copyId.error')));
  }, [currentSessionId, t]);

  const exportCurrentSession = React.useCallback(async () => {
    if (!currentSessionId) {
      toast.error(t('sessions.sidebar.session.export.nothingToExport'));
      return;
    }
    try {
      if (!identity || !threadAPI) throw new Error('Conversation unavailable');
      const markdown = await exportThreadMarkdown(threadAPI, identity, currentSessionTitle);
      const filename = buildExportFilename(currentSessionTitle);
      const savedPath = await saveAsMarkdownDesktop(markdown, filename);
      if (!savedPath) downloadAsMarkdown(markdown, filename);
      toast.success(t('sessions.sidebar.session.export.success'));
    } catch {
      toast.error(t('sessions.sidebar.session.export.failedLoadHistory'));
    }
  }, [identity, threadAPI, currentSessionId, currentSessionTitle, t]);

  const currentSessionSubtreeIds = React.useMemo(() => currentSessionId ? threadSubtreeIds(threadCatalog, currentSessionId) : [], [threadCatalog, currentSessionId]);

  const headerRetentionDescription = React.useMemo(() => {
    const childCount = Math.max(0, currentSessionSubtreeIds.length - 1);
    if (pendingHeaderRetentionAction === 'archive') {
      if (childCount === 1) {
        return t('sessions.sidebar.dialogs.archiveSession.withOneSubtask', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      if (childCount > 1) {
        return t('sessions.sidebar.dialogs.archiveSession.withManySubtasks', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      return t('sessions.sidebar.dialogs.archiveSession.single', { sessionTitle: currentSessionTitle });
    }
    if (pendingHeaderRetentionAction === 'delete') {
      if (childCount === 1) {
        return t('sessions.sidebar.dialogs.deleteSession.withOneSubtask', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      if (childCount > 1) {
        return t('sessions.sidebar.dialogs.deleteSession.withManySubtasks', {
          count: childCount,
          sessionTitle: currentSessionTitle,
        });
      }
      return t('sessions.sidebar.dialogs.deleteSession.single', { sessionTitle: currentSessionTitle });
    }
    return '';
  }, [currentSessionSubtreeIds.length, currentSessionTitle, pendingHeaderRetentionAction, t]);

  const confirmHeaderRetentionAction = React.useCallback(async () => {
    if (!currentSessionId || !pendingHeaderRetentionAction) return;
    const ids = [...currentSessionSubtreeIds];
    const action = pendingHeaderRetentionAction;
    setPendingHeaderRetentionAction(null);
    const results = await Promise.allSettled(ids.map((sessionId) => (
      action === 'archive' ? archiveSession(sessionId) : deleteSession(sessionId)
    )));
    const failed = results.filter((result) => (
      result.status === 'rejected'
    ));
    if (failed.length > 0) {
      toast.error(t(action === 'archive'
        ? 'sessions.sidebar.session.archive.error'
        : 'sessions.sidebar.session.delete.error'));
      return;
    }
    toast.success(t(action === 'archive'
      ? 'sessions.sidebar.session.archive.success'
      : 'sessions.sidebar.session.delete.success'));
  }, [archiveSession, currentSessionId, currentSessionSubtreeIds, deleteSession, pendingHeaderRetentionAction, t]);

  // Full-page surfaces (Scheduled, Archive, Worktrees, Multi-run) replace the
  // chat area; while one is open the header shows the surface identity
  // instead of the session switcher.
  const isScheduledSurfaceOpen = useUIStore((state) => state.isScheduledTasksDialogOpen);
  const isArchiveSurfaceOpen = useUIStore((state) => state.isArchivePageOpen);
  const worktreesSurfaceProjectId = useUIStore((state) => state.worktreesPageProjectId);
  const isMultiRunSurfaceOpen = useUIStore((state) => state.isMultiRunLauncherOpen);
  const worktreesSurfaceProjectLabel = useProjectsStore((state) => {
    if (!worktreesSurfaceProjectId) return null;
    const project = state.projects.find((entry) => entry.id === worktreesSurfaceProjectId);
    return project?.label?.trim() || project?.path?.split('/').pop() || null;
  });
  const activeSurfaceHeader = React.useMemo<{ title: string; subtitle: string | null } | null>(() => {
    if (isScheduledSurfaceOpen) {
      return { title: t('tasksHub.title'), subtitle: null };
    }
    if (isArchiveSurfaceOpen) {
      return { title: t('sessions.archivePage.title'), subtitle: null };
    }
    if (worktreesSurfaceProjectId) {
      return {
        title: t('sessions.worktreesPage.title', { project: worktreesSurfaceProjectLabel ?? '' }),
        subtitle: null,
      };
    }
    if (isMultiRunSurfaceOpen) {
      return { title: t('sessions.sidebar.header.actions.newMultiRun'), subtitle: null };
    }
    return null;
  }, [isArchiveSurfaceOpen, isMultiRunSurfaceOpen, isScheduledSurfaceOpen, t, worktreesSurfaceProjectId, worktreesSurfaceProjectLabel]);


  const projectActionsContext = useProjectActionsContext();
  const actionDirectory = projectActionsContext?.directory ?? '';



  const handleOpenContextPlan = React.useCallback(() => {
    const directory = normalize(openDirectory || '');
    if (!directory) {
      return;
    }

    const panelState = useUIStore.getState().contextPanelByDirectory[directory];
    if (getActiveContextMode(panelState) === 'plan') {
      closeContextPanel(directory);
      return;
    }

    openContextPlan(directory);
  }, [closeContextPanel, openContextPlan, openDirectory]);

  const desktopHeaderIconButtonClass = DESKTOP_HEADER_ICON_BUTTON_CLASS;

  const macosHeaderSizeClass = React.useMemo(() => {
    if (!isDesktopApp || !isMacPlatform || macosMajorVersion === null) {
      return '';
    }
    if (macosMajorVersion >= 26) {
      return 'h-12';
    }
    if (macosMajorVersion <= 15) {
      return 'h-14';
    }
    return '';
  }, [isDesktopApp, isMacPlatform, macosMajorVersion]);

  const webWindowControlsOverlayStyle = React.useMemo<React.CSSProperties | undefined>(() => {
    if (isDesktopApp && !usesFramelessChrome) {
      return undefined;
    }

    return {
      // Left inset is handled by the no-drag spacer (see renderDesktop); only
      // the right inset / titlebar height are owned by the window-controls overlay.
      paddingRight: usesFramelessChrome && windowControlsSide === 'right' ? 0 : 'calc(0.75rem + var(--varin-wco-right-inset, 0px))',
      minHeight: 'max(2.75rem, var(--varin-wco-titlebar-height, 0px))',
      height: 'max(2.75rem, var(--varin-wco-titlebar-height, 0px))',
    };
  }, [isDesktopApp, usesFramelessChrome, windowControlsSide]);

  const updateHeaderHeight = React.useCallback(() => {
    if (typeof document === 'undefined') {
      return;
    }

    const height = headerRef.current?.getBoundingClientRect().height;
    if (height) {
      document.documentElement.style.setProperty('--varin-header-height', `${height}px`);
    }
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    updateHeaderHeight();

    const node = headerRef.current;
    if (!node || typeof ResizeObserver === 'undefined') {
      return () => { };
    }

    let rafId = 0;
    const scheduleUpdate = () => {
      if (rafId) return;
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        updateHeaderHeight();
      });
    };

    const observer = new ResizeObserver(scheduleUpdate);

    observer.observe(node);
    window.addEventListener('resize', scheduleUpdate);
    window.addEventListener('orientationchange', scheduleUpdate);

    return () => {
      if (rafId) cancelAnimationFrame(rafId);
      observer.disconnect();
      window.removeEventListener('resize', scheduleUpdate);
      window.removeEventListener('orientationchange', scheduleUpdate);
    };
  }, [updateHeaderHeight]);

  useEffect(() => {
    updateHeaderHeight();
  }, [updateHeaderHeight, macosHeaderSizeClass]);

  const handleDragStart = React.useCallback(async (e: React.MouseEvent) => {
    const target = e.target as HTMLElement;
    if (target.closest('.app-region-no-drag')) {
      return;
    }
    if (target.closest('button, a, input, select, textarea')) {
      return;
    }
    if (e.button !== 0) {
      return;
    }
    if (isDesktopApp) {
      await startDesktopWindowDrag();
    }
  }, [isDesktopApp]);


  useEffect(() => {
    if (shouldResetDesktopMainTabToChat(activeMainTab, false)) {
      setActiveMainTab('chat');
    }
  }, [activeMainTab, setActiveMainTab]);



  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const toggleContextPlanCombo = getEffectiveShortcutCombo('toggle_context_plan', shortcutOverrides);
      if (eventMatchesShortcut(e, toggleContextPlanCombo)) {
        e.preventDefault();
        handleOpenContextPlan();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    shortcutOverrides,
    handleOpenContextPlan,
  ]);


  const projectNameMenu = projectActionsContext && activeProjectLabel ? (
    <ProjectActionsButton
      projectRef={projectActionsContext.projectRef}
      directory={projectActionsContext.directory}
      menuTrigger={(
        <button type="button" className="flex min-w-0 max-w-full items-center gap-1 rounded text-inherit hover:bg-interactive-hover" aria-label={`${activeProjectLabel}: ${t('projectActions.actions.chooseActionAria')}`}>
          <span className="truncate">{activeProjectLabel}</span>
          <Icon name="arrow-down-s" className="size-3 shrink-0 opacity-60" />
        </button>
      )}
    />
  ) : activeProjectLabel;

  const renderDesktop = () => (
    <div
      onMouseDown={handleDragStart}
      className={cn(
        'app-region-drag relative flex h-10 select-none items-center pr-3',
        macosHeaderSizeClass
      )}
      style={webWindowControlsOverlayStyle}
      role="tablist"
      aria-label={t('header.navigation.mainAria')}
    >
      {settingsOpen ? <SettingsTitlebar leftInset={titlebarLeftInset} /> : <>
      <TitlebarLeftControls attention={sidebarAttention ?? null} leftInset={titlebarLeftInset} />
      {navigationTitle === undefined ? <BotReturnChip /> : null}
      <div className="flex min-w-0 flex-1 self-stretch items-center">
        {activeSurfaceHeader ? (
          <div className="mr-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-left">
            <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
              {activeSurfaceHeader.title}
            </span>
            {activeSurfaceHeader.subtitle ? (
              <span className="truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75 max-w-full">
                {activeSurfaceHeader.subtitle}
              </span>
            ) : null}
          </div>
        ) : navigationTitle !== undefined ? (
          <div className="mr-3 flex min-w-0 flex-col items-start px-1 py-0.5 -my-0.5 text-left">
            <SwapText text={navigationTitle} hold={0} direction={recentSwitchDirection() === -1 ? -1 : 1}
              className="typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full" />
            {navigationSubtitle ? (
              <span className="max-w-full truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">{navigationSubtitle}</span>
            ) : null}
          </div>
        ) : (
          <div className="app-region-no-drag mr-3 flex min-w-0 max-w-full items-center gap-0.5 py-0.5 -my-0.5 text-left">
            {!isSidebarOpen ? (
              <ThreadSwitcherDropdown align="start">
                <button
                  type="button"
                  className={desktopHeaderIconButtonClass}
                  aria-label={t('sessions.switcher.openAria')}
                >
                  <Icon name="history" className="h-[18px] w-[18px]" />
                </button>
              </ThreadSwitcherDropdown>
            ) : null}
            <div className="flex min-w-0 flex-col justify-center px-1">
              {isRenamingHeaderSession ? (
                <form
                  ref={headerRenameFormRef}
                  className="flex w-full min-w-0 items-center gap-2 leading-tight"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void saveHeaderSessionRename();
                  }}
                >
                  <input
                    value={headerSessionTitleDraft}
                    onChange={(event) => setHeaderSessionTitleDraft(event.target.value)}
                    autoFocus
                    onKeyDown={(event) => {
                      event.stopPropagation();
                      if (event.key === 'Escape') {
                        setIsRenamingHeaderSession(false);
                      }
                    }}
                    placeholder={t('sessions.sidebar.session.menu.rename')}
                    className="min-w-0 flex-1 bg-transparent typography-ui-label text-[14px] font-normal leading-tight outline-none placeholder:text-muted-foreground"
                  />
                  <button
                    type="submit"
                    aria-label={t('sessions.sidebar.session.rename.save')}
                    title={t('sessions.sidebar.session.rename.save')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="check" className="size-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => setIsRenamingHeaderSession(false)}
                    aria-label={t('sessions.sidebar.session.rename.cancel')}
                    title={t('sessions.sidebar.session.rename.cancel')}
                    className="shrink-0 text-muted-foreground hover:text-foreground"
                  >
                    <Icon name="close" className="size-4" />
                  </button>
                </form>
              ) : currentSessionId ? (
                // The title changes in place, the same way the conversation moved; a new
                // session's title arrives when its draft becomes a thread.
                <SwapText text={currentSessionTitle} hold={0} direction={recentSwitchDirection() === -1 ? -1 : 1}
                  className={cn('typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full', titleArrives && 'header-title-arrive')} />
              ) : (
                <span className="truncate typography-ui-label text-[14px] font-normal leading-tight text-foreground max-w-full">
                  {projectNameMenu ?? t('sessions.sidebar.grouping.generalChat')}
                </span>
              )}
              {(sessionDirectory || (currentSessionId && activeProjectLabel) || currentBranchLabel) ? (
                <span className="flex min-w-0 max-w-full items-center gap-1.5 truncate typography-micro text-[10.5px] font-normal leading-tight text-muted-foreground/75">
                  <BotDelegatedNote />
                  {sessionDirectory ? <span className="truncate">{sessionDirectory}</span> : null}
                  {currentSessionId && activeProjectLabel ? <span className="min-w-0 truncate">{projectNameMenu}</span> : null}
                  {currentBranchLabel ? (
                    <span className="inline-flex min-w-0 items-center gap-0.5">
                      <Icon name="git-branch" className="h-3 w-3 flex-shrink-0 text-muted-foreground/70" />
                      <span className="truncate">{currentBranchLabel}</span>
                    </span>
                  ) : null}
                </span>
              ) : null}
            </div>
            <div className="flex h-[18px] shrink-0 items-center justify-center self-start">
              {currentSessionId && !isRenamingHeaderSession ? (
                <DropdownMenu
                  open={isHeaderSessionMenuOpen}
                  onOpenChange={setIsHeaderSessionMenuOpen}
                  onOpenChangeComplete={(open) => {
                    if (!open && pendingHeaderRenameRef.current) {
                      pendingHeaderRenameRef.current = false;
                      beginHeaderSessionRename();
                    }
                  }}
                >
                  <DropdownMenuTrigger asChild>
                    <Button variant="ghost" size="xs" className="h-[18px] w-6 px-0 text-muted-foreground hover:bg-transparent hover:text-foreground" aria-label={t('header.sessionActions.openAria')}>
                      <Icon name="more" className="size-4" />
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end" className="min-w-[190px]">
                    <DropdownMenuItem onClick={() => { pendingHeaderRenameRef.current = true; }}><Icon name="pencil-ai" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.rename')}</DropdownMenuItem>
                    {currentSessionSummary?.title_mode === 'manual' && !currentSessionSummary.parent_thread_id && <DropdownMenuItem onClick={() => {
                      if (currentSessionId) void useThreadStore.getState().updateThread(currentSessionId, { titleMode: 'automatic' }).catch(error => toast.error(error instanceof Error ? error.message : String(error)));
                    }}><Icon name="refresh" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.resumeTitles')}</DropdownMenuItem>}
                    <DropdownMenuItem onClick={copyCurrentSessionId}><Icon name="file-copy" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.copyId')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => void exportCurrentSession()}><Icon name="download" className="mr-2 size-4" />{t('sessions.sidebar.session.menu.exportMarkdown')}</DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem onClick={() => setPendingHeaderRetentionAction('archive')}><Icon name="inbox-archive" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.archive')}</DropdownMenuItem>
                    <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setPendingHeaderRetentionAction('delete')}><Icon name="delete-bin" className="mr-2 size-4" />{t('sessions.sidebar.bulkActions.delete')}</DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
            </div>
          </div>
        )}


        <div className="flex-1" />

        <div className="flex shrink-0 self-stretch items-center gap-1">
          {activeMainTab === 'chat' && <ExternalContextUsage />}
          {activeMainTab === 'chat' && contextUsage && contextUsage.totalTokens > 0 && <ContextUsageDisplay
            {...contextUsage}
            size="compact" hideIcon showPercentIcon
            pressed={activeContextMode === 'context'}
            onClick={() => {
              if (!openDirectory) return;
              if (activeContextMode === 'context') closeContextPanel(openDirectory);
              else if (identity) openThreadContext(identity, openDirectory);
            }}
            className="mr-1.5"
            valueClassName="typography-ui-label font-medium leading-none text-foreground"
            percentIconClassName="h-4.5 w-4.5"
          />}
          {activeMainTab === 'chat' && identity && contextPhase && contextPhase !== 'superseded' && <button type="button"
            className="mr-2 inline-flex items-center gap-1.5 rounded px-1.5 py-1 typography-micro text-muted-foreground hover:bg-interactive-hover hover:text-foreground"
            onClick={() => openThreadContext(identity, openDirectory ?? undefined)} title={t(contextPhaseLabels[contextPhase])}>
            {(contextPhase === 'preparing' || contextPhase === 'waiting') && <Icon name="loader-4" className="size-3 animate-spin" />}
            <span className="max-w-40 truncate">{t(contextPhaseLabels[contextPhase])}</span>
          </button>}
          {projectActionsContext?.projectRef.resourceOwner?.kind !== 'managed_host' && <OpenInAppButton directory={actionDirectory} className="mr-1" />}
          <WorkbenchServices />
          {panelControl ?? <ContextPanelControls />}
          <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" />
        </div>
      </div>
      </>}
      {settingsOpen ? <WindowsWindowControls visible={usesFramelessChrome && windowControlsSide === 'right'} position="right" /> : null}
    </div>
  );


  return (
    <>
      <header
        ref={headerRef}
        data-startup-part="header"
        className="header-safe-area relative z-10 shrink-0 bg-background"
        style={{ ['--padding-scale' as string]: '1' } as React.CSSProperties}
      >
        {renderDesktop()}
      </header>
      <Dialog open={pendingHeaderRetentionAction !== null} onOpenChange={(open) => { if (!open) setPendingHeaderRetentionAction(null); }}>
        <DialogContent showCloseButton={false} className="max-w-sm gap-5">
          <DialogHeader>
            <DialogTitle>{pendingHeaderRetentionAction === 'delete'
              ? t('sessions.sidebar.dialogs.deleteSession.title')
              : t('sessions.sidebar.dialogs.archiveSession.title')}</DialogTitle>
            <DialogDescription>{headerRetentionDescription}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setPendingHeaderRetentionAction(null)}>
              {t('sessions.sidebar.dialogs.cancel')}
            </Button>
            <Button variant="destructive" size="sm" onClick={() => void confirmHeaderRetentionAction()}>
              {pendingHeaderRetentionAction === 'delete'
                ? t('sessions.sidebar.bulkActions.delete')
                : t('sessions.sidebar.bulkActions.archive')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};
