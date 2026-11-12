/**
 * Studio frame compositor (browser canvas): draws every visible clip at time `t` with its
 * keyframed transform, opacity and fades, blend mode, look (adjustments + filter preset),
 * chroma key, blur and drop shadow. Shared by the live preview and the export, so they match.
 */
import { applyAdjustments, applyFilter, isIdentity } from '../media/image-ops';
import { BLEND_MODES } from '../pro-image/document';
import { chromaKey } from './dsp';
import { clipEnd, valueAt, type MediaClip, type Project, type TextClip, type VisualClip } from './model';

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
  if (pixelOps) {
    // process at the size it is drawn (never more than the output), so cost follows the preview size
    const pw = Math.min(dw, W(p, scale) * 1.5);
    const ph = (dh / dw) * pw;
    const tmp = makeCanvas(pw, ph);
    const tctx = tmp.getContext('2d', { willReadFrequently: true }) as Ctx2D;
    tctx.drawImage(img, 0, 0, tmp.width, tmp.height);
    const data = tctx.getImageData(0, 0, tmp.width, tmp.height);
    const px = { data: data.data, width: tmp.width, height: tmp.height };
    if (fx.chromaKey.enabled) chromaKey(px, fx.chromaKey.color, fx.chromaKey.tolerance, fx.chromaKey.softness, fx.chromaKey.spill);
    if (fx.filter !== 'none') applyFilter(px, fx.filter);
    if (!isIdentity(fx.adjustments)) applyAdjustments(px, fx.adjustments);
    tctx.putImageData(data, 0, 0);
    img = tmp;
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
  ctx.translate(valueAt(tr.x, local) * scale, valueAt(tr.y, local) * scale);
  const rot = valueAt(tr.rotation, local);
  if (rot) ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(img, -dw / 2, -dh / 2, dw, dh);
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
