import { describe, expect, it } from 'vitest';
import { createPixels, type Pixels } from '../src/core/media/image-ops';
import { applyAdjust, autoLevels, curveLut, defaultAdjust, histogram, levelsLut } from '../src/core/pro-image/adjust';
import { LUT_PRESETS, applyLut, clarity, dehaze, grain, makeLut, parseCube } from '../src/core/pro-image/tone';
import { addNoise, dodgeBurn, findEdges, gaussianBlur, median, motionBlur, spotHeal, unsharpMask } from '../src/core/pro-image/filters';
import { combineMasks, ellipseMask, featherMask, invertMask, isEmptyMask, magicWand, maskBounds, polygonMask, rectMask } from '../src/core/pro-image/selection';
import { duplicateLayer, moveLayer, newDocument, rasterLayer, rasterToDocSize, textLayer } from '../src/core/pro-image/document';

function solid(w: number, h: number, rgba: [number, number, number, number]): Pixels {
  const px = createPixels(w, h);
  for (let i = 0; i < w * h; i++) px.data.set(rgba, i * 4);
  return px;
}
const at = (px: Pixels, x: number, y: number) => Array.from(px.data.subarray((y * px.width + x) * 4, (y * px.width + x) * 4 + 4));

describe('clarity, dehaze, grain and LUTs', () => {
  const scene = (haze = 0): Pixels => {
    const px = createPixels(64, 48);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 64; x++) {
      const v = (x >> 3) % 2 ? 60 : 180;
      const c = [v, (v * 0.6) | 0, 255 - v].map((ch) => ch * (1 - haze) + 230 * haze);
      px.data.set([c[0], c[1], c[2], 255], (y * 64 + x) * 4);
    }
    return px;
  };
  const contrast = (px: Pixels | { data: Uint8ClampedArray }) => {
    let lo = 255;
    let hi = 0;
    for (let i = 0; i < px.data.length; i += 4) {
      lo = Math.min(lo, px.data[i]);
      hi = Math.max(hi, px.data[i]);
    }
    return hi - lo;
  };
  it('clarity raises local contrast and leaves flat areas and extremes alone', () => {
    const px = scene();
    // the step across a stripe edge (x = 7 → 8)
    const step = (d: Uint8ClampedArray) => Math.abs(d[(10 * 64 + 8) * 4] - d[(10 * 64 + 7) * 4]);
    expect(step(clarity(px, 60))).toBeGreaterThan(step(px.data));
    expect(step(clarity(px, -60))).toBeLessThan(step(px.data));
    expect(clarity(solid(16, 16, [120, 120, 120, 255]), 100)[0]).toBe(120);
    expect(Array.from(clarity(solid(8, 8, [255, 255, 255, 255]), 100).subarray(0, 3))).toEqual([255, 255, 255]);
    expect(clarity(px, 0)).toEqual(px.data);
  });
  it('dehaze restores contrast lost to haze, and can add haze', () => {
    const hazy = scene(0.5);
    const clear = dehaze(hazy, 90);
    expect(contrast({ data: clear })).toBeGreaterThan(contrast(hazy) * 1.3);
    expect(contrast({ data: dehaze(scene(), -80) })).toBeLessThan(contrast(scene()));
  });
  it('grain is repeatable, scaled with the preview and gentlest at the extremes', () => {
    const grey = solid(64, 64, [128, 128, 128, 255]);
    const a = grain(grey, 50, 2, 50);
    expect(a).toEqual(grain(grey, 50, 2, 50));
    /** mean distance of the red channel from its average */
    const spread = (d: Uint8ClampedArray) => {
      let mean = 0;
      for (let i = 0; i < d.length; i += 4) mean += d[i];
      mean /= d.length / 4;
      let dev = 0;
      for (let i = 0; i < d.length; i += 4) dev += Math.abs(d[i] - mean);
      return dev / (d.length / 4);
    };
    expect(spread(a)).toBeGreaterThan(2);
    expect(spread(grain(solid(64, 64, [250, 250, 250, 255]), 50, 2, 50))).toBeLessThan(spread(a));
    // monochrome: the three channels move together
    expect(a[0] - 128).toBe(a[1] - 128);
    expect(grain(grey, 0, 2, 50)).toEqual(grey.data);
  });
  it('reads .cube files and applies them with trilinear interpolation', () => {
    const cube = ['TITLE "Swap"', '# red and blue exchanged', 'LUT_3D_SIZE 2', '0 0 0', '0 0 1', '0 1 0', '0 1 1', '1 0 0', '1 0 1', '1 1 0', '1 1 1'].join('\n');
    const lut = parseCube(cube);
    expect(lut).toMatchObject({ name: 'Swap', size: 2 });
    const px = solid(2, 2, [200, 100, 30, 255]);
    expect(Array.from(applyLut(px, lut).subarray(0, 4))).toEqual([30, 100, 200, 255]);
    expect(Array.from(applyLut(px, lut, 50).subarray(0, 3))).toEqual([115, 100, 115]);
    const identity = makeLut('id', 9, (r, g, b) => [r, g, b]);
    expect(Array.from(applyLut(px, identity).subarray(0, 3))).toEqual([200, 100, 30]);
    expect(() => parseCube('LUT_3D_SIZE 2\n0 0 0')).toThrow(/incomplete/);
    expect(() => parseCube('LUT_1D_SIZE 16')).toThrow(/1D/);
    expect(() => parseCube('hello')).toThrow(/not a .cube/);
    for (const p of LUT_PRESETS) {
      const t = p.build();
      expect(t.table.length).toBe(t.size ** 3 * 3);
      expect(t.name).toBe(p.label);
    }
  });
  it('run as adjustment layers, respecting the mask', () => {
    const px = scene();
    const half = new Uint8Array(64 * 48);
    for (let y = 0; y < 48; y++) for (let x = 0; x < 32; x++) half[y * 64 + x] = 255;
    const noir = LUT_PRESETS.find((p) => p.id === 'noir')!.build();
    applyAdjust(px, { type: 'lut', lut: noir, strength: 100 }, half);
    expect(at(px, 4, 4)[0]).toBe(at(px, 4, 4)[2]);
    expect(at(px, 40, 4)).toEqual(at(scene(), 40, 4));
    const untouched = scene();
    applyAdjust(untouched, defaultAdjust('lut'));
    expect(untouched.data).toEqual(scene().data);
    for (const t of ['clarity', 'dehaze', 'grain'] as const) {
      const p2 = scene();
      applyAdjust(p2, defaultAdjust(t));
      expect(p2.data).not.toEqual(scene().data);
    }
  });
});

