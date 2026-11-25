import { expect, it, vi } from 'vitest';
import { BrowserPageActivity, BrowserFrameReferences } from './browser-page-lifetime.js';

it('throttles a parked idle renderer but allows hidden read/capture and overlapping work before sleeping again', async () => {
  const applied = vi.fn(), activity = new BrowserPageActivity(applied);
  activity.present(false);
  const first = activity.hold();
  await expect(activity.during(async () => { throw new Error('cancel'); })).rejects.toThrow('cancel');
  activity.present(true); first(); first(); activity.present(false);
  await activity.during(async () => expect(applied).toHaveBeenLastCalledWith(false));
  expect(applied.mock.calls.flat()).toEqual([true, false, true, false, true]);
});

it('retires removed SPA nodes without breaking surviving IDs, other frames, or full-tree-only refs', () => {
  let id = 0;
  const refs = new BrowserFrameReferences<object, string>(() => String(id++));
  const main = {}, child = {};
  refs.observeDocument(main, 'document-a');
  const a = refs.record(main, 'a', 'current', true), b = refs.record(main, 'b', 'obsolete', true);
  const detailed = refs.record(main, 'c', 'hidden label', false), nested = refs.record(child, 'a', 'child', true);
  refs.observeDocument(main, 'document-a'); // hash / pushState navigation
  expect(refs.record(main, 'a', 'new snapshot same element', true)).toBe(a);
  refs.finish(main, new Set(['a']), false);
  expect(refs.get(b)).toBeUndefined(); expect(refs.get(detailed)).toBeDefined(); expect(refs.get(nested)?.node).toBe('child');
  refs.finish(main, new Set(['a']), true); expect(refs.get(detailed)).toBeUndefined();
  refs.retire(child); expect(refs.get(nested)).toBeUndefined(); expect(refs.get(a)?.node).toContain('same element');
  refs.observeDocument(main, 'document-b');
  expect(refs.get(a)).toBeUndefined();
});
