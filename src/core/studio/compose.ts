/**
 * Studio frame compositor (browser canvas): draws every visible clip at time `t` with its
 * keyframed transform, opacity and fades, blend mode, look (adjustments + filter preset),
 * chroma key, blur and drop shadow. Shared by the live preview and the export, so they match.
 */
import { applyAdjustments, applyFilter, isIdentity } from '../media/image-ops';
import { BLEND_MODES } from '../pro-image/document';
import { chromaKey } from './dsp';
import { cameraDistance, clipEnd, is3D, valueAt, type ClipMask, type MediaClip, type Project, type TextClip, type VisualClip } from './model';

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;
type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** The picture of a media clip at a source time (video frame, image), or null if not ready. */
export type FrameFor = (clip: MediaClip, sourceTime: number) => CanvasImageSource | null;

function makeCanvas(w: number, h: number): AnyCanvas {
  const W = Math.max(1, Math.round(w));
  const H = Math.max(1, Math.round(h));
  return typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(W, H) : Object.assign(document.createElement('canvas'), { width: W, height: H });
}

const textCache = new Map<string, AnyCanvas>();

function textCanvas(c: TextClip, scale: number): AnyCanvas {
  const key = JSON.stringify([c.text, c.font, c.size, c.color, c.bold, c.italic, c.align, c.stroke, c.strokeColor, c.background, scale]);
  let cv = textCache.get(key);
  if (cv) return cv;
  const size = c.size * scale;
  const font = `${c.italic ? 'italic ' : ''}${c.bold ? 700 : 500} ${size}px ${c.font}`;
  const probe = makeCanvas(1, 1).getContext('2d') as Ctx2D;
  probe.font = font;
  const lines = c.text.split('\n');
  const pad = size * 0.3 + c.stroke * scale;
  const w = Math.max(...lines.map((l) => probe.measureText(l).width), 1) + pad * 2;
  const lh = size * 1.2;
  const h = lines.length * lh + pad * 2;
  cv = makeCanvas(w, h);
  const ctx = cv.getContext('2d') as Ctx2D;
  if (c.background) {
    ctx.fillStyle = c.background;
    ctx.beginPath();
    ctx.roundRect(0, 0, w, h, size * 0.15);
    ctx.fill();
  }
  ctx.font = font;
  ctx.textBaseline = 'middle';
  ctx.textAlign = c.align;
  ctx.lineJoin = 'round';
  const x = c.align === 'left' ? pad : c.align === 'right' ? w - pad : w / 2;
  lines.forEach((l, i) => {
    const y = pad + lh * (i + 0.5);
    if (c.stroke > 0) {
      ctx.strokeStyle = c.strokeColor;
      ctx.lineWidth = c.stroke * 2 * scale;
      ctx.strokeText(l, x, y);
    }
    ctx.fillStyle = c.color;
    ctx.fillText(l, x, y);
  });
  if (textCache.size > 60) textCache.delete(textCache.keys().next().value!);
  textCache.set(key, cv);
  return cv;
}

function sourceSize(img: CanvasImageSource): [number, number] {
  const i = img as { videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number; width?: number; height?: number; displayWidth?: number; displayHeight?: number };
  return [i.videoWidth || i.naturalWidth || i.displayWidth || (i.width as number) || 1, i.videoHeight || i.naturalHeight || i.displayHeight || (i.height as number) || 1];
}

/** Opacity multiplier of a clip's fades at `local` seconds. */
function fadeAt(c: VisualClip, local: number): number {
  let f = 1;
  const { fadeIn, fadeOut } = c.effects;
  if (fadeIn > 0 && local < fadeIn) f = Math.min(f, local / fadeIn);
  if (fadeOut > 0 && local > c.duration - fadeOut) f = Math.min(f, (c.duration - local) / fadeOut);
  return Math.max(0, Math.min(1, f));
}

/**
 * Draws the frame at `t` into ctx (whose canvas is p.width × p.height × `scale`).
 * Video tracks are listed top-first, so they are drawn in reverse.
 */
export function drawFrame(ctx: Ctx2D, p: Project, t: number, frameFor: FrameFor, scale = 1): void {
  const W = p.width * scale;
  const H = p.height * scale;
  ctx.save();
  ctx.globalCompositeOperation = 'source-over';
  ctx.globalAlpha = 1;
  ctx.fillStyle = p.background;
  ctx.fillRect(0, 0, W, H);
  ctx.restore();
  const tracks = p.tracks.filter((tr) => tr.kind === 'video' && !tr.muted);
  for (let ti = tracks.length - 1; ti >= 0; ti--) {
    for (const c of tracks[ti].clips) {
      if (c.kind === 'audio' || t < c.start || t >= clipEnd(c)) continue;
      drawClip(ctx, p, c, t - c.start, frameFor, scale);
    }
  }
}

