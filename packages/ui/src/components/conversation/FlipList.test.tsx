import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { parseHTML } from 'linkedom';
import { expect, it, vi } from 'vitest';
import { FlipList } from './FlipList';

it('animates changes within a view and replaces views without measuring rows or leaving ghosts', async () => {
  const { window, document } = parseHTML('<html><body></body></html>');
  vi.stubGlobal('window', window); vi.stubGlobal('document', document);
  vi.stubGlobal('HTMLElement', window.HTMLElement); vi.stubGlobal('Element', window.Element);
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  let reads = 0;
  window.HTMLElement.prototype.getBoundingClientRect = function () {
    reads++;
    const top = Number(this.getAttribute('data-top') ?? 0);
    return { top, left: 0, width: 200, height: 30, bottom: top + 30, right: 200, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  const animations: Array<{ cancel: ReturnType<typeof vi.fn>; options: KeyframeAnimationOptions }> = [];
  window.HTMLElement.prototype.animate = function (_frames, options) {
    const cancel = vi.fn();
    animations.push({ cancel, options: options as KeyframeAnimationOptions });
    return { cancel, finished: new Promise(() => {}) } as unknown as Animation;
  };
  const host = document.createElement('div'); document.body.append(host);
  const root = createRoot(host);
  const list = (order: string[], status: string, view = 'classified') => <FlipList layoutKey={order.join(',')} instantKey={view}>
    {order.map((key, index) => <div key={key} data-flip-key={key} data-top={index * 30}>{key} {status}</div>)}
  </FlipList>;
  const groups = (open: boolean, target: 'left' | 'right') => <FlipList layoutKey={`${open}:${target}`} instantKey="classified">
    <div data-flip-key="left" data-top={0} data-collapsed={open ? undefined : ''}>
      <div inert={!open}>{target === 'left' && <div data-flip-key="child" data-top={30} />}</div>
    </div>
    <div data-flip-key="right" data-top={60}>
      {target === 'right' && <div data-flip-key="child" data-top={90} />}
    </div>
  </FlipList>;
  try {
    await act(async () => root.render(list(['a', 'b'], 'running')));
    await act(async () => root.render(list(['b', 'a'], 'running')));
    expect(animations).toHaveLength(2);
    reads = 0;
    await act(async () => root.render(list(['b', 'a'], 'completed')));
    expect(reads).toBe(0);
    expect(animations).toHaveLength(2);
    expect(animations.every(value => value.cancel.mock.calls.length === 0)).toBe(true);
    await act(async () => root.render(list(['a', 'b'], 'completed')));
    expect(animations).toHaveLength(4);
    expect(animations.every(value => value.options.composite === 'add' && !value.cancel.mock.calls.length)).toBe(true);

    await act(async () => root.render(list(['a'], 'completed')));
    expect(host.querySelector('[data-flip-ghost]')).not.toBeNull();
    const previousAnimations = animations.length;
    reads = 0;
    await act(async () => root.render(list([], 'completed', 'recent-loading')));
    await act(async () => root.render(list(['b', 'c'], 'completed', 'recent-ready')));
    expect(reads).toBe(0);
    expect(host.querySelector('[data-flip-ghost]')).toBeNull();
    expect(animations).toHaveLength(previousAnimations);
    expect(animations.slice(0, 4).every(value => value.cancel.mock.calls.length === 1)).toBe(true);

    await act(async () => root.render(list(['c', 'b'], 'completed', 'recent-ready')));
    expect(animations.slice(previousAnimations).map(value => value.options.composite)).toEqual(['add', 'add']);

    await act(async () => root.render(groups(false, 'left')));
    const beforeOpening = animations.length;
    await act(async () => root.render(groups(true, 'left')));
    expect(animations.slice(beforeOpening).map(value => value.options.fill)).toEqual(['backwards']);
    const beforeMoving = animations.length;
    await act(async () => root.render(groups(true, 'right')));
    expect(animations.slice(beforeMoving).map(value => value.options.composite)).toEqual(['add']);
  } finally { await act(async () => root.unmount()); vi.unstubAllGlobals(); }
});
