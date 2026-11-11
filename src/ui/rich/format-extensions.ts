/**
 * Word-style formatting the editor schema keeps beyond the basics (see the HTML contract in
 * core/types.ts): paragraph spacing / line height / indent / shading, table cell shading,
 * borders, vertical alignment and widths, row heights, and floating images (ink drawings).
 */
import { Extension, Node, type CommandProps } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { NodeSelection } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView, NodeView } from '@tiptap/pm/view';
import { borderSideCss, cssBorderSide, cssColorToHex } from '../../core/dom';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    paragraphFormat: {
      /** CSS line-height (unitless) or null for the default. */
      setLineHeight: (value: string | null) => ReturnType;
      /** Space before / after in pt; null = default. */
      setParagraphSpacing: (spacing: { before?: number | null; after?: number | null }) => ReturnType;
      /** Moves paragraphs right (+1) or left (-1) by half an inch. */
      shiftIndent: (direction: 1 | -1) => ReturnType;
      setParagraphShading: (color: string | null) => ReturnType;
    };
    cellFormat: {
      setCellBackground: (color: string | null) => ReturnType;
      setCellBorders: (mode: BorderMode, border?: string) => ReturnType;
      setCellVerticalAlign: (value: 'top' | 'middle' | 'bottom') => ReturnType;
    };
  }
}

export type BorderMode = 'all' | 'outside' | 'inside' | 'none' | 'top' | 'bottom' | 'left' | 'right';

export const DEFAULT_BORDER = '1px solid #000000';
const TEXT_BLOCKS = ['paragraph', 'heading'];
const INDENT_STEP = 36; // pt (0.5 in)

/**
 * Reads a declaration from the raw style attribute. (The CSSOM would rewrite colours as rgb()
 * and serialises some values, like "border-top: none", as an empty string.)
 */
function styleValue(el: HTMLElement, prop: string): string | null {
  for (const part of (el.getAttribute('style') ?? '').split(';')) {
    const i = part.indexOf(':');
    if (i > 0 && part.slice(0, i).trim().toLowerCase() === prop) return part.slice(i + 1).trim() || null;
  }
  return null;
}

/** Applies a node attribute to every text block in the selection. */
function updateBlocks(props: CommandProps, fn: (node: PMNode) => Record<string, unknown> | null): boolean {
  const { tr, state, dispatch } = props;
  const { from, to } = state.selection;
  let changed = false;
  state.doc.nodesBetween(from, to, (node, pos) => {
    if (!TEXT_BLOCKS.includes(node.type.name)) return true;
    const attrs = fn(node);
    if (attrs) {
      tr.setNodeMarkup(pos, undefined, { ...node.attrs, ...attrs });
      changed = true;
    }
    return false;
  });
  if (changed && dispatch) dispatch(tr);
  return changed;
}

function cssAttr(name: string, prop: string) {
  return {
    [name]: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => styleValue(el, prop),
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { style: `${prop}: ${attrs[name]}` } : {}),
    },
  };
}

/** background-color, kept as #rrggbb whatever form the HTML used. */
function colorAttr(name: string) {
  return {
    [name]: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => {
        const hex = cssColorToHex(styleValue(el, 'background-color') ?? el.style.backgroundColor);
        return hex ? `#${hex}` : null;
      },
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { style: `background-color: ${attrs[name]}` } : {}),
    },
  };
}

/** One border side as "1px solid #000000" / "none", read from whatever border shorthand the HTML used. */
function borderAttr(name: string, side: 'top' | 'right' | 'bottom' | 'left') {
  return {
    [name]: {
      default: null as string | null,
      parseHTML: (el: HTMLElement) => {
        const b = cssBorderSide(el, side);
        return b ? borderSideCss(b) : styleValue(el, `border-${side}`);
      },
      renderHTML: (attrs: Record<string, unknown>) => (attrs[name] ? { style: `border-${side}: ${attrs[name]}` } : {}),
    },
  };
}

const ptNumber = (v: unknown): number => {
  const m = /^(-?[\d.]+)pt$/.exec(String(v ?? ''));
  return m ? parseFloat(m[1]) : 0;
};