function drawClip(ctx: Ctx2D, p: Project, c: VisualClip, local: number, frameFor: FrameFor, scale: number): void {
  const tr = c.transform;
  const opacity = valueAt(tr.opacity, local) * fadeAt(c, local);
  if (opacity <= 0.001) return;
  let img: CanvasImageSource | null = null;
  let dw = 0;
  let dh = 0;
  const s = valueAt(tr.scale, local);
  if (c.kind === 'video' || c.kind === 'image') {
    img = frameFor(c, c.in + local);
    if (!img) return;
    const [sw, sh] = sourceSize(img);
    const fit = Math.min(p.width / sw, p.height / sh);
    dw = sw * fit * s * scale;
    dh = sh * fit * s * scale;
  } else if (c.kind === 'text') {
    if (!c.text.trim()) return;
    img = textCanvas(c, scale * s);
    const [w, h] = sourceSize(img);
    dw = w;
    dh = h;
  } else if (c.kind === 'solid') {
    const cv = makeCanvas(8, 64);
    const cctx = cv.getContext('2d') as Ctx2D;
    if (c.color2) {
      const g = cctx.createLinearGradient(0, 0, 0, 64);
      g.addColorStop(0, c.color);
      g.addColorStop(1, c.color2);
      cctx.fillStyle = g;
    } else cctx.fillStyle = c.color;
    cctx.fillRect(0, 0, 8, 64);
    img = cv;
    dw = p.width * s * scale;
    dh = p.height * s * scale;
  }
  if (!img || dw < 0.5 || dh < 0.5) return;

  const fx = c.effects;
  const pixelOps = (c.kind === 'video' || c.kind === 'image') && (fx.chromaKey.enabled || fx.filter !== 'none' || !isIdentity(fx.adjustments));
  const mask = c.mask?.enabled ? c.mask : null;
  if (pixelOps || mask) {
    // work on a copy at the size it is drawn (never more than the output), so cost follows the preview size
    const pw = Math.min(dw, W(p, scale) * 1.5);
    const ph = (dh / dw) * pw;
    const tmp = makeCanvas(pw, ph);
    const tctx = tmp.getContext('2d', { willReadFrequently: true }) as Ctx2D;
    tctx.drawImage(img, 0, 0, tmp.width, tmp.height);
    if (pixelOps) {
      const data = tctx.getImageData(0, 0, tmp.width, tmp.height);
      const px = { data: data.data, width: tmp.width, height: tmp.height };
      if (fx.chromaKey.enabled) chromaKey(px, fx.chromaKey.color, fx.chromaKey.tolerance, fx.chromaKey.softness, fx.chromaKey.spill);
      if (fx.filter !== 'none') applyFilter(px, fx.filter);
      if (!isIdentity(fx.adjustments)) applyAdjustments(px, fx.adjustments);
      tctx.putImageData(data, 0, 0);
    }
    if (mask) applyMask(tctx, tmp.width, tmp.height, mask, local);
    img = tmp;
  }

  const x = valueAt(tr.x, local);
  const y = valueAt(tr.y, local);
  const rot = valueAt(tr.rotation, local);
  let quad: Quad | null = null;
  if (is3D(c)) {
    quad = projectQuad(p, x, y, dw / scale, dh / scale, rot, valueAt(c.three!.rotX, local), valueAt(c.three!.rotY, local), valueAt(c.three!.z, local));
    if (!quad) return; // behind the camera
    // the perspective view is drawn on its own frame, so opacity, blend, blur and shadow apply to it as a whole
    const frame = makeCanvas(p.width * scale, p.height * scale);
    drawQuad(frame.getContext('2d') as Ctx2D, img, quad, scale);
    img = frame;
  }

  ctx.save();
  ctx.globalAlpha = opacity;
  ctx.globalCompositeOperation = BLEND_MODES.find((b) => b.id === fx.blend)?.canvas ?? 'source-over';
  if (fx.blur > 0) ctx.filter = `blur(${fx.blur * scale}px)`;
  if (fx.shadow) {
    ctx.shadowColor = 'rgba(0,0,0,0.6)';
    ctx.shadowBlur = 18 * scale;
    ctx.shadowOffsetX = ctx.shadowOffsetY = 6 * scale;
  }
  if (quad) ctx.drawImage(img, 0, 0);
  else {
    ctx.translate(x * scale, y * scale);
    if (rot) ctx.rotate((rot * Math.PI) / 180);
    ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
  }
  ctx.restore();
}

