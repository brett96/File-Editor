/**
 * Vector Studio document model.
 *
 * A document is a set of artboards (canvases) over one shared coordinate space, and a stack of
 * layers holding objects. Everything is plain immutable data: an edit returns a new document
 * that shares every untouched node with the old one, which is what makes undo history cheap
 * and lets the canvas re-render only the objects that changed.
 *
 * Geometry is in document units (CSS px, 96 per inch), y down. Paths keep no transform of
 * their own: moving, scaling or rotating a path rewrites its anchors. Text and images carry a
 * matrix, because their content (glyphs, pixels) can't be rewritten point by point.
 */

/** Affine matrix [a b c d e f]: x' = a·x + c·y + e, y' = b·x + d·y + f. */
export type Mat = [number, number, number, number, number, number];

export const IDENTITY: Mat = [1, 0, 0, 1, 0, 0];

/** One anchor point with its two Bézier handles (absolute positions; equal to x,y when retracted). */
export interface Anchor {
  x: number;
  y: number;
  /** incoming handle */
  ix: number;
  iy: number;
  /** outgoing handle */
  ox: number;
  oy: number;
  /** handles stay collinear when one is dragged (curvature tool points are always smooth) */
  smooth?: boolean;
}

export interface SubPath {
  anchors: Anchor[];
  closed: boolean;
}

export interface GradientStop {
  offset: number;
  color: string;
  alpha?: number;
}

