import React from 'react';
import { isCapacitorApp } from '@/lib/platform';

export function useNativeAndroidBackButton(active: boolean, onBack: () => boolean) {
  const handle = React.useRef(onBack);
  handle.current = onBack;
  React.useEffect(() => {
    if (!active || !isCapacitorApp()) return;
    let disposed = false;
    const listener = import('@capacitor/app').then(({ App }) => {
      if (disposed) return;
      return App.addListener('backButton', () => {
        const focused = document.activeElement;
        const overlay = focused?.closest('[role="dialog"], [role="menu"], [role="listbox"]');
        if (overlay) { focused?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })); return; }
        if (!handle.current()) void App.minimizeApp().catch(() => undefined);
      });
    }).catch(() => undefined);
    return () => { disposed = true; void listener.then(subscription => subscription?.remove()).catch(() => undefined); };
  }, [active]);
}