export const ParagraphFormat = Extension.create({
  name: 'paragraphFormat',
  addGlobalAttributes() {
    return [
      {
        types: TEXT_BLOCKS,
        attributes: {
          ...cssAttr('lineHeight', 'line-height'),
          ...cssAttr('spaceBefore', 'margin-top'),
          ...cssAttr('spaceAfter', 'margin-bottom'),
          ...cssAttr('indent', 'margin-left'),
          ...cssAttr('textIndent', 'text-indent'),
          ...colorAttr('shading'),
        },
      },
    ];
  },
  addCommands() {
    return {
      setLineHeight: (value) => (props) => updateBlocks(props, () => ({ lineHeight: value })),
      setParagraphSpacing:
        ({ before, after }) =>
        (props) =>
          updateBlocks(props, () => ({
            ...(before !== undefined ? { spaceBefore: before === null ? null : `${before}pt` } : {}),
            ...(after !== undefined ? { spaceAfter: after === null ? null : `${after}pt` } : {}),
          })),
      shiftIndent: (direction) => (props) =>
        updateBlocks(props, (node) => {
          const next = Math.max(0, Math.min(INDENT_STEP * 12, ptNumber(node.attrs.indent) + direction * INDENT_STEP));
          return { indent: next ? `${next}pt` : null };
        }),
      setParagraphShading: (color) => (props) => updateBlocks(props, () => ({ shading: color })),
    };
  },
});

// ── tables ──────────────────────────────────────────────────────────────────

const SIDES = ['top', 'right', 'bottom', 'left'] as const;
type Side = (typeof SIDES)[number];

export const CellFormat = Extension.create({
  name: 'cellFormat',
  addGlobalAttributes() {
    return [
      {
        types: ['tableCell', 'tableHeader'],
        attributes: {
          ...colorAttr('background'),
          ...borderAttr('borderTop', 'top'),
          ...borderAttr('borderRight', 'right'),
          ...borderAttr('borderBottom', 'bottom'),
          ...borderAttr('borderLeft', 'left'),
          ...cssAttr('verticalAlign', 'vertical-align'),
          padding: {
            default: null as string | null,
            // read the longhands: browsers rewrite the shorthand when they serialise styles
            parseHTML: (el: HTMLElement) => {
              const st = el.style;
              const sides = [st.paddingTop, st.paddingRight, st.paddingBottom, st.paddingLeft];
              return sides.every(Boolean) ? sides.join(' ') : styleValue(el, 'padding');
            },
            renderHTML: (attrs: Record<string, unknown>) => (attrs.padding ? { style: `padding: ${attrs.padding}` } : {}),
          },
        },
      },
      {
        types: ['tableRow'],
        attributes: cssAttr('height', 'height'),
      },
    ];
  },
  addCommands() {
    return {
      setCellBackground: (color) => (props) => {
        const cells = cellGrid(props);
        if (!cells.length) return false;
        if (props.dispatch) {
          for (const c of cells) props.tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, background: color });
          props.dispatch(props.tr);
        }
        return true;
      },
      setCellVerticalAlign: (value) => (props) => {
        const cells = cellGrid(props);
        if (!cells.length) return false;
        if (props.dispatch) {
          for (const c of cells) props.tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, verticalAlign: value === 'top' ? null : value });
          props.dispatch(props.tr);
        }
        return true;
      },
      setCellBorders:
        (mode, border = DEFAULT_BORDER) =>
        (props) => {
          const cells = cellGrid(props);
          if (!cells.length) return false;
          if (!props.dispatch) return true;
          const minRow = Math.min(...cells.map((c) => c.top));
          const maxRow = Math.max(...cells.map((c) => c.bottom));
          const minCol = Math.min(...cells.map((c) => c.left));
          const maxCol = Math.max(...cells.map((c) => c.right));
          for (const c of cells) {
            const edge: Record<Side, boolean> = {
              top: c.top === minRow,
              bottom: c.bottom === maxRow,
              left: c.left === minCol,
              right: c.right === maxCol,
            };
            const next: Partial<Record<'borderTop' | 'borderRight' | 'borderBottom' | 'borderLeft', string | null>> = {};
            const key = (s: Side) => `border${s[0].toUpperCase()}${s.slice(1)}` as 'borderTop';
            for (const s of SIDES) {
              const outer = edge[s];
              let value: string | null | undefined;
              switch (mode) {
                case 'all':
                  value = border;
                  break;
                case 'none':
                  value = 'none';
                  break;
                case 'outside':
                  value = outer ? border : undefined;
                  break;
                case 'inside':
                  value = outer ? undefined : border;
                  break;
                default:
                  value = mode === s && outer ? border : undefined;
              }
              if (value !== undefined) next[key(s)] = value;
            }
            // a table this app created has no explicit borders; give the untouched sides the default look
            const base: Record<string, unknown> = {};
            for (const s of SIDES) if (!c.node.attrs[key(s)]) base[key(s)] = mode === 'none' ? 'none' : '1px solid #b9bcc7';
            props.tr.setNodeMarkup(c.pos, undefined, { ...c.node.attrs, ...base, ...next });
          }
          props.dispatch(props.tr);
          return true;
        },
    };
  },
});

