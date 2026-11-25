import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import type { CompanionPackage } from './sequencePackage';
import { useCompanionPlayback } from './useCompanionPlayback';

it('paints the hidden startup window, then suspends and resumes at the displayed pose', () => {
  const { window } = parseHTML('<html><body><div id="root"></div></body></html>');
  let hidden = true, sequence = 0;
  Object.defineProperty(window.document, 'hidden', { get: () => hidden });
  const frames = new Map<number, FrameRequestCallback>();
  vi.stubGlobal('document', window.document);
  vi.stubGlobal('window', window);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  vi.stubGlobal('requestAnimationFrame', (fn: FrameRequestCallback) => { frames.set(++sequence, fn); return sequence; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id));
  const paint = (now: number) => {
    expect(frames.size).toBe(1);
    const [[id, frame]] = [...frames] as [[number, FrameRequestCallback]];
    frames.delete(id);
    act(() => frame(now));
  };
  const visibility = (value: boolean) => {
    hidden = value;
    act(() => document.dispatchEvent(new window.Event('visibilitychange')));
  };
  const assets: CompanionPackage[] = [{
    id: 'rest', action: 'rest', kind: 'action', stage: 'motion-candidate', reviewStatus: 'accepted',
    entryPose: 'rest', exitPose: 'rest', geometryReference: 'rest', canvas: [1, 1], pages: [], durationMs: 300,
    frames: [0, 100, 200].map(startMs => ({ page: 0, rect: [0, 0, 1, 1], offset: [0, 0], durationMs: 100, startMs, pose: 'rest' })),
  }];
  function Probe({ startup }: { startup: boolean }) {
    const view = useCompanionPlayback(assets, 'rest', false, ['rest'], undefined, { awaitingFirstPaint: startup });
    return React.createElement('output', null, view.packageId + '/' + view.exposure);
  }
  const root = createRoot(document.getElementById('root')!);
  try {
    act(() => root.render(React.createElement(Probe, { startup: true })));
    paint(0);
    expect(document.querySelector('output')!.textContent).toBe('rest/0');
    act(() => root.render(React.createElement(Probe, { startup: false })));
    expect(frames.size).toBe(0);
    visibility(false);
    paint(10);
    paint(120);
    expect(document.querySelector('output')!.textContent).toBe('rest/1');
    visibility(true);
    expect(frames.size).toBe(0);
    visibility(false);
    paint(20_000);
    expect(document.querySelector('output')!.textContent).toBe('rest/1');
    paint(20_100);
    expect(document.querySelector('output')!.textContent).toBe('rest/2');
  } finally {
    act(() => root.unmount());
    vi.unstubAllGlobals();
  }
  expect(frames.size).toBe(0);
});
