import { beforeAll, describe, expect, it } from 'vitest';
import { harmony, hexToRgb, hsvToRgb, parseCssColor, rgbToCmyk, rgbToHex, rgbToHsv, cmykToRgb } from '../src/core/vector/color';
import { brushShape, containsPoint, cutPath, fitCurve, joinSubs, loadGeom, offsetSubs, outlineStroke, pathfinder, regions, simplifySubs } from '../src/core/vector/geom';
import { createMesh, meshAverage, renderMesh, splitMesh } from '../src/core/vector/mesh';
import { DEFAULT_STYLE, addNodes, arrange, cloneNode, findNode, groupNodes, newDocument, newId, removeNodes, ungroupNodes, updateNodes, type PathNode, type SubPath } from '../src/core/vector/model';
import { autoSmooth, ellipseSubs, insertAnchor, nearestOnPath, nodeBounds, parseD, polygonSubs, rectSubs, rotateAbout, starSubs, subsBounds, subsToD, transformNode, translate } from '../src/core/vector/path';
import { softenMask, traceBitmap, traceField } from '../src/core/vector/trace';

const path = (subs: SubPath[], patch: Partial<PathNode> = {}): PathNode => ({ ...DEFAULT_STYLE, id: newId(), type: 'path', opacity: 1, subs, ...patch });
const area = (subs: SubPath[]) => {
  // shoelace over flattened anchors: enough for the straight-edged shapes used here
  let a = 0;
  for (const s of subs) {
    const p = s.anchors;
    let sub = 0;
    for (let i = 0; i < p.length; i++) sub += p[i].x * p[(i + 1) % p.length].y - p[(i + 1) % p.length].x * p[i].y;
    a += Math.abs(sub / 2);
  }
  return a;
};

describe('vector paths', () => {
  it('round-trips path data', () => {
    const d = 'M10 10L90 10C90 50 50 90 10 90Z';
    expect(subsToD(parseD(d))).toBe(d);
  });

  it('reads relative commands, shorthand curves and arcs', () => {
    const subs = parseD('m10,10 h80 v80 h-80 z M 0 0 q 10 10 20 0 t 20 0 M0 50 a25 25 0 1 1 50 0');
    expect(subs).toHaveLength(3);
    expect(subs[0].closed).toBe(true);
    expect(subsBounds([subs[0]])).toEqual({ x: 10, y: 10, width: 80, height: 80 });
    // the half circle of radius 25 from (0,50) to (50,50) reaches y = 25
    const arc = subsBounds([subs[2]])!;
    expect(arc.y).toBeCloseTo(25, 1);
    expect(arc.width).toBeCloseTo(50, 1);
  });

  it('reads arc flags written without separators', () => {
    const subs = parseD('M0 0a5 5 0 0110 0');
    expect(subs[0].anchors[subs[0].anchors.length - 1].x).toBeCloseTo(10, 5);
  });

  it('measures exact curve bounds, not the handle box', () => {
    const b = subsBounds(ellipseSubs(50, 50, 40, 20))!;
    expect(b.x).toBeCloseTo(10, 3);
    expect(b.width).toBeCloseTo(80, 3);
    expect(b.height).toBeCloseTo(40, 3);
  });

  it('builds primitives', () => {
    expect(rectSubs(0, 0, 10, 10)[0].anchors).toHaveLength(4);
    expect(rectSubs(0, 0, 100, 100, 10)[0].anchors).toHaveLength(8);
    expect(polygonSubs(0, 0, 10, 6)[0].anchors).toHaveLength(6);
    expect(starSubs(0, 0, 10, 5, 5)[0].anchors).toHaveLength(10);
  });

  it('inserts an anchor without changing the shape', () => {
    const subs = ellipseSubs(0, 0, 50, 50);
    const hit = nearestOnPath(subs, 40, -40)!;
    expect(hit.distance).toBeLessThan(8);
    const next = insertAnchor(subs, hit);
    expect(next.subs[0].anchors).toHaveLength(5);
    const before = subsBounds(subs)!;
    const after = subsBounds(next.subs)!;
    expect(after.width).toBeCloseTo(before.width, 3);
    expect(after.height).toBeCloseTo(before.height, 3);
  });

  it('smooths curvature-tool points', () => {
    const sub = autoSmooth({ closed: true, anchors: rectSubs(0, 0, 100, 100)[0].anchors.map((a) => ({ ...a, smooth: true })) });
    expect(sub.anchors.every((a) => a.ox !== a.x || a.oy !== a.y)).toBe(true);
  });

  it('transforms nodes', () => {
    const p = path(rectSubs(0, 0, 10, 20));
    expect(nodeBounds(transformNode(p, translate(5, 5)))).toEqual({ x: 5, y: 5, width: 10, height: 20 });
    const r = nodeBounds(transformNode(p, rotateAbout(Math.PI / 2, 0, 0)))!;
    expect(r.width).toBeCloseTo(20, 6);
    expect(r.height).toBeCloseTo(10, 6);
  });
});

