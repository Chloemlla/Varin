import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { afterEach, expect, it, vi } from 'vitest';
import { useNativePushRegistration } from './useNativePushRegistration';

const mock = vi.hoisted(() => ({
  getAvailability: vi.fn(),
  checkPermissions: vi.fn(async () => ({ receive: 'granted' })),
  requestPermissions: vi.fn(),
  addListener: vi.fn(async () => ({ remove: vi.fn() })),
  register: vi.fn(async () => {}),
}));

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => ({ getAvailability: mock.getAvailability }),
}));
vi.mock('@capacitor/push-notifications', () => ({ PushNotifications: mock }));
vi.mock('@/lib/runtime-api/registry', () => ({ getRegisteredRuntimeAPIs: () => null }));
vi.mock('@/stores/useThreadStore', () => ({
  useThreadStore: (select: (state: { hostKey: string }) => unknown) => select({ hostKey: 'connected' }),
}));
vi.mock('@/stores/useUIStore', () => ({
  useUIStore: (select: (state: { nativeNotificationsEnabled: boolean }) => unknown) =>
    select({ nativeNotificationsEnabled: true }),
}));

function ConnectedPhone() {
  useNativePushRegistration({ enabled: true });
  return null;
}

afterEach(() => vi.unstubAllGlobals());

it.each([
  { platform: 'android', available: false, registers: false },
  { platform: 'android', available: true, registers: true },
  { platform: 'ios', available: false, registers: true },
])('registers push on $platform with availability $available only when supported', async ({ platform, available, registers }) => {
  vi.clearAllMocks();
  mock.getAvailability.mockResolvedValue({ available });
  const { document, window } = parseHTML('<html><body><div id="root"></div></body></html>');
  Object.defineProperty(window, 'Capacitor', {
    configurable: true,
    value: { getPlatform: () => platform, isNativePlatform: () => true },
  });
  vi.stubGlobal('window', window);
  vi.stubGlobal('document', document);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.getElementById('root')!);
  try {
    await act(async () => root.render(<ConnectedPhone />));
    await vi.dynamicImportSettled();
    expect(mock.getAvailability).toHaveBeenCalledTimes(platform === 'android' ? 1 : 0);
    expect(mock.checkPermissions).toHaveBeenCalledTimes(registers ? 1 : 0);
    expect(mock.register).toHaveBeenCalledTimes(registers ? 1 : 0);
    expect(mock.requestPermissions).not.toHaveBeenCalled();
  } finally {
    await act(async () => root.unmount());
  }
});