// ── masks ─────────────────────────────────────────────────────────────────

/** Keeps (or, inverted, removes) the mask shape from a layer canvas, with a soft edge. */
function applyMask(ctx: Ctx2D, w: number, h: number, m: ClipMask, local: number): void {
  const shape = makeCanvas(w, h);
  const sctx = shape.getContext('2d') as Ctx2D;
  const mw = Math.max(0, valueAt(m.w, local)) * w;
  const mh = Math.max(0, valueAt(m.h, local)) * h;
  const cx = valueAt(m.x, local) * w;
  const cy = valueAt(m.y, local) * h;
  const feather = (Math.max(0, m.feather) / 100) * (Math.min(w, h) / 2);
  if (feather > 0.3) sctx.filter = `blur(${feather / 2}px)`;
  sctx.fillStyle = '#fff';
  sctx.beginPath();
  if (m.shape === 'ellipse') sctx.ellipse(cx, cy, mw / 2, mh / 2, 0, 0, Math.PI * 2);
  else sctx.rect(cx - mw / 2, cy - mh / 2, mw, mh);
  sctx.fill();
  ctx.save();
  ctx.globalCompositeOperation = m.invert ? 'destination-out' : 'destination-in';
  ctx.drawImage(shape, 0, 0);
  ctx.restore();
}

// ── 3D layers ─────────────────────────────────────────────────────────────

/** Corners of a layer on screen (output px): top-left, top-right, bottom-right, bottom-left. */
export type Quad = [[number, number], [number, number], [number, number], [number, number]];

/** One point of the layer plane (lx, ly from its centre) as the camera sees it, or null behind the camera. */
function project3D(p: Project, cx: number, cy: number, cz: number, lx: number, ly: number, rz: number, rx: number, ry: number): [number, number] | null {
  const x1 = lx * Math.cos(rz) - ly * Math.sin(rz);
  const y1 = lx * Math.sin(rz) + ly * Math.cos(rz);
  // tilt about the horizontal axis, then swivel about the vertical one
  const y2 = y1 * Math.cos(rx);
  const z2 = -y1 * Math.sin(rx);
  const x3 = x1 * Math.cos(ry) - z2 * Math.sin(ry);
  const z3 = x1 * Math.sin(ry) + z2 * Math.cos(ry);
  const f = cameraDistance(p);
  const depth = f + cz + z3;
  if (depth < f * 0.02) return null;
  const k = f / depth;
  return [p.width / 2 + (cx + x3 - p.width / 2) * k, p.height / 2 + (cy + y2 - p.height / 2) * k];
}

const rad = (deg: number) => (deg * Math.PI) / 180;

/** Where the four corners of a w×h layer centred at (x, y, z) land on screen; null if any is behind the camera. */
export function projectQuad(p: Project, x: number, y: number, w: number, h: number, rotation: number, rotX: number, rotY: number, z: number): Quad | null {
  const pts = ([[-1, -1], [1, -1], [1, 1], [-1, 1]] as const).map(([sx, sy]) => project3D(p, x, y, z, (sx * w) / 2, (sy * h) / 2, rad(rotation), rad(rotX), rad(rotY)));
  return pts.every(Boolean) ? (pts as Quad) : null;
}

const MESH = 12;

/**
 * Draws `img` into the quad. A 2D canvas can only draw affine (parallelogram) images, so the
 * layer is cut into a grid of small triangles; the grid points are spaced the way perspective
 * spaces them (by the homography of the quad), which keeps straight lines straight.
 */
function drawQuad(ctx: Ctx2D, img: CanvasImageSource, q: Quad, scale: number): void {
  const [sw, sh] = sourceSize(img);
  const H = homography(q);
  const at = (u: number, v: number): [number, number] => {
    const d = H[6] * u + H[7] * v + 1;
    return [((H[0] * u + H[1] * v + H[2]) / d) * scale, ((H[3] * u + H[4] * v + H[5]) / d) * scale];
  };
  const pts: [number, number][][] = [];
  for (let j = 0; j <= MESH; j++) {
    pts.push([]);
    for (let i = 0; i <= MESH; i++) pts[j].push(at(i / MESH, j / MESH));
  }
  for (let j = 0; j < MESH; j++) {
    for (let i = 0; i < MESH; i++) {
      const u0 = (i / MESH) * sw;
      const u1 = ((i + 1) / MESH) * sw;
      const v0 = (j / MESH) * sh;
      const v1 = ((j + 1) / MESH) * sh;
      triangle(ctx, img, [u0, v0], [u1, v0], [u0, v1], pts[j][i], pts[j][i + 1], pts[j + 1][i]);
      triangle(ctx, img, [u1, v1], [u0, v1], [u1, v0], pts[j + 1][i + 1], pts[j + 1][i], pts[j][i + 1]);
    }
  }
}