describe('adjustments', () => {
  it('curves: identity, monotone and through the points', () => {
    const id = curveLut([[0, 0], [255, 255]]);
    expect(id[100]).toBe(100);
    const s = curveLut([[0, 0], [64, 40], [192, 220], [255, 255]]);
    expect(s[64]).toBe(40);
    expect(s[192]).toBe(220);
    for (let i = 1; i < 256; i++) expect(s[i]).toBeGreaterThanOrEqual(s[i - 1]);
  });

  it('levels map black/white points and gamma', () => {
    const lut = levelsLut({ inBlack: 50, inWhite: 200, gamma: 1, outBlack: 0, outWhite: 255 });
    expect(lut[50]).toBe(0);
    expect(lut[200]).toBe(255);
    expect(lut[125]).toBe(128);
    expect(levelsLut({ inBlack: 0, inWhite: 255, gamma: 2, outBlack: 0, outWhite: 255 })[64]).toBeGreaterThan(64);
  });

  it('hue/saturation, invert, threshold, posterize, black & white', () => {
    const red = () => solid(2, 1, [255, 0, 0, 255]);
    expect(at(applyAdjust(red(), { ...defaultAdjust('hueSat'), hue: 120 } as never), 0, 0).slice(0, 3)).toEqual([0, 255, 0]);
    expect(at(applyAdjust(red(), { type: 'invert' }), 0, 0).slice(0, 3)).toEqual([0, 255, 255]);
    expect(at(applyAdjust(solid(1, 1, [200, 200, 200, 255]), { type: 'threshold', level: 128 }), 0, 0).slice(0, 3)).toEqual([255, 255, 255]);
    expect(at(applyAdjust(solid(1, 1, [100, 100, 100, 255]), { type: 'posterize', levels: 2 }), 0, 0)[0]).toBe(0);
    const bw = at(applyAdjust(red(), defaultAdjust('blackWhite')), 0, 0);
    expect(bw[0]).toBe(bw[1]);
    expect(bw[1]).toBe(bw[2]);
  });

  it('respects a mask (none, partial, full)', () => {
    const px = solid(3, 1, [100, 100, 100, 255]);
    applyAdjust(px, { type: 'invert' }, new Uint8Array([0, 128, 255]));
    expect([at(px, 0, 0)[0], at(px, 1, 0)[0], at(px, 2, 0)[0]]).toEqual([100, 128, 155]);
  });

  it('histogram and auto levels', () => {
    const px = createPixels(4, 1);
    [[20, 20, 20, 255], [100, 100, 100, 255], [150, 150, 150, 255], [230, 230, 230, 255]].forEach((c, i) => px.data.set(c, i * 4));
    const h = histogram(px);
    expect(h.l[20]).toBe(1);
    expect(autoLevels(h, 0)).toEqual({ inBlack: 20, inWhite: 230 });
  });
});