describe('vector document', () => {
  it('adds, updates, groups, arranges and removes nodes immutably', () => {
    let doc = newDocument();
    const a = path(rectSubs(0, 0, 10, 10));
    const b = path(rectSubs(5, 5, 10, 10));
    const c = path(rectSubs(9, 9, 10, 10));
    doc = addNodes(doc, [a, b, c]);
    const before = doc;
    doc = updateNodes(doc, [a.id], (n) => ({ ...n, opacity: 0.5 }));
    expect(findNode(before, a.id)!.opacity).toBe(1);
    expect(findNode(doc, a.id)!.opacity).toBe(0.5);
    // untouched nodes are shared, which is what keeps undo cheap
    expect(findNode(doc, b.id)).toBe(b);

    doc = arrange(doc, new Set([a.id]), 'front');
    expect(doc.layers[0].children.map((n) => n.id)).toEqual([b.id, c.id, a.id]);

    const grouped = groupNodes(doc, new Set([b.id, c.id]));
    expect(grouped.group!.children.map((n) => n.id)).toEqual([b.id, c.id]);
    expect(grouped.doc.layers[0].children).toHaveLength(2);
    const un = ungroupNodes(grouped.doc, new Set([grouped.group!.id]));
    expect(un.doc.layers[0].children).toHaveLength(3);

    const copy = cloneNode(grouped.group!);
    expect(copy.id).not.toBe(grouped.group!.id);
    expect(copy.children[0].id).not.toBe(b.id);

    expect(removeNodes(doc, [a.id]).layers[0].children).toHaveLength(2);
  });

  it('makes a clipping mask from the topmost object', () => {
    let doc = newDocument();
    const art = path(rectSubs(0, 0, 100, 100));
    const mask = path(ellipseSubs(50, 50, 20, 20));
    doc = addNodes(doc, [art, mask]);
    const { group } = groupNodes(doc, new Set([art.id, mask.id]), true);
    expect(group!.clip).toBe(true);
    expect(group!.children[0].id).toBe(mask.id);
    expect(nodeBounds(group!)!.width).toBeCloseTo(40, 3);
  });
});

describe('colour', () => {
  it('converts between models', () => {
    expect(rgbToHex(hexToRgb('#3a7'))).toBe('#33aa77');
    const hsv = rgbToHsv({ r: 255, g: 0, b: 0 });
    expect(hsv).toEqual({ h: 0, s: 100, v: 100 });
    expect(hsvToRgb(120, 100, 100)).toEqual({ r: 0, g: 255, b: 0 });
    const cmyk = rgbToCmyk({ r: 0, g: 128, b: 255 });
    expect(cmykToRgb(cmyk.c, cmyk.m, cmyk.y, cmyk.k)).toEqual({ r: 0, g: 128, b: 255 });
  });

  it('parses CSS colours', () => {
    expect(parseCssColor('rgb(255, 0, 0)')).toEqual({ color: '#ff0000', alpha: 1 });
    expect(parseCssColor('rgba(0,0,255,.5)')).toEqual({ color: '#0000ff', alpha: 0.5 });
    expect(parseCssColor('hsl(120, 100%, 50%)')!.color).toBe('#00ff00');
    expect(parseCssColor('Navy')!.color).toBe('#000080');
    expect(parseCssColor('none')).toBeNull();
  });

  it('builds harmonies around the base colour', () => {
    const comp = harmony('#ff0000', 'complementary');
    expect(comp[0]).toBe('#ff0000');
    expect(comp).toContain('#00ffff');
    expect(harmony('#ff0000', 'triad').slice(0, 3)).toEqual(['#ff0000', '#00ff00', '#0000ff']);
    expect(harmony('#336699', 'tints')).toHaveLength(5);
  });
});

