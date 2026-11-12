/**
 * Renders a DrawingML group / shape / picture (as found in Word headers: background panels,
 * gradient bands, faded photos, rounded boxes) to a raster image, so it can be shown and saved
 * as an ordinary picture. Supports the common preset shapes, solid / gradient / picture fills,
 * outlines, theme colours with their modifiers, rotation and flips. Anything else is skipped.
 *
 * Needs OffscreenCanvas (every browser and Electron); returns null where it is missing (tests).
 */

const EMU_PER_PX = 9525;

export interface ThemeColors {
  /** scheme name (dk1, lt1, dk2, lt2, accent1…6, hlink, folHlink) → "rrggbb" */
  scheme: Record<string, string>;
  /** w:clrSchemeMapping: bg1/tx1/bg2/tx2/… → scheme name */
  map: Record<string, string>;
}

export const DEFAULT_COLOR_MAP: Record<string, string> = {
  bg1: 'lt1', tx1: 'dk1', bg2: 'lt2', tx2: 'dk2',
  accent1: 'accent1', accent2: 'accent2', accent3: 'accent3', accent4: 'accent4', accent5: 'accent5', accent6: 'accent6',
  hlink: 'hlink', folHlink: 'folHlink',
};

export interface RenderEnv {
  theme: ThemeColors;
  /** relationship id → image data URL */
  media: Map<string, string>;
}

const kids = (el: Element | null | undefined, name?: string): Element[] =>
  el ? Array.from(el.children).filter((c) => !name || c.localName === name) : [];
const kid = (el: Element | null | undefined, name: string): Element | null => kids(el, name)[0] ?? null;
const num = (el: Element | null | undefined, name: string, d = 0): number => {
  const v = el?.getAttribute(name);
  const n = v === null || v === undefined ? NaN : parseFloat(v);
  return Number.isFinite(n) ? n : d;
};
const relId = (el: Element | null): string | null => {
  if (!el) return null;
  for (const a of Array.from(el.attributes)) if (a.localName === 'embed') return a.value;
  return null;
};

// ── colours ─────────────────────────────────────────────────────────────────

interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

function hexToRgba(hex: string): Rgba {
  const n = parseInt(hex.padEnd(6, '0').slice(0, 6), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255, a: 1 };
}