describe('selection', () => {
  it('rect, ellipse, polygon, bounds', () => {
    const r = rectMask(10, 10, 2, 3, 4, 5);
    expect(maskBounds(r)).toEqual({ x: 2, y: 3, width: 4, height: 5 });
    const e = ellipseMask(20, 20, 0, 0, 20, 20);
    expect(e.data[10 * 20 + 10]).toBe(255);
    expect(e.data[0]).toBe(0);
    const p = polygonMask(10, 10, [[0, 0], [10, 0], [0, 10]]);
    expect(p.data[1 * 10 + 1]).toBe(255);
    expect(p.data[9 * 10 + 9]).toBe(0);
  });

  it('magic wand: contiguous vs global, tolerance', () => {
    const px = solid(5, 1, [255, 255, 255, 255]);
    px.data.set([0, 0, 0, 255], 2 * 4); // a black pixel splits the row
    const c = magicWand(px, 0, 0, 10, true);
    expect(Array.from(c.data)).toEqual([255, 255, 0, 0, 0]);
    expect(Array.from(magicWand(px, 0, 0, 10, false).data)).toEqual([255, 255, 0, 255, 255]);
    expect(Array.from(magicWand(px, 0, 0, 255, true).data)).toEqual([255, 255, 255, 255, 255]);
  });

  it('combine, invert, feather, empty', () => {
    const a = rectMask(4, 1, 0, 0, 2, 1);
    const b = rectMask(4, 1, 1, 0, 2, 1);
    expect(Array.from(combineMasks(a, b, 'add').data)).toEqual([255, 255, 255, 0]);
    expect(Array.from(combineMasks(a, b, 'subtract').data)).toEqual([255, 0, 0, 0]);
    expect(Array.from(combineMasks(a, b, 'intersect').data)).toEqual([0, 255, 0, 0]);
    expect(Array.from(invertMask(a).data)).toEqual([0, 0, 255, 255]);
    const f = featherMask(rectMask(30, 1, 0, 0, 15, 1), 4);
    expect(f.data[14]).toBeGreaterThan(0);
    expect(f.data[14]).toBeLessThan(255);
    expect(f.data[0]).toBe(255);
    expect(isEmptyMask(rectMask(4, 4, 0, 0, 0, 0))).toBe(true);
  });
});

describe('filters', () => {
  it('blur softens an edge, unsharp mask increases contrast', () => {
    const px = createPixels(20, 1);
    for (let x = 0; x < 20; x++) px.data.set(x < 10 ? [0, 0, 0, 255] : [255, 255, 255, 255], x * 4);
    const b = gaussianBlur(px, 4);
    expect(at(b, 9, 0)[0]).toBeGreaterThan(0);
    expect(at(b, 9, 0)[0]).toBeLessThan(255);
    expect(at(b, 9, 0)[3]).toBe(255);
    const mid = createPixels(20, 1);
    for (let x = 0; x < 20; x++) mid.data.set(x < 10 ? [100, 100, 100, 255] : [150, 150, 150, 255], x * 4);
    const s = unsharpMask(mid, 200, 2, 0);
    expect(at(s, 9, 0)[0]).toBeLessThan(100);
    expect(at(s, 10, 0)[0]).toBeGreaterThan(150);
  });

  it('median removes a speckle; noise is seeded; motion blur and edges run', () => {
    const px = solid(5, 5, [50, 50, 50, 255]);
    px.data.set([255, 255, 255, 255], (2 * 5 + 2) * 4);
    expect(at(median(px, 1), 2, 2)[0]).toBe(50);
    expect(Array.from(addNoise(px, 20, true).data)).toEqual(Array.from(addNoise(px, 20, true).data));
    expect(motionBlur(px, 0, 5).width).toBe(5);
    expect(at(findEdges(solid(4, 4, [10, 10, 10, 255])), 1, 1)[0]).toBe(255);
  });

  it('spot healing fills a blemish from its surroundings', () => {
    const px = solid(20, 20, [120, 80, 60, 255]);
    for (let y = 8; y < 12; y++) for (let x = 8; x < 12; x++) px.data.set([255, 0, 255, 255], (y * 20 + x) * 4);
    const healed = spotHeal(px, ellipseMask(20, 20, 7, 7, 6, 6));
    const c = at(healed, 10, 10);
    expect(Math.abs(c[0] - 120)).toBeLessThan(10);
    expect(Math.abs(c[1] - 80)).toBeLessThan(10);
  });

  it('dodge lightens, burn darkens', () => {
    const px = solid(1, 1, [128, 128, 128, 255]);
    const m = rectMask(1, 1, 0, 0, 1, 1);
    expect(at(dodgeBurn(px, m, 'dodge', 50, 'midtones'), 0, 0)[0]).toBeGreaterThan(128);
    expect(at(dodgeBurn(px, m, 'burn', 50, 'midtones'), 0, 0)[0]).toBeLessThan(128);
  });
});