/** Gradient geometry is in the unit square of the painted object's bounding box. */
export interface LinearGradient {
  type: 'linear';
  stops: GradientStop[];
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface RadialGradient {
  type: 'radial';
  stops: GradientStop[];
  cx: number;
  cy: number;
  r: number;
}

export interface MeshPoint {
  /** position in the unit square of the object's bounding box */
  x: number;
  y: number;
  color: string;
}

/** A gradient mesh: a (rows+1) × (cols+1) grid of coloured points, row by row. */
export interface MeshPaint {
  type: 'mesh';
  rows: number;
  cols: number;
  points: MeshPoint[];
}

export type Paint = { type: 'none' } | { type: 'solid'; color: string; alpha?: number } | LinearGradient | RadialGradient | MeshPaint;

export const NO_PAINT: Paint = { type: 'none' };

export type BlendMode =
  | 'normal' | 'multiply' | 'screen' | 'overlay' | 'darken' | 'lighten' | 'color-dodge' | 'color-burn'
  | 'hard-light' | 'soft-light' | 'difference' | 'exclusion' | 'hue' | 'saturation' | 'color' | 'luminosity';

export const BLEND_MODES: BlendMode[] = [
  'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'color-dodge', 'color-burn',
  'hard-light', 'soft-light', 'difference', 'exclusion', 'hue', 'saturation', 'color', 'luminosity',
];

export interface Style {
  fill: Paint;
  stroke: Paint;
  strokeWidth: number;
  cap: 'butt' | 'round' | 'square';
  join: 'miter' | 'round' | 'bevel';
  miter: number;
  dash: number[];
  fillRule: 'nonzero' | 'evenodd';
}

export const DEFAULT_STYLE: Style = {
  fill: { type: 'solid', color: '#ffffff' },
  stroke: { type: 'solid', color: '#000000' },
  strokeWidth: 1,
  cap: 'butt',
  join: 'miter',
  miter: 10,
  dash: [],
  fillRule: 'nonzero',
};

interface NodeBase {
  id: string;
  name?: string;
  hidden?: boolean;
  locked?: boolean;
  /** 0–1 */
  opacity: number;
  blend?: BlendMode;
}

export interface PathNode extends NodeBase, Style {
  type: 'path';
  subs: SubPath[];
}

export interface CharStyle {
  family: string;
  size: number;
  weight: number;
  italic: boolean;
  /** letter spacing in thousandths of an em (Illustrator's tracking) */
  tracking: number;
  underline?: boolean;
}

export interface ParaStyle {
  align: 'left' | 'center' | 'right';
  /** line height as a multiple of the font size */
  leading: number;
}

export interface TextNode extends NodeBase, Style, CharStyle, ParaStyle {
  type: 'text';
  text: string;
  /**
   * point: lines start at (x, y) (y = first baseline); area: text wraps inside the box
   * (x, y, width, height); path: text runs along `path` from `startOffset` (0–1 of its length).
   */
  kind: 'point' | 'area' | 'path';
  x: number;
  y: number;
  width?: number;
  height?: number;
  path?: SubPath[];
  startOffset?: number;
  matrix: Mat;
}

export interface ImageNode extends NodeBase {
  type: 'image';
  /** data: URL */
  href: string;
  x: number;
  y: number;
  width: number;
  height: number;
  matrix: Mat;
}

export interface GroupNode extends NodeBase {
  type: 'group';
  children: VNode[];
  /** clipping mask: the first child's outline clips the rest (and is not painted) */
  clip?: boolean;
}

export type VNode = PathNode | TextNode | ImageNode | GroupNode;

export interface Layer {
  id: string;
  name: string;
  hidden?: boolean;
  locked?: boolean;
  children: VNode[];
}

export interface Artboard {
  id: string;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Swatch {
  name: string;
  paint: Paint;
}

/** A saved character + paragraph style, applied to text objects by name. */
export interface TextStyle {
  name: string;
  char: CharStyle;
  para: ParaStyle;
}

export interface VectorDoc {
  version: 1;
  artboards: Artboard[];
  layers: Layer[];
  swatches: Swatch[];
  textStyles: TextStyle[];
}

let idSeq = 0;
/** A short id that is unique within this session and unlikely to clash with ids read from a file. */
export function newId(prefix = 'n'): string {
  idSeq++;
  return `${prefix}${Date.now().toString(36).slice(-4)}${idSeq.toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

export const DEFAULT_CHAR: CharStyle = { family: 'Arial', size: 24, weight: 400, italic: false, tracking: 0 };
export const DEFAULT_PARA: ParaStyle = { align: 'left', leading: 1.2 };

export const DEFAULT_SWATCHES: Swatch[] = [
  ['White', '#ffffff'], ['Black', '#000000'], ['Charcoal', '#3a3a3c'], ['Grey', '#8e8e93'], ['Silver', '#d1d1d6'],
  ['Red', '#e5383b'], ['Orange', '#f77f00'], ['Amber', '#fcbf49'], ['Yellow', '#ffe94e'], ['Lime', '#9bd33a'],
  ['Green', '#2a9d4f'], ['Teal', '#1fa7a0'], ['Cyan', '#35c2f0'], ['Blue', '#2f6fed'], ['Indigo', '#4a47d1'],
  ['Violet', '#8b46d6'], ['Magenta', '#d6409f'], ['Rose', '#f25f7a'], ['Brown', '#8a5a36'], ['Sand', '#e6d3b1'],
].map(([name, color]) => ({ name, paint: { type: 'solid', color } as Paint }));

export const ARTBOARD_PRESETS: { name: string; width: number; height: number }[] = [
  { name: 'Letter', width: 816, height: 1056 },
  { name: 'A4', width: 794, height: 1123 },
  { name: 'Square 1080', width: 1080, height: 1080 },
  { name: 'HD 1920 × 1080', width: 1920, height: 1080 },
  { name: 'Web 1440 × 900', width: 1440, height: 900 },
  { name: 'Phone 390 × 844', width: 390, height: 844 },
  { name: 'Icon 512', width: 512, height: 512 },
  { name: 'Icon 64', width: 64, height: 64 },
  { name: 'Business card', width: 336, height: 192 },
];

export function newDocument(width = 800, height = 600, name = 'Artboard 1'): VectorDoc {
  return {
    version: 1,
    artboards: [{ id: newId('a'), name, x: 0, y: 0, width, height }],
    layers: [{ id: newId('l'), name: 'Layer 1', children: [] }],
    swatches: DEFAULT_SWATCHES,
    textStyles: [],
  };
}

// ── tree helpers ───────────────────────────────────────────────────────────

/** Depth-first walk over every node (groups before their children). */
export function walk(nodes: VNode[], fn: (node: VNode, parent: GroupNode | null) => void, parent: GroupNode | null = null): void {
  for (const n of nodes) {
    fn(n, parent);
    if (n.type === 'group') walk(n.children, fn, n);
  }
}

export function allNodes(doc: VectorDoc): VNode[] {
  const out: VNode[] = [];
  for (const l of doc.layers) walk(l.children, (n) => out.push(n));
  return out;
}

export function findNode(doc: VectorDoc, id: string): VNode | null {
  for (const l of doc.layers) {
    let hit: VNode | null = null;
    walk(l.children, (n) => {
      if (n.id === id) hit = n;
    });
    if (hit) return hit;
  }
  return null;
}

/** The layer holding `id` (at any depth), or null. */
export function layerOf(doc: VectorDoc, id: string): Layer | null {
  for (const l of doc.layers) {
    let has = false;
    walk(l.children, (n) => {
      if (n.id === id) has = true;
    });
    if (has) return l;
  }
  return null;
}

/** The outermost ancestor of `id` (the object the selection tool picks), or the node itself. */
export function topLevelOf(doc: VectorDoc, id: string): VNode | null {
  for (const l of doc.layers) {
    for (const top of l.children) {
      if (top.id === id) return top;
      if (top.type === 'group') {
        let has = false;
        walk(top.children, (n) => {
          if (n.id === id) has = true;
        });
        if (has) return top;
      }
    }
  }
  return null;
}

function mapList(nodes: VNode[], fn: (n: VNode) => VNode | VNode[] | null): VNode[] {
  let changed = false;
  const out: VNode[] = [];
  for (const n of nodes) {
    let next: VNode | VNode[] | null = fn(n);
    if (next === n && n.type === 'group') {
      const kids = mapList(n.children, fn);
      if (kids !== n.children) next = { ...n, children: kids };
    }
    if (next !== n) changed = true;
    if (Array.isArray(next)) out.push(...next);
    else if (next) out.push(next);
  }
  return changed ? out : nodes;
}

/**
 * Rewrites nodes anywhere in the tree. `fn` returns the node unchanged to keep it (its
 * children are then visited), a replacement, several replacements, or null to remove it.
 */
export function mapNodes(doc: VectorDoc, fn: (n: VNode) => VNode | VNode[] | null): VectorDoc {
  let changed = false;
  const layers = doc.layers.map((l) => {
    const kids = mapList(l.children, fn);
    if (kids === l.children) return l;
    changed = true;
    return { ...l, children: kids };
  });
  return changed ? { ...doc, layers } : doc;
}

export function updateNodes(doc: VectorDoc, ids: Iterable<string>, fn: (n: VNode) => VNode): VectorDoc {
  const set = ids instanceof Set ? ids : new Set(ids);
  if (!set.size) return doc;
  return mapNodes(doc, (n) => (set.has(n.id) ? fn(n) : n));
}

export function removeNodes(doc: VectorDoc, ids: Iterable<string>): VectorDoc {
  const set = ids instanceof Set ? ids : new Set(ids);
  if (!set.size) return doc;
  return mapNodes(doc, (n) => (set.has(n.id) ? null : n));
}

/** Adds nodes on top of a layer (the last layer that is neither hidden nor locked by default). */
export function addNodes(doc: VectorDoc, nodes: VNode[], layerId?: string): VectorDoc {
  const target = doc.layers.find((l) => l.id === layerId) ?? [...doc.layers].reverse().find((l) => !l.hidden && !l.locked) ?? doc.layers[doc.layers.length - 1];
  if (!target) return { ...doc, layers: [{ id: newId('l'), name: 'Layer 1', children: nodes }] };
  return { ...doc, layers: doc.layers.map((l) => (l === target ? { ...l, children: [...l.children, ...nodes] } : l)) };
}

/** Replaces the node `id` with `nodes` at the same place in the stacking order. */
export function replaceNode(doc: VectorDoc, id: string, nodes: VNode[]): VectorDoc {
  return mapNodes(doc, (n) => (n.id === id ? nodes : n));
}

/** A deep copy with fresh ids (paste, duplicate). */
export function cloneNode<T extends VNode>(node: T): T {
  if (node.type === 'group') return { ...node, id: newId(), children: node.children.map(cloneNode) };
  return { ...node, id: newId() };
}

export function styleOf(node: PathNode | TextNode): Style {
  const { fill, stroke, strokeWidth, cap, join, miter, dash, fillRule } = node;
  return { fill, stroke, strokeWidth, cap, join, miter, dash, fillRule };
}

export type Arrange = 'front' | 'forward' | 'backward' | 'back';

/** Moves the selected nodes within their own parent's stacking order. */
export function arrange(doc: VectorDoc, ids: Set<string>, how: Arrange): VectorDoc {
  const reorder = (list: VNode[]): VNode[] => {
    let out = list;
    if (list.some((n) => ids.has(n.id))) {
      const sel = list.filter((n) => ids.has(n.id));
      const rest = list.filter((n) => !ids.has(n.id));
      if (how === 'front') out = [...rest, ...sel];
      else if (how === 'back') out = [...sel, ...rest];
      else {
        out = [...list];
        const step = how === 'forward' ? 1 : -1;
        const order = how === 'forward' ? [...out.keys()].reverse() : [...out.keys()];
        for (const i of order) {
          const j = i + step;
          if (ids.has(out[i].id) && j >= 0 && j < out.length && !ids.has(out[j].id)) [out[i], out[j]] = [out[j], out[i]];
        }
      }
    }
    return out.map((n) => (n.type === 'group' ? { ...n, children: reorder(n.children) } : n));
  };
  return { ...doc, layers: doc.layers.map((l) => ({ ...l, children: reorder(l.children) })) };
}

/** Groups the selected top-level nodes of a layer into one group at the topmost one's place. */
export function groupNodes(doc: VectorDoc, ids: Set<string>, clip = false): { doc: VectorDoc; group: GroupNode | null } {
  let made: GroupNode | null = null;
  const layers = doc.layers.map((l) => {
    if (made) return l;
    const sel = l.children.filter((n) => ids.has(n.id));
    if (sel.length < (clip ? 2 : 1)) return l;
    // a clipping mask is cut by the topmost object, which the renderer expects first
    const children = clip ? [sel[sel.length - 1], ...sel.slice(0, -1)] : sel;
    const group: GroupNode = { id: newId('g'), type: 'group', opacity: 1, children, clip: clip || undefined };
    made = group;
    const last = l.children.lastIndexOf(sel[sel.length - 1]);
    const kids: VNode[] = [];
    l.children.forEach((n, i) => {
      if (i === last) kids.push(group);
      else if (!ids.has(n.id)) kids.push(n);
    });
    return { ...l, children: kids };
  });
  return { doc: made ? { ...doc, layers } : doc, group: made };
}

/** Dissolves groups (and clipping masks: the mask shape comes back as an ordinary object on top). */
export function ungroupNodes(doc: VectorDoc, ids: Set<string>): { doc: VectorDoc; children: VNode[] } {
  const freed: VNode[] = [];
  const next = mapNodes(doc, (n) => {
    if (!ids.has(n.id) || n.type !== 'group') return n;
    const kids = n.clip ? [...n.children.slice(1), n.children[0]] : n.children;
    freed.push(...kids);
    return kids;
  });
  return { doc: next, children: freed };
}
