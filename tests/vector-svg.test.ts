// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { DEFAULT_STYLE, addNodes, allNodes, newDocument, newId, type PathNode, type TextNode, type VectorDoc } from '../src/core/vector/model';
import { nodeBounds, rectSubs, subsBounds } from '../src/core/vector/path';
import { docToSvg, nodeToSvg } from '../src/core/vector/svg';
import { importSvg, parseTransform } from '../src/core/vector/svg-import';

const rect = (patch: Partial<PathNode> = {}): PathNode => ({ ...DEFAULT_STYLE, id: newId(), type: 'path', opacity: 1, subs: rectSubs(10, 10, 80, 40), ...patch });

const text = (patch: Partial<TextNode> = {}): TextNode => ({
  ...DEFAULT_STYLE, id: newId(), type: 'text', opacity: 1, kind: 'point', text: 'Hello', x: 20, y: 40, matrix: [1, 0, 0, 1, 0, 0],
  family: 'Arial', size: 24, weight: 400, italic: false, tracking: 0, align: 'left', leading: 1.2, stroke: { type: 'none' }, fill: { type: 'solid', color: '#000000' }, ...patch,
});

describe('SVG export', () => {
  it('writes paths with their appearance', () => {
    const svg = nodeToSvg(rect({ fill: { type: 'solid', color: '#ff0000', alpha: 0.5 }, strokeWidth: 3, dash: [4, 2], cap: 'round', opacity: 0.8, blend: 'multiply' }));
    expect(svg).toContain('d="M10 10L90 10L90 50L10 50Z"');
    expect(svg).toContain('fill="#ff0000" fill-opacity="0.5"');
    expect(svg).toContain('stroke-width="3"');
    expect(svg).toContain('stroke-dasharray="4 2"');
    expect(svg).toContain('stroke-linecap="round"');
    expect(svg).toContain('opacity="0.8"');
    expect(svg).toContain('mix-blend-mode:multiply');
  });

  it('maps gradients onto the object box', () => {
    const node = rect({ fill: { type: 'linear', x1: 0, y1: 0, x2: 1, y2: 0, stops: [{ offset: 0, color: '#000000' }, { offset: 1, color: '#ffffff', alpha: 0.5 }] } });
    const svg = nodeToSvg(node);
    expect(svg).toContain(`<linearGradient id="${node.id}-f" gradientUnits="userSpaceOnUse" gradientTransform="matrix(80 0 0 40 10 10)"`);
    expect(svg).toContain('stop-opacity="0.5"');
    expect(svg).toContain(`fill="url(#${node.id}-f)"`);
  });

  it('writes point, area and path text', () => {
    expect(nodeToSvg(text({ text: 'One\nTwo', weight: 700, italic: true }))).toMatch(/font-weight="700" font-style="italic".*<tspan x="20" y="40">One<\/tspan><tspan x="20" y="68.8">Two<\/tspan>/);
    const area = nodeToSvg(text({ kind: 'area', width: 60, height: 200, text: 'aaaa bbbb cccc dddd' }));
    expect(area.match(/<tspan/g)!.length).toBeGreaterThan(1);
    const onPath = nodeToSvg(text({ kind: 'path', path: rectSubs(0, 0, 100, 100), startOffset: 0.25 }));
    expect(onPath).toContain('<textPath');
    expect(onPath).toContain('startOffset="25%"');
  });

  it('skips hidden objects and escapes text', () => {
    expect(nodeToSvg(rect({ hidden: true }))).toBe('');
    expect(nodeToSvg(text({ text: 'a < b & c' }))).toContain('a &lt; b &amp; c');
  });
});

describe('SVG round trip', () => {
  const build = (): VectorDoc => {
    let doc = newDocument(400, 300);
    doc = { ...doc, artboards: [...doc.artboards, { id: 'a2', name: 'Icon', x: 440, y: 0, width: 64, height: 64 }] };
    return addNodes(doc, [
      rect({ fill: { type: 'mesh', rows: 1, cols: 1, points: [{ x: 0, y: 0, color: '#ff0000' }, { x: 1, y: 0, color: '#00ff00' }, { x: 0, y: 1, color: '#0000ff' }, { x: 1, y: 1, color: '#ffffff' }] } }),
      text({ kind: 'area', width: 100, height: 80 }),
      { id: 'img1', type: 'image', opacity: 1, href: 'data:image/png;base64,AAAA', x: 0, y: 0, width: 10, height: 10, matrix: [1, 0, 0, 1, 5, 5] },
    ]);
  };

  it('reopens its own saves exactly, artboards and all', () => {
    const doc = build();
    const svg = docToSvg(doc, { embedModel: true });
    const { doc: back, warnings } = importSvg(svg);
    expect(warnings).toEqual([]);
    expect(back).toEqual(doc);
    // image pixels are stored once, in the drawing
    expect(svg.match(/data:image\/png;base64,AAAA/g)).toHaveLength(1);
  });

  it('falls back to the drawing when another program has changed it', () => {
    const svg = docToSvg(build(), { embedModel: true }).replace('font-size="24"', 'font-size="30"');
    const { doc } = importSvg(svg);
    const t = allNodes(doc).find((n) => n.type === 'text') as TextNode;
    expect(t.size).toBe(30);
    expect(doc.artboards).toHaveLength(1);
  });

  it('exports one artboard on its own', () => {
    const svg = docToSvg(build(), { artboard: 'a2', background: '#ffffff' });
    expect(svg).toContain('viewBox="440 0 64 64"');
    expect(svg).toContain('<rect x="440" y="0" width="64" height="64" fill="#ffffff"/>');
    expect(svg).not.toContain('<metadata');
  });
});

