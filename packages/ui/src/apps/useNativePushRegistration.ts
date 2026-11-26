import React from 'react';

import { getRegisteredRuntimeAPIs } from '@/lib/runtime-api/registry';
import { getClientPlatform } from '@/lib/platform';
import { useThreadStore } from '@/stores/useThreadStore';
import { useUIStore } from '@/stores/useUIStore';

/**
 * Registers the native push token with the connected server so the app can
 * receive remote push even when suspended/closed. Delivery goes through the central relay
 * (server posts generic text → relay signs+sends) — see
 * `packages/web/application-host/lib/notifications/APNS.md`.
 *
 * Lazy-imports `@capacitor/push-notifications` (only present in the Capacitor shell),
 * mirroring the other `@capacitor/*` integrations in MobileApp. On `registration` the
 * device token is sent to the server via `apis.push.registerApnsToken`; tapping a push
 * deep-links to its session. Pass `enabled = isNativeMobileApp && isConnected`; the hook
 * additionally gates on the `nativeNotificationsEnabled` setting and re-registers when
 * the connection (and thus the active server endpoint) changes.
 */
// iOS uses APNs and Android builds with Firebase configured use FCM.
// The relay routes each token based on its platform.
// APNs environment of this build. Xcode/dev-signed installs get sandbox device tokens,
// TestFlight/App Store installs get production ones; the native iOS shell reports which via
// a global injected in SceneDelegate (see packages/mobile/ios/App/App/AppDelegate.swift).
// Undefined when the global is absent (Android, or a shell predating the injection) — the
// server then defaults to production, matching released builds.
const getApnsEnvironment = (): 'sandbox' | 'production' | undefined => {
  if (typeof window === 'undefined') return undefined;
  const env = (window as typeof window & { __VARIN_APNS_ENV__?: string }).__VARIN_APNS_ENV__;
  if (env === 'development') return 'sandbox';
  if (env === 'production') return 'production';
  return undefined;
};

const isNativePushPlatform = (): boolean => {
  if (typeof window === 'undefined') return false;
  const capacitor = (window as typeof window & { Capacitor?: { getPlatform?: () => string } }).Capacitor;
  const platform = capacitor?.getPlatform?.();
  return platform === 'ios' || platform === 'android';
};

const isNativePushAvailable = async (): Promise<boolean> => {
  if (getClientPlatform() === 'ios') return true;
  const { registerPlugin } = await import('@capacitor/core');
  const support = registerPlugin<{
    getAvailability(): Promise<{ available: boolean }>;
  }>('NativePushSupport');
  // The Android plugin is installed even when no default Firebase app exists.
  // Calling its register method in that state can terminate the native process.
  return (await support.getAvailability()).available;
};

export const useNativePushRegistration = (options: { enabled: boolean }): void => {
  const { enabled } = options;
  const hostKey = useThreadStore(state => state.hostKey);
  const nativeNotificationsEnabled = useUIStore((state) => state.nativeNotificationsEnabled);
  const lastTokenRef = React.useRef<string | null>(null);

  React.useEffect(() => {
    if (!enabled || !nativeNotificationsEnabled || !isNativePushPlatform()) {
      return;
    }

    let disposed = false;
    const cleanup: Array<() => void> = [];

    void import('@capacitor/push-notifications')
      .then(async ({ PushNotifications }) => {
        if (disposed) return;
        const available = await isNativePushAvailable();
        if (!available || disposed) return;

        let permission = await PushNotifications.checkPermissions().catch(() => null);
        if (permission?.receive !== 'granted') {
          permission = await PushNotifications.requestPermissions().catch(() => null);
        }
        if (permission?.receive !== 'granted') {
          return;
        }

        const registrationHandle = await PushNotifications.addListener('registration', (token) => {
          if (disposed || hostKey !== useThreadStore.getState().hostKey) return;
          lastTokenRef.current = token.value;
          const apis = getRegisteredRuntimeAPIs();
          void apis?.push?.registerApnsToken?.({
            token: token.value,
            hostKey,
            platform: getClientPlatform(),
            environment: getApnsEnvironment(),
          });
        });

        const registrationErrorHandle = await PushNotifications.addListener('registrationError', (error) => {
          console.warn('[Push] APNs registration error:', error);
        });

        // Note: notification-tap handling lives in the deep-link layer (`useDeepLinkSource`
        // in deepLinkNavigation), registered unconditionally so cold-launch taps aren't lost
        // while disconnected.

        await PushNotifications.register().catch(() => undefined);

        if (disposed) {
          void registrationHandle.remove();
          void registrationErrorHandle.remove();
          return;
        }
        cleanup.push(
          () => void registrationHandle.remove(),
          () => void registrationErrorHandle.remove(),
        );
      })
      .catch(() => undefined);

    return () => {
      disposed = true;
      cleanup.forEach((remove) => remove());
    };
  }, [enabled, nativeNotificationsEnabled, hostKey]);

  // When notifications are turned off, drop the token from the server so it stops
  // pushing to this device. (Separate from the register effect so a transient
  // disconnect doesn't unregister.)
  React.useEffect(() => {
    if (nativeNotificationsEnabled) return;
    const token = lastTokenRef.current;
    if (!token) return;
    lastTokenRef.current = null;
    const apis = getRegisteredRuntimeAPIs();
    void apis?.push?.unregisterApnsToken?.({ token });
  }, [nativeNotificationsEnabled]);
};