/** The projective map of the unit square onto a quad (8 coefficients, the ninth is 1). */
export function homography(q: Quad): number[] {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const sx = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const sy = y0 - y1 + y2 - y3;
  const den = dx1 * dy2 - dx2 * dy1 || 1e-9;
  const g = (sx * dy2 - dx2 * sy) / den;
  const h = (dx1 * sy - sx * dy1) / den;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

type Pt = readonly [number, number];

/** Draws the source triangle (s0 s1 s2, image px) onto the destination triangle (d0 d1 d2). */
function triangle(ctx: Ctx2D, img: CanvasImageSource, s0: Pt, s1: Pt, s2: Pt, d0: Pt, d1: Pt, d2: Pt): void {
  const den = (s1[0] - s0[0]) * (s2[1] - s0[1]) - (s2[0] - s0[0]) * (s1[1] - s0[1]);
  if (!den) return;
  const a = ((d1[0] - d0[0]) * (s2[1] - s0[1]) - (d2[0] - d0[0]) * (s1[1] - s0[1])) / den;
  const b = ((d1[1] - d0[1]) * (s2[1] - s0[1]) - (d2[1] - d0[1]) * (s1[1] - s0[1])) / den;
  const c2 = ((d2[0] - d0[0]) * (s1[0] - s0[0]) - (d1[0] - d0[0]) * (s2[0] - s0[0])) / den;
  const d = ((d2[1] - d0[1]) * (s1[0] - s0[0]) - (d1[1] - d0[1]) * (s2[0] - s0[0])) / den;
  // grow the clip a little from its centre so neighbouring triangles leave no hairline gaps
  const mx = (d0[0] + d1[0] + d2[0]) / 3;
  const my = (d0[1] + d1[1] + d2[1]) / 3;
  const grow = (pt: Pt): [number, number] => {
    const vx = pt[0] - mx;
    const vy = pt[1] - my;
    const len = Math.hypot(vx, vy) || 1;
    return [pt[0] + (vx / len) * 0.7, pt[1] + (vy / len) * 0.7];
  };
  const [g0, g1, g2] = [grow(d0), grow(d1), grow(d2)];
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(g0[0], g0[1]);
  ctx.lineTo(g1[0], g1[1]);
  ctx.lineTo(g2[0], g2[1]);
  ctx.closePath();
  ctx.clip();
  ctx.transform(a, b, c2, d, d0[0] - a * s0[0] - c2 * s0[1], d0[1] - b * s0[0] - d * s0[1]);
  ctx.drawImage(img, 0, 0);
  ctx.restore();
}

const W = (p: Project, scale: number) => p.width * scale;

/** Bounding box (output px, unrotated) of a visual clip at `local`, for on-canvas handles. */
export function clipBox(p: Project, c: VisualClip, local: number, sourceSizeOf: (c: MediaClip) => [number, number] | null): { x: number; y: number; w: number; h: number } | null {
  const s = valueAt(c.transform.scale, local);
  let w = 0;
  let h = 0;
  if (c.kind === 'video' || c.kind === 'image') {
    const sz = sourceSizeOf(c);
    if (!sz) return null;
    const fit = Math.min(p.width / sz[0], p.height / sz[1]);
    w = sz[0] * fit * s;
    h = sz[1] * fit * s;
  } else if (c.kind === 'text') {
    const [tw, th] = sourceSize(textCanvas(c, s));
    w = tw;
    h = th;
  } else {
    w = p.width * s;
    h = p.height * s;
  }
  const x = valueAt(c.transform.x, local);
  const y = valueAt(c.transform.y, local);
  return { x: x - w / 2, y: y - h / 2, w, h };
}

/** The clip's outline on screen (output px), following its rotation and 3D placement. */
export function clipQuad(p: Project, c: VisualClip, local: number, sourceSizeOf: (c: MediaClip) => [number, number] | null): Quad | null {
  const b = clipBox(p, c, local, sourceSizeOf);
  if (!b) return null;
  const t3 = is3D(c) ? c.three! : null;
  return projectQuad(p, b.x + b.w / 2, b.y + b.h / 2, b.w, b.h, valueAt(c.transform.rotation, local), t3 ? valueAt(t3.rotX, local) : 0, t3 ? valueAt(t3.rotY, local) : 0, t3 ? valueAt(t3.z, local) : 0);
}
