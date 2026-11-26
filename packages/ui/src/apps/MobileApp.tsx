import React from 'react';

import { Icon } from '@/components/icon/Icon';
import { MobileAppUpdateToast } from '@/components/update/MobileAppUpdateToast';
import { Button } from '@/components/ui/button';
import { VarinLogo } from '@/components/ui/VarinLogo';
import { MobileAgentWorkspace } from '@/workbenches/agent/MobileAgentWorkspace';
import { ErrorBoundary } from '@/components/ui/ErrorBoundary';
import { dismissInitialSplash, setInitialSplashStatus } from '@/lib/splash';
import { WorkbenchTransitionOverlay } from '@/components/ui/WorkbenchTransitionOverlay';
import { RuntimeAPIProvider } from '@/contexts/RuntimeAPIProvider';
import { AgentEditorCoordinator } from '@/components/workbench/AgentEditorCoordinator';
import { RunDebugCoordinator } from '@/components/workbench/RunDebugCoordinator';
import { registerRuntimeAPIs } from '@/lib/runtime-api/registry';
import { subscribeDefaultDirectoryToRuntimeChanges } from '@/lib/directoryPersistence';
import { TooltipProvider } from '@/components/ui/tooltip';
import { Toaster } from '@/components/ui/sonner';
import { SearchCredentialDialog } from '@/components/sections/harness/SearchCredentialDialog';
import { usePushVisibilityBeacon } from '@/hooks/usePushVisibilityBeacon';
import { useRouter } from '@/hooks/useRouter';
import { useUpdatePolling } from '@/hooks/useUpdatePolling';
import { useWindowTitle } from '@/hooks/useWindowTitle';
import type { RuntimeAPIs } from '@varin/application-client';
import { useI18n } from '@/lib/i18n';
import { isCapacitorApp as isCapacitorMobileApp } from '@/lib/platform';
import { readStoredThemeState } from '@/lib/theme/themeStorage';
import { runtimeFetch } from '@varin/application-client';
import { getRuntimeApiBaseUrl, subscribeRuntimeEndpointChanged, switchRuntimeEndpointSafely } from '@varin/application-client';
import { useMobileAppViewport } from '@/lib/mobileAppRuntime';
import { cn } from '@/lib/utils';
import { useFeatureFlagsStore } from '@/stores/useFeatureFlagsStore';
import { useGitHubAuthStore } from '@/stores/useGitHubAuthStore';
import { useThreadStore, bindThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';

import { useKeyboardShortcuts } from '@/hooks/useKeyboardShortcuts';
import { usePwaManifestSync } from '@/hooks/usePwaManifestSync';
import { bindMobileWorkspaceShell } from './mobileWorkspaceShell';
import { WorkbenchProfileBridge } from '@/lib/extensions/workbench-registry';
import { WorkbenchShellHost } from '@/lib/extensions/workbench-shell-host';
import { resetVarinExtensionCatalogForHostSwitch, startVarinExtensionCatalog } from '@/lib/extensions/catalog-store';
import { MOBILE_WORKSPACE_DISCONNECTED_EVENT } from '@/workbenches/agent/AgentWorkspaceShell';
import { BusyDots } from '@/components/chat/message/parts/BusyDots';
import {
  autoConnectLastInstance,
  connectionDisplayUrl,
  getAutoConnectTargetLabel,
  isActiveRuntimeConnection,
  reprobeActiveConnection,
  useMobileConnection,
  type AutoConnectOutcome,
} from './mobileConnections';
import { isRelayModeActive } from '@/lib/relay/runtime-tunnel';
import { isQrScanSupported, parseConnectionPayload, scanConnectionQr } from './mobileQrScan';
import { MobileQrConnectionLoading, MobileQrScannerOverlay } from './MobileQrScannerOverlay';
import { resetAppForRuntimeEndpointChange } from './runtimeEndpointReset';
import { useAppFontEffects } from './useAppFontEffects';
import { useFontsReady } from './useFontsReady';
import { useDeepLinkSource } from './deepLinkNavigation';
import { useNativePushRegistration } from './useNativePushRegistration';



type MobileAppProps = {
  apis: RuntimeAPIs;
};



const useNativeMobileChrome = (): void => {
  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const root = document.documentElement;
    // Marks the Capacitor shell so keyboard-inset CSS only applies here, not in
    // the browser-hosted PWA (which handles the keyboard via dvh / interactive-widget).
    root.classList.add('varin-capacitor-app');
    // Platform marker: Android resizes the window for the keyboard natively (no manual
    // inset/choreography — the keyboard listeners below skip Android entirely).
    const capacitorPlatform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
    if (capacitorPlatform === 'android') {
      root.classList.add('varin-platform-android');
    }

    const setInset = (px: number) => {
      root.style.setProperty('--varin-keyboard-inset', `${Math.max(0, Math.round(px))}px`);
    };

    void import('@capacitor/status-bar').then(async ({ StatusBar, Style }) => {
      if (disposed) return;
      // Keep the status bar transparent over the WebView. A custom UIScene lifecycle
      // (iOS 26) plus returning from background can silently drop the overlay state,
      // letting an opaque status-bar background flash in at the top — so re-assert it
      // on mount, once shortly after (startup race), and whenever the app re-activates.
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      const applyStatusBar = async () => {
        if (platform === 'android') {
          // Inset the WebView below the bar and paint it with the resolved theme background
          // (the splash colours the theme system persists). On Android 15+ edge-to-edge is
          // enforced and both calls are no-ops — there the app pads itself via the
          // Capacitor-injected --safe-area-inset-* CSS vars (see mobile.css, varin-platform-android).
          const isDark = document.documentElement.classList.contains('dark');
          const storedTheme = readStoredThemeState();
          const themeBg = (isDark
            ? storedTheme?.splash.dark.background
            : storedTheme?.splash.light.background) || (isDark ? '#171515' : '#fffdf4');
          await StatusBar.setOverlaysWebView({ overlay: false }).catch(() => undefined);
          await StatusBar.setBackgroundColor({ color: themeBg }).catch(() => undefined);
          // Capacitor Style is named for the CONTENT: Style.Light = dark text (light bg),
          // Style.Dark = light text (dark bg). So dark theme → Style.Dark, light theme → Style.Light.
          await StatusBar.setStyle({ style: isDark ? Style.Dark : Style.Light }).catch(() => undefined);
          await StatusBar.show().catch(() => undefined);
          return;
        }
        await StatusBar.setStyle({ style: Style.Default }).catch(() => undefined);
        await StatusBar.setOverlaysWebView({ overlay: true }).catch(() => undefined);
        await StatusBar.show().catch(() => undefined);
      };
      await applyStatusBar();
      const retry = window.setTimeout(() => void applyStatusBar(), 400);
      cleanup.push(() => window.clearTimeout(retry));

      const { App } = await import('@capacitor/app');
      const stateHandle = await App.addListener('appStateChange', ({ isActive }) => {
        if (isActive) void applyStatusBar();
      });
      if (disposed) {
        void stateHandle.remove();
        return;
      }
      cleanup.push(() => void stateHandle.remove());
    }).catch(() => undefined);

    void import('@capacitor/keyboard').then(async ({ Keyboard }) => {
      if (disposed) return;
      // iOS (WKWebView, resize: 'none') keeps 100dvh at full height with the keyboard
      // overlaying, so we lift the UI manually via --varin-keyboard-inset. Android resizes the
      // window for the keyboard (dvh already shrinks), so applying the inset on top would
      // double-count — Android gets only the class/event signals below.
      const platform = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor?.getPlatform?.();
      if (platform === 'android') {
        // Android resizes the WebView natively, so no inset/transform
        // choreography — but the UI still needs the open/closed signal:
        // varin-keyboard-open drives CSS (draft starters, composer padding), and
        // the settled event gives the chat its one deterministic re-pin after
        // the native resize (the auto-follow idle gate ignores it otherwise).
        const willShowHandle = await Keyboard.addListener('keyboardWillShow', () => {
          root.classList.add('varin-keyboard-open');
          // The composer already expanded on tap — re-pin the chat to it now,
          // so the native resize that follows is the only remaining movement.
          window.dispatchEvent(new CustomEvent('varin:keyboard-settled', { detail: { open: true } }));
        });
        const didShowHandle = await Keyboard.addListener('keyboardDidShow', () => {
          window.dispatchEvent(new CustomEvent('varin:keyboard-settled', { detail: { open: true } }));
        });
        const willHideHandle = await Keyboard.addListener('keyboardWillHide', () => {
          // Same single-motion trick as iOS: collapse the composer into the
          // pill synchronously (flushSync in ChatInput) so the native window
          // growth and the composer shrink land together, not as two steps.
          window.dispatchEvent(new CustomEvent('varin:keyboard-intent', { detail: { open: false } }));
          root.classList.remove('varin-keyboard-open');
        });
        const didHideHandle = await Keyboard.addListener('keyboardDidHide', () => {
          window.dispatchEvent(new CustomEvent('varin:keyboard-settled', { detail: { open: false } }));
        });
        const removeAll = () => {
          void willShowHandle.remove();
          void didShowHandle.remove();
          void willHideHandle.remove();
          void didHideHandle.remove();
        };
        if (disposed) {
          removeAll();
          return;
        }
        cleanup.push(removeAll);
        return;
      }
      // No WebKit form accessory bar (prev/next arrows + Done) above the keyboard —
      // there's a single input, so it only eats vertical space.
      await Keyboard.setAccessoryBarVisible({ isVisible: false }).catch(() => undefined);

      // Keyboard slide choreography (see the "Native (Capacitor) keyboard handling"
      // block in mobile.css for the full picture). `keyboardWillShow` fires at the
      // START of the iOS keyboard animation and carries the final height; the
      // visible motion is transform-only (inline styles on the kb-movers), and the shell's layout
      // height (--varin-kb-layout) snaps exactly once per open/close at the moment the
      // resize is invisible. visualViewport tracking was tried but doesn't shrink
      // under WKWebView's `resize: 'none'`, so these events are the reliable signal.
      const KB_ANIM_MS = 250;
      // Dismissal reads faster than the rise — run the hide leg shorter (kept in
      // sync with the .varin-kb-hide transition-duration override in mobile.css).
      const KB_HIDE_MS = 200;
      const KB_ANIM_EASING = 'cubic-bezier(0.38, 0.7, 0.125, 1)';
      let settleTimer: number | null = null;
      let caretTimer: number | null = null;
      let keyboardHeight = 0;
      let layoutApplied = false;
      let safeBottomPx = 0;
      let keyboardOpen = false;

      const setVar = (name: string, px: number) => {
        root.style.setProperty(name, `${Math.max(0, Math.round(px))}px`);
      };
      const clearSettle = () => {
        if (settleTimer !== null) {
          window.clearTimeout(settleTimer);
          settleTimer = null;
        }
      };
      const dispatchKb = (type: 'varin:keyboard-intent' | 'varin:keyboard-anim' | 'varin:keyboard-settled', detail: Record<string, unknown>) => {
        window.dispatchEvent(new CustomEvent(type, { detail }));
      };
      // Elements that ride the keyboard slide, with their travel factor. Driven
      // by INLINE styles from here: WebKit does not reliably start a transition
      // when the transform's value changes via a CSS custom property, which
      // left the composer parked until the keyboard finished.
      const getKbMovers = (): Array<{ el: HTMLElement; factor: number }> => {
        const movers: Array<{ el: HTMLElement; factor: number }> = [];
        const composer = document.querySelector<HTMLElement>('.varin-mobile-composer');
        if (composer) movers.push({ el: composer, factor: 1 });
        // The centered draft title moves half the shift — exactly where the
        // center lands after the shell snap (see mobile.css notes).
        const draftCenter = document.querySelector<HTMLElement>('.varin-draft-center');
        if (draftCenter) movers.push({ el: draftCenter, factor: 0.5 });
        return movers;
      };
      const clearKbMovers = () => {
        for (const { el } of getKbMovers()) {
          el.style.transition = '';
          el.style.transform = '';
        }
      };

      const showHandle = await Keyboard.addListener('keyboardWillShow', (info) => {
        clearSettle();
        keyboardOpen = true;
        keyboardHeight = info.keyboardHeight;
        if (!layoutApplied) {
          // The shell's resolved padding-bottom while the keyboard is down IS the
          // bottom safe padding it gives up when open — measure it so the slide
          // distance lands the composer exactly where the final layout puts it.
          const shell = document.querySelector('.varin-mobile-app-shell');
          safeBottomPx = shell ? parseFloat(getComputedStyle(shell).paddingBottom) || 0 : 0;
        }
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('varin-kb-hide');
        // WKWebView renders the caret as a native layer that doesn't ride CSS
        // transforms — after the rise it visibly "flies" from the pre-keyboard
        // position to the final one. Hide it for the transition (plus the lag
        // window where UIKit animates it into place) and pop it back in.
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.add('varin-keyboard-open', 'varin-kb-animating', 'varin-kb-caret-hold');
        setInset(keyboardHeight);
        for (const { el, factor } of getKbMovers()) {
            el.style.transition = `transform ${KB_ANIM_MS}ms ${KB_ANIM_EASING}`;
            el.style.transform = `translateY(${-slide * factor}px)`;
        }
        // Reserve the keyboard strip inside the chat scroller NOW and re-pin
        // immediately (settled = one cheap scrollTop write over already-mounted
        // rows), so the chat bottom moves as the keyboard STARTS rising instead
        // of waiting for it to finish. `slide` (keyboard minus the safe inset
        // the shell gives up) is exactly the strip the scroller loses at
        // settle, so pin position and settle stay geometry-neutral.
        setVar('--varin-kb-scroll-inset', slide);
        dispatchKb('varin:keyboard-settled', { open: true });
        dispatchKb('varin:keyboard-anim', { phase: 'show', slide, durationMs: KB_ANIM_MS, easing: KB_ANIM_EASING });
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          // Invisible swap: transition off, layout takes the keyboard height (one
          // reflow), shift returns to 0 in the same frame.
          root.classList.remove('varin-kb-animating');
          setVar('--varin-kb-layout', keyboardHeight);
          layoutApplied = true;
          clearKbMovers();
          dispatchKb('varin:keyboard-settled', { open: true });
          // Reveal the caret only after UIKit's own caret reposition window.
          caretTimer = window.setTimeout(() => {
            caretTimer = null;
            root.classList.remove('varin-kb-caret-hold');
          }, 250);
        }, KB_ANIM_MS + 20);
      });

      // Shared hide choreography. The bridge's `keyboardWillHide` can arrive a
      // beat AFTER the native dismiss animation has already started (WKWebView +
      // resize: 'none'), which made the composer begin its down-slide only once
      // the keyboard was gone. The earliest reliable signal for the common
      // dismissal path (tap outside the input) is the textarea's focusout — so
      // both trigger this, and `keyboardOpen` makes the second call a no-op.
      const runHide = () => {
        if (!keyboardOpen) return;
        keyboardOpen = false;
        clearSettle();
        // Fired BEFORE any layout change: lets the composer collapse into its
        // pill synchronously (flushSync in ChatInput), so the keyboard hide
        // compensation below measures keyboard + composer shrink as ONE delta
        // instead of two staggered steps.
        dispatchKb('varin:keyboard-intent', { open: false });
        if (caretTimer !== null) {
          window.clearTimeout(caretTimer);
          caretTimer = null;
        }
        root.classList.remove('varin-kb-caret-hold');
        const slide = Math.max(0, keyboardHeight - safeBottomPx);
        root.classList.remove('varin-keyboard-open');
        setInset(0);
        setVar('--varin-kb-scroll-inset', 0);
        if (layoutApplied) {
          // Settled-open → restore the full-height layout NOW (still hidden behind
          // the keyboard) and FLIP the movers to their raised position without
          // transitioning, so the next frame looks unchanged.
          root.classList.remove('varin-kb-animating');
          setVar('--varin-kb-layout', 0);
          layoutApplied = false;
          for (const { el, factor } of getKbMovers()) {
            el.style.transition = 'none';
            el.style.transform = `translateY(${-slide * factor}px)`;
          }
          // Force the style/layout flush so the transition below starts from the
          // FLIP position instead of coalescing both writes into one frame.
          void (document.querySelector('.varin-mobile-app-shell') as HTMLElement | null)?.offsetHeight;
        }
        // If the hide interrupted a show mid-animation (layout not applied yet),
        // the movers transition back down from wherever they currently are.
        dispatchKb('varin:keyboard-anim', { phase: 'hide', slide, durationMs: KB_HIDE_MS, easing: KB_ANIM_EASING });
        root.classList.add('varin-kb-animating', 'varin-kb-hide');
        for (const { el } of getKbMovers()) {
            el.style.transition = `transform ${KB_HIDE_MS}ms ${KB_ANIM_EASING}`;
            el.style.transform = 'translateY(0px)';
        }
        settleTimer = window.setTimeout(() => {
          settleTimer = null;
          root.classList.remove('varin-kb-animating', 'varin-kb-hide');
          clearKbMovers();
          dispatchKb('varin:keyboard-settled', { open: false });
        }, KB_HIDE_MS + 20);
      };

      const hideHandle = await Keyboard.addListener('keyboardWillHide', runHide);

      // Early hide trigger: blurring the focused text field is what starts the
      // native dismiss animation, and it happens in-page — no bridge latency.
      // Deferred a task so a synchronous refocus (focus moving to another text
      // input, or a control that restores focus) doesn't false-trigger; in that
      // case the keyboard never hides and `keyboardWillHide` never fires either.
      const isTextInput = (node: unknown): boolean =>
        node instanceof HTMLElement
        && (node.tagName === 'TEXTAREA' || node.tagName === 'INPUT' || node.isContentEditable);
      const handleFocusOut = (event: FocusEvent) => {
        if (!keyboardOpen) return;
        if (!isTextInput(event.target)) return;
        if (isTextInput(event.relatedTarget)) return;
        window.setTimeout(() => {
          if (!keyboardOpen) return;
          if (isTextInput(document.activeElement)) return;
          runHide();
        }, 0);
      };
      document.addEventListener('focusout', handleFocusOut, true);

      if (disposed) {
        clearSettle();
        document.removeEventListener('focusout', handleFocusOut, true);
        void showHandle.remove();
        void hideHandle.remove();
        return;
      }
      cleanup.push(
        clearSettle,
        () => {
          if (caretTimer !== null) {
            window.clearTimeout(caretTimer);
            caretTimer = null;
          }
        },
        () => document.removeEventListener('focusout', handleFocusOut, true),
        () => void showHandle.remove(),
        () => void hideHandle.remove(),
      );
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
      root.classList.remove('varin-capacitor-app', 'varin-keyboard-open', 'varin-kb-animating', 'varin-kb-hide', 'varin-kb-caret-hold', 'varin-platform-android');
      root.style.removeProperty('--varin-keyboard-inset');
      root.style.removeProperty('--varin-kb-shift');
      root.style.removeProperty('--varin-kb-layout');
      root.style.removeProperty('--varin-kb-scroll-inset');
    };
  }, []);
};