describe('SVG import', () => {
  it('parses transform lists', () => {
    expect(parseTransform('translate(10 20) scale(2)')).toEqual([2, 0, 0, 2, 10, 20]);
    const r = parseTransform('rotate(90)');
    expect(r[0]).toBeCloseTo(0, 9);
    expect(r[1]).toBeCloseTo(1, 9);
  });

  it('reads shapes, applying transforms and the viewBox', () => {
    const { doc } = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="100 100 200 100">
      <g transform="translate(100,100)"><rect x="10" y="20" width="30" height="40" fill="#f00" stroke="blue" stroke-width="2"/></g>
      <circle cx="200" cy="150" r="10"/><line x1="100" y1="100" x2="300" y2="200" stroke="black"/>
      <polygon points="100,100 120,100 110,120" fill="none" stroke="#000"/>
    </svg>`);
    expect(doc.artboards[0]).toMatchObject({ x: 0, y: 0, width: 200, height: 100 });
    const nodes = doc.layers[0].children as PathNode[];
    expect(nodes).toHaveLength(4);
    expect(subsBounds(nodes[0].subs)).toEqual({ x: 10, y: 20, width: 30, height: 40 });
    expect(nodes[0].fill).toEqual({ type: 'solid', color: '#ff0000' });
    expect(nodes[0].stroke).toEqual({ type: 'solid', color: '#0000ff' });
    expect(nodes[0].strokeWidth).toBe(2);
    const circle = subsBounds(nodes[1].subs)!;
    expect(circle.x).toBeCloseTo(90, 3);
    expect(nodes[1].fill).toEqual({ type: 'solid', color: '#000000' });
    expect(nodes[2].fill.type).toBe('none');
    expect(nodes[3].subs[0].closed).toBe(true);
  });

  it('resolves CSS classes, inheritance and style attributes', () => {
    const { doc } = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100">
      <style>.a{fill:#00ff00;stroke-width:4} rect.b{opacity:.5}</style>
      <g fill="red" stroke="#000"><rect class="a b" width="10" height="10"/><rect width="10" height="10" style="fill:rgb(0,0,255)"/></g>
    </svg>`);
    const group = doc.layers[0].children[0];
    expect(group.type).toBe('group');
    const [one, two] = (group as { children: PathNode[] }).children;
    expect(one.fill).toEqual({ type: 'solid', color: '#00ff00' });
    expect(one.strokeWidth).toBe(4);
    expect(one.opacity).toBe(0.5);
    expect(one.stroke).toEqual({ type: 'solid', color: '#000000' });
    expect(two.fill).toEqual({ type: 'solid', color: '#0000ff' });
  });

  it('remaps user-space gradients onto the object', () => {
    const { doc } = importSvg(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="200" height="100">
      <defs><linearGradient id="base"><stop offset="0" stop-color="#f00"/><stop offset="100%" style="stop-color:#00f;stop-opacity:.5"/></linearGradient>
      <linearGradient id="g" xlink:href="#base" gradientUnits="userSpaceOnUse" x1="50" y1="0" x2="150" y2="0"/></defs>
      <rect x="50" y="10" width="100" height="50" fill="url(#g)"/>
    </svg>`);
    const fill = (doc.layers[0].children[0] as PathNode).fill;
    expect(fill).toMatchObject({ type: 'linear', x1: 0, x2: 1 });
    if (fill.type === 'linear') expect(fill.stops).toEqual([{ offset: 0, color: '#ff0000' }, { offset: 1, color: '#0000ff', alpha: 0.5 }]);
  });

  it('reads text, <use>, clip paths and layers', () => {
    const { doc, warnings } = importSvg(`<?xml version="1.0"?>
      <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd" [ <!ENTITY ns_svg "http://www.w3.org/2000/svg"> ]>
      <svg xmlns="&ns_svg;" xmlns:xlink="http://www.w3.org/1999/xlink" width="300" height="200">
      <defs><clipPath id="c"><circle cx="50" cy="50" r="20"/></clipPath><rect id="tile" width="10" height="10"/></defs>
      <g id="Background"><rect width="100" height="100" clip-path="url(#c)" fill="#ccc"/><use xlink:href="#tile" x="200" y="20" fill="#0a0"/></g>
      <g id="Type_x20_layer"><text x="10" y="30" font-family="'Georgia', serif" font-size="20" font-weight="bold" text-anchor="middle" fill="#123456"><tspan x="10" y="30">First</tspan><tspan x="10" dy="24">Second</tspan></text>
      <rect width="5" height="5" filter="url(#blur)"/></g>
    </svg>`);
    expect(doc.layers.map((l) => l.name)).toEqual(['Background', 'Type layer']);
    const [clipped, used] = doc.layers[0].children;
    expect(clipped.type).toBe('group');
    if (clipped.type === 'group') {
      expect(clipped.clip).toBe(true);
      expect(nodeBounds(clipped)!.width).toBeCloseTo(40, 3);
    }
    expect(subsBounds((used as PathNode).subs)).toEqual({ x: 200, y: 20, width: 10, height: 10 });
    expect((used as PathNode).fill).toEqual({ type: 'solid', color: '#00aa00' });
    const t = doc.layers[1].children[0] as TextNode;
    expect(t).toMatchObject({ type: 'text', text: 'First\nSecond', family: 'Georgia', size: 20, weight: 700, align: 'center', x: 10, y: 30 });
    expect(t.fill).toEqual({ type: 'solid', color: '#123456' });
    expect(warnings).toContain('Filter effects');
  });

  it('rejects files that are not SVG', () => {
    expect(() => importSvg('<html><body/></html>')).toThrow(/not an SVG/);
  });
});