function rgbToHsl({ r, g, b }: Rgba): [number, number, number] {
  const R = r / 255, G = g / 255, B = b / 255;
  const max = Math.max(R, G, B), min = Math.min(R, G, B);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === R ? (G - B) / d + (G < B ? 6 : 0) : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number, a: number): Rgba {
  if (s === 0) return { r: l * 255, g: l * 255, b: l * 255, a };
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const f = (t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  return { r: f(h + 1 / 3) * 255, g: f(h) * 255, b: f(h - 1 / 3) * 255, a };
}

/** A colour element (srgbClr, schemeClr, sysClr, prstClr) with its modifiers. */
function colorOf(el: Element | null, env: RenderEnv, placeholder?: Rgba): Rgba | null {
  if (!el) return null;
  let base: Rgba | null = null;
  switch (el.localName) {
    case 'srgbClr':
      base = hexToRgba(el.getAttribute('val') ?? '000000');
      break;
    case 'sysClr':
      base = hexToRgba(el.getAttribute('lastClr') ?? (el.getAttribute('val') === 'window' ? 'FFFFFF' : '000000'));
      break;
    case 'schemeClr': {
      const v = el.getAttribute('val') ?? '';
      if (v === 'phClr') base = placeholder ? { ...placeholder } : null;
      else {
        const name = env.theme.map[v] ?? v;
        const hex = env.theme.scheme[name];
        base = hex ? hexToRgba(hex) : null;
      }
      break;
    }
    case 'prstClr': {
      const v = (el.getAttribute('val') ?? '').toLowerCase();
      base = hexToRgba(v === 'white' ? 'FFFFFF' : v === 'red' ? 'FF0000' : v === 'blue' ? '0000FF' : v === 'green' ? '008000' : '000000');
      break;
    }
    default:
      return null;
  }
  if (!base) return null;
  let c = base;
  for (const m of kids(el)) {
    const v = num(m, 'val', 100000) / 100000;
    switch (m.localName) {
      case 'alpha':
        c = { ...c, a: v };
        break;
      case 'alphaMod':
        c = { ...c, a: c.a * v };
        break;
      case 'lumMod': {
        const [h, s, l] = rgbToHsl(c);
        c = hslToRgb(h, s, Math.min(1, l * v), c.a);
        break;
      }
      case 'lumOff': {
        const [h, s, l] = rgbToHsl(c);
        c = hslToRgb(h, s, Math.min(1, Math.max(0, l + v)), c.a);
        break;
      }
      case 'shade':
        c = { r: c.r * v, g: c.g * v, b: c.b * v, a: c.a };
        break;
      case 'tint':
        c = { r: 255 - (255 - c.r) * v, g: 255 - (255 - c.g) * v, b: 255 - (255 - c.b) * v, a: c.a };
        break;
      default:
        break;
    }
  }
  return c;
}

const css = (c: Rgba): string => `rgba(${Math.round(c.r)}, ${Math.round(c.g)}, ${Math.round(c.b)}, ${c.a})`;
const COLOR_TAGS = new Set(['srgbClr', 'schemeClr', 'sysClr', 'prstClr']);
const firstColor = (el: Element | null): Element | null => kids(el).find((c) => COLOR_TAGS.has(c.localName)) ?? null;

// ── geometry ────────────────────────────────────────────────────────────────

function adj(prstGeom: Element | null, name: string, d: number): number {
  for (const gd of kids(kid(prstGeom, 'avLst'), 'gd')) {
    if (gd.getAttribute('name') === name) {
      const m = /val\s+(-?\d+)/.exec(gd.getAttribute('fmla') ?? '');
      if (m) return parseInt(m[1], 10);
    }
  }
  return d;
}

/** Builds a Path2D from DrawingML path commands (preset or custom geometry). */
function pathFromCommands(
  cmds: Array<{ op: string; pts: Array<{ x: number; y: number }> }>,
  sx: number,
  sy: number,
): Path2D {
  const p = new Path2D();
  for (const c of cmds) {
    const pts = c.pts.map((pt) => ({ x: pt.x * sx, y: pt.y * sy }));
    switch (c.op) {
      case 'moveTo':
        if (pts[0]) p.moveTo(pts[0].x, pts[0].y);
        break;
      case 'lnTo':
        if (pts[0]) p.lineTo(pts[0].x, pts[0].y);
        break;
      case 'cubicBezTo':
        if (pts.length >= 3) p.bezierCurveTo(pts[0].x, pts[0].y, pts[1].x, pts[1].y, pts[2].x, pts[2].y);
        break;
      case 'quadBezTo':
        if (pts.length >= 2) p.quadraticCurveTo(pts[0].x, pts[0].y, pts[1].x, pts[1].y);
        break;
      case 'arcTo':
        // approximate as a line to the end point (icons rarely rely on arcTo alone)
        if (pts[0]) p.lineTo(pts[0].x, pts[0].y);
        break;
      case 'close':
        p.closePath();
        break;
      default:
        break;
    }
  }
  return p;
}

function readPathCommands(pathEl: Element): Array<{ op: string; pts: Array<{ x: number; y: number }> }> {
  const cmds: Array<{ op: string; pts: Array<{ x: number; y: number }> }> = [];
  for (const child of kids(pathEl)) {
    const pts = kids(child, 'pt').map((pt) => ({ x: num(pt, 'x'), y: num(pt, 'y') }));
    // arcTo uses different attributes; keep an end-ish point if present
    if (child.localName === 'arcTo' && !pts.length) {
      pts.push({ x: num(child, 'wR') + num(child, 'hR'), y: num(child, 'hR') });
    }
    cmds.push({ op: child.localName, pts });
  }
  return cmds;
}

/** Custom geometry (footer icons etc.): scale each path's coordinate space into the shape box. */
function custGeomPath(custGeom: Element | null, w: number, h: number): Path2D | null {
  if (!custGeom) return null;
  const paths = kids(kid(custGeom, 'pathLst'), 'path');
  if (!paths.length) return null;
  const combined = new Path2D();
  let any = false;
  for (const pathEl of paths) {
    const pw = num(pathEl, 'w', w) || w;
    const ph = num(pathEl, 'h', h) || h;
    const cmds = readPathCommands(pathEl);
    if (!cmds.length) continue;
    combined.addPath(pathFromCommands(cmds, w / pw, h / ph));
    any = true;
  }
  return any ? combined : null;
}

/** Path of a preset or custom shape in a w×h box, or null for shapes we don't draw. */
function shapePath(spPr: Element | null, w: number, h: number): Path2D | null {
  const cust = kid(spPr, 'custGeom');
  if (cust) return custGeomPath(cust, w, h);
  const prstGeom = kid(spPr, 'prstGeom');
  const prst = prstGeom?.getAttribute('prst') ?? 'rect';
  const p = new Path2D();
  const ss = Math.min(w, h);
  const round = (tl: number, tr: number, br: number, bl: number) => {
    p.moveTo(tl, 0);
    p.lineTo(w - tr, 0);
    p.arcTo(w, 0, w, tr, tr);
    p.lineTo(w, h - br);
    p.arcTo(w, h, w - br, h, br);
    p.lineTo(bl, h);
    p.arcTo(0, h, 0, h - bl, bl);
    p.lineTo(0, tl);
    p.arcTo(0, 0, tl, 0, tl);
    p.closePath();
  };
  switch (prst) {
    case 'rect':
      p.rect(0, 0, w, h);
      return p;
    case 'roundRect': {
      const r = (ss * adj(prstGeom, 'adj', 16667)) / 100000;
      round(r, r, r, r);
      return p;
    }
    case 'round2SameRect': {
      const t = (ss * adj(prstGeom, 'adj1', 16667)) / 100000;
      const b = (ss * adj(prstGeom, 'adj2', 0)) / 100000;
      round(t, t, b, b);
      return p;
    }
    case 'round1Rect': {
      const r = (ss * adj(prstGeom, 'adj', 16667)) / 100000;
      round(0, r, 0, 0);
      return p;
    }
    case 'ellipse':
    case 'circle':
      p.ellipse(w / 2, h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
      return p;
    case 'line':
      p.moveTo(0, 0);
      p.lineTo(w, h);
      return p;
    case 'triangle':
      p.moveTo(w / 2, 0);
      p.lineTo(w, h);
      p.lineTo(0, h);
      p.closePath();
      return p;
    case 'diamond':
      p.moveTo(w / 2, 0);
      p.lineTo(w, h / 2);
      p.lineTo(w / 2, h);
      p.lineTo(0, h / 2);
      p.closePath();
      return p;
    case 'pentagon': {
      for (let i = 0; i < 5; i++) {
        const a = (-Math.PI / 2) + (i * 2 * Math.PI) / 5;
        const x = w / 2 + (w / 2) * Math.cos(a);
        const y = h / 2 + (h / 2) * Math.sin(a);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
      return p;
    }
    case 'hexagon': {
      for (let i = 0; i < 6; i++) {
        const a = (i * Math.PI) / 3;
        const x = w / 2 + (w / 2) * Math.cos(a);
        const y = h / 2 + (h / 2) * Math.sin(a);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
      return p;
    }
    case 'rightArrow': {
      const neck = h * 0.35;
      p.moveTo(0, neck);
      p.lineTo(w * 0.55, neck);
      p.lineTo(w * 0.55, 0);
      p.lineTo(w, h / 2);
      p.lineTo(w * 0.55, h);
      p.lineTo(w * 0.55, h - neck);
      p.lineTo(0, h - neck);
      p.closePath();
      return p;
    }
    case 'leftArrow': {
      const neck = h * 0.35;
      p.moveTo(w, neck);
      p.lineTo(w * 0.45, neck);
      p.lineTo(w * 0.45, 0);
      p.lineTo(0, h / 2);
      p.lineTo(w * 0.45, h);
      p.lineTo(w * 0.45, h - neck);
      p.lineTo(w, h - neck);
      p.closePath();
      return p;
    }
    case 'upArrow': {
      const neck = w * 0.35;
      p.moveTo(neck, h);
      p.lineTo(neck, h * 0.45);
      p.lineTo(0, h * 0.45);
      p.lineTo(w / 2, 0);
      p.lineTo(w, h * 0.45);
      p.lineTo(w - neck, h * 0.45);
      p.lineTo(w - neck, h);
      p.closePath();
      return p;
    }
    case 'downArrow': {
      const neck = w * 0.35;
      p.moveTo(neck, 0);
      p.lineTo(neck, h * 0.55);
      p.lineTo(0, h * 0.55);
      p.lineTo(w / 2, h);
      p.lineTo(w, h * 0.55);
      p.lineTo(w - neck, h * 0.55);
      p.lineTo(w - neck, 0);
      p.closePath();
      return p;
    }
    case 'plus':
    case 'cross': {
      const t = ss * 0.28;
      p.moveTo((w - t) / 2, 0);
      p.lineTo((w + t) / 2, 0);
      p.lineTo((w + t) / 2, (h - t) / 2);
      p.lineTo(w, (h - t) / 2);
      p.lineTo(w, (h + t) / 2);
      p.lineTo((w + t) / 2, (h + t) / 2);
      p.lineTo((w + t) / 2, h);
      p.lineTo((w - t) / 2, h);
      p.lineTo((w - t) / 2, (h + t) / 2);
      p.lineTo(0, (h + t) / 2);
      p.lineTo(0, (h - t) / 2);
      p.lineTo((w - t) / 2, (h - t) / 2);
      p.closePath();
      return p;
    }
    case 'star4':
    case 'star5':
    case 'star6': {
      const tips = prst === 'star4' ? 4 : prst === 'star6' ? 6 : 5;
      const outer = 0.5;
      const inner = 0.2;
      for (let i = 0; i < tips * 2; i++) {
        const r = i % 2 === 0 ? outer : inner;
        const a = (-Math.PI / 2) + (i * Math.PI) / tips;
        const x = w / 2 + w * r * Math.cos(a);
        const y = h / 2 + h * r * Math.sin(a);
        if (i === 0) p.moveTo(x, y);
        else p.lineTo(x, y);
      }
      p.closePath();
      return p;
    }
    case 'heart': {
      p.moveTo(w / 2, h * 0.35);
      p.bezierCurveTo(w / 2, h * 0.05, 0, h * 0.05, 0, h * 0.35);
      p.bezierCurveTo(0, h * 0.6, w / 2, h * 0.85, w / 2, h);
      p.bezierCurveTo(w / 2, h * 0.85, w, h * 0.6, w, h * 0.35);
      p.bezierCurveTo(w, h * 0.05, w / 2, h * 0.05, w / 2, h * 0.35);
      p.closePath();
      return p;
    }
    default:
      // unknown preset: fall back to the bounding rectangle so icons still appear
      p.rect(0, 0, w, h);
      return p;
  }
}

// ── drawing ─────────────────────────────────────────────────────────────────

type Ctx2D = OffscreenCanvasRenderingContext2D;

interface Xfrm {
  x: number;
  y: number;
  w: number;
  h: number;
  rot: number;
  flipH: boolean;
  flipV: boolean;
}

function readXfrm(xfrm: Element | null): Xfrm {
  const off = kid(xfrm, 'off');
  const ext = kid(xfrm, 'ext');
  return {
    x: num(off, 'x'),
    y: num(off, 'y'),
    w: num(ext, 'cx'),
    h: num(ext, 'cy'),
    rot: num(xfrm, 'rot') / 60000,
    flipH: xfrm?.getAttribute('flipH') === '1',
    flipV: xfrm?.getAttribute('flipV') === '1',
  };
}

/** Sets the transform for a shape's own box (rotation and flips about its centre). */
function enterBox(ctx: Ctx2D, x: Xfrm): void {
  ctx.translate(x.x + x.w / 2, x.y + x.h / 2);
  if (x.rot) ctx.rotate((x.rot * Math.PI) / 180);
  ctx.scale(x.flipH ? -1 : 1, x.flipV ? -1 : 1);
  ctx.translate(-x.w / 2, -x.h / 2);
}

async function loadImage(src: string): Promise<ImageBitmap | null> {
  try {
    return await createImageBitmap(await (await fetch(src)).blob());
  } catch {
    return null;
  }
}

function fillStyle(ctx: Ctx2D, spPr: Element | null, style: Element | null, env: RenderEnv, w: number, h: number): string | CanvasGradient | null {
  const solid = kid(spPr, 'solidFill');
  const grad = kid(spPr, 'gradFill');
  if (kid(spPr, 'noFill')) return null;
  if (solid) {
    const c = colorOf(firstColor(solid), env);
    return c ? css(c) : null;
  }
  if (grad) {
    const stops = kids(kid(grad, 'gsLst'), 'gs')
      .map((gs) => ({ pos: num(gs, 'pos') / 100000, c: colorOf(firstColor(gs), env) }))
      .filter((s): s is { pos: number; c: Rgba } => !!s.c)
      .sort((a, b) => a.pos - b.pos);
    if (!stops.length) return null;
    const ang = (num(kid(grad, 'lin'), 'ang') / 60000) * (Math.PI / 180);
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    // gradient line through the centre, long enough to span the box at that angle
    const half = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    const g = ctx.createLinearGradient(w / 2 - dx * half, h / 2 - dy * half, w / 2 + dx * half, h / 2 + dy * half);
    for (const s of stops) g.addColorStop(Math.min(1, Math.max(0, s.pos)), css(s.c));
    return g;
  }
  // no fill in the shape properties: the shape style's fill reference applies
  const ref = kid(style, 'fillRef');
  if (ref && num(ref, 'idx') > 0) {
    const c = colorOf(firstColor(ref), env);
    return c ? css(c) : null;
  }
  return null;
}

function lineStyle(spPr: Element | null, style: Element | null, env: RenderEnv): { color: string; width: number } | null {
  const ln = kid(spPr, 'ln');
  if (kid(ln, 'noFill')) return null;
  const width = num(ln, 'w', 9525);
  const solid = kid(ln, 'solidFill');
  if (solid) {
    const c = colorOf(firstColor(solid), env);
    return c ? { color: css(c), width } : null;
  }
  const ref = kid(style, 'lnRef');
  if (ref && num(ref, 'idx') > 0) {
    const c = colorOf(firstColor(ref), env);
    return c ? { color: css(c), width: ln ? width : 12700 * num(ref, 'idx') } : null;
  }
  return null;
}

async function drawShape(ctx: Ctx2D, sp: Element, env: RenderEnv): Promise<void> {
  const spPr = kid(sp, 'spPr');
  const x = readXfrm(kid(spPr, 'xfrm'));
  if (x.w <= 0 && x.h <= 0) return;
  const path = shapePath(spPr, x.w, x.h);
  if (!path) return;
  ctx.save();
  enterBox(ctx, x);
  const style = kid(sp, 'style');
  const fill = fillStyle(ctx, spPr, style, env, x.w, x.h);
  if (fill) {
    ctx.fillStyle = fill;
    ctx.fill(path);
  }
  const blipFill = kid(spPr, 'blipFill');
  if (blipFill) await drawBlip(ctx, blipFill, env, x.w, x.h, path);
  const line = lineStyle(spPr, style, env);
  if (line) {
    ctx.strokeStyle = line.color;
    ctx.lineWidth = line.width;
    ctx.stroke(path);
  }
  ctx.restore();
}

async function drawBlip(ctx: Ctx2D, blipFill: Element, env: RenderEnv, w: number, h: number, clip?: Path2D): Promise<void> {
  const blip = kid(blipFill, 'blip');
  const id = relId(blip);
  const src = id ? env.media.get(id) : undefined;
  if (!src) return;
  const img = await loadImage(src);
  if (!img) return;
  ctx.save();
  if (clip) ctx.clip(clip);
  const alphaFix = kid(blip, 'alphaModFix');
  if (alphaFix) ctx.globalAlpha *= num(alphaFix, 'amt', 100000) / 100000;
  if (kid(blip, 'grayscl')) ctx.filter = 'grayscale(1)';
  // srcRect: percentages (1/1000 %) trimmed from each edge of the picture (negative = padding)
  const sr = kid(blipFill, 'srcRect');
  const l = num(sr, 'l') / 100000;
  const t = num(sr, 't') / 100000;
  const r = num(sr, 'r') / 100000;
  const b = num(sr, 'b') / 100000;
  const sw = img.width * (1 - l - r);
  const sh = img.height * (1 - t - b);
  if (sw > 0 && sh > 0) {
    // map the (possibly extended) source rectangle onto the box
    const kx = w / sw;
    const ky = h / sh;
    ctx.drawImage(img, -img.width * l * kx, -img.height * t * ky, img.width * kx, img.height * ky);
  }
  ctx.restore();
  img.close();
}

async function drawPicture(ctx: Ctx2D, pic: Element, env: RenderEnv): Promise<void> {
  const spPr = kid(pic, 'spPr');
  const x = readXfrm(kid(spPr, 'xfrm'));
  if (x.w <= 0 || x.h <= 0) return;
  ctx.save();
  enterBox(ctx, x);
  await drawBlip(ctx, kid(pic, 'blipFill')!, env, x.w, x.h, shapePath(spPr, x.w, x.h) ?? undefined);
  ctx.restore();
}

async function drawGroup(ctx: Ctx2D, grp: Element, env: RenderEnv, root: boolean): Promise<void> {
  const x = readXfrm(kid(kid(grp, 'grpSpPr'), 'xfrm'));
  const chOff = kid(kid(kid(grp, 'grpSpPr'), 'xfrm'), 'chOff');
  const chExt = kid(kid(kid(grp, 'grpSpPr'), 'xfrm'), 'chExt');
  const cw = num(chExt, 'cx', x.w) || 1;
  const ch = num(chExt, 'cy', x.h) || 1;
  ctx.save();
  if (!root) enterBox(ctx, x);
  // child coordinates → the group's box
  ctx.scale(x.w / cw || 1, x.h / ch || 1);
  ctx.translate(-num(chOff, 'x'), -num(chOff, 'y'));
  for (const child of kids(grp)) await drawElement(ctx, child, env);
  ctx.restore();
}

async function drawElement(ctx: Ctx2D, el: Element, env: RenderEnv): Promise<void> {
  try {
    switch (el.localName) {
      case 'grpSp':
        await drawGroup(ctx, el, env, false);
        break;
      case 'wsp':
      case 'sp':
        await drawShape(ctx, el, env);
        break;
      case 'pic':
        await drawPicture(ctx, el, env);
        break;
      default:
        break;
    }
  } catch {
    /* one broken shape must not lose the rest */
  }
}

/**
 * Renders the content of an a:graphicData (group, shape or picture) at the frame's size.
 * `opaque` flattens onto white and encodes as JPEG (much smaller; for art behind the text).
 */
export async function renderGraphic(graphicData: Element, widthEmu: number, heightEmu: number, env: RenderEnv, opaque: boolean): Promise<string | null> {
  if (typeof OffscreenCanvas === 'undefined' || widthEmu <= 0 || heightEmu <= 0) return null;
  const content = kids(graphicData)[0];
  if (!content) return null;
  const pxW = widthEmu / EMU_PER_PX;
  const pxH = heightEmu / EMU_PER_PX;
  const scale = Math.min(1.5, 2400 / Math.max(pxW, pxH)); // crisp, but bounded in size
  const canvas = new OffscreenCanvas(Math.max(1, Math.round(pxW * scale)), Math.max(1, Math.round(pxH * scale)));
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  if (opaque) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }
  ctx.scale(canvas.width / widthEmu, canvas.height / heightEmu);
  if (content.localName === 'wgp' || content.localName === 'grpSp') {
    // the top-level group fills the frame
    const x = readXfrm(kid(kid(content, 'grpSpPr'), 'xfrm'));
    const chOff = kid(kid(kid(content, 'grpSpPr'), 'xfrm'), 'chOff');
    const chExt = kid(kid(kid(content, 'grpSpPr'), 'xfrm'), 'chExt');
    ctx.scale(widthEmu / (num(chExt, 'cx', x.w) || widthEmu), heightEmu / (num(chExt, 'cy', x.h) || heightEmu));
    ctx.translate(-num(chOff, 'x'), -num(chOff, 'y'));
    for (const child of kids(content)) await drawElement(ctx, child, env);
  } else if (content.localName === 'wsp' || content.localName === 'pic') {
    // a lone shape / picture: draw it in the frame's box
    const spPr = kid(content, 'spPr');
    const xfrm = kid(spPr, 'xfrm');
    if (xfrm) {
      const x = readXfrm(xfrm);
      ctx.scale(widthEmu / (x.w || widthEmu), heightEmu / (x.h || heightEmu));
      ctx.translate(-x.x, -x.y);
    }
    await drawElement(ctx, content, env);
  } else {
    return null;
  }
  const blob = await canvas.convertToBlob(opaque ? { type: 'image/jpeg', quality: 0.86 } : { type: 'image/png' });
  return await new Promise<string | null>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => resolve(null);
    reader.readAsDataURL(blob);
  });
}

/**
 * Payload stored on floating images so DrawingML shapes round-trip as editable shapes in Word
 * instead of being flattened to pictures.
 */
export interface DrawingMlPayload {
  /** Inner XML of <a:graphicData> (children only — avoids duplicate xmlns on reinjection). */
  graphicData: string;
  /** Original graphicData/@uri */
  uri: string;
  cx: number;
  cy: number;
  /** Relationship id → image data URL for blips inside the graphic. */
  media: Record<string, string>;
}

/** Collects every blip relationship id under a graphic. */
function collectBlipIds(el: Element, out: Set<string>): void {
  if (el.localName === 'blip') {
    const id = relId(el);
    if (id) out.add(id);
  }
  for (const c of kids(el)) collectBlipIds(c, out);
}

/** Serializes graphicData children + embedded media so the drawing can be re-emitted on save. */
export function packDrawingMl(graphicData: Element, cx: number, cy: number, media: Map<string, string>): string {
  const ids = new Set<string>();
  collectBlipIds(graphicData, ids);
  const used: Record<string, string> = {};
  for (const id of ids) {
    const src = media.get(id);
    if (src) used[id] = src;
  }
  const ser = new XMLSerializer();
  const inner = Array.from(graphicData.childNodes)
    .map((n) => ser.serializeToString(n))
    .join('');
  const uri = graphicData.getAttribute('uri') ?? '';
  const payload: DrawingMlPayload = { graphicData: inner, uri, cx, cy, media: used };
  return btoa(unescape(encodeURIComponent(JSON.stringify(payload))));
}

export function unpackDrawingMl(encoded: string): DrawingMlPayload | null {
  try {
    const json = decodeURIComponent(escape(atob(encoded)));
    const p = JSON.parse(json) as DrawingMlPayload;
    if (!p?.graphicData || !(p.cx > 0) || !(p.cy > 0)) return null;
    return { ...p, uri: p.uri ?? '' };
  } catch {
    return null;
  }
}

/** SVG path `d` from the same geometry used for canvas drawing (for vector preview). */
function svgPathD(spPr: Element | null, w: number, h: number): string | null {
  // Reuse Path2D by stroking into a temporary canvas is heavy; rebuild for common cases via Path2D is not serializable.
  // Instead, reconstruct from custGeom commands or approximate presets as SVG.
  const cust = kid(spPr, 'custGeom');
  if (cust) {
    const paths = kids(kid(cust, 'pathLst'), 'path');
    const parts: string[] = [];
    for (const pathEl of paths) {
      const pw = num(pathEl, 'w', w) || w;
      const ph = num(pathEl, 'h', h) || h;
      const sx = w / pw;
      const sy = h / ph;
      for (const c of readPathCommands(pathEl)) {
        const pts = c.pts.map((pt) => `${pt.x * sx},${pt.y * sy}`);
        switch (c.op) {
          case 'moveTo':
            if (pts[0]) parts.push(`M${pts[0]}`);
            break;
          case 'lnTo':
            if (pts[0]) parts.push(`L${pts[0]}`);
            break;
          case 'cubicBezTo':
            if (pts.length >= 3) parts.push(`C${pts[0]} ${pts[1]} ${pts[2]}`);
            break;
          case 'quadBezTo':
            if (pts.length >= 2) parts.push(`Q${pts[0]} ${pts[1]}`);
            break;
          case 'close':
            parts.push('Z');
            break;
          default:
            break;
        }
      }
    }
    return parts.length ? parts.join(' ') : null;
  }
  const prst = kid(spPr, 'prstGeom')?.getAttribute('prst') ?? 'rect';
  const ss = Math.min(w, h);
  switch (prst) {
    case 'rect':
      return `M0,0 H${w} V${h} H0 Z`;
    case 'ellipse':
    case 'circle':
      return `M${w / 2},0 A${w / 2},${h / 2} 0 1 1 ${w / 2 - 0.001},0 Z`;
    case 'roundRect': {
      const r = (ss * adj(kid(spPr, 'prstGeom'), 'adj', 16667)) / 100000;
      return `M${r},0 H${w - r} Q${w},0 ${w},${r} V${h - r} Q${w},${h} ${w - r},${h} H${r} Q0,${h} 0,${h - r} V${r} Q0,0 ${r},0 Z`;
    }
    case 'line':
      return `M0,0 L${w},${h}`;
    default:
      return `M0,0 H${w} V${h} H0 Z`;
  }
}

function svgColor(el: Element | null, env: RenderEnv): string | null {
  const c = colorOf(el, env);
  return c ? css(c) : null;
}

function svgEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

async function svgShape(sp: Element, env: RenderEnv): Promise<string> {
  const spPr = kid(sp, 'spPr');
  const x = readXfrm(kid(spPr, 'xfrm'));
  if (x.w <= 0 && x.h <= 0) return '';
  const d = svgPathD(spPr, x.w, x.h);
  if (!d) return '';
  const style = kid(sp, 'style');
  let fill = 'none';
  const solid = kid(spPr, 'solidFill');
  if (solid) fill = svgColor(firstColor(solid), env) ?? 'none';
  else if (!kid(spPr, 'noFill')) {
    const ref = kid(style, 'fillRef');
    if (ref && num(ref, 'idx') > 0) fill = svgColor(firstColor(ref), env) ?? 'none';
  }
  const line = lineStyle(spPr, style, env);
  const stroke = line ? ` stroke="${svgEscape(line.color)}" stroke-width="${line.width}"` : ' stroke="none"';
  const transform = `translate(${x.x} ${x.y})` + (x.rot ? ` rotate(${x.rot} ${x.w / 2} ${x.h / 2})` : '') + (x.flipH || x.flipV ? ` translate(${x.flipH ? x.w : 0} ${x.flipV ? x.h : 0}) scale(${x.flipH ? -1 : 1} ${x.flipV ? -1 : 1})` : '');
  let blip = '';
  const blipFill = kid(spPr, 'blipFill');
  if (blipFill) {
    const id = relId(kid(blipFill, 'blip'));
    const src = id ? env.media.get(id) : undefined;
    if (src) {
      blip = `<image href="${svgEscape(src)}" x="0" y="0" width="${x.w}" height="${x.h}" preserveAspectRatio="none"/>`;
    }
  }
  return `<g transform="${transform}"><path d="${d}" fill="${svgEscape(fill)}"${stroke}/>${blip}</g>`;
}

async function svgPicture(pic: Element, env: RenderEnv): Promise<string> {
  const spPr = kid(pic, 'spPr');
  const x = readXfrm(kid(spPr, 'xfrm'));
  if (x.w <= 0 || x.h <= 0) return '';
  const id = relId(kid(kid(pic, 'blipFill'), 'blip'));
  const src = id ? env.media.get(id) : undefined;
  if (!src) return '';
  const transform = `translate(${x.x} ${x.y})`;
  return `<g transform="${transform}"><image href="${svgEscape(src)}" x="0" y="0" width="${x.w}" height="${x.h}" preserveAspectRatio="none"/></g>`;
}

async function svgGroup(grp: Element, env: RenderEnv, root: boolean): Promise<string> {
  const x = readXfrm(kid(kid(grp, 'grpSpPr'), 'xfrm'));
  const chOff = kid(kid(kid(grp, 'grpSpPr'), 'xfrm'), 'chOff');
  const chExt = kid(kid(kid(grp, 'grpSpPr'), 'xfrm'), 'chExt');
  const cw = num(chExt, 'cx', x.w) || 1;
  const ch = num(chExt, 'cy', x.h) || 1;
  const parts: string[] = [];
  for (const child of kids(grp)) {
    const s = await svgElement(child, env);
    if (s) parts.push(s);
  }
  const inner = parts.join('');
  if (root) {
    return `<g transform="scale(${x.w / cw || 1} ${x.h / ch || 1}) translate(${-num(chOff, 'x')} ${-num(chOff, 'y')})">${inner}</g>`;
  }
  return `<g transform="translate(${x.x} ${x.y}) scale(${x.w / cw || 1} ${x.h / ch || 1}) translate(${-num(chOff, 'x')} ${-num(chOff, 'y')})">${inner}</g>`;
}

async function svgElement(el: Element, env: RenderEnv): Promise<string> {
  try {
    switch (el.localName) {
      case 'grpSp':
      case 'wgp':
        return await svgGroup(el, env, false);
      case 'wsp':
      case 'sp':
        return await svgShape(el, env);
      case 'pic':
        return await svgPicture(el, env);
      default:
        return '';
    }
  } catch {
    return '';
  }
}

/**
 * Renders DrawingML as an SVG data URL (vector, stays sharp when resized). Falls back to null
 * when the graphic cannot be represented.
 */
export async function renderGraphicSvg(graphicData: Element, widthEmu: number, heightEmu: number, env: RenderEnv): Promise<string | null> {
  if (widthEmu <= 0 || heightEmu <= 0) return null;
  const content = kids(graphicData)[0];
  if (!content) return null;
  let body = '';
  if (content.localName === 'wgp' || content.localName === 'grpSp') {
    const x = readXfrm(kid(kid(content, 'grpSpPr'), 'xfrm'));
    const chOff = kid(kid(kid(content, 'grpSpPr'), 'xfrm'), 'chOff');
    const chExt = kid(kid(kid(content, 'grpSpPr'), 'xfrm'), 'chExt');
    const cw = num(chExt, 'cx', x.w) || widthEmu;
    const ch = num(chExt, 'cy', x.h) || heightEmu;
    const parts: string[] = [];
    for (const child of kids(content)) {
      const s = await svgElement(child, env);
      if (s) parts.push(s);
    }
    body = `<g transform="scale(${widthEmu / cw} ${heightEmu / ch}) translate(${-num(chOff, 'x')} ${-num(chOff, 'y')})">${parts.join('')}</g>`;
  } else if (content.localName === 'wsp' || content.localName === 'pic' || content.localName === 'sp') {
    const spPr = kid(content, 'spPr');
    const xfrm = kid(spPr, 'xfrm');
    if (xfrm) {
      const x = readXfrm(xfrm);
      body = `<g transform="scale(${widthEmu / (x.w || widthEmu)} ${heightEmu / (x.h || heightEmu)}) translate(${-x.x} ${-x.y})">${await svgElement(content, env)}</g>`;
    } else {
      body = await svgElement(content, env);
    }
  } else {
    return null;
  }
  if (!body.replace(/<g[^>]*>|<\/g>/g, '').trim()) return null;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${widthEmu / EMU_PER_PX}" height="${heightEmu / EMU_PER_PX}" viewBox="0 0 ${widthEmu} ${heightEmu}">${body}</svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

/** Theme colours from theme1.xml (a:clrScheme). */
export function readThemeColors(theme: Document | null, settings: Document | null): ThemeColors {
  const scheme: Record<string, string> = {};
  const clr = theme ? Array.from(theme.getElementsByTagNameNS('*', 'clrScheme'))[0] : undefined;
  for (const c of kids(clr)) {
    const v = kids(c)[0];
    const hex = v?.localName === 'sysClr' ? v.getAttribute('lastClr') : v?.getAttribute('val');
    if (hex && /^[0-9a-f]{6}$/i.test(hex)) scheme[c.localName] = hex;
  }
  const map = { ...DEFAULT_COLOR_MAP };
  const mapping = settings ? Array.from(settings.getElementsByTagNameNS('*', 'clrSchemeMapping'))[0] : undefined;
  if (mapping) {
    const names: Record<string, string> = { light1: 'lt1', dark1: 'dk1', light2: 'lt2', dark2: 'dk2' };
    const keys: Record<string, string> = { bg1: 'bg1', t1: 'tx1', bg2: 'bg2', t2: 'tx2' };
    for (const a of Array.from(mapping.attributes)) {
      const key = keys[a.localName] ?? a.localName;
      map[key] = names[a.value] ?? a.value;
    }
  }
  return { scheme, map };
}
