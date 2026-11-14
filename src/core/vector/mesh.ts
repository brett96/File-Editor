/**
 * Gradient mesh: a grid of coloured points whose colours blend smoothly across the object.
 *
 * The mesh is rendered to pixels (it has no SVG equivalent): every patch is subdivided, each
 * sub-vertex gets its position and colour from Catmull-Rom interpolation over the grid (so
 * colour flows through the points instead of creasing at them), and the small quads are
 * filled as colour-interpolated triangles. The result is clipped to the object's outline by
 * the renderer.
 */
import { hexToRgb, mixHex, rgbToHex } from './color';
import type { MeshPaint, MeshPoint, Paint } from './model';

export function meshPoint(mesh: MeshPaint, row: number, col: number): MeshPoint {
  return mesh.points[row * (mesh.cols + 1) + col];
}

/** The colour a paint shows at (u, v) of the bounding box: what a new mesh point starts with. */
export function paintColorAt(paint: Paint, u: number, v: number): string {
  if (paint.type === 'solid') return paint.color;
  if (paint.type === 'mesh') return sampleMesh(paint, u, v);
  if (paint.type === 'none' || !paint.stops.length) return '#ffffff';
  let t: number;
  if (paint.type === 'linear') {
    const dx = paint.x2 - paint.x1;
    const dy = paint.y2 - paint.y1;
    t = ((u - paint.x1) * dx + (v - paint.y1) * dy) / (dx * dx + dy * dy || 1);
  } else t = Math.hypot(u - paint.cx, v - paint.cy) / (paint.r || 1);
  const stops = [...paint.stops].sort((a, b) => a.offset - b.offset);
  if (t <= stops[0].offset) return stops[0].color;
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i].offset) return mixHex(stops[i - 1].color, stops[i].color, (t - stops[i - 1].offset) / (stops[i].offset - stops[i - 1].offset || 1));
  }
  return stops[stops.length - 1].color;
}

/** A new mesh over an object, coloured from the paint it replaces. */
export function createMesh(rows: number, cols: number, from: Paint): MeshPaint {
  const points: MeshPoint[] = [];
  for (let r = 0; r <= rows; r++) for (let c = 0; c <= cols; c++) points.push({ x: c / cols, y: r / rows, color: paintColorAt(from, c / cols, r / rows) });
  return { type: 'mesh', rows, cols, points };
}

function catmull(p0: number, p1: number, p2: number, p3: number, t: number): number {
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t * t + (-p0 + 3 * p1 - 3 * p2 + p3) * t * t * t);
}

interface Sample {
  x: number;
  y: number;
  r: number;
  g: number;
  b: number;
}

/** Position and colour at grid coordinate (gr, gc), both in grid units (0…rows, 0…cols). */
function evalMesh(mesh: MeshPaint, rgb: { r: number; g: number; b: number }[], gr: number, gc: number): Sample {
  const { rows, cols } = mesh;
  const r0 = Math.min(rows - 1, Math.max(0, Math.floor(gr)));
  const c0 = Math.min(cols - 1, Math.max(0, Math.floor(gc)));
  const tr = gr - r0;
  const tc = gc - c0;
  const idx = (r: number, c: number) => Math.max(0, Math.min(rows, r)) * (cols + 1) + Math.max(0, Math.min(cols, c));
  const along = (get: (i: number) => number): number => {
    const col = (r: number) => catmull(get(idx(r, c0 - 1)), get(idx(r, c0)), get(idx(r, c0 + 1)), get(idx(r, c0 + 2)), tc);
    return catmull(col(r0 - 1), col(r0), col(r0 + 1), col(r0 + 2), tr);
  };
  return {
    x: along((i) => mesh.points[i].x),
    y: along((i) => mesh.points[i].y),
    r: along((i) => rgb[i].r),
    g: along((i) => rgb[i].g),
    b: along((i) => rgb[i].b),
  };
}

/** The colour at the mesh point nearest to (u, v): cheap, and enough to seed new points. */
export function sampleMesh(mesh: MeshPaint, u: number, v: number): string {
  const rgb = mesh.points.map((p) => hexToRgb(p.color));
  const s = evalMesh(mesh, rgb, v * mesh.rows, u * mesh.cols);
  return rgbToHex({ r: s.r, g: s.g, b: s.b });
}

