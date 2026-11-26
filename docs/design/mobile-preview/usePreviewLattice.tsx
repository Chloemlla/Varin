import React from 'react';
import { flushSync } from 'react-dom';
import { LatticeStage } from '@/components/ui/workbench-lattice-stage';
import { latticeOrigin, SETTINGS_WAVE_SCALE, type LatticePoint } from '@/components/ui/workbench-lattice';
import type { MotionLevel } from '@/lib/motion/preference';
import { recentPointer } from '@/lib/motion/pointer';

export type ShellWave = { kind: 'mode'; inward: boolean } | { kind: 'settings'; opening: boolean };

/** The preview supplies the route change; the desktop renderer owns the grid and both animation phases. */
export function usePreviewLattice() {
  const root = React.useRef<HTMLDivElement>(null);
  const field = React.useRef<HTMLDivElement>(null);
  const sheet = React.useRef<HTMLDivElement>(null);
  const running = React.useRef<LatticeStage | null>(null);
  const stop = React.useCallback(() => {
    running.current?.dispose();
    running.current = null;
    if (root.current) {
      root.current.hidden = true;
      delete root.current.dataset.covering;
    }
  }, []);
  React.useEffect(() => stop, [stop]);
  const play = React.useCallback(async (wave: ShellWave, level: MotionLevel, point: LatticePoint | null, commit: () => void) => {
    const layer = root.current;
    if (!layer || !field.current || !sheet.current || level === 'off') { commit(); return; }
    layer.hidden = false;
    layer.dataset.covering = '';
    const stage = new LatticeStage(layer, field.current, sheet.current, level, wave.kind === 'settings' ? SETTINGS_WAVE_SCALE : 1);
    running.current = stage;
    try {
      let origin: LatticePoint;
      if (wave.kind === 'mode') origin = stage.measureOrigin(recentPointer());
      else {
        const selector = wave.opening ? '[data-varin-settings-origin="open"]' : '[data-varin-settings-origin="return"]';
        const anchor = layer.parentElement?.querySelector(selector);
        origin = latticeOrigin(layer.getBoundingClientRect(), !point && anchor ? anchor.getBoundingClientRect() : null, point);
      }
      if (!await stage.cover(origin) || running.current !== stage) return;
      stage.close();
      flushSync(commit);
      delete layer.dataset.covering;
      await stage.reveal(wave.kind === 'mode' ? stage.measureOrigin(null, origin) : origin, wave.kind === 'mode' && wave.inward);
    } finally {
      if (running.current === stage) stop();
    }
  }, [stop]);
  return { stop, play, layer: <div ref={root} className="wb-lattice workbench-settings-lattice" hidden aria-hidden="true">
    <div className="wb-lattice-field" ref={field} /><div className="wb-lattice-sheet" ref={sheet} />
  </div> };
}