/** Selected cells with their grid rectangle (rows / columns they cover). */
function cellGrid(props: CommandProps): { pos: number; node: PMNode; top: number; bottom: number; left: number; right: number }[] {
  const { state } = props;
  const sel = state.selection;
  let $cell = null as ReturnType<typeof state.doc.resolve> | null;
  const positions: number[] = [];
  if (sel instanceof CellSelection) {
    sel.forEachCell((_n, pos) => positions.push(pos));
    $cell = sel.$anchorCell;
  } else {
    const $from = sel.$from;
    for (let d = $from.depth; d > 0; d--) {
      const n = $from.node(d);
      if (n.type.name === 'tableCell' || n.type.name === 'tableHeader') {
        positions.push($from.before(d));
        $cell = state.doc.resolve($from.before(d));
        break;
      }
    }
  }
  if (!$cell || !positions.length) return [];
  // walk up to the table node
  let depth = $cell.depth;
  while (depth > 0 && $cell.node(depth).type.name !== 'table') depth--;
  const table = $cell.node(depth);
  const tableStart = $cell.start(depth);
  // build a simple grid map
  const where = new Map<number, { top: number; bottom: number; left: number; right: number }>();
  const taken: boolean[][] = [];
  table.forEach((row, rowOffset, r) => {
    let col = 0;
    row.forEach((cell, cellOffset) => {
      taken[r] ??= [];
      while (taken[r][col]) col++;
      const colspan = cell.attrs.colspan ?? 1;
      const rowspan = cell.attrs.rowspan ?? 1;
      for (let dr = 0; dr < rowspan; dr++) for (let dc = 0; dc < colspan; dc++) (taken[r + dr] ??= [])[col + dc] = true;
      where.set(tableStart + rowOffset + 1 + cellOffset, { top: r, bottom: r + rowspan - 1, left: col, right: col + colspan - 1 });
      col += colspan;
    });
  });
  return positions
    .map((pos) => ({ pos, node: state.doc.nodeAt(pos)!, ...(where.get(pos) ?? { top: 0, bottom: 0, left: 0, right: 0 }) }))
    .filter((c) => !!c.node);
}

// ── floating images (ink) ───────────────────────────────────────────────────

/**
 * An image that floats over the text, positioned from the top-left of the paragraph it is
 * anchored in (like a Word drawing with "In front of text" wrapping). Drawings made with the
 * Draw tools are floating images marked data-ink="true".
 */
