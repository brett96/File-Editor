/**
 * SVG → vector document.
 *
 * A file this app saved carries its own document in <metadata>; it is used when the drawing's
 * checksum still matches. Any other SVG is read element by element: shapes become paths with
 * their transforms applied, text and images keep a matrix, <g> becomes a group (or a layer,
 * for files whose top level is nothing but named groups, as Illustrator and Inkscape write),
 * and gradients are remapped onto each object's bounding box. What has no equivalent here
 * (filters, masks, patterns, animation) is skipped and reported.
 */
import { parseXml } from '../dom';
import { parseCssColor } from './color';
import {
  DEFAULT_CHAR, DEFAULT_PARA, DEFAULT_SWATCHES, IDENTITY, NO_PAINT, newId,
  type BlendMode, type GradientStop, type GroupNode, type Layer, type Mat, type Paint, type PathNode, type SubPath, type TextNode, type VNode, type VectorDoc, BLEND_MODES,
} from './model';
import { apply, ellipseSubs, lineSubs, mul, nodeBounds, parseD, rectSubs, scaleOf, subsBounds, transformSubs, corner, type Box } from './path';
import { BODY_MARK, MODEL_ID, checksum, fromBase64Utf8 } from './svg';

export interface SvgImport {
  doc: VectorDoc;
  warnings: string[];
}

const UNIT: Record<string, number> = { px: 1, pt: 96 / 72, pc: 16, mm: 96 / 25.4, cm: 96 / 2.54, in: 96, em: 16, ex: 8 };

function length(value: string | null | undefined, fallback = 0, percentOf = 0): number {
  if (value == null) return fallback;
  const m = /^\s*([-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?)\s*([a-z%]*)/i.exec(value);
  if (!m) return fallback;
  const n = parseFloat(m[1]);
  if (m[2] === '%') return (n / 100) * percentOf;
  return n * (UNIT[m[2].toLowerCase()] ?? 1);
}

export function parseTransform(value: string | null | undefined): Mat {
  let m: Mat = IDENTITY;
  if (!value) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let hit: RegExpExecArray | null;
  while ((hit = re.exec(value))) {
    const a = hit[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let t: Mat = IDENTITY;
    switch (hit[1]) {
      case 'matrix':
        if (a.length >= 6) t = [a[0], a[1], a[2], a[3], a[4], a[5]];
        break;
      case 'translate':
        t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
        break;
      case 'scale':
        t = [a[0] ?? 1, 0, 0, a[1] ?? a[0] ?? 1, 0, 0];
        break;
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180;
        const c = Math.cos(r);
        const s = Math.sin(r);
        const cx = a[1] || 0;
        const cy = a[2] || 0;
        t = [c, s, -s, c, cx - c * cx + s * cy, cy - s * cx - c * cy];
        break;
      }
      case 'skewX':
        t = [1, 0, Math.tan(((a[0] || 0) * Math.PI) / 180), 1, 0, 0];
        break;
      case 'skewY':
        t = [1, Math.tan(((a[0] || 0) * Math.PI) / 180), 0, 1, 0, 0];
        break;
    }
    m = mul(m, t);
  }
  return m;
}

/** The properties that pass from an element to its children. */
const INHERITED = [
  'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin', 'stroke-miterlimit', 'stroke-dasharray', 'fill-rule', 'fill-opacity',
  'stroke-opacity', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-anchor', 'letter-spacing', 'text-decoration', 'color', 'visibility',
];
const OWN = ['opacity', 'display', 'mix-blend-mode', 'clip-path', 'mask', 'filter'];

type Props = Record<string, string>;

interface CssRule {
  tag: string;
  id: string;
  classes: string[];
  props: Props;
}

function parseDeclarations(text: string): Props {
  const out: Props = {};
  for (const decl of text.split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const key = decl.slice(0, i).trim().toLowerCase();
    if (key) out[key] = decl.slice(i + 1).replace(/!important/i, '').trim();
  }
  return out;
}

function parseCss(css: string): CssRule[] {
  const rules: CssRule[] = [];
  const re = /([^{}]+)\{([^{}]*)\}/g;
  let m: RegExpExecArray | null;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/<!\[CDATA\[|\]\]>/g, '');
  while ((m = re.exec(clean))) {
    const props = parseDeclarations(m[2]);
    for (const sel of m[1].split(',')) {
      // only the last compound of a selector is matched (".a .b" is treated as ".b")
      const last = sel.trim().split(/[\s>+~]+/).pop() ?? '';
      if (!last || /[:[\]*]/.test(last)) continue;
      const tag = /^[a-zA-Z][\w-]*/.exec(last)?.[0] ?? '';
      const id = /#([\w-]+)/.exec(last)?.[1] ?? '';
      const classes = [...last.matchAll(/\.([\w-]+)/g)].map((x) => x[1]);
      rules.push({ tag, id, classes, props });
    }
  }
  return rules;
}

