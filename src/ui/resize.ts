/**
 * Shared geometry for the 8-handle resize box used by the PDF and image editors:
 * four corners plus a width/height anchor in the middle of each side.
 */

export type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

export const ALL_HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
export const CORNER_HANDLES: Handle[] = ['nw', 'ne', 'se', 'sw'];

export interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Position of a handle as fractions of the box (0..1). */
export const HANDLE_POS: Record<Handle, [number, number]> = {
  nw: [0, 0], n: [0.5, 0], ne: [1, 0], e: [1, 0.5], se: [1, 1], s: [0.5, 1], sw: [0, 1], w: [0, 0.5],
};

export const HANDLE_CURSOR: Record<Handle, string> = {
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
};

const isCorner = (h: Handle) => h.length === 2;

/**
 * New box after dragging handle `h` by (dx, dy). The opposite side/corner stays put.
 * With keepAspect, corners scale uniformly and side anchors change both dimensions,
 * keeping the box centred on the other axis.
 */
export function resizeBox(b: Box, h: Handle, dx: number, dy: number, opts: { keepAspect?: boolean; min?: number } = {}): Box {
  const min = opts.min ?? 4;
  let left = b.x;
  let top = b.y;
  let right = b.x + b.width;
  let bottom = b.y + b.height;
  if (h.includes('w')) left = Math.min(left + dx, right - min);
  if (h.includes('e')) right = Math.max(right + dx, left + min);
  if (h.includes('n')) top = Math.min(top + dy, bottom - min);
  if (h.includes('s')) bottom = Math.max(bottom + dy, top + min);
  let w = right - left;
  let hgt = bottom - top;

  if (opts.keepAspect && b.width > 0 && b.height > 0) {
    const ratio = b.width / b.height;
    if (isCorner(h)) {
      const k = Math.max(w / b.width, hgt / b.height);
      w = Math.max(min, b.width * k);
      hgt = Math.max(min, b.height * k);
      left = h.includes('w') ? right - w : left;
      top = h.includes('n') ? bottom - hgt : top;
    } else if (h === 'e' || h === 'w') {
      hgt = Math.max(min, w / ratio);
      top = b.y + (b.height - hgt) / 2;
    } else {
      w = Math.max(min, hgt * ratio);
      left = b.x + (b.width - w) / 2;
    }
  }
  return { x: left, y: top, width: w, height: hgt };
}

/** Maps a point from one box into another (used to scale lines and freehand strokes). */
export function mapPoint(from: Box, to: Box, x: number, y: number): [number, number] {
  const kx = from.width > 0 ? to.width / from.width : 1;
  const ky = from.height > 0 ? to.height / from.height : 1;
  return [to.x + (x - from.x) * kx, to.y + (y - from.y) * ky];
}