export const FloatingImage = Node.create({
  name: 'floatingImage',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  draggable: false,

  addAttributes() {
    const num = (name: string) => ({
      default: 0,
      parseHTML: (el: HTMLElement) => {
        const n = parseFloat(el.getAttribute(name) ?? '');
        return Number.isFinite(n) ? n : 0;
      },
    });
    return {
      src: { default: '' },
      alt: { default: '' },
      width: num('width'),
      height: num('height'),
      x: num('data-float-x'),
      y: num('data-float-y'),
      ink: { default: false, parseHTML: (el: HTMLElement) => el.getAttribute('data-ink') === 'true' },
      behind: { default: false, parseHTML: (el: HTMLElement) => el.getAttribute('data-behind') === 'true' },
    };
  },

  parseHTML() {
    return [{ tag: 'img[data-float-x]', priority: 60 }];
  },

  renderHTML({ node }) {
    const a = node.attrs;
    return [
      'img',
      {
        src: a.src,
        alt: a.alt,
        width: Math.round(a.width),
        height: Math.round(a.height),
        'data-float-x': Math.round(a.x),
        'data-float-y': Math.round(a.y),
        ...(a.ink ? { 'data-ink': 'true' } : {}),
        ...(a.behind ? { 'data-behind': 'true' } : {}),
      },
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => new FloatingImageView(node, getPos as () => number | undefined, editor.view);
  },
});

class FloatingImageView implements NodeView {
  dom: HTMLImageElement;
  private node: PMNode;

  constructor(
    node: PMNode,
    private readonly getPos: () => number | undefined,
    private readonly view: EditorView,
  ) {
    this.node = node;
    const img = document.createElement('img');
    img.className = 'float-img';
    img.draggable = false;
    img.contentEditable = 'false';
    this.dom = img;
    this.apply();
    img.addEventListener('pointerdown', this.onPointerDown);
  }

  private apply(): void {
    const a = this.node.attrs;
    const img = this.dom;
    if (img.getAttribute('src') !== a.src) img.src = a.src;
    img.alt = a.alt ?? '';
    img.style.left = `${a.x}px`;
    img.style.top = `${a.y}px`;
    img.style.width = `${a.width}px`;
    img.style.height = `${a.height}px`;
    img.toggleAttribute('data-ink', !!a.ink);
    img.toggleAttribute('data-behind', !!a.behind);
  }

  /** Drag to move; a click selects the drawing (Delete removes it). */
  private onPointerDown = (e: PointerEvent): void => {
    if (e.button !== 0 || !this.view.editable) return;
    const pos = this.getPos();
    if (pos === undefined) return;
    e.preventDefault();
    e.stopPropagation();
    this.view.dispatch(this.view.state.tr.setSelection(NodeSelection.create(this.view.state.doc, pos)));
    this.view.focus();
    const img = this.dom;
    const scale = img.getBoundingClientRect().width / Math.max(1, this.node.attrs.width) || 1;
    const start = { x: e.clientX, y: e.clientY, left: this.node.attrs.x as number, top: this.node.attrs.y as number };
    let moved = false;
    img.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const dx = (ev.clientX - start.x) / scale;
      const dy = (ev.clientY - start.y) / scale;
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      img.style.left = `${start.left + dx}px`;
      img.style.top = `${start.top + dy}px`;
    };
    const up = (ev: PointerEvent) => {
      img.removeEventListener('pointermove', move);
      img.removeEventListener('pointerup', up);
      img.removeEventListener('pointercancel', up);
      if (!moved) return;
      const p = this.getPos();
      if (p === undefined) return;
      const x = Math.round(start.left + (ev.clientX - start.x) / scale);
      const y = Math.round(start.top + (ev.clientY - start.y) / scale);
      this.view.dispatch(this.view.state.tr.setNodeMarkup(p, undefined, { ...this.node.attrs, x, y }));
    };
    img.addEventListener('pointermove', move);
    img.addEventListener('pointerup', up);
    img.addEventListener('pointercancel', up);
  };

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.apply();
    return true;
  }

  selectNode(): void {
    this.dom.classList.add('ProseMirror-selectednode');
  }

  deselectNode(): void {
    this.dom.classList.remove('ProseMirror-selectednode');
  }

  stopEvent(e: Event): boolean {
    return e.type.startsWith('pointer') || e.type === 'mousedown' || e.type === 'dragstart';
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    this.dom.removeEventListener('pointerdown', this.onPointerDown);
  }
}

