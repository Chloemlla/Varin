import { afterEach, expect, it, vi } from 'vitest';
import { artworkHitTest } from './artwork-hit-test';
import type { CompanionFrame } from './sequencePackage';

afterEach(() => vi.unstubAllGlobals());
it('does no work when idle and reuses the atlas alpha at the painted offset across exposures', () => {
  const rgba = new Uint8ClampedArray([0,0,0,16, 0,0,0,17, 0,0,0,255]);
  const ctx = { drawImage: vi.fn(), getImageData: vi.fn(() => ({ data: rgba })) };
  vi.stubGlobal('document', { createElement: () => ({ getContext: () => ctx }) });
  const image = {} as ImageBitmap;
  const frame: CompanionFrame = { rect: [4, 1, 3, 1], offset: [10, 20], page: 0, startMs: 0, durationMs: 50 };
  const hit = artworkHitTest(image, frame);
  expect(hit(9, 20)).toBe(false); expect(ctx.getImageData).not.toHaveBeenCalled();
  expect(hit(10.9,20)).toBe(false); expect(hit(11,20)).toBe(true); expect(hit(13,20)).toBe(false);
  expect(artworkHitTest(image, { ...frame, offset: [0,0] })(2,0)).toBe(true);
  expect(ctx.getImageData).toHaveBeenCalledTimes(1);
  expect(ctx.drawImage).toHaveBeenCalledWith(image, 4, 1, 3, 1, 0, 0, 3, 1);
});