const useNativeMobileLifecycle = (onResume: () => void): void => {
  const wasInactiveRef = React.useRef(false);

  React.useEffect(() => {
    if (!isCapacitorMobileApp()) return;

    let disposed = false;
    const cleanup: Array<() => void> = [];
    const resumeAfterInactive = () => {
      if (!wasInactiveRef.current) return;
      wasInactiveRef.current = false;
      onResume();
    };

    // Belt-and-suspenders resume detection. Capacitor's `appStateChange` is the
    // primary signal, but on iOS it can be missed after a long suspend, so the
    // webview's own `visibilitychange` is a second trigger — either one flips
    // wasInactiveRef and fires onResume exactly once per background→foreground.
    const handleVisibility = () => {
      if (document.visibilityState === 'hidden') {
        wasInactiveRef.current = true;
        return;
      }
      resumeAfterInactive();
    };
    document.addEventListener('visibilitychange', handleVisibility);
    cleanup.push(() => document.removeEventListener('visibilitychange', handleVisibility));

    void import('@capacitor/app').then(async ({ App }) => {
      if (disposed) return;
      const state = await App.addListener('appStateChange', ({ isActive }) => {
        document.documentElement.classList.toggle('varin-native-app-active', isActive);
        if (!isActive) {
          wasInactiveRef.current = true;
          return;
        }
        resumeAfterInactive();
      });
      const resume = await App.addListener('resume', resumeAfterInactive);
      if (disposed) {
        void state.remove();
        void resume.remove();
        return;
      }
      cleanup.push(() => void state.remove(), () => void resume.remove());
    }).catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, [onResume]);
};



const mobileInputKeyboardProps = {
  autoComplete: 'off',
  autoCorrect: 'off',
  spellCheck: false,
} as const;


const MobileConnectionWelcome: React.FC<{ onConnected: () => void }> = ({ onConnected }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnected);
  const { connections, isBusy, isPasswordBusy, error, pendingConnection } = conn;
  const [serverUrl, setServerUrl] = React.useState('');
  const [connectionName, setConnectionName] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const [isCompletingScan, setIsCompletingScan] = React.useState(false);
  const scanAbortRef = React.useRef<AbortController | null>(null);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // QR pairing is the primary flow; the manual URL form stays collapsed unless
  // scanning is unavailable (web build) or the user asks for it.
  const [manualOpen, setManualOpen] = React.useState(() => !isQrScanSupported());
  // Which saved connection is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);
  const [password, setPassword] = React.useState('');

  const handleSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.connect({ url: serverUrl, clientToken, label: connectionName });
  }, [clientToken, conn, connectionName, serverUrl]);

  // Accept a pasted pairing link (varin://connect?...) in the URL field and
  // split it back into the server URL + token.
  const handleUrlChange = React.useCallback((value: string) => {
    if (/^varin:\/\//i.test(value.trim())) {
      const payload = parseConnectionPayload(value);
      if (payload) {
        if ('pairing' in payload) {
          void conn.redeemPairingConnection(payload.pairing);
          return;
        }
        setServerUrl(payload.url);
        if (payload.label) setConnectionName(payload.label);
        if (payload.clientToken) setClientToken(payload.clientToken);
        return;
      }
    }
    setServerUrl(value);
  }, [conn]);

  const handleScanQr = React.useCallback(async () => {
    if (scanAbortRef.current || isBusy) return;
    conn.setError(null);
    setIsScanning(true);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const result = await scanConnectionQr({ signal: controller.signal });
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
      switch (result.status) {
        case 'ok':
          setIsCompletingScan(true);
          setServerUrl(result.url);
          if (result.label) setConnectionName(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          await conn.connect({ url: result.url, clientToken: result.clientToken, label: result.label });
          break;
        case 'pairing':
          setIsCompletingScan(true);
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          conn.setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          conn.setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          conn.setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          conn.setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsCompletingScan(false);
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
    }
  }, [conn, isBusy, t]);

  React.useEffect(() => () => scanAbortRef.current?.abort(), []);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void conn.submitPassword(password);
  }, [conn, password]);

  const cancelPassword = React.useCallback(() => {
    setPassword('');
    conn.cancelPassword();
  }, [conn]);

  return (
    <>
    {isScanning ? <MobileQrScannerOverlay onCancel={() => scanAbortRef.current?.abort()} /> : null}
    {isCompletingScan ? <MobileQrConnectionLoading /> : null}
    <main className="varin-keyboard-fill-screen flex min-h-dvh flex-col overflow-y-auto bg-background px-6 pb-[calc(var(--safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+28px)] pt-[calc(var(--safe-area-inset-top,env(safe-area-inset-top,0px))+28px)] text-foreground">
      <div className="m-auto flex w-full max-w-[360px] shrink-0 flex-col items-center gap-9 py-8">
        <div className="flex flex-col items-center gap-5 text-center">
          <VarinLogo width={72} height={72} className="size-[72px]" />
          <h1 className="typography-h2 text-foreground">{t('mobile.connect.welcome.title')}</h1>
        </div>

        {pendingConnection ? (
          <form className="flex w-full flex-col gap-3" onSubmit={handlePasswordSubmit}>
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0 text-left">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
            />
            {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full"
              onClick={cancelPassword}
            >
              {t('mobile.connect.cancelPassword')}
            </Button>
          </form>
        ) : (
          <div className="flex w-full flex-col gap-6">
            {/* Primary path: scan the pairing QR from "Add a device" on the server. */}
            {qrScanSupported ? (
              <div className="flex w-full flex-col gap-2">
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanQr()}
                  disabled={isScanning || isBusy}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.scanQr')}
                </Button>
                <p className="px-2 text-center typography-small text-muted-foreground">
                  {t('mobile.connect.welcome.scanHint')}
                </p>
              </div>
            ) : null}

            {error && !manualOpen ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}

            {connections.length > 0 ? (
              <section className="flex w-full flex-col gap-2.5">
                <h2 className="text-center typography-micro uppercase tracking-[0.14em] text-muted-foreground">
                  {t('mobile.connect.saved.title')}
                </h2>
                <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
                  {connections.map((connection) => {
                    const isConnectingRow = connectingId === connection.id;
                    return (
                      <button
                        key={connection.id}
                        type="button"
                        disabled={isBusy}
                        className="flex min-h-14 w-full items-center gap-3 border-b border-border/60 px-3.5 py-2.5 text-left last:border-b-0 hover:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-70"
                        onClick={() => {
                          setConnectingId(connection.id);
                          void conn.connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                            .finally(() => setConnectingId(null));
                        }}
                      >
                        <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                          <Icon name="server" className="size-[18px]" />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                          <span className={cn('block truncate typography-small', isConnectingRow ? 'text-foreground' : 'text-muted-foreground')}>
                            {isConnectingRow
                              ? t('mobile.connect.connecting')
                              : connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : t('mobile.connect.relay.badge')}
                          </span>
                        </span>
                        {isConnectingRow
                          ? <Icon name="loader-4" className="size-5 animate-spin text-muted-foreground" />
                          : <Icon name="arrow-right-s" className="size-5 text-muted-foreground" />}
                      </button>
                    );
                  })}
                </div>
              </section>
            ) : null}

            {/* Manual URL entry, collapsed by default — most people pair by QR. */}
            <div className="flex w-full flex-col">
              {qrScanSupported ? (
                <button
                  type="button"
                  onClick={() => setManualOpen((value) => !value)}
                  aria-expanded={manualOpen}
                  className="mx-auto flex items-center gap-1 rounded-full px-2 py-1 typography-small text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                >
                  <span>{t('mobile.connect.manual.toggle')}</span>
                  <Icon name="arrow-down-s" className={cn('size-4 transition-transform duration-(--motion-dur-snap) ease-snap', manualOpen && 'rotate-180')} />
                </button>
              ) : null}
              <div
                className="grid transition-[grid-template-rows] duration-(--motion-dur-glide) ease-glide"
                style={{ gridTemplateRows: manualOpen ? '1fr' : '0fr' }}
              >
                <div className="min-h-0 overflow-hidden">
                  <form className="flex w-full flex-col gap-3 pt-3" onSubmit={handleSubmit}>
                    <input
                      {...mobileInputKeyboardProps}
                      value={serverUrl}
                      onChange={(event) => handleUrlChange(event.target.value)}
                      placeholder={t('mobile.connect.url.placeholder')}
                      aria-label={t('mobile.connect.url.label')}
                      type="url"
                      inputMode="url"
                      autoCapitalize="none"
                      tabIndex={manualOpen ? undefined : -1}
                      className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      value={connectionName}
                      onChange={(event) => setConnectionName(event.target.value)}
                      placeholder={t('mobile.instances.label.placeholder')}
                      aria-label={t('mobile.instances.label.label')}
                      autoComplete="off"
                      autoCapitalize="words"
                      autoCorrect="off"
                      spellCheck={false}
                      tabIndex={manualOpen ? undefined : -1}
                      className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <input
                      {...mobileInputKeyboardProps}
                      value={clientToken}
                      onChange={(event) => setClientToken(event.target.value)}
                      placeholder={t('mobile.connect.token.placeholder')}
                      aria-label={t('mobile.connect.token.label')}
                      tabIndex={manualOpen ? undefined : -1}
                      autoCapitalize="none"
                      className="h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-center text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20"
                    />
                    <p className="px-1 text-center typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
                    {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
                    <Button type="submit" variant={qrScanSupported ? 'outline' : 'default'} size="lg" className="h-12 w-full" disabled={isBusy || isScanning || !serverUrl.trim()}>
                      {isBusy ? t('mobile.connect.connecting') : t('mobile.connect.connectButton')}
                    </Button>
                  </form>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    </main>
    </>
  );
};

const MobileInstancesSurface: React.FC<{
  onConnect: () => void;
  onActiveConnectionDeleted: () => void;
}> = ({ onActiveConnectionDeleted, onConnect }) => {
  const { t } = useI18n();
  const conn = useMobileConnection(onConnect);
  const {
    connections, isBusy, isPasswordBusy, error, pendingConnection,
    connect, submitPassword, cancelPassword, saveConnection, removeConnection, setError,
  } = conn;
  const [editingId, setEditingId] = React.useState<string | null>(null);
  const editingConnection = editingId ? connections.find((connection) => connection.id === editingId) ?? null : null;
  const [confirmingDeleteId, setConfirmingDeleteId] = React.useState<string | null>(null);
  const [url, setUrl] = React.useState('');
  const [label, setLabel] = React.useState('');
  const [clientToken, setClientToken] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [isScanning, setIsScanning] = React.useState(false);
  const [isCompletingScan, setIsCompletingScan] = React.useState(false);
  const scanAbortRef = React.useRef<AbortController | null>(null);
  const qrScanSupported = React.useMemo(() => isQrScanSupported(), []);
  // The manual add/edit form is hidden until asked for — the sheet leads with
  // the list of instances (with live status), not a wall of inputs.
  const [formOpen, setFormOpen] = React.useState(false);
  // Which row is being connected to, for the per-row spinner.
  const [connectingId, setConnectingId] = React.useState<string | null>(null);

  // Populate/clear the form imperatively (on edit tap / cancel / save) rather than via
  // an effect keyed on the derived connection object. With an effect, any churn of the
  // connections list re-fires it and overwrites what the user is typing — the keyboard
  // "resets" mid-edit. Imperative population is immune to that.
  const resetForm = React.useCallback(() => {
    setEditingId(null);
    setUrl('');
    setLabel('');
    setClientToken('');
    setError(null);
    setFormOpen(false);
  }, [setError]);

  const saveInstance = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    // The id is what makes this an EDIT: saveConnection uses it to preserve the
    // existing relay/https candidates (and the Keychain token they key) instead
    // of rebuilding the instance from the single URL field.
    void saveConnection({ id: editingId ?? undefined, url, label, clientToken }).then((saved) => {
      if (saved) resetForm();
    });
  }, [clientToken, editingId, label, resetForm, saveConnection, url]);

  // Scan a pairing QR into the add/edit form fields (does not change edit mode, so
  // the form-reset effect doesn't wipe the scanned values). The user reviews + saves.
  const handleScanInstance = React.useCallback(async () => {
    if (scanAbortRef.current) return;
    setError(null);
    setIsScanning(true);
    const controller = new AbortController();
    scanAbortRef.current = controller;
    try {
      const result = await scanConnectionQr({ signal: controller.signal });
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
      switch (result.status) {
        case 'ok':
          // Legacy token QR: prefill the manual form for review before saving.
          setUrl(result.url);
          if (result.label) setLabel(result.label);
          if (result.clientToken) setClientToken(result.clientToken);
          setFormOpen(true);
          break;
        case 'pairing':
          setIsCompletingScan(true);
          await conn.redeemPairingConnection(result.pairing);
          break;
        case 'permission-denied':
          setError(t('mobile.connect.scan.permissionDenied'));
          break;
        case 'invalid':
          setError(t('mobile.connect.scan.invalid'));
          break;
        case 'unsupported':
          setError(t('mobile.connect.scan.unsupported'));
          break;
        case 'failed':
          setError(t('mobile.connect.scan.failed'));
          break;
        case 'cancelled':
        default:
          break;
      }
    } finally {
      setIsCompletingScan(false);
      if (scanAbortRef.current === controller) {
        scanAbortRef.current = null;
        setIsScanning(false);
      }
    }
  }, [conn, setError, t]);

  React.useEffect(() => () => scanAbortRef.current?.abort(), []);

  const handlePasswordSubmit = React.useCallback((event: React.FormEvent) => {
    event.preventDefault();
    void submitPassword(password);
  }, [password, submitPassword]);

  const cancelPasswordPrompt = React.useCallback(() => {
    setPassword('');
    cancelPassword();
  }, [cancelPassword]);

  // Two-step delete (mirrors the session sheet): the trash icon arms the row, a
  // second tap on the destructive button confirms, the X disarms. No hover relied on.
  const toggleConfirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId((current) => (current === id ? null : id));
  }, []);

  const confirmDelete = React.useCallback((id: string) => {
    setConfirmingDeleteId(null);
    if (editingId === id) resetForm();
    // Removing the ACTIVE instance — or the LAST one — must drop the user back
    // to the connect screen instead of leaving them in a stale, unbacked UI.
    const wasLast = connections.length === 1;
    void removeConnection(id).then((removed) => {
      if (!removed) return;
      if (wasLast || isActiveRuntimeConnection(removed)) {
        onActiveConnectionDeleted();
      }
    });
  }, [connections.length, editingId, onActiveConnectionDeleted, removeConnection, resetForm]);

  const inputClass = 'h-12 w-full rounded-[16px] border border-border/70 bg-surface-elevated px-4 text-[16px] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-primary focus:ring-2 focus:ring-primary/20';

  if (pendingConnection) {
    return (
      <div className="flex h-full flex-col overflow-hidden">
        <form className="flex-1 overflow-y-auto px-5 py-4" onSubmit={handlePasswordSubmit}>
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3 rounded-[18px] border border-border/70 bg-surface-elevated px-3.5 py-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                <Icon name="lock" className="size-[18px]" />
              </span>
              <div className="min-w-0">
                <p className="truncate typography-ui-label text-foreground">{pendingConnection.label}</p>
                <p className="truncate typography-small text-muted-foreground">
                  {pendingConnection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(pendingConnection) : t('mobile.connect.relay.badge')}
                </p>
              </div>
            </div>
            <input
              {...mobileInputKeyboardProps}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder={t('mobile.connect.password.placeholder')}
              aria-label={t('mobile.connect.password.label')}
              type="password"
              autoFocus
              className={inputClass}
            />
            {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
            <Button type="submit" size="lg" className="mt-1 h-12 w-full" disabled={isPasswordBusy || !password.trim()}>
              {isPasswordBusy ? t('mobile.connect.connecting') : t('mobile.connect.unlockButton')}
            </Button>
            <Button type="button" variant="ghost" size="sm" className="w-full" onClick={cancelPasswordPrompt}>
              {t('mobile.connect.cancelPassword')}
            </Button>
          </div>
        </form>
      </div>
    );
  }

  return (
    <>
    {isScanning ? <MobileQrScannerOverlay onCancel={() => scanAbortRef.current?.abort()} /> : null}
    {isCompletingScan ? <MobileQrConnectionLoading /> : null}
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex-1 overflow-y-auto px-5 py-4">
        <div className="space-y-6">
          {connections.length > 0 ? (
            <div className="overflow-hidden rounded-[18px] border border-border/70 bg-surface-elevated">
              {connections.map((connection) => {
                const confirming = confirmingDeleteId === connection.id;
                const isActive = isActiveRuntimeConnection(connection);
                const isConnectingRow = connectingId === connection.id;
                // Status line: the active instance says HOW it is connected right
                // now (direct vs relay); others show their address.
                const statusText = isConnectingRow
                  ? t('mobile.connect.connecting')
                  : isActive
                    ? (isRelayModeActive() ? t('mobile.instances.status.connectedRelay') : t('mobile.instances.status.connectedDirect'))
                    : connection.candidates.some((c) => c.kind === 'direct') ? connectionDisplayUrl(connection) : t('mobile.connect.relay.badge');
                return (
                  <div
                    key={connection.id}
                    className={cn(
                      'flex items-center border-b border-border/60 transition-colors last:border-b-0',
                      confirming && 'bg-[color-mix(in_srgb,var(--destructive)_8%,transparent)]',
                    )}
                  >
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-3.5 py-3 text-left transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary disabled:opacity-60"
                      onClick={() => {
                        if (isActive) return;
                        setConnectingId(connection.id);
                        void connect({ id: connection.id, candidates: connection.candidates, clientToken: connection.clientToken, label: connection.label })
                          .finally(() => setConnectingId(null));
                      }}
                      disabled={(isBusy && !isConnectingRow) || confirming}
                    >
                      <span className="relative flex size-9 shrink-0 items-center justify-center rounded-[12px] bg-interactive-hover text-foreground">
                        <Icon name="server" className="size-[18px]" />
                        {isActive ? (
                          <span className="absolute -right-0.5 -top-0.5 size-2.5 rounded-full border-2 border-[var(--surface-elevated)] bg-[var(--status-success)]" aria-hidden />
                        ) : null}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="block truncate typography-ui-label text-foreground">{connection.label}</span>
                        <span className={cn(
                          'block truncate typography-small',
                          isActive && !isConnectingRow ? 'text-[var(--status-success)]' : 'text-muted-foreground',
                        )}>
                          {statusText}
                        </span>
                      </span>
                      {isConnectingRow ? <Icon name="loader-4" className="size-5 shrink-0 animate-spin text-muted-foreground" /> : null}
                    </button>
                    <div className="flex items-center gap-0.5 pr-2">
                      {confirming ? (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.confirmDeleteAria', { label: connection.label })}
                          className="flex h-9 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-3 text-destructive-foreground transition-opacity active:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-destructive"
                          onClick={() => confirmDelete(connection.id)}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="delete-bin" className="size-[18px]" />
                          <span className="typography-ui-label">{t('mobile.instances.delete')}</span>
                        </button>
                      ) : !connection.candidates.some((c) => c.kind === 'direct') ? null : (
                        <button
                          type="button"
                          aria-label={t('mobile.instances.edit')}
                          className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                          onClick={() => {
                            setEditingId(connection.id);
                            setUrl(connectionDisplayUrl(connection));
                            setLabel(connection.label);
                            setClientToken(connection.clientToken || '');
                            setError(null);
                          }}
                          style={{ touchAction: 'manipulation' }}
                        >
                          <Icon name="edit" className="size-[18px]" />
                        </button>
                      )}
                      <button
                        type="button"
                        aria-label={confirming
                          ? t('mobile.instances.cancelDeleteAria', { label: connection.label })
                          : t('mobile.instances.deleteAria', { label: connection.label })}
                        className="flex size-9 items-center justify-center rounded-full text-muted-foreground transition-colors active:bg-interactive-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary"
                        onClick={() => toggleConfirmDelete(connection.id)}
                        style={{ touchAction: 'manipulation' }}
                      >
                        <Icon name={confirming ? 'close' : 'delete-bin'} className="size-[18px]" />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <p className="rounded-[18px] border border-dashed border-border/70 px-4 py-6 text-center typography-small text-muted-foreground">
              {t('mobile.connect.saved.empty')}
            </p>
          )}

          {/* Add actions: QR pairing is the primary path; the manual form stays
              hidden until asked for (or until a row's edit button opens it). */}
          {!formOpen && !editingConnection ? (
            <div className="space-y-2">
              {qrScanSupported ? (
                <Button
                  type="button"
                  size="lg"
                  className="h-12 w-full"
                  onClick={() => void handleScanInstance()}
                  disabled={isScanning}
                >
                  <Icon name="scan-2" className={cn('size-[18px]', isScanning && 'animate-pulse')} />
                  {t('mobile.connect.scanQr')}
                </Button>
              ) : null}
              <Button
                type="button"
                variant={qrScanSupported ? 'ghost' : 'outline'}
                size="lg"
                className="h-12 w-full"
                onClick={() => { setError(null); setFormOpen(true); }}
              >
                <Icon name="add" className="size-[18px]" />
                {t('mobile.instances.addManual')}
              </Button>
              {error ? <p className="px-1 text-center typography-small text-[var(--status-error)]">{error}</p> : null}
            </div>
          ) : (
            <form className="space-y-3" onSubmit={saveInstance}>
              <div className="flex h-8 items-center justify-between gap-3 px-1">
                <h3 className="typography-ui-label text-foreground">
                  {editingConnection ? t('mobile.instances.editTitle') : t('mobile.instances.addTitle')}
                </h3>
                <Button type="button" variant="ghost" size="xs" onClick={resetForm}>
                  {t('mobile.instances.cancelEdit')}
                </Button>
              </div>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.url.label')}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={url}
                  onChange={(event) => setUrl(event.target.value)}
                  placeholder={t('mobile.connect.url.placeholder')}
                  type="url"
                  inputMode="url"
                  autoCapitalize="none"
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.instances.label.label')}</span>
                <input
                  value={label}
                  onChange={(event) => setLabel(event.target.value)}
                  placeholder={t('mobile.instances.label.placeholder')}
                  autoComplete="off"
                  autoCapitalize="words"
                  autoCorrect="off"
                  spellCheck={false}
                  className={inputClass}
                />
              </label>
              <label className="block space-y-1.5">
                <span className="block px-1 typography-ui-label text-foreground">{t('mobile.connect.token.label')}</span>
                <input
                  {...mobileInputKeyboardProps}
                  value={clientToken}
                  onChange={(event) => setClientToken(event.target.value)}
                  placeholder={t('mobile.connect.token.placeholder')}
                  autoCapitalize="none"
                  className={inputClass}
                />
                <p className="px-1 typography-micro text-muted-foreground">{t('mobile.connect.token.hint')}</p>
              </label>
              {error ? <p className="px-1 typography-small text-[var(--status-error)]">{error}</p> : null}
              <Button type="submit" size="lg" className="mt-1 h-12 w-full">
                {editingConnection ? t('mobile.instances.saveEdit') : t('mobile.instances.saveNew')}
              </Button>
            </form>
          )}
        </div>
      </div>
    </div>
    </>
  );
};

bindMobileWorkspaceShell(props => <MobileAgentWorkspace instances={close =>
  <MobileInstancesSurface onConnect={close} onActiveConnectionDeleted={props.onActiveConnectionDeleted} />} />);

export function MobileApp({ apis }: MobileAppProps) {
  React.useEffect(() => apis.threads ? bindThreadStore(apis.threads) : undefined, [apis.threads]);
  useKeyboardShortcuts();
  usePwaManifestSync();
  const { t } = useI18n();
  const catalogLoaded = useThreadStore((state) => state.catalogLoaded);
  const catalogLoading = useThreadStore((state) => state.catalogLoading);
  const loadCatalog = useThreadStore((state) => state.loadCatalog);
  const setIsMobile = useUIStore((state) => state.setIsMobile);
  const refreshGitHubAuthStatus = useGitHubAuthStore((state) => state.refreshStatus);
  const setPlanModeEnabled = useFeatureFlagsStore((state) => state.setPlanModeEnabled);
  const [connectionEpoch, setConnectionEpoch] = React.useState(0);
  const [runtimeEndpointEpoch, setRuntimeEndpointEpoch] = React.useState(0);
  const [showConnectionRecovery, setShowConnectionRecovery] = React.useState(false);
  // Cold-launch auto-connect to the last instance: 'pending'/'attempting' hold the
  // splash so we don't flash the connect screen; 'done' means we either connected or
  // exhausted the attempt (then the connect screen shows).
  const [autoConnectPhase, setAutoConnectPhase] = React.useState<'pending' | 'attempting' | 'done'>('pending');
  const [hasLoadedCatalog, setHasLoadedCatalog] = React.useState(catalogLoaded);
  // The instance the splash says we are connecting to. Read once on mount —
  // auto-connect targets the most-recent saved connection from the same list.
  const autoConnectLabel = React.useMemo(() => getAutoConnectTargetLabel(), []);
  const isNativeMobileApp = React.useMemo(() => isCapacitorMobileApp(), []);
  const nativeResumeValidationSeqRef = React.useRef(0);

  React.useEffect(() => {
    const onDisconnected = () => setConnectionEpoch((value) => value + 1);
    window.addEventListener(MOBILE_WORKSPACE_DISCONNECTED_EVENT, onDisconnected);
    return () => window.removeEventListener(MOBILE_WORKSPACE_DISCONNECTED_EVENT, onDisconnected);
  }, []);

  const handleNativeResume = React.useCallback(() => {
    const apiBaseUrl = getRuntimeApiBaseUrl();
    const validationSeq = nativeResumeValidationSeqRef.current + 1;
    nativeResumeValidationSeqRef.current = validationSeq;

    if (!apiBaseUrl) {
      // Already disconnected — e.g. a previous re-probe ran mid network flux
      // (Android Wi-Fi switch with no cellular fallback) and found nothing
      // reachable. When a resume/online signal arrives, silently retry the last
      // saved instance instead of dead-ending on the connect screen until the
      // user restarts the app. Success fires runtime-endpoint-changed, which
      // re-bootstraps everything.
      void autoConnectLastInstance({ fast: false, skipIfConnected: true });
      return;
    }

    // Re-probe the active device's transports on resume: the network may have
    // changed while the app slept, so hot-switch LAN⇄relay if a better transport
    // is now reachable — no re-pairing. A 'switched' outcome already fired the
    // runtime-endpoint-changed subscription (which re-bootstraps the app), so we
    // only refresh in place when the transport is 'unchanged'.
    const refreshInPlace = () => {
      void loadCatalog();
      void refreshGitHubAuthStatus(apis.github, { force: true });
    };
    const disconnect = () => {
      void switchRuntimeEndpointSafely({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' })
        .then(() => setConnectionEpoch((value) => value + 1))
        .catch((error) => console.error('[Mobile] Failed to persist state before disconnect:', error));
    };

    void reprobeActiveConnection().then((outcome) => {
      if (nativeResumeValidationSeqRef.current !== validationSeq) return;
      if (outcome === 'no-connection') {
        disconnect();
        return;
      }
      if (outcome === 'needs-login') {
        disconnect();
        return;
      }
      if (outcome === 'unreachable') {
        // Right after a resume or Wi-Fi switch the network is often still
        // settling (on Android without a SIM there is NO connectivity at all for
        // a few seconds), WireGuard can be re-handshaking, and relay TLS + WS +
        // E2EE can still be warming. Retry on a widening ladder; the last pass
        // uses the full connection budget before the app disconnects.
        const retryDelaysMs = [4_000, 10_000];
        const retryAt = (attempt: number) => {
          window.setTimeout(() => {
            if (nativeResumeValidationSeqRef.current !== validationSeq) return;
            const lastAttempt = attempt === retryDelaysMs.length - 1;
            void reprobeActiveConnection({ fast: !lastAttempt }).then((retry) => {
              if (nativeResumeValidationSeqRef.current !== validationSeq) return;
              if (retry === 'switched') return;
              if (retry === 'unchanged') {
                refreshInPlace();
                return;
              }
              if (retry === 'needs-login' || lastAttempt) {
                disconnect();
                return;
              }
              retryAt(attempt + 1);
            });
          }, retryDelaysMs[attempt]);
        };
        retryAt(0);
        return;
      }
      if (outcome === 'switched') return;

      refreshInPlace();
    });
  }, [apis.github, loadCatalog, refreshGitHubAuthStatus]);

  useNativeMobileChrome();
  useNativeMobileLifecycle(handleNativeResume);

  useMobileAppViewport(true);

  // Network-change re-probe. The resume hook only fires on background→foreground,
  // but on Android switching Wi-Fi (quick-settings tile) does NOT background the
  // app — no visibility/appState event ever fires, so the app would sit on a dead
  // LAN transport instead of hot-switching to relay. The webview's `online` event
  // fires on connectivity changes (new Wi-Fi, cellular back, airplane off), so
  // run the same re-probe then. Debounced: the first seconds after `online` the
  // route is often not usable yet, and rapid offline/online flaps must collapse
  // into one probe. iOS also gets this (harmless — same seq-guarded operation the
  // resume path runs; a concurrent duplicate supersedes via the seq ref).
  React.useEffect(() => {
    if (!isNativeMobileApp) return;
    let timer: number | undefined;
    const handleOnline = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => handleNativeResume(), 1500);
    };
    window.addEventListener('online', handleOnline);
    return () => {
      window.removeEventListener('online', handleOnline);
      window.clearTimeout(timer);
    };
  }, [isNativeMobileApp, handleNativeResume]);

  React.useEffect(() => {
    registerRuntimeAPIs(apis);
    return () => registerRuntimeAPIs(null);
  }, [apis]);

  React.useEffect(() => subscribeDefaultDirectoryToRuntimeChanges(apis), [apis]);

  // Switching instances (or disconnecting) only changes the runtime endpoint; the
  // Cross-instance changes reset instance-owned stores. Same-device LAN/relay
  // swaps keep the shell mounted while the native runtime connection rebinds itself.
  React.useEffect(() => {
    return subscribeRuntimeEndpointChanged((detail) => {
      // A LAN⇄relay swap for the same device keeps project/UI state while the
      // endpoint-aware Thread store drops its transport and reloads the catalog.
      const sameDevice = Boolean(detail.runtimeKey) && detail.runtimeKey === detail.previousRuntimeKey;
      if (sameDevice) {
        setRuntimeEndpointEpoch((epoch) => epoch + 1);
        setConnectionEpoch((epoch) => epoch + 1);
        return;
      }
      if (isNativeMobileApp) resetVarinExtensionCatalogForHostSwitch();
      resetAppForRuntimeEndpointChange(detail);
      setRuntimeEndpointEpoch((epoch) => epoch + 1);
      setConnectionEpoch((epoch) => epoch + 1);
    });
  }, [isNativeMobileApp]);

  // On cold launch, silently reconnect to the most-recent saved instance so a
  // returning user — and notification deep-links — land in the app instead of the
  // connect screen. The splash is held while we try (see render below). If there's
  // no saved instance, it's unreachable, or it needs a (re)login, we fall through
  // to the connect screen. A successful switchRuntimeEndpoint fires the endpoint-
  // changed subscription above, which bumps the epochs and bootstraps the app.
  React.useEffect(() => {
    if (!isNativeMobileApp || catalogLoaded || getRuntimeApiBaseUrl()) {
      setAutoConnectPhase('done');
      return;
    }
    let cancelled = false;
    setAutoConnectPhase('attempting');
    void (async () => {
      const outcome = await autoConnectLastInstance()
        .catch((): AutoConnectOutcome => ({ status: 'no-candidate' }));
      if (cancelled) return;
      // Release the splash after the fast decision. A transiently cold network
      // gets one full-budget background retry; a manual connection made during
      // that retry remains authoritative.
      setAutoConnectPhase('done');
      if (outcome.status === 'unreachable') {
        void autoConnectLastInstance({ fast: false, skipIfConnected: true }).catch(() => null);
      }
    })();
    return () => {
      cancelled = true;
    };
    // Run once on mount — auto-connect is a cold-launch concern only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  React.useEffect(() => {
    setIsMobile(true);
  }, [setIsMobile]);

  React.useEffect(() => {
    // Never bootstrap without a runtime endpoint on native: with apiBaseUrl ''
    // the resolver falls back to the webview's own origin, where Capacitor's
    // static server answers every request with index.html — the bootstrap
    // could otherwise appear to load against a fake backend, leaving
    // the user in an empty shell after a disconnect.
    if (isNativeMobileApp && !getRuntimeApiBaseUrl()) return;
    void loadCatalog().catch((catalogError) => {
      console.warn('[Varin] failed to load the mobile Thread catalog:', catalogError);
    });
  }, [isNativeMobileApp, loadCatalog, runtimeEndpointEpoch]);

  React.useEffect(() => {
    if (catalogLoaded) setHasLoadedCatalog(true);
  }, [catalogLoaded]);

  React.useEffect(() => {
    if (!isNativeMobileApp || !catalogLoaded || !getRuntimeApiBaseUrl()) return;
    // Restart the catalog after a Host switch even when the Surface loader is already running.
    void Promise.all([
      startVarinExtensionCatalog(),
      import('@/lib/extensions/managed-runtime').then(({ startSurfaceExtensions }) => startSurfaceExtensions()),
    ]).catch((error) => {
      console.error('[Varin Extensions] Mobile workbench startup failed:', error);
    });
  }, [catalogLoaded, isNativeMobileApp, runtimeEndpointEpoch]);

  // Gated on the Thread catalog handshake (and re-run on instance switch): probing the
  // GitHub auth status before the runtime is reachable cached a "not connected"
  // answer that stuck until something else forced a re-check.
  React.useEffect(() => {
    if (!catalogLoaded) return;
    void refreshGitHubAuthStatus(apis.github, { force: true });
  }, [apis.github, catalogLoaded, refreshGitHubAuthStatus]);

  React.useEffect(() => {
    let cancelled = false;

    const run = async () => {
      const res = await runtimeFetch('/health', { method: 'GET' }).catch(() => null);
      if (!res || !res.ok || cancelled) return;
      const data = (await res.json().catch(() => null)) as null | { planModeExperimentalEnabled?: unknown };
      if (!data || cancelled) return;
      const raw = data.planModeExperimentalEnabled;
      setPlanModeEnabled(raw === true || raw === 1 || raw === '1' || raw === 'true');
    };

    void run();

    return () => {
      cancelled = true;
    };
  }, [setPlanModeEnabled]);

  React.useEffect(() => {
    // Native: only while an instance is selected and reconnecting. Browser: the
    // runtime is same-origin (no explicit base URL), so any not-connected spell
    // counts — the splash holds until this fires, then the error screen shows.
    const waitingOnConnection = !catalogLoaded && (isNativeMobileApp ? Boolean(getRuntimeApiBaseUrl()) : true);
    if (!waitingOnConnection) {
      setShowConnectionRecovery(false);
      return;
    }
    const timeout = window.setTimeout(() => setShowConnectionRecovery(true), 8000);
    return () => window.clearTimeout(timeout);
  }, [catalogLoaded, isNativeMobileApp, connectionEpoch, runtimeEndpointEpoch]);

  useAppFontEffects();
  usePushVisibilityBeacon({ enabled: true });
  useUpdatePolling();
  useWindowTitle();
  useRouter();
  // APNs is the only notification channel on the native app (background-capable,
  // focus-suppressed server-side via the visibility beacon). Local notifications are
  // intentionally disabled — they can't tell foreground from background in a WKWebView
  // (document.hasFocus() is unreliable) and leaked while the app was open; the in-app SSE
  // notification dispatch is no-op'd for native in renderMobileApp.
  useNativePushRegistration({ enabled: isNativeMobileApp && catalogLoaded });
  // Single native deep-link entry point: notification taps AND the varin:// URL
  // scheme (widgets, Live Activities, external links). Registered unconditionally so a
  // cold-launch tap/open isn't lost on the connect/splash screen; intents stash until
  // the app is ready (connected + initialized) and shell handlers are registered.
  useDeepLinkSource({ ready: isNativeMobileApp && catalogLoaded });
  const fontsReady = useFontsReady();

  // A runtime switch resets the Thread catalog. During an in-flight reload after a
  // back true on reconnect. We must NOT blank the whole app to a loader on those —
  // only on the initial connect / instance switch (connectionPhase 'connecting').
  // previously successful connection, keep MobileShell mounted so the
  // UI doesn't reload on every network blip.
  const isReconnecting = !catalogLoaded && catalogLoading && hasLoadedCatalog;
  const hasRuntimeEndpoint = Boolean(getRuntimeApiBaseUrl());
  const handleWorkbenchReady = React.useCallback((ready: boolean) => {
    if (ready) dismissInitialSplash();
  }, []);
  React.useEffect(() => {
    if (!fontsReady) return;
    // A recovery/connect screen is usable UI too. Normal startup waits for the
    // actual Shell paint; it must not leave index.html's cover above mobile UI.
    if ((isNativeMobileApp && !hasRuntimeEndpoint) || (!catalogLoaded && !isReconnecting && showConnectionRecovery)) {
      dismissInitialSplash();
    } else {
      setInitialSplashStatus(t(catalogLoaded ? 'splash.status.preparingWorkspace' : 'splash.status.connectingRuntime'));
    }
  }, [fontsReady, hasRuntimeEndpoint, isNativeMobileApp, catalogLoaded, isReconnecting, showConnectionRecovery, t]);

  // Hold a logo splash until the UI web font is loaded, so the first UI the user sees
  // already uses the real font instead of flashing the fallback and reflowing (FOUT).
  if (!fontsReady) {
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
        <VarinLogo width={120} height={120} isAnimated />
      </main>
    );
  }

  // No runtime endpoint on native = explicitly disconnected (last instance
  // deleted, revoked token, unreachable). The connect screen is the only valid
  // UI then — regardless of what a stale isConnected flag claims (the store can
  // be poisoned by a bootstrap that ran against the webview's own origin).
  if (isNativeMobileApp && (!hasRuntimeEndpoint || (!catalogLoaded && !isReconnecting))) {
    // A runtime endpoint is already selected (first connect or switching instances):
    // show a loader while it re-bootstraps instead of flashing the onboarding screen.
    if (hasRuntimeEndpoint) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
          <div className="flex max-w-sm flex-col items-center gap-4">
            <VarinLogo width={120} height={120} isAnimated={!showConnectionRecovery} />
            {showConnectionRecovery ? (
              <>
                <div className="space-y-2">
                  <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
                  <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => {
                    void switchRuntimeEndpointSafely({ apiBaseUrl: '', clientToken: null, runtimeKey: 'mobile-disconnected' })
                      .then(() => setConnectionEpoch((value) => value + 1))
                      .catch((error) => console.error('[Mobile] Failed to persist state before disconnect:', error));
                  }}
                >
                  {t('mobile.connect.cancelPassword')}
                </Button>
              </>
            ) : null}
          </div>
        </main>
      );
    }
    // Cold-launch auto-connect is still resolving — hold the splash instead of
    // flashing the connect screen. Only show the connect screen once we've finished
    // (no saved instance, unreachable, or needs re-login).
    if (autoConnectPhase !== 'done') {
      return (
        <main className="relative flex min-h-dvh items-center justify-center bg-background text-foreground">
          <VarinLogo width={120} height={120} isAnimated />
          {/* Absolutely positioned below the (still perfectly centered) logo so
              the text never pushes it up. 50% + half the 120px logo + a gap. */}
          {autoConnectLabel ? (
            <div className="absolute inset-x-0 top-[calc(50%+84px)] flex flex-col items-center gap-0.5 px-6 text-center">
              <p className="typography-small text-muted-foreground">{t('mobile.connect.splash.connectingTo')}</p>
              <p className="typography-small text-foreground">
                {autoConnectLabel}
                <BusyDots />
              </p>
            </div>
          ) : null}
        </main>
      );
    }
    return <MobileConnectionWelcome onConnected={() => setConnectionEpoch((value) => value + 1)} />;
  }

  if (!catalogLoaded && !isReconnecting) {
    // Browser: the initial connect takes a beat — hold the logo splash instead
    // of flashing the unreachable-server error while it resolves. The error
    // only shows once the recovery delay has expired (genuinely unreachable).
    if (!showConnectionRecovery) {
      return (
        <main className="flex min-h-dvh items-center justify-center bg-background text-foreground">
          <VarinLogo width={120} height={120} isAnimated />
        </main>
      );
    }
    return (
      <main className="flex min-h-dvh items-center justify-center bg-background px-6 text-center text-foreground">
        <div className="max-w-sm space-y-3">
          <h1 className="typography-h3 text-foreground">{t('sessionAuth.error.networkTitle')}</h1>
          <p className="typography-body text-muted-foreground">{t('sessionAuth.error.networkDescription')}</p>
        </div>
      </main>
    );
  }

  return (
    <ErrorBoundary onError={dismissInitialSplash}>
      <RuntimeAPIProvider apis={apis}>
        <TooltipProvider>
          <div className="h-full bg-background text-foreground">

            <AgentEditorCoordinator />
            <RunDebugCoordinator />
            <MobileAppUpdateToast />
            <WorkbenchProfileBridge />
            <WorkbenchShellHost onReadyChange={handleWorkbenchReady} />
            <WorkbenchTransitionOverlay />
            <Toaster position="top-center" offset="calc(var(--varin-safe-area-top, 0px) + 16px)" />
            <SearchCredentialDialog />
          </div>
        </TooltipProvider>
      </RuntimeAPIProvider>
    </ErrorBoundary>
  );
}