describe('document', () => {
  it('layers: duplicate, reorder, place at an offset', () => {
    let doc = newDocument(solid(4, 4, [1, 2, 3, 255]));
    doc = { ...doc, layers: [...doc.layers, textLayer('T', 0, 0, 'Hi', 12, '#fff')] };
    const dup = duplicateLayer(doc.layers[0]);
    expect(dup.id).not.toBe(doc.layers[0].id);
    expect(dup.kind === 'raster' && dup.px.data).not.toBe((doc.layers[0] as { px: Pixels }).px.data);
    doc = moveLayer(doc, doc.layers[1].id, -1);
    expect(doc.layers[0].kind).toBe('text');
    const placed = rasterToDocSize({ width: 4, height: 4 }, rasterLayer('p', solid(2, 2, [9, 9, 9, 255]), 3, 3));
    expect(at(placed, 3, 3)).toEqual([9, 9, 9, 255]);
    expect(at(placed, 2, 2)).toEqual([0, 0, 0, 0]);
  });
});

describe('psd', async () => {
  // Node has no canvas: give ag-psd a plain image-data factory (the browser uses its own)
  const agpsd = await import('ag-psd');
  agpsd.initializeCanvas(
    () => {
      throw new Error('no canvas in tests');
    },
    (w: number, h: number) => ({ width: w, height: h, data: new Uint8ClampedArray(w * h * 4) }) as unknown as ImageData,
  );
  const { readPsdDocument, writePsdDocument } = await import('../src/core/pro-image/psd');
  const { adjustLayer, newDocument: nd, rasterLayer: rl } = await import('../src/core/pro-image/document');
  it('round-trips layers, blend modes, opacity, masks and adjustment layers', () => {
    const doc = nd(solid(8, 6, [200, 30, 30, 255]));
    const top = rl('Top', solid(4, 3, [0, 0, 255, 255]), 2, 1);
    top.blend = 'multiply';
    top.opacity = 0.5;
    top.mask = rectMask(8, 6, 0, 0, 4, 6);
    const curves = adjustLayer('curves', 'Curves 1');
    if (curves.adjust.type === 'curves') curves.adjust.rgb = [[0, 0], [128, 160], [255, 255]];
    const levels = adjustLayer('levels', 'Levels 1');
    if (levels.adjust.type === 'levels') Object.assign(levels.adjust, { inBlack: 10, inWhite: 240, gamma: 1.2 });
    const hidden = rl('Hidden', solid(8, 6, [9, 9, 9, 255]));
    hidden.visible = false;
    doc.layers.push(top, curves, levels, hidden);
    const bytes = writePsdDocument(doc, solid(8, 6, [1, 2, 3, 255]), () => solid(8, 6, [0, 0, 0, 0]));
    expect(String.fromCharCode(...bytes.slice(0, 4))).toBe('8BPS');
    const { doc: back } = readPsdDocument(bytes);
    expect(back.width).toBe(8);
    expect(back.layers.map((l) => l.name)).toEqual(['Background', 'Top', 'Curves 1', 'Levels 1', 'Hidden']);
    const t = back.layers[1];
    expect(t.kind === 'raster' && [t.x, t.y, t.px.width, t.blend, Math.round(t.opacity * 100)]).toEqual([2, 1, 4, 'multiply', 50]);
    expect(t.mask && t.mask.data[0] === 255 && t.mask.data[7] === 0).toBe(true);
    expect(back.layers[2].kind === 'adjust' && back.layers[2].adjust).toMatchObject({ type: 'curves', rgb: [[0, 0], [128, 160], [255, 255]] });
    expect(back.layers[3].kind === 'adjust' && back.layers[3].adjust).toMatchObject({ type: 'levels', inBlack: 10, inWhite: 240 });
    expect(back.layers[4].visible).toBe(false);
  });
});