const local = (el: Element) => el.localName || el.nodeName.replace(/^.*:/, '');

function hrefOf(el: Element): string {
  return el.getAttribute('href') ?? el.getAttributeNS('http://www.w3.org/1999/xlink', 'href') ?? el.getAttribute('xlink:href') ?? '';
}

/** Replaces the entities Illustrator declares in the DOCTYPE (&ns_svg; …) and drops the DOCTYPE. */
function stripDoctype(text: string): string {
  const doctype = /<!DOCTYPE[^[>]*(\[[\s\S]*?\])?\s*>/i.exec(text);
  if (!doctype) return text;
  let out = text.replace(doctype[0], '');
  for (const e of doctype[0].matchAll(/<!ENTITY\s+([\w.-]+)\s+"([^"]*)"\s*>/g)) out = out.split(`&${e[1]};`).join(e[2]);
  return out;
}

/** The document a File Editor save embedded, when the drawing has not been changed since. */
function embeddedModel(text: string): VectorDoc | null {
  const meta = new RegExp(`<metadata id="${MODEL_ID}" data-hash="([0-9a-f]{8})">([A-Za-z0-9+/=\\s]*)</metadata>`).exec(text);
  const mark = text.indexOf(BODY_MARK);
  const end = text.lastIndexOf('</svg>');
  if (!meta || mark < 0 || end < mark) return null;
  const body = text.slice(mark + BODY_MARK.length, end);
  if (checksum(body) !== meta[1]) return null;
  try {
    const doc = JSON.parse(fromBase64Utf8(meta[2])) as VectorDoc;
    if (doc?.version !== 1 || !Array.isArray(doc.layers) || !Array.isArray(doc.artboards)) return null;
    // image pixels live in the drawing: put them back
    const hrefs = new Map<string, string>();
    for (const m of body.matchAll(/<image id="fe-([^"]+)" href="([^"]*)"/g)) hrefs.set(m[1], m[2].replace(/&amp;/g, '&'));
    const fill = (nodes: VNode[]): VNode[] =>
      nodes.map((n) => (n.type === 'image' ? { ...n, href: n.href || hrefs.get(n.id) || '' } : n.type === 'group' ? { ...n, children: fill(n.children) } : n));
    return { ...doc, layers: doc.layers.map((l) => ({ ...l, children: fill(l.children) })), swatches: doc.swatches ?? DEFAULT_SWATCHES, textStyles: doc.textStyles ?? [] };
  } catch {
    return null;
  }
}

interface Ctx {
  matrix: Mat;
  props: Props;
}

export function importSvg(source: string): SvgImport {
  const embedded = embeddedModel(source);
  if (embedded) return { doc: embedded, warnings: [] };

  const warnings = new Set<string>();
  const xml = parseXml(stripDoctype(source.replace(/^\uFEFF/, '')));
  const root = xml.documentElement;
  if (!root || local(root) !== 'svg') throw new Error('This is not an SVG drawing.');

  const byId = new Map<string, Element>();
  const rules: CssRule[] = [];
  const all = root.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const el = all[i];
    const id = el.getAttribute('id');
    if (id) byId.set(id, el);
    if (local(el) === 'style') rules.push(...parseCss(el.textContent ?? ''));
  }

  // ── viewport ──
  const vb = (root.getAttribute('viewBox') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
  const hasVb = vb.length === 4 && vb.every(Number.isFinite) && vb[2] > 0 && vb[3] > 0;
  const width = hasVb ? vb[2] : length(root.getAttribute('width'), 800, 800) || 800;
  const height = hasVb ? vb[3] : length(root.getAttribute('height'), 600, 600) || 600;
  const rootMatrix: Mat = hasVb ? [1, 0, 0, 1, -vb[0], -vb[1]] : IDENTITY;

  const ownProps = (el: Element): Props => {
    const out: Props = {};
    for (const key of [...INHERITED, ...OWN]) {
      const v = el.getAttribute(key);
      if (v != null) out[key] = v;
    }
    if (rules.length) {
      const tag = local(el);
      const id = el.getAttribute('id') ?? '';
      const classes = (el.getAttribute('class') ?? '').split(/\s+/);
      for (const r of rules) {
        if ((r.tag && r.tag !== tag) || (r.id && r.id !== id) || !r.classes.every((c) => classes.includes(c))) continue;
        Object.assign(out, r.props);
      }
    }
    const style = el.getAttribute('style');
    if (style) Object.assign(out, parseDeclarations(style));
    return out;
  };

  const inherit = (parent: Props, own: Props): Props => {
    const out: Props = {};
    for (const key of INHERITED) {
      const v = own[key] !== undefined && own[key] !== 'inherit' ? own[key] : parent[key];
      if (v !== undefined) out[key] = v;
    }
    for (const key of OWN) if (own[key] !== undefined) out[key] = own[key];
    return out;
  };

  // ── paints ──
  const gradientChain = (el: Element): Element[] => {
    const chain = [el];
    let cur = el;
    for (let guard = 0; guard < 8; guard++) {
      const ref = hrefOf(cur).replace(/^#/, '');
      const next = ref ? byId.get(ref) : undefined;
      if (!next || chain.includes(next)) break;
      chain.push(next);
      cur = next;
    }
    return chain;
  };
  const gAttr = (chain: Element[], name: string): string | null => {
    for (const el of chain) {
      const v = el.getAttribute(name);
      if (v != null) return v;
    }
    return null;
  };

  /** `box`: the painted object's bounds in document space; `matrix`: user space → document space. */
  const resolvePaint = (value: string | undefined, opacity: number, props: Props, box: Box, matrix: Mat): Paint => {
    if (!value || value === 'none') return NO_PAINT;
    const url = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(value);
    if (url) {
      const el = byId.get(url[1]);
      const tag = el ? local(el) : '';
      if (!el || (tag !== 'linearGradient' && tag !== 'radialGradient')) {
        if (tag === 'pattern') warnings.add('Pattern fills (shown as grey)');
        const fallback = parseCssColor(value.replace(/url\([^)]*\)/, '').trim());
        return fallback ? { type: 'solid', color: fallback.color } : tag ? { type: 'solid', color: '#999999' } : NO_PAINT;
      }
      const chain = gradientChain(el);
      const stopsEl = chain.find((c) => Array.from(c.children).some((k) => local(k) === 'stop'));
      const stops: GradientStop[] = [];
      for (const s of Array.from(stopsEl?.children ?? [])) {
        if (local(s) !== 'stop') continue;
        const sp = ownProps(s);
        const st = { ...sp, 'stop-color': s.getAttribute('stop-color') ?? '', 'stop-opacity': s.getAttribute('stop-opacity') ?? '', ...parseDeclarations(s.getAttribute('style') ?? '') };
        const c = parseCssColor(st['stop-color'] || 'black') ?? { color: '#000000', alpha: 1 };
        const a = c.alpha * (st['stop-opacity'] ? length(st['stop-opacity'], 1, 1) : 1) * opacity;
        const off = s.getAttribute('offset') ?? '0';
        stops.push({ offset: Math.max(0, Math.min(1, off.trim().endsWith('%') ? parseFloat(off) / 100 : parseFloat(off) || 0)), color: c.color, ...(a < 1 ? { alpha: a } : {}) });
      }
      if (!stops.length) return NO_PAINT;
      if (stops.length === 1) return { type: 'solid', color: stops[0].color, alpha: stops[0].alpha };
      const user = gAttr(chain, 'gradientUnits') === 'userSpaceOnUse';
      const gt = parseTransform(gAttr(chain, 'gradientTransform'));
      const bw = box.width || 1;
      const bh = box.height || 1;
      // a point of the gradient's own space → the unit square of the object's box
      const toUnit = (x: number, y: number) => {
        const p = apply(gt, x, y);
        if (!user) return p;
        const d = apply(matrix, p.x, p.y);
        return { x: (d.x - box.x) / bw, y: (d.y - box.y) / bh };
      };
      const coord = (name: string, dflt: string, size: number) => {
        const v = gAttr(chain, name) ?? dflt;
        return v.trim().endsWith('%') ? (parseFloat(v) / 100) * (user ? size : 1) : length(v);
      };
      if (tag === 'linearGradient') {
        const a = toUnit(coord('x1', '0%', width), coord('y1', '0%', height));
        const b = toUnit(coord('x2', '100%', width), coord('y2', '0%', height));
        return { type: 'linear', stops, x1: a.x, y1: a.y, x2: b.x, y2: b.y };
      }
      const cx = coord('cx', '50%', width);
      const cy = coord('cy', '50%', height);
      const r = coord('r', '50%', Math.hypot(width, height) / Math.SQRT2);
      const c = toUnit(cx, cy);
      const edge = toUnit(cx + r, cy);
      const radius = user ? (r * scaleOf(mul(matrix, gt))) / Math.sqrt(bw * bh) : Math.hypot(edge.x - c.x, edge.y - c.y);
      return { type: 'radial', stops, cx: c.x, cy: c.y, r: radius || 0.5 };
    }
    const c = parseCssColor(value === 'currentColor' || value === 'currentcolor' ? props.color ?? 'black' : value);
    if (!c) return NO_PAINT;
    const alpha = c.alpha * opacity;
    return alpha < 1 ? { type: 'solid', color: c.color, alpha } : { type: 'solid', color: c.color };
  };

  const base = (props: Props) => {
    const blend = props['mix-blend-mode'] as BlendMode | undefined;
    return {
      id: newId(),
      opacity: Math.max(0, Math.min(1, props.opacity !== undefined ? length(props.opacity, 1, 1) : 1)),
      ...(blend && BLEND_MODES.includes(blend) && blend !== 'normal' ? { blend } : {}),
    };
  };

  const styleFor = (props: Props, box: Box, matrix: Mat, defaultFill = 'black') => {
    const scale = scaleOf(matrix);
    const op = (key: string) => (props[key] !== undefined ? Math.max(0, Math.min(1, length(props[key], 1, 1))) : 1);
    const dash = (props['stroke-dasharray'] ?? 'none') === 'none' ? [] : props['stroke-dasharray'].split(/[\s,]+/).map((v) => length(v) * scale).filter((v) => v >= 0);
    const cap = props['stroke-linecap'];
    const join = props['stroke-linejoin'];
    return {
      fill: resolvePaint(props.fill ?? defaultFill, op('fill-opacity'), props, box, matrix),
      stroke: resolvePaint(props.stroke, op('stroke-opacity'), props, box, matrix),
      strokeWidth: length(props['stroke-width'], 1) * scale,
      cap: (cap === 'round' || cap === 'square' ? cap : 'butt') as PathNode['cap'],
      join: (join === 'round' || join === 'bevel' ? join : 'miter') as PathNode['join'],
      miter: length(props['stroke-miterlimit'], 4),
      dash: dash.some((v) => v > 0) ? dash : [],
      fillRule: (props['fill-rule'] === 'evenodd' ? 'evenodd' : 'nonzero') as PathNode['fillRule'],
    };
  };

  const shapeSubs = (el: Element): SubPath[] | null => {
    const n = (name: string, pct = 0) => length(el.getAttribute(name), 0, pct);
    switch (local(el)) {
      case 'path':
        return parseD(el.getAttribute('d') ?? '');
      case 'rect': {
        const w = n('width', width);
        const h = n('height', height);
        if (w <= 0 || h <= 0) return [];
        const rx = el.hasAttribute('rx') ? n('rx') : n('ry');
        return rectSubs(n('x', width), n('y', height), w, h, rx);
      }
      case 'circle':
        return n('r') > 0 ? ellipseSubs(n('cx', width), n('cy', height), n('r'), n('r')) : [];
      case 'ellipse':
        return n('rx') > 0 && n('ry') > 0 ? ellipseSubs(n('cx', width), n('cy', height), n('rx'), n('ry')) : [];
      case 'line':
        return lineSubs(n('x1'), n('y1'), n('x2'), n('y2'));
      case 'polyline':
      case 'polygon': {
        const pts = (el.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
        const anchors = [];
        for (let i = 0; i + 1 < pts.length; i += 2) anchors.push(corner(pts[i], pts[i + 1]));
        return anchors.length > 1 ? [{ anchors, closed: local(el) === 'polygon' }] : [];
      }
    }
    return null;
  };

  const textNode = (el: Element, ctx: Ctx, props: Props): TextNode | null => {
    const lines: string[] = [];
    let x = length(el.getAttribute('x')?.split(/[\s,]+/)[0]);
    let y = length(el.getAttribute('y')?.split(/[\s,]+/)[0]);
    let first = true;
    let pathSubs: SubPath[] | undefined;
    let startOffset = 0;
    const visit = (node: Node, line: { text: string }) => {
      for (const child of Array.from(node.childNodes)) {
        if (child.nodeType === 3) line.text += (child.nodeValue ?? '').replace(/\s+/g, ' ');
        else if (child.nodeType === 1) {
          const c = child as Element;
          const tag = local(c);
          if (tag === 'textPath') {
            const ref = byId.get(hrefOf(c).replace(/^#/, ''));
            const subs = ref ? shapeSubs(ref) : null;
            if (subs?.length) {
              pathSubs = transformSubs(subs, parseTransform(ref!.getAttribute('transform')));
              const so = c.getAttribute('startOffset') ?? '0';
              startOffset = so.trim().endsWith('%') ? parseFloat(so) / 100 : 0;
            }
            visit(c, line);
          } else if (tag === 'tspan') {
            // a tspan that sets its own position starts a new line
            const breaks = c.hasAttribute('x') && (c.hasAttribute('y') || c.hasAttribute('dy'));
            if (breaks && line.text.trim()) {
              lines.push(line.text.trim());
              line.text = '';
            }
            if (first && c.hasAttribute('x') && !el.hasAttribute('x')) x = length(c.getAttribute('x')!.split(/[\s,]+/)[0]);
            if (first && c.hasAttribute('y') && !el.hasAttribute('y')) y = length(c.getAttribute('y')!.split(/[\s,]+/)[0]);
            first = false;
            visit(c, line);
          } else if (tag === 'a') visit(c, line);
        }
      }
    };
    const line = { text: '' };
    visit(el, line);
    if (line.text.trim()) lines.push(line.text.trim());
    if (!lines.length) return null;
    const size = length(props['font-size'], 16) || 16;
    const weight = props['font-weight'] === 'bold' ? 700 : props['font-weight'] === 'normal' || !props['font-weight'] ? 400 : parseInt(props['font-weight'], 10) || 400;
    const anchor = props['text-anchor'];
    const family = (props['font-family'] ?? DEFAULT_CHAR.family).split(',')[0].trim().replace(/^['"]|['"]$/g, '') || DEFAULT_CHAR.family;
    const node: TextNode = {
      ...base(props),
      type: 'text',
      text: lines.join('\n'),
      kind: pathSubs ? 'path' : 'point',
      x,
      y,
      ...(pathSubs ? { path: pathSubs, startOffset } : {}),
      matrix: ctx.matrix,
      family,
      size,
      weight,
      italic: props['font-style'] === 'italic' || props['font-style'] === 'oblique',
      tracking: props['letter-spacing'] && props['letter-spacing'] !== 'normal' ? Math.round((length(props['letter-spacing']) / size) * 1000) : 0,
      ...(/underline/.test(props['text-decoration'] ?? '') ? { underline: true } : {}),
      align: anchor === 'middle' ? 'center' : anchor === 'end' ? 'right' : 'left',
      leading: DEFAULT_PARA.leading,
      ...styleFor(props, { x: 0, y: 0, width: 1, height: 1 }, IDENTITY),
    };
    // gradients on text are resolved against its local box
    const box = nodeBounds({ ...node, matrix: IDENTITY }) ?? { x, y, width: 1, height: 1 };
    const st = styleFor(props, box, IDENTITY);
    return { ...node, fill: st.fill, stroke: st.stroke, strokeWidth: length(props['stroke-width'], 1) };
  };

  const SKIP = new Set(['defs', 'style', 'metadata', 'title', 'desc', 'clipPath', 'mask', 'pattern', 'linearGradient', 'radialGradient', 'filter', 'marker', 'symbol', 'script', 'namedview', 'foreignObject']);

  const convert = (el: Element, ctx: Ctx, depth = 0): VNode | null => {
    const tag = local(el);
    if (SKIP.has(tag) || depth > 64) {
      if (tag === 'foreignObject') warnings.add('Embedded HTML (foreignObject)');
      return null;
    }
    const own = ownProps(el);
    if (own.display === 'none' || own.visibility === 'hidden') return null;
    const props = inherit(ctx.props, own);
    const matrix = mul(ctx.matrix, parseTransform(el.getAttribute('transform')));
    const here: Ctx = { matrix, props };
    if (props.filter && props.filter !== 'none') warnings.add('Filter effects');
    if (props.mask && props.mask !== 'none') warnings.add('Masks');
    let node: VNode | null = null;

    if (tag === 'g' || tag === 'svg' || tag === 'a' || tag === 'switch') {
      const kids: VNode[] = [];
      for (const c of Array.from(el.children)) {
        const k = convert(c, { matrix, props: { ...props, opacity: undefined as never, 'clip-path': undefined as never, 'mix-blend-mode': undefined as never } }, depth + 1);
        if (k) kids.push(k);
        if (tag === 'switch' && k) break;
      }
      if (!kids.length) return null;
      const b = base(props);
      // a group that only wraps one object and adds nothing is dropped
      node = kids.length === 1 && b.opacity === 1 && !b.blend && !own['clip-path'] ? kids[0] : ({ ...b, type: 'group', children: kids, name: el.getAttribute('id') ?? undefined } as GroupNode);
    } else if (tag === 'use') {
      const ref = byId.get(hrefOf(el).replace(/^#/, ''));
      if (!ref) return null;
      const m = mul(matrix, [1, 0, 0, 1, length(el.getAttribute('x')), length(el.getAttribute('y'))]);
      if (local(ref) === 'symbol') {
        const kids = Array.from(ref.children).map((c) => convert(c, { matrix: m, props }, depth + 1)).filter((k): k is VNode => !!k);
        node = kids.length ? ({ ...base(props), type: 'group', children: kids } as GroupNode) : null;
      } else node = convert(ref, { matrix: m, props: { ...props, opacity: undefined as never } }, depth + 1);
      if (node && own.opacity !== undefined) node = { ...node, opacity: node.opacity * base(props).opacity };
    } else if (tag === 'text') {
      node = textNode(el, here, props);
    } else if (tag === 'image') {
      const href = hrefOf(el);
      if (!/^data:image\//i.test(href)) {
        warnings.add('Linked images (only embedded images are kept)');
        return null;
      }
      node = {
        ...base(props),
        type: 'image',
        href,
        x: length(el.getAttribute('x')),
        y: length(el.getAttribute('y')),
        width: length(el.getAttribute('width'), 0, width),
        height: length(el.getAttribute('height'), 0, height),
        matrix,
      };
      if (!node.width || !node.height) return null;
    } else {
      const local0 = shapeSubs(el);
      if (local0 === null) {
        if (!['animate', 'animateTransform', 'set'].includes(tag)) warnings.add(`<${tag}> elements`);
        else warnings.add('Animation');
        return null;
      }
      if (!local0.length) return null;
      const subs = transformSubs(local0, matrix);
      const box = subsBounds(subs) ?? { x: 0, y: 0, width: 1, height: 1 };
      // open shapes with no fill given default to black, like every SVG viewer; a <line> has no area
      const st = styleFor(props, box, matrix, tag === 'line' ? 'none' : 'black');
      node = { ...base(props), type: 'path', subs, ...st, name: el.getAttribute('id') ?? undefined } as PathNode;
    }

    // clip-path: the first shape of the <clipPath> masks this object
    const clip = /url\(\s*['"]?#([^'")\s]+)/.exec(own['clip-path'] ?? '');
    if (node && clip) {
      const cp = byId.get(clip[1]);
      const shapes: SubPath[] = [];
      const user = cp?.getAttribute('clipPathUnits') !== 'objectBoundingBox';
      const cm = mul(matrix, parseTransform(cp?.getAttribute('transform')));
      for (const c of Array.from(cp?.children ?? [])) {
        let target: Element | undefined = c;
        let m = cm;
        if (local(c) === 'use') {
          target = byId.get(hrefOf(c).replace(/^#/, ''));
          m = mul(m, [1, 0, 0, 1, length(c.getAttribute('x')), length(c.getAttribute('y'))]);
        }
        const s = target ? shapeSubs(target) : null;
        if (s?.length) shapes.push(...transformSubs(s, mul(m, parseTransform(target!.getAttribute('transform')))));
      }
      if (shapes.length && user) {
        const mask: PathNode = { id: newId(), type: 'path', opacity: 1, subs: shapes, fill: NO_PAINT, stroke: NO_PAINT, strokeWidth: 1, cap: 'butt', join: 'miter', miter: 4, dash: [], fillRule: 'nonzero' };
        node = { id: newId('g'), type: 'group', opacity: 1, clip: true, children: [mask, node] };
      } else if (shapes.length) warnings.add('Clipping paths in bounding-box units');
    }
    return node;
  };

  const rootProps = inherit({}, ownProps(root));
  const top = Array.from(root.children).filter((c) => !SKIP.has(local(c)));
  const label = (el: Element) => el.getAttribute('inkscape:label') ?? el.getAttribute('data-name') ?? el.getAttribute('id') ?? '';
  // Illustrator / Inkscape layers: a top level made only of named groups
  const layered = top.length > 0 && top.every((c) => local(c) === 'g' && label(c) && !c.getAttribute('transform') && !c.getAttribute('clip-path'));
  const layers: Layer[] = [];
  if (layered) {
    for (const g of top) {
      const own = ownProps(g);
      const props = inherit(rootProps, own);
      const kids = Array.from(g.children).map((c) => convert(c, { matrix: rootMatrix, props })).filter((k): k is VNode => !!k);
      const opacity = own.opacity !== undefined ? length(own.opacity, 1, 1) : 1;
      layers.push({
        id: newId('l'),
        name: label(g).replace(/_x([0-9A-F]{2})_/g, (_, h: string) => String.fromCharCode(parseInt(h, 16))).replace(/_/g, ' '),
        hidden: own.display === 'none' || undefined,
        // a layer has no opacity of its own: keep it by grouping the layer's content
        children: opacity < 1 && kids.length ? [{ id: newId('g'), type: 'group', opacity, children: kids }] : kids,
      });
    }
  } else {
    const kids = top.map((c) => convert(c, { matrix: rootMatrix, props: rootProps })).filter((k): k is VNode => !!k);
    layers.push({ id: newId('l'), name: 'Layer 1', children: kids });
  }

  return {
    doc: {
      version: 1,
      artboards: [{ id: newId('a'), name: 'Artboard 1', x: 0, y: 0, width, height }],
      layers,
      swatches: DEFAULT_SWATCHES,
      textStyles: [],
    },
    warnings: [...warnings],
  };
}
