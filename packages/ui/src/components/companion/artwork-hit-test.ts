import type { CompanionFrame } from './sequencePackage';

export type ArtworkHitTest = (x: number, y: number) => boolean;
// A collision mask follows the decoded artwork, not palette/animation lifetime.
// Identical atlas rectangles reuse one bit per pixel, even at different offsets.
const atlases = new WeakMap<ImageBitmap, Map<string, Uint8Array>>();
let reader: HTMLCanvasElement | undefined;

export function artworkHitTest(image: ImageBitmap, frame: CompanionFrame): ArtworkHitTest {
  const [sx, sy, w, h] = frame.rect, [dx, dy] = frame.offset;
  let mask: Uint8Array | undefined;
  return (x, y) => {
    x = Math.floor(x) - dx; y = Math.floor(y) - dy;
    if (x < 0 || y < 0 || x >= w || y >= h) return false;
    if (!mask) {
      let rectangles = atlases.get(image);
      if (!rectangles) { rectangles = new Map(); atlases.set(image, rectangles); }
      const key = frame.rect.join(',');
      mask = rectangles.get(key);
      if (!mask) {
        reader ??= document.createElement('canvas');
        reader.width = w; reader.height = h;
        const context = reader.getContext('2d', { willReadFrequently: true });
        if (!context || context.isContextLost?.()) return false;
        try {
          context.drawImage(image, sx, sy, w, h, 0, 0, w, h);
          const { data } = context.getImageData(0, 0, w, h);
          const bits = new Uint8Array(Math.ceil(w * h / 8));
          for (let i = 0; i < w*h; i++) if (data[4*i+3]! > 16) bits[i >>> 3] = bits[i >>> 3]! | (1 << (i & 7));
          mask = bits; rectangles.set(key, mask);
        } catch { return false; }
      }
    }
    const i = y * w + x;
    return Boolean(mask[i >>> 3]! & (1 << (i & 7)));
  };
}