describe('gradient mesh', () => {
  it('fills every pixel and blends between the corner colours', () => {
    const mesh = createMesh(1, 1, { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff' }] });
    const px = renderMesh(mesh, 40, 20);
    for (let i = 3; i < px.length; i += 4) expect(px[i]).toBe(255);
    const at = (x: number, y: number) => px[(y * 40 + x) * 4];
    expect(at(1, 10)).toBeLessThan(30);
    expect(at(38, 10)).toBeGreaterThan(225);
    expect(Math.abs(at(20, 10) - 128)).toBeLessThan(20);
    expect(meshAverage(mesh)).toBe('#808080');
  });

  it('adds a row and a column where the mesh is split', () => {
    const mesh = createMesh(2, 2, { type: 'solid', color: '#ff0000' });
    const { mesh: next, row, col } = splitMesh(mesh, 0.25, 0.75);
    expect(next.rows).toBe(3);
    expect(next.cols).toBe(3);
    expect(next.points).toHaveLength(16);
    expect([row, col]).toEqual([2, 1]);
    expect(next.points.every((p) => p.color === '#ff0000')).toBe(true);
  });
});

describe('tracing', () => {
  it('finds the outline of a filled square, and its hole', () => {
    const w = 20;
    const field = new Float32Array(w * w);
    for (let y = 4; y < 16; y++) for (let x = 4; x < 16; x++) field[y * w + x] = x >= 8 && x < 12 && y >= 8 && y < 12 ? 0 : 1;
    const loops = traceField(field, w, w);
    expect(loops).toHaveLength(2);
    const xs = loops.flat().map((p) => p.x);
    expect(Math.min(...xs)).toBeCloseTo(4, 0);
    expect(Math.max(...xs)).toBeCloseTo(16, 0);
  });

  it('separates colours into stacked shapes', () => {
    const w = 16;
    const rgba = new Uint8ClampedArray(w * w * 4);
    for (let y = 0; y < w; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        const red = x < 8;
        rgba.set(red ? [220, 20, 20, 255] : [20, 20, 220, 255], i);
      }
    }
    const shapes = traceBitmap(rgba, w, w, { mode: 'color', threshold: 128, colors: 2, minSize: 2 });
    expect(shapes).toHaveLength(2);
    expect(shapes.map((s) => s.color).sort()).toEqual(['#1414dc', '#dc1414']);
    expect(softenMask(new Float32Array([1, 1, 1, 1]), 2, 2)[0]).toBe(1);
  });
});

describe('path operations', () => {
  beforeAll(() => loadGeom());

  const a = () => path(rectSubs(0, 0, 100, 100), { fill: { type: 'solid', color: '#ff0000' } });
  const b = () => path(rectSubs(50, 50, 100, 100), { fill: { type: 'solid', color: '#0000ff' } });

  it('unites, subtracts and intersects', () => {
    const united = pathfinder('unite', [a(), b()]);
    expect(united).toHaveLength(1);
    expect(area(united[0].subs)).toBeCloseTo(17500, 0);
    // the result takes the frontmost object's appearance
    expect(united[0].fill).toEqual({ type: 'solid', color: '#0000ff' });
    expect(area(pathfinder('minus-front', [a(), b()])[0].subs)).toBeCloseTo(7500, 0);
    expect(area(pathfinder('minus-back', [a(), b()])[0].subs)).toBeCloseTo(7500, 0);
    expect(area(pathfinder('intersect', [a(), b()])[0].subs)).toBeCloseTo(2500, 0);
    expect(area(pathfinder('exclude', [a(), b()])[0].subs)).toBeCloseTo(15000, 0);
  });

  it('divides overlapping shapes into their regions', () => {
    const r = regions([a(), b()]);
    expect(r).toHaveLength(3);
    expect(r.map((x) => x.sources.join(',')).sort()).toEqual(['0', '0,1', '1']);
    const pieces = pathfinder('divide', [a(), b()]);
    expect(pieces).toHaveLength(3);
    expect(pieces.reduce((n, p) => n + area(p.subs), 0)).toBeCloseTo(17500, 0);
    // the overlap is painted like the frontmost shape
    expect(pieces.filter((p) => p.fill.type === 'solid' && p.fill.color === '#0000ff')).toHaveLength(2);
  });

  it('trims, merges and crops', () => {
    const trimmed = pathfinder('trim', [a(), b()]);
    expect(area(trimmed[0].subs)).toBeCloseTo(7500, 0);
    expect(trimmed[0].stroke.type).toBe('none');
    const sameColor = pathfinder('merge', [a(), { ...b(), fill: { type: 'solid', color: '#ff0000' } }]);
    expect(sameColor).toHaveLength(1);
    expect(area(pathfinder('crop', [a(), b()])[0].subs)).toBeCloseTo(2500, 0);
  });

  it('hit-tests fills', () => {
    expect(containsPoint(rectSubs(0, 0, 10, 10), 5, 5)).toBe(true);
    expect(containsPoint(rectSubs(0, 0, 10, 10), 15, 5)).toBe(false);
  });

  it('fits curves through freehand points with far fewer anchors', () => {
    const pts = Array.from({ length: 200 }, (_, i) => ({ x: i, y: Math.sin(i / 20) * 30 }));
    const sub = fitCurve(pts, 1)!;
    expect(sub.anchors.length).toBeLessThan(20);
    expect(sub.anchors[0].x).toBeCloseTo(0, 3);
    expect(sub.anchors[sub.anchors.length - 1].x).toBeCloseTo(199, 3);
    const many = { closed: false, anchors: pts.map((p) => ({ x: p.x, y: p.y, ix: p.x, iy: p.y, ox: p.x, oy: p.y })) };
    expect(simplifySubs([many], 1)[0].anchors.length).toBeLessThan(20);
  });

  it('outlines strokes with the right joins', () => {
    const square = path(rectSubs(0, 0, 100, 100), { strokeWidth: 10, join: 'miter' });
    const outline = outlineStroke(square);
    // a ring: outer 110 × 110 with square corners, inner 90 × 90
    expect(outline).toHaveLength(2);
    const box = subsBounds(outline)!;
    expect(box.width).toBeCloseTo(110, 1);
    expect(containsPoint(outline, -4, -4)).toBe(true);
    expect(containsPoint(outline, 50, 50)).toBe(false);
    const round = outlineStroke({ ...square, join: 'round' });
    expect(containsPoint(round, -4.5, -4.5)).toBe(false);
  });

  it('makes blob-brush shapes and offsets paths', () => {
    const blob = brushShape([{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 100, y: 0 }], 20);
    expect(blob).toHaveLength(1);
    const box = subsBounds(blob)!;
    expect(box.width).toBeCloseTo(120, 0);
    expect(box.height).toBeCloseTo(20, 0);
    const grown = subsBounds(offsetSubs(rectSubs(0, 0, 100, 100), 10))!;
    expect(grown.width).toBeCloseTo(120, 0);
    const shrunk = subsBounds(offsetSubs(rectSubs(0, 0, 100, 100), -10))!;
    expect(shrunk.width).toBeCloseTo(80, 0);
  });

  it('cuts and joins paths', () => {
    const line: SubPath[] = [{ closed: false, anchors: parseD('M0 0L100 0')[0].anchors }];
    const cut = cutPath(line, 40, 1, 4)!;
    expect(cut).toHaveLength(2);
    expect(cut[0][0].anchors[1].x).toBeCloseTo(40, 3);
    const opened = cutPath(rectSubs(0, 0, 10, 10), 5, 0, 2)!;
    expect(opened).toHaveLength(1);
    expect(opened[0][0].closed).toBe(false);
    expect(cutPath(line, 40, 30, 4)).toBeNull();

    const joined = joinSubs([cut[0][0], cut[1][0]]);
    expect(joined).toHaveLength(1);
    expect(joined[0].anchors).toHaveLength(3);
    expect(joinSubs(joined)[0].closed).toBe(true);
  });
});