function fillTriangle(data: Uint8ClampedArray, w: number, h: number, a: Sample, b: Sample, c: Sample): void {
  const minX = Math.max(0, Math.floor(Math.min(a.x, b.x, c.x)));
  const maxX = Math.min(w - 1, Math.ceil(Math.max(a.x, b.x, c.x)));
  const minY = Math.max(0, Math.floor(Math.min(a.y, b.y, c.y)));
  const maxY = Math.min(h - 1, Math.ceil(Math.max(a.y, b.y, c.y)));
  const area = (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
  if (Math.abs(area) < 1e-9) return;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      const w0 = ((b.x - px) * (c.y - py) - (b.y - py) * (c.x - px)) / area;
      const w1 = ((c.x - px) * (a.y - py) - (c.y - py) * (a.x - px)) / area;
      const w2 = 1 - w0 - w1;
      // a hair of slack so neighbouring triangles leave no pinholes between them
      if (w0 < -0.002 || w1 < -0.002 || w2 < -0.002) continue;
      const i = (y * w + x) * 4;
      data[i] = w0 * a.r + w1 * b.r + w2 * c.r;
      data[i + 1] = w0 * a.g + w1 * b.g + w2 * c.g;
      data[i + 2] = w0 * a.b + w1 * b.b + w2 * c.b;
      data[i + 3] = 255;
    }
  }
}

/** Renders the mesh into a width × height RGBA buffer (pixels the mesh doesn't reach stay transparent). */
export function renderMesh(mesh: MeshPaint, width: number, height: number): Uint8ClampedArray {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const data = new Uint8ClampedArray(w * h * 4);
  const rgb = mesh.points.map((p) => hexToRgb(p.color));
  // enough subdivisions that each small quad is a few pixels across
  const sub = Math.max(4, Math.min(24, Math.ceil(Math.max(w / mesh.cols, h / mesh.rows) / 6)));
  const R = mesh.rows * sub;
  const C = mesh.cols * sub;
  const grid: Sample[] = new Array((R + 1) * (C + 1));
  for (let r = 0; r <= R; r++) {
    for (let c = 0; c <= C; c++) {
      const s = evalMesh(mesh, rgb, r / sub, c / sub);
      s.x *= w;
      s.y *= h;
      grid[r * (C + 1) + c] = s;
    }
  }
  for (let r = 0; r < R; r++) {
    for (let c = 0; c < C; c++) {
      const p00 = grid[r * (C + 1) + c];
      const p01 = grid[r * (C + 1) + c + 1];
      const p10 = grid[(r + 1) * (C + 1) + c];
      const p11 = grid[(r + 1) * (C + 1) + c + 1];
      fillTriangle(data, w, h, p00, p01, p11);
      fillTriangle(data, w, h, p00, p11, p10);
    }
  }
  return data;
}

/** The mean colour of the mesh: what stands in for it where pixels can't be made (no canvas). */
export function meshAverage(mesh: MeshPaint): string {
  const sum = { r: 0, g: 0, b: 0 };
  for (const p of mesh.points) {
    const c = hexToRgb(p.color);
    sum.r += c.r;
    sum.g += c.g;
    sum.b += c.b;
  }
  const n = mesh.points.length || 1;
  return rgbToHex({ r: sum.r / n, g: sum.g / n, b: sum.b / n });
}

/** Adds a grid line through (u, v): a new row and a new column, coloured from the mesh as it is. */
export function splitMesh(mesh: MeshPaint, u: number, v: number): { mesh: MeshPaint; row: number; col: number } {
  const rgb = mesh.points.map((p) => hexToRgb(p.color));
  // grid coordinates of the click: the mesh is assumed close to regular for the lookup
  const gc = Math.max(0.05, Math.min(mesh.cols - 0.05, u * mesh.cols));
  const gr = Math.max(0.05, Math.min(mesh.rows - 0.05, v * mesh.rows));
  const colAt = Math.floor(gc) + 1;
  const rowAt = Math.floor(gr) + 1;
  const rowsG: number[] = [];
  for (let r = 0; r <= mesh.rows; r++) rowsG.push(r);
  rowsG.splice(rowAt, 0, gr);
  const colsG: number[] = [];
  for (let c = 0; c <= mesh.cols; c++) colsG.push(c);
  colsG.splice(colAt, 0, gc);
  const points: MeshPoint[] = [];
  for (const r of rowsG) {
    for (const c of colsG) {
      if (Number.isInteger(r) && Number.isInteger(c)) points.push(meshPoint(mesh, r, c));
      else {
        const s = evalMesh(mesh, rgb, r, c);
        points.push({ x: s.x, y: s.y, color: rgbToHex({ r: s.r, g: s.g, b: s.b }) });
      }
    }
  }
  return { mesh: { type: 'mesh', rows: mesh.rows + 1, cols: mesh.cols + 1, points }, row: rowAt, col: colAt };
}
