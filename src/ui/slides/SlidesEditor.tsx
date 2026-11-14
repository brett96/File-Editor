/**
 * Presentation editor (PowerPoint-style): a slide list, a stage where text boxes, shapes,
 * pictures, tables and lines are selected, moved, resized, rotated and typed into, a ribbon
 * (Home, Insert, Design, Transitions, Slide Show), speaker notes and a full-screen slide show.
 * The deck model and file formats are in src/core/slides; drawing is core/slides/render.
 */
import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type PointerEvent as RPointerEvent, type ReactNode } from 'react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownToLine,
  ArrowUpToLine,
  Bold,
  ChevronDown,
  ChevronUp,
  CircleHelp,
  Copy,
  EyeOff,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  LayoutGrid,
  Search,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  MoveUpRight,
  Play,
  Plus,
  Redo2,
  Shapes,
  Strikethrough,
  Table as TableIcon,
  Trash2,
  Type,
  Underline,
  Undo2,
} from 'lucide-react';
import {
  LAYOUTS,
  PX_PER_PT,
  SHAPES,
  SHAPE_LABELS,
  THEMES,
  TRANSITIONS,
  cloneElement,
  cloneSlide,
  findInSlide,
  image,
  isEmptyText,
  layoutElements,
  line,
  newSlide,
  para,
  replaceInDeck,
  resizeDeck,
  shape,
  styleAll,
  table,
  textBox,
  textDefaults,
  uid,
  type Align,
  type Background,
  type Deck,
  type LayoutId,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableElement,
  type TextRun,
  type Theme,
  type TransitionType,
} from '../../core/slides/model';
import { backgroundCss, cellTextStyle, elementInner, shapePath, shapeTextStyle, slideHtml, paragraphsHtml, type TextStyle } from '../../core/slides/render';
import { Modal, Popover, PromptModal, cx } from '../components';
import { openGuide } from '../help/open';
import { useTabActive } from '../tab-active';
import { readPicture } from './export';
import { SlideShow } from './SlideShow';
import { applyFontSize, caretParagraph, placeCaret, readEditable, selectAllText, selectedBlocks } from './text-edit';
import './slides.css';

export interface SlidesHandle {
  getDeck(): Deck;
  startShow(fromStart?: boolean): void;
}

interface Props {
  initial: Deck;
  onChange: () => void;
  onError: (message: string) => void;
}

type Tab = 'home' | 'insert' | 'design' | 'transitions' | 'show';
type Editing = { id: string; cell?: [number, number] } | null;

const FONTS: [string, string][] = [
  ['', 'Theme font'],
  ['Calibri, "Segoe UI", Arial, sans-serif', 'Calibri'],
  ['Arial, Helvetica, sans-serif', 'Arial'],
  ['"Segoe UI", Arial, sans-serif', 'Segoe UI'],
  ['"Times New Roman", Times, serif', 'Times New Roman'],
  ['Georgia, serif', 'Georgia'],
  ['Verdana, Geneva, sans-serif', 'Verdana'],
  ['"Trebuchet MS", sans-serif', 'Trebuchet MS'],
  ['"Courier New", monospace', 'Courier New'],
  ['Impact, "Arial Black", sans-serif', 'Impact'],
  ['"Comic Sans MS", cursive', 'Comic Sans MS'],
];
const SIZES = [8, 10, 12, 14, 16, 18, 20, 24, 28, 32, 36, 40, 44, 48, 54, 60, 72, 96];
const SLIDE_SIZES: [string, number, number][] = [
  ['Widescreen (16:9)', 1280, 720],
  ['Standard (4:3)', 960, 720],
  ['Widescreen (16:10)', 1152, 720],
  ['A4 landscape', 1123, 794],
  ['Portrait (9:16)', 720, 1280],
];

let clipboard: SlideElement[] = [];

const ElementView = memo(function ElementView({ el, deck, hideText, onDown, onDouble }: { el: SlideElement; deck: Deck; hideText: Editing; onDown: (e: RPointerEvent, el: SlideElement) => void; onDouble: (e: React.MouseEvent, el: SlideElement) => void }) {
  // while its text is being typed, the element is drawn without that text (the editable sits on top)
  const html = useMemo(() => {
    let shown = el;
    if (hideText && hideText.id === el.id) {
      if (el.kind === 'shape') shown = { ...el, text: [], placeholder: undefined };
      else if (el.kind === 'table' && hideText.cell) {
        const [r, c] = hideText.cell;
        shown = { ...el, cells: el.cells.map((row, ri) => row.map((cell, ci) => (cell && ri === r && ci === c ? { ...cell, text: [para('')] } : cell))) };
      }
    }
    return elementInner(shown, deck, true);
  }, [el, deck, hideText]);
  return (
    <div
      className={cx('sl-el', el.locked && 'is-locked')}
      data-id={el.id}
      style={{ left: el.x, top: el.y, width: el.w, height: el.h, transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined, opacity: el.kind === 'shape' && el.opacity !== undefined ? el.opacity : undefined }}
      onPointerDown={(e) => onDown(e, el)}
      onDoubleClick={(e) => onDouble(e, el)}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
});

const Thumb = memo(function Thumb({ deck, slide, width }: { deck: Deck; slide: Slide; width: number }) {
  const k = width / deck.width;
  const html = useMemo(() => slideHtml(deck, slide), [deck.theme, deck.width, deck.height, slide]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="sl-thumb-frame" style={{ width, height: deck.height * k }}>
      <div className="sl-thumb-inner" style={{ width: deck.width, height: deck.height, transform: `scale(${k})` }} dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
});

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sl-group">
      <div className="sl-group-body">{children}</div>
      <div className="sl-group-label">{label}</div>
    </div>
  );
}

/** A colour button: theme colours, standard colours, a custom colour and (optionally) "none". */
function Swatch({ label, value, theme, onPick, allowNone }: { label: string; value: string | null | undefined; theme: Theme; onPick: (c: string | null) => void; allowNone?: boolean }) {
  const colors = [theme.background, theme.text, theme.heading, ...theme.accents, '#ffffff', '#000000', '#7f7f7f', '#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0', '#f2f2f2', '#d9d9d9'];
  return (
    <Popover
      label={label}
      button={
        <span className="sl-swatch" title={label}>
          <span className="sl-swatch-chip"><i style={{ background: value ?? 'transparent' }} /></span>
          <span>{label}</span>
        </span>
      }
    >
      {(close) => (
        <div className="sl-palette" onMouseDown={(e) => (e.target as HTMLElement).tagName !== 'INPUT' && e.preventDefault()}>
          <div className="sl-palette-grid">
            {[...new Set(colors.map((c) => c.toLowerCase()))].map((c) => (
              <button key={c} type="button" aria-label={c} title={c} style={{ background: c }} onClick={() => { onPick(c); close(); }} />
            ))}
          </div>
          <div className="sl-palette-row">
            <label>Custom <input type="color" value={value && /^#[0-9a-f]{6}$/i.test(value) ? value : '#000000'} onChange={(e) => onPick(e.target.value)} /></label>
            {allowNone && <button type="button" className="btn btn-text" onClick={() => { onPick(null); close(); }}>None</button>}
          </div>
        </div>
      )}
    </Popover>
  );
}

export const SlidesEditor = forwardRef<SlidesHandle, Props>(function SlidesEditor({ initial, onChange, onError }, ref) {
  // ── deck + history ──────────────────────────────────────────────────────
  const [hist, setHist] = useState<{ past: Deck[]; present: Deck; future: Deck[] }>({ past: [], present: initial, future: [] });
  const deck = hist.present;
  const deckRef = useRef(deck);
  deckRef.current = deck;
  const lastCommit = useRef<{ key: string | null; at: number }>({ key: null, at: 0 });
  const commit = useCallback(
    (next: Deck, coalesce?: string) => {
      const now = Date.now();
      const merge = !!coalesce && lastCommit.current.key === coalesce && now - lastCommit.current.at < 900;
      lastCommit.current = { key: coalesce ?? null, at: now };
      deckRef.current = next;
      setHist((h) => (merge ? { ...h, present: next } : { past: [...h.past, h.present].slice(-100), present: next, future: [] }));
      onChange();
    },
    [onChange],
  );
  const dragSnap = useRef<Deck | null>(null);
  const preview = (next: Deck) => {
    deckRef.current = next;
    setHist((h) => ({ ...h, present: next }));
  };
  const endDrag = () => {
    const snap = dragSnap.current;
    dragSnap.current = null;
    if (!snap || snap === deckRef.current) return;
    lastCommit.current = { key: null, at: 0 };
    setHist((h) => ({ past: [...h.past, snap].slice(-100), present: h.present, future: [] }));
    onChange();
  };

  const [index, setIndex] = useState(0);
  const [selected, setSelected] = useState<string[]>([]);
  const [editing, setEditing] = useState<Editing>(null);
  const [seed, setSeed] = useState(0);
  const [tab, setTab] = useState<Tab>('home');
  const [show, setShow] = useState<number | null>(null);
  const [guides, setGuides] = useState<{ x?: number; y?: number }[]>([]);
  const [marquee, setMarquee] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [dropAt, setDropAt] = useState<number | null>(null);
  const [sorter, setSorter] = useState(false);
  const [linkOpen, setLinkOpen] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [find, setFind] = useState({ text: '', replace: '', matchCase: false, note: '' });
  const slideIndex = Math.min(index, deck.slides.length - 1);
  const slide = deck.slides[slideIndex];
  const indexRef = useRef(slideIndex);
  indexRef.current = slideIndex;
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const editingRef = useRef(editing);
  editingRef.current = editing;
  const editable = useRef<HTMLDivElement>(null);
  const savedRange = useRef<Range | null>(null);

  const curSlide = () => deckRef.current.slides[Math.min(indexRef.current, deckRef.current.slides.length - 1)];
  const withSlide = (d: Deck, s: Slide): Deck => ({ ...d, slides: d.slides.map((x) => (x.id === s.id ? s : x)) });
  const setElements = (fn: (els: SlideElement[]) => SlideElement[], coalesce?: string) => {
    const s = curSlide();
    commit(withSlide(deckRef.current, { ...s, elements: fn(s.elements) }), coalesce);
  };
  const patchSelected = (fn: (el: SlideElement) => SlideElement, coalesce?: string) => {
    const ids = new Set(selectedRef.current);
    setElements((els) => els.map((e) => (ids.has(e.id) ? fn(e) : e)), coalesce);
  };
  const selEls = slide.elements.filter((e) => selected.includes(e.id));
  const one = selEls.length === 1 ? selEls[0] : null;

  // ── text editing ────────────────────────────────────────────────────────
  /** The text style the element (or table cell) being edited starts from. */
  const editStyle = (ed: Editing, d = deckRef.current): TextStyle | null => {
    const el = ed && curSlide().elements.find((e) => e.id === ed.id);
    if (!el) return null;
    if (el.kind === 'shape') return shapeTextStyle(el, d);
    if (el.kind === 'table' && ed!.cell) return cellTextStyle(d, el, ed!.cell[0]);
    return null;
  };
  /** Writes what is in the editable back into the deck. */
  const syncText = (coalesce = true): void => {
    const ed = editingRef.current;
    const root = editable.current;
    const style = editStyle(ed);
    if (!ed || !root || !style) return;
    const text = readEditable(root, style);
    const s = curSlide();
    const el = s.elements.find((e) => e.id === ed.id);
    if (!el) return;
    let next: SlideElement | null = null;
    if (el.kind === 'shape') {
      if (JSON.stringify(el.text) === JSON.stringify(text)) return;
      next = { ...el, text };
    } else if (el.kind === 'table' && ed.cell) {
      const [r, c] = ed.cell;
      if (JSON.stringify(el.cells[r]?.[c]?.text) === JSON.stringify(text)) return;
      next = { ...el, cells: el.cells.map((row, ri) => row.map((cell, ci) => (cell && ri === r && ci === c ? { ...cell, text } : cell))) };
    }
    if (next) commit(withSlide(deckRef.current, { ...s, elements: s.elements.map((e) => (e.id === ed.id ? next! : e)) }), coalesce ? `text:${ed.id}` : undefined);
  };
  const endEdit = () => {
    if (!editingRef.current) return;
    syncText();
    // a text box left empty is removed, as in PowerPoint
    const ed = editingRef.current;
    const el = curSlide().elements.find((e) => e.id === ed.id);
    if (el?.kind === 'shape' && !el.placeholder && !el.fill && !el.line && isEmptyText(el.text)) {
      setElements((els) => els.filter((e) => e.id !== el.id));
      setSelected([]);
    }
    setEditing(null);
    editingRef.current = null;
    savedRange.current = null;
  };
  const beginEdit = (id: string, cell?: [number, number]) => {
    if (editingRef.current) endEdit();
    setSelected([id]);
    setEditing({ id, cell });
    setSeed((n) => n + 1);
  };
  const pendingChar = useRef<string | null>(null);
  const pendingCaret = useRef<number | 'all' | null>('all');
  // (re)fill the editable when editing starts or its text was restyled as a whole
  useLayoutEffect(() => {
    const root = editable.current;
    const style = editStyle(editing);
    const el = editing && slide.elements.find((e) => e.id === editing.id);
    if (!root || !style || !el) return;
    const text = el.kind === 'shape' ? el.text : el.kind === 'table' && editing!.cell ? el.cells[editing!.cell[0]]?.[editing!.cell[1]]?.text ?? [para('')] : [para('')];
    root.innerHTML = paragraphsHtml(text.length ? text : [para('')], style);
    root.focus();
    if (pendingChar.current !== null) {
      placeCaret(root);
      document.execCommand('insertText', false, pendingChar.current);
      pendingChar.current = null;
    } else if (pendingCaret.current === 'all' && !isEmptyText(text)) selectAllText(root);
    else placeCaret(root, typeof pendingCaret.current === 'number' ? pendingCaret.current : -1);
    pendingCaret.current = 'all';
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seed, editing?.id, editing?.cell?.[0], editing?.cell?.[1]]);

  useEffect(() => {
    const onSel = () => {
      const sel = window.getSelection();
      if (sel?.rangeCount && editable.current?.contains(sel.anchorNode)) savedRange.current = sel.getRangeAt(0).cloneRange();
    };
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, []);
  /** Puts the caret / selection back in the text after a ribbon control took the focus. */
  const restoreRange = () => {
    const root = editable.current;
    if (!root) return false;
    root.focus();
    if (savedRange.current) {
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(savedRange.current);
    }
    return true;
  };

  // ── formatting (selected text while typing, else the whole of the selected elements) ──
  const eachText = (el: SlideElement, fn: (ps: Paragraph[]) => Paragraph[]): SlideElement => {
    if (el.kind === 'shape') return { ...el, text: fn(el.text) };
    if (el.kind === 'table') return { ...el, cells: el.cells.map((row) => row.map((c) => (c ? { ...c, text: fn(c.text) } : c))) };
    return el;
  };
  const firstRun = (): { run: TextRun | null; para: Paragraph | null; style: TextStyle | null } => {
    const el = one;
    if (!el) return { run: null, para: null, style: null };
    if (el.kind === 'shape') return { run: el.text[0]?.runs[0] ?? null, para: el.text[0] ?? null, style: shapeTextStyle(el, deck) };
    if (el.kind === 'table') {
      const [r, c] = editing?.cell ?? [0, 0];
      const cell = el.cells[r]?.[c];
      return { run: cell?.text[0]?.runs[0] ?? null, para: cell?.text[0] ?? null, style: cellTextStyle(deck, el, r) };
    }
    return { run: null, para: null, style: null };
  };
  const cur = firstRun();

  const runFormat = (patch: Partial<Omit<TextRun, 'text'>>, command?: [string, string?]) => {
    if (editingRef.current && editable.current && restoreRange()) {
      const sel = window.getSelection();
      // nothing selected: the whole text box is formatted, as in PowerPoint
      if (sel?.isCollapsed) selectAllText(editable.current);
      document.execCommand('styleWithCSS', false, 'true');
      if (patch.size) applyFontSize(editable.current, patch.size);
      else if (command) document.execCommand(command[0], false, command[1]);
      syncText(false);
      return;
    }
    patchSelected((el) => eachText(el, (ps) => styleAll(ps, patch)));
  };
  const toggle = (key: 'bold' | 'italic' | 'underline' | 'strike', command: string) => {
    const on = !!(cur.run && (cur.run[key] ?? (key === 'bold' ? cur.style?.bold : false)));
    runFormat({ [key]: !on }, [command]);
  };
  const paraFormat = (patch: (p: { bullet: string; level: number; align: string }) => Partial<{ bullet: string; level: number; align: string; ls: string }>) => {
    if (editingRef.current && editable.current && restoreRange()) {
      const root = editable.current;
      const at = caretParagraph(root);
      for (const b of selectedBlocks(root)) {
        const next = patch({ bullet: b.dataset.bullet ?? 'none', level: Number(b.dataset.level ?? 0), align: b.dataset.align ?? 'left' });
        if (next.bullet !== undefined) b.dataset.bullet = next.bullet;
        if (next.level !== undefined) b.dataset.level = String(Math.min(8, Math.max(0, next.level)));
        if (next.align !== undefined) b.dataset.align = next.align;
        if (next.ls !== undefined) b.dataset.ls = next.ls;
        if (next.align !== undefined) b.style.textAlign = next.align;
      }
      syncText(false);
      // bullets and indents are drawn from the model: draw the text again and put the caret back
      pendingCaret.current = at;
      setSeed((n) => n + 1);
      return;
    }
    patchSelected((el) => {
      const d = el.kind === 'shape' ? textDefaults(el, deckRef.current).bullets : false;
      return eachText(el, (ps) =>
        ps.map((p) => {
          const next = patch({ bullet: p.bullet ?? (d ? 'bullet' : 'none'), level: p.level ?? 0, align: p.align ?? 'left' });
          const out: Paragraph = { ...p };
          if (next.bullet !== undefined) out.bullet = next.bullet as Paragraph['bullet'];
          if (next.level !== undefined) out.level = Math.min(8, Math.max(0, next.level));
          if (next.align !== undefined) out.align = next.align as Align;
          if (next.ls !== undefined) out.lineSpacing = Number(next.ls);
          return out;
        }),
      );
    });
  };
  /** Asks for the address (the text selection is kept and put back when the answer comes). */
  const addLink = () => setLinkOpen(cur.run?.link ?? 'https://');
  const applyLink = (url: string) => {
    setLinkOpen(null);
    const clean = url === 'https://' ? '' : url.trim();
    if (clean && !/^(https?:|mailto:)/i.test(clean)) return onError('Links must start with https://, http:// or mailto:.');
    if (editingRef.current && editable.current && restoreRange()) {
      const sel = window.getSelection();
      if (sel?.isCollapsed) selectAllText(editable.current);
      document.execCommand('styleWithCSS', false, 'true');
      // mark the range, then turn the marks into link spans
      document.execCommand('hiliteColor', false, '#fffffe');
      editable.current.querySelectorAll<HTMLElement>('span, font').forEach((s) => {
        if (!/255,\s*255,\s*254|#fffffe/i.test(s.style.backgroundColor)) return;
        s.style.backgroundColor = '';
        if (clean) s.dataset.link = clean;
        else delete s.dataset.link;
      });
      if (!clean) editable.current.querySelectorAll<HTMLElement>('[data-link]').forEach((s) => sel && sel.containsNode(s, true) && delete s.dataset.link);
      syncText(false);
      pendingCaret.current = caretParagraph(editable.current);
      setSeed((n) => n + 1);
      return;
    }
    patchSelected((el) => eachText(el, (ps) => ps.map((p) => ({ ...p, runs: p.runs.map((r) => ({ ...r, link: clean || undefined })) }))));
  };

  // ── slides ──────────────────────────────────────────────────────────────
  const goto = (i: number) => {
    endEdit();
    setSelected([]);
    setIndex(Math.max(0, Math.min(deckRef.current.slides.length - 1, i)));
  };
  const addSlide = (layout: LayoutId = 'titleContent') => {
    endEdit();
    const d = deckRef.current;
    const at = Math.min(indexRef.current, d.slides.length - 1) + 1;
    const s = newSlide(d, layout);
    commit({ ...d, slides: [...d.slides.slice(0, at), s, ...d.slides.slice(at)] });
    setIndex(at);
    setSelected([]);
  };
  const duplicateSlide = () => {
    endEdit();
    const d = deckRef.current;
    const i = Math.min(indexRef.current, d.slides.length - 1);
    commit({ ...d, slides: [...d.slides.slice(0, i + 1), cloneSlide(d.slides[i]), ...d.slides.slice(i + 1)] });
    setIndex(i + 1);
  };
  const deleteSlide = () => {
    endEdit();
    const d = deckRef.current;
    const i = Math.min(indexRef.current, d.slides.length - 1);
    const slides = d.slides.filter((_, k) => k !== i);
    commit({ ...d, slides: slides.length ? slides : [newSlide(d, 'title')] });
    setIndex(Math.max(0, Math.min(i, slides.length - 1)));
    setSelected([]);
  };
  const moveSlide = (from: number, to: number) => {
    const d = deckRef.current;
    if (from === to || from < 0 || to < 0 || from >= d.slides.length) return;
    const slides = [...d.slides];
    const [s] = slides.splice(from, 1);
    slides.splice(Math.min(slides.length, to), 0, s);
    commit({ ...d, slides });
    setIndex(slides.indexOf(s));
  };
  const patchSlide = (patch: Partial<Slide>, coalesce?: string) => commit(withSlide(deckRef.current, { ...curSlide(), ...patch }), coalesce);
  const applyLayout = (layout: LayoutId) => {
    endEdit();
    const s = curSlide();
    const fresh = layoutElements(deckRef.current, layout);
    // text already typed into placeholders moves into the new layout's placeholders of the same kind
    const old = s.elements.filter((e): e is ShapeElement => e.kind === 'shape' && !!e.placeholder && !isEmptyText(e.text));
    const titleLike = (p?: string) => p === 'title' || p === 'ctrTitle';
    const used = new Set<string>();
    const placed = fresh.map((ph) => {
      const src = old.find((o) => !used.has(o.id) && (o.placeholder === ph.placeholder || (titleLike(o.placeholder) && titleLike(ph.placeholder)) || (!titleLike(o.placeholder) && !titleLike(ph.placeholder))));
      if (!src) return ph;
      used.add(src.id);
      return { ...ph, text: src.text };
    });
    const left = old.filter((o) => !used.has(o.id)).map((o) => ({ ...o, placeholder: undefined }));
    patchSlide({ elements: [...s.elements.filter((e) => !(e.kind === 'shape' && e.placeholder)), ...placed, ...left] });
    setSelected([]);
  };

  // ── elements ────────────────────────────────────────────────────────────
  const addElement = (el: SlideElement, edit = false) => {
    endEdit();
    setElements((els) => [...els, el]);
    setSelected([el.id]);
    if (edit) {
      pendingCaret.current = 'all';
      setEditing({ id: el.id });
      setSeed((n) => n + 1);
    }
  };
  const centre = (w: number, h: number) => ({ x: Math.round((deckRef.current.width - w) / 2), y: Math.round((deckRef.current.height - h) / 2) });
  const addShape = (kind: string) => {
    const { x, y } = centre(220, 150);
    addElement(shape(kind, x, y, 220, 150, deckRef.current.theme.accents[0]));
  };
  const addTextBox = () => {
    const { x, y } = centre(420, 60);
    addElement(textBox(x, y, 420, 60), true);
  };
  const addLine = (arrow: boolean) => {
    const { x, y } = centre(260, 0);
    addElement(line(x, y, 260, 0, deckRef.current.theme.text, arrow));
  };
  const addTable = (rows: number, cols: number) => {
    const w = Math.min(deckRef.current.width * 0.7, cols * 180);
    const h = rows * 44;
    const { x, y } = centre(w, h);
    addElement(table(x, y, w, h, rows, cols));
  };
  const fileInput = useRef<HTMLInputElement>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const addPicture = async (file: Blob | undefined) => {
    if (!file) return;
    try {
      const pic = await readPicture(file);
      const d = deckRef.current;
      const k = Math.min(1, (d.width * 0.6) / pic.width, (d.height * 0.6) / pic.height);
      const w = Math.round(pic.width * k);
      const h = Math.round(pic.height * k);
      addElement(image(pic.src, Math.round((d.width - w) / 2), Math.round((d.height - h) / 2), w, h));
    } catch (err) {
      onError(err instanceof Error ? err.message : String(err));
    }
  };
  const removeSelected = () => {
    const ids = new Set(selectedRef.current);
    if (!ids.size) return;
    setElements((els) => els.filter((e) => !ids.has(e.id)));
    setSelected([]);
  };
  const copySelected = () => {
    const ids = new Set(selectedRef.current);
    clipboard = curSlide().elements.filter((e) => ids.has(e.id)).map((e) => structuredClone(e));
  };
  const pasteClipboard = (offset = 20) => {
    if (!clipboard.length) return;
    endEdit();
    const copies = clipboard.map((e) => ({ ...cloneElement(e, offset, offset), locked: undefined }));
    clipboard = copies.map((e) => structuredClone(e));
    setElements((els) => [...els, ...copies]);
    setSelected(copies.map((e) => e.id));
  };
  const reorder = (how: 'front' | 'back' | 'up' | 'down') => {
    const ids = new Set(selectedRef.current);
    setElements((els) => {
      const picked = els.filter((e) => ids.has(e.id));
      const rest = els.filter((e) => !ids.has(e.id));
      if (how === 'front') return [...rest, ...picked];
      if (how === 'back') return [...picked, ...rest];
      const out = [...els];
      const order = how === 'up' ? [...out.keys()].reverse() : [...out.keys()];
      for (const i of order) {
        const j = how === 'up' ? i + 1 : i - 1;
        if (ids.has(out[i].id) && out[j] && !ids.has(out[j].id)) [out[i], out[j]] = [out[j], out[i]];
      }
      return out;
    });
  };
  const alignEls = (how: 'left' | 'center' | 'right' | 'top' | 'middle' | 'bottom' | 'hdist' | 'vdist') => {
    const d = deckRef.current;
    const ids = new Set(selectedRef.current);
    const picked = curSlide().elements.filter((e) => ids.has(e.id));
    if (!picked.length) return;
    // one element is aligned to the slide, several to each other
    const box = picked.length === 1 ? { x0: 0, y0: 0, x1: d.width, y1: d.height } : { x0: Math.min(...picked.map((e) => e.x)), y0: Math.min(...picked.map((e) => e.y)), x1: Math.max(...picked.map((e) => e.x + e.w)), y1: Math.max(...picked.map((e) => e.y + e.h)) };
    const pos = new Map<string, { x?: number; y?: number }>();
    if (how === 'hdist' || how === 'vdist') {
      if (picked.length < 3) return;
      const h = how === 'hdist';
      const sorted = [...picked].sort((a, b) => (h ? a.x - b.x : a.y - b.y));
      const total = sorted.reduce((s, e) => s + (h ? e.w : e.h), 0);
      const gap = ((h ? box.x1 - box.x0 : box.y1 - box.y0) - total) / (sorted.length - 1);
      let at = h ? box.x0 : box.y0;
      for (const e of sorted) {
        pos.set(e.id, h ? { x: at } : { y: at });
        at += (h ? e.w : e.h) + gap;
      }
    } else {
      for (const e of picked) {
        pos.set(e.id, how === 'left' ? { x: box.x0 } : how === 'right' ? { x: box.x1 - e.w } : how === 'center' ? { x: (box.x0 + box.x1 - e.w) / 2 } : how === 'top' ? { y: box.y0 } : how === 'bottom' ? { y: box.y1 - e.h } : { y: (box.y0 + box.y1 - e.h) / 2 });
      }
    }
    setElements((els) => els.map((e) => (pos.has(e.id) ? { ...e, ...pos.get(e.id) } : e)));
  };

  // ── tables ──────────────────────────────────────────────────────────────
  const tableOp = (op: 'rowAdd' | 'colAdd' | 'rowDel' | 'colDel') => {
    const t = one?.kind === 'table' ? one : null;
    if (!t) return;
    const [r, c] = editingRef.current?.cell ?? [t.rows.length - 1, t.cols.length - 1];
    endEdit();
    const blank = () => ({ text: [para('')] });
    let next: TableElement = t;
    if (op === 'rowAdd') {
      const hgt = t.rows[r] ?? 40;
      next = { ...t, rows: [...t.rows.slice(0, r + 1), hgt, ...t.rows.slice(r + 1)], cells: [...t.cells.slice(0, r + 1), t.cols.map(blank), ...t.cells.slice(r + 1)], h: t.h + hgt };
    } else if (op === 'colAdd') {
      const wid = t.cols[c] ?? 120;
      const k = t.w / (t.w + wid);
      // the table keeps its width: every column gives up a little
      next = { ...t, cols: [...t.cols.slice(0, c + 1), wid, ...t.cols.slice(c + 1)].map((v) => v * k), cells: t.cells.map((row) => [...row.slice(0, c + 1), blank(), ...row.slice(c + 1)]) };
    } else if (op === 'rowDel' && t.rows.length > 1) {
      next = { ...t, rows: t.rows.filter((_, i) => i !== r), cells: t.cells.filter((_, i) => i !== r), h: t.h - t.rows[r] };
    } else if (op === 'colDel' && t.cols.length > 1) {
      const k = t.w / (t.w - t.cols[c]);
      next = { ...t, cols: t.cols.filter((_, i) => i !== c).map((v) => v * k), cells: t.cells.map((row) => row.filter((_, i) => i !== c)) };
    }
    // merged cells cannot survive a change of grid: they are split
    next = { ...next, cells: next.cells.map((row) => row.map((cell) => (cell ? { ...cell, colSpan: undefined, rowSpan: undefined } : blank()))) };
    setElements((els) => els.map((e) => (e.id === t.id ? next : e)));
  };

  // ── find and replace ────────────────────────────────────────────────────
  const findNext = () => {
    const d = deckRef.current;
    if (!find.text) return;
    endEdit();
    // from the slide after this one (or later on this slide), wrapping round
    for (let step = 0; step <= d.slides.length; step++) {
      const i = (indexRef.current + step) % d.slides.length;
      const hits = findInSlide(d.slides[i], find.text, find.matchCase);
      const after = step === 0 ? hits.slice(hits.indexOf(selectedRef.current[0]) + 1) : hits;
      if (after.length) {
        setIndex(i);
        setSelected([after[0]]);
        setFind((f) => ({ ...f, note: `Found on slide ${i + 1}` }));
        return;
      }
    }
    setFind((f) => ({ ...f, note: `“${find.text}” was not found.` }));
  };
  const replaceAll = () => {
    endEdit();
    const res = replaceInDeck(deckRef.current, find.text, find.replace, find.matchCase);
    if (res.count) commit(res.deck);
    setFind((f) => ({ ...f, note: res.count ? `Replaced ${res.count} ${res.count === 1 ? 'occurrence' : 'occurrences'}.` : `“${find.text}” was not found.` }));
  };

  // ── stage geometry ──────────────────────────────────────────────────────
  const wrap = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 800, h: 500 });
  const [zoom, setZoom] = useState(1);
  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setBox({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const fit = Math.max(0.05, Math.min((box.w - 40) / deck.width, (box.h - 40) / deck.height));
  const scale = fit * zoom;
  const stageLeft = Math.max(10, (box.w - deck.width * scale) / 2);
  const stageTop = Math.max(10, (box.h - deck.height * scale) / 2);
  const scaleRef = useRef(scale);
  scaleRef.current = scale;
  const stage = useRef<HTMLDivElement>(null);
  const point = (e: { clientX: number; clientY: number }) => {
    const r = stage.current!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / scaleRef.current, y: (e.clientY - r.top) / scaleRef.current };
  };

  // ── pointer: move, resize, rotate, marquee ──────────────────────────────
  type Drag =
    | { kind: 'move'; x0: number; y0: number; orig: Map<string, { x: number; y: number }>; moved: boolean }
    | { kind: 'resize'; id: string; hx: number; hy: number; orig: SlideElement; x0: number; y0: number }
    | { kind: 'rotate'; id: string; cx: number; cy: number }
    | { kind: 'marquee'; x0: number; y0: number };
  const drag = useRef<Drag | null>(null);

  const onElementDown = (e: RPointerEvent, el: SlideElement) => {
    if (e.button !== 0) return;
    if (editingRef.current?.id === el.id) return; // typing: clicks place the caret
    e.stopPropagation();
    endEdit();
    let ids = selectedRef.current;
    if (e.shiftKey || e.ctrlKey || e.metaKey) ids = ids.includes(el.id) ? ids.filter((i) => i !== el.id) : [...ids, el.id];
    else if (!ids.includes(el.id)) ids = [el.id];
    setSelected(ids);
    selectedRef.current = ids;
    if (!ids.includes(el.id)) return;
    const p = point(e);
    const set = new Set(ids);
    drag.current = { kind: 'move', x0: p.x, y0: p.y, orig: new Map(curSlide().elements.filter((x) => set.has(x.id)).map((x) => [x.id, { x: x.x, y: x.y }])), moved: false };
    dragSnap.current = deckRef.current;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const cellAt = (t: TableElement, e: { clientX: number; clientY: number }): [number, number] => {
    const p = point(e);
    let c = 0;
    let r = 0;
    for (let acc = t.x; c < t.cols.length - 1 && p.x > acc + t.cols[c]; acc += t.cols[c], c++);
    for (let acc = t.y; r < t.rows.length - 1 && p.y > acc + t.rows[r]; acc += t.rows[r], r++);
    // inside a merged cell: the cell that owns it
    while (c > 0 && !t.cells[r]?.[c]) c--;
    while (r > 0 && !t.cells[r]?.[c]) r--;
    return [r, c];
  };
  const onElementDouble = (e: React.MouseEvent, el: SlideElement) => {
    if (el.locked) return;
    if (el.kind === 'shape') {
      pendingCaret.current = 'all';
      beginEdit(el.id);
    } else if (el.kind === 'table') {
      pendingCaret.current = 'all';
      beginEdit(el.id, cellAt(el, e));
    }
  };
  const onStageDown = (e: RPointerEvent) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('.sl-edit')) return;
    endEdit();
    if (!e.shiftKey) setSelected([]);
    const p = point(e);
    drag.current = { kind: 'marquee', x0: p.x, y0: p.y };
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onHandleDown = (e: RPointerEvent, el: SlideElement, hx: number, hy: number) => {
    e.stopPropagation();
    endEdit();
    const p = point(e);
    drag.current = { kind: 'resize', id: el.id, hx, hy, orig: el, x0: p.x, y0: p.y };
    dragSnap.current = deckRef.current;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onRotateDown = (e: RPointerEvent, el: SlideElement) => {
    e.stopPropagation();
    endEdit();
    drag.current = { kind: 'rotate', id: el.id, cx: el.x + el.w / 2, cy: el.y + el.h / 2 };
    dragSnap.current = deckRef.current;
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
  };
  const onMove = (e: RPointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dk = deckRef.current;
    const s = curSlide();
    if (d.kind === 'marquee') {
      setMarquee({ x: Math.min(d.x0, p.x), y: Math.min(d.y0, p.y), w: Math.abs(p.x - d.x0), h: Math.abs(p.y - d.y0) });
      return;
    }
    if (d.kind === 'move') {
      let dx = p.x - d.x0;
      let dy = p.y - d.y0;
      if (!d.moved && Math.hypot(dx, dy) * scaleRef.current < 3) return;
      d.moved = true;
      if (e.shiftKey) Math.abs(dx) > Math.abs(dy) ? (dy = 0) : (dx = 0);
      const moving = s.elements.filter((x) => d.orig.has(x.id));
      const g: { x?: number; y?: number }[] = [];
      if (!e.altKey && moving.length) {
        // snap the moving group's edges and centre to the slide and to the other elements
        const b = { x0: Math.min(...moving.map((x) => d.orig.get(x.id)!.x)) + dx, y0: Math.min(...moving.map((x) => d.orig.get(x.id)!.y)) + dy, x1: Math.max(...moving.map((x) => d.orig.get(x.id)!.x + x.w)) + dx, y1: Math.max(...moving.map((x) => d.orig.get(x.id)!.y + x.h)) + dy };
        const others = s.elements.filter((x) => !d.orig.has(x.id) && !x.locked);
        const xs = [0, dk.width / 2, dk.width, ...others.flatMap((o) => [o.x, o.x + o.w / 2, o.x + o.w])];
        const ys = [0, dk.height / 2, dk.height, ...others.flatMap((o) => [o.y, o.y + o.h / 2, o.y + o.h])];
        const thr = 6 / scaleRef.current;
        const snapTo = (mine: number[], lines: number[]) => {
          let best: { off: number; at: number } | null = null;
          for (const m of mine) for (const l of lines) if (Math.abs(l - m) < thr && (!best || Math.abs(l - m) < Math.abs(best.off))) best = { off: l - m, at: l };
          return best;
        };
        const sx = snapTo([b.x0, (b.x0 + b.x1) / 2, b.x1], xs);
        const sy = snapTo([b.y0, (b.y0 + b.y1) / 2, b.y1], ys);
        if (sx) {
          dx += sx.off;
          g.push({ x: sx.at });
        }
        if (sy) {
          dy += sy.off;
          g.push({ y: sy.at });
        }
      }
      setGuides(g);
      preview(withSlide(dk, { ...s, elements: s.elements.map((x) => (d.orig.has(x.id) ? { ...x, x: Math.round(d.orig.get(x.id)!.x + dx), y: Math.round(d.orig.get(x.id)!.y + dy) } : x)) }));
      return;
    }
    if (d.kind === 'rotate') {
      let deg = (Math.atan2(p.y - d.cy, p.x - d.cx) * 180) / Math.PI + 90;
      deg = e.shiftKey ? Math.round(deg / 15) * 15 : Math.abs(deg % 90) < 3 ? Math.round(deg / 90) * 90 : Math.round(deg);
      preview(withSlide(dk, { ...s, elements: s.elements.map((x) => (x.id === d.id ? { ...x, rotation: ((deg % 360) + 360) % 360 } : x)) }));
      return;
    }
    // resize: work in the element's own (unrotated) axes, keeping the opposite edge where it is
    const o = d.orig;
    const th = (o.rotation * Math.PI) / 180;
    const cos = Math.cos(th);
    const sin = Math.sin(th);
    const gx = p.x - d.x0;
    const gy = p.y - d.y0;
    const lx = gx * cos + gy * sin;
    const ly = -gx * sin + gy * cos;
    const minSize = o.kind === 'line' ? 0 : 8;
    let w = o.w + lx * d.hx;
    let h = o.h + ly * d.hy;
    if (e.shiftKey && d.hx && d.hy && o.w > 0 && o.h > 0) {
      const k = Math.max(w / o.w, h / o.h);
      w = o.w * k;
      h = o.h * k;
    }
    w = Math.max(minSize, w);
    h = Math.max(minSize, h);
    // the centre moves by half the size change, along the element's axes
    const cxl = ((w - o.w) / 2) * d.hx;
    const cyl = ((h - o.h) / 2) * d.hy;
    const cx = o.x + o.w / 2 + cxl * cos - cyl * sin;
    const cy = o.y + o.h / 2 + cxl * sin + cyl * cos;
    preview(
      withSlide(dk, {
        ...s,
        elements: s.elements.map((x) => {
          if (x.id !== d.id) return x;
          const next = { ...x, x: Math.round(cx - w / 2), y: Math.round(cy - h / 2), w: Math.round(w), h: Math.round(h) };
          if (next.kind === 'table' && o.kind === 'table') return { ...next, cols: o.cols.map((c) => (c * next.w) / o.w), rows: o.rows.map((r) => (r * next.h) / o.h) };
          return next;
        }),
      }),
    );
  };
  const onUp = () => {
    const d = drag.current;
    drag.current = null;
    setGuides([]);
    if (!d) return;
    if (d.kind === 'marquee') {
      const m = marquee;
      setMarquee(null);
      if (m && (m.w > 4 || m.h > 4)) {
        const hit = curSlide().elements.filter((e) => !e.locked && e.x < m.x + m.w && e.x + e.w > m.x && e.y < m.y + m.h && e.y + e.h > m.y).map((e) => e.id);
        setSelected((cur0) => [...new Set([...cur0, ...hit])]);
      }
      return;
    }
    endDrag();
  };

  // ── keyboard, clipboard ─────────────────────────────────────────────────
  const undo = () => {
    endEdit();
    setSelected([]);
    setHist((h) => (h.past.length ? { past: h.past.slice(0, -1), present: h.past[h.past.length - 1], future: [h.present, ...h.future] } : h));
    onChange();
  };
  const redo = () => {
    endEdit();
    setSelected([]);
    setHist((h) => (h.future.length ? { past: [...h.past, h.present], present: h.future[0], future: h.future.slice(1) } : h));
    onChange();
  };
  const startShow = (fromStart: boolean) => {
    endEdit();
    setShow(fromStart ? Math.max(0, deckRef.current.slides.findIndex((s) => !s.hidden)) : indexRef.current);
  };
  useImperativeHandle(ref, () => ({
    getDeck: () => {
      syncText();
      return deckRef.current;
    },
    startShow: (fromStart = true) => startShow(fromStart),
  }));

  const tabActive = useTabActive();
  const keyHandler = useRef<(e: KeyboardEvent) => void>(() => undefined);
  keyHandler.current = (e: KeyboardEvent) => {
    if (show !== null) return;
    if (document.querySelector('.modal-backdrop')) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    const target = e.target as HTMLElement | null;
    const inEditable = !!editable.current && !!target && editable.current.contains(target);
    if (e.key === 'F5') {
      e.preventDefault();
      startShow(!e.shiftKey);
      return;
    }
    if (inEditable) {
      const ed = editingRef.current;
      if (e.key === 'Escape') {
        e.preventDefault();
        endEdit();
      } else if (e.key === 'Tab') {
        e.preventDefault();
        const el = ed && curSlide().elements.find((x) => x.id === ed.id);
        if (el?.kind === 'table' && ed?.cell) {
          // Tab walks through the cells; past the last one it adds a row
          const flat = el.cells.flatMap((row, r) => row.map((c, ci) => (c ? ([r, ci] as [number, number]) : null))).filter(Boolean) as [number, number][];
          const at = flat.findIndex(([r, c]) => r === ed.cell![0] && c === ed.cell![1]);
          const next = flat[at + (e.shiftKey ? -1 : 1)];
          if (next) {
            pendingCaret.current = 'all';
            beginEdit(el.id, next);
          } else if (!e.shiftKey) {
            tableOp('rowAdd');
            pendingCaret.current = 'all';
            setSelected([el.id]);
            setEditing({ id: el.id, cell: [el.rows.length, 0] });
            setSeed((n) => n + 1);
          }
        } else paraFormat((p) => ({ level: p.level + (e.shiftKey ? -1 : 1) }));
      } else if (mod && k === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (mod && k === 'y') {
        e.preventDefault();
        redo();
      } else if (mod && (k === 'b' || k === 'i' || k === 'u')) {
        e.preventDefault();
        toggle(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline', k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline');
      }
      return;
    }
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName))) return;
    const ids = selectedRef.current;
    if (mod && k === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (mod && k === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && (k === 'f' || k === 'h')) {
      e.preventDefault();
      setFindOpen(true);
    } else if (mod && k === 'm') {
      e.preventDefault();
      addSlide();
    } else if (mod && k === 'c' && ids.length) {
      copySelected();
    } else if (mod && k === 'x' && ids.length) {
      copySelected();
      removeSelected();
    } else if (mod && k === 'v' && clipboard.length) {
      // pictures and text from other programs arrive through the paste event instead
      e.preventDefault();
      pasteClipboard();
    } else if (mod && k === 'd') {
      e.preventDefault();
      if (ids.length) {
        copySelected();
        pasteClipboard();
      } else duplicateSlide();
    } else if (mod && k === 'a') {
      e.preventDefault();
      setSelected(curSlide().elements.filter((x) => !x.locked).map((x) => x.id));
    } else if (mod && (k === 'b' || k === 'i' || k === 'u') && ids.length) {
      e.preventDefault();
      toggle(k === 'b' ? 'bold' : k === 'i' ? 'italic' : 'underline', k);
    } else if (mod) return;
    else if ((e.key === 'Delete' || e.key === 'Backspace') && ids.length) {
      e.preventDefault();
      removeSelected();
    } else if (e.key === 'Escape') setSelected([]);
    else if (e.key.startsWith('Arrow') && ids.length) {
      e.preventDefault();
      const step = e.shiftKey ? 10 : 1;
      const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
      const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
      patchSelected((el) => ({ ...el, x: el.x + dx, y: el.y + dy }), 'nudge');
    } else if (e.key === 'PageDown' || (e.key === 'ArrowDown' && !ids.length)) {
      e.preventDefault();
      goto(indexRef.current + 1);
    } else if (e.key === 'PageUp' || (e.key === 'ArrowUp' && !ids.length)) {
      e.preventDefault();
      goto(indexRef.current - 1);
    } else if (e.key === 'Tab') {
      e.preventDefault();
      const els = curSlide().elements.filter((x) => !x.locked);
      if (els.length) setSelected([els[(els.findIndex((x) => x.id === ids[0]) + (e.shiftKey ? -1 : 1) + els.length) % els.length].id]);
    } else if (ids.length === 1 && (e.key === 'Enter' || e.key === 'F2' || (e.key.length === 1 && !e.altKey))) {
      // typing on a selected text shape starts editing it
      const el = curSlide().elements.find((x) => x.id === ids[0]);
      if (el?.kind === 'shape' && !el.locked) {
        e.preventDefault();
        if (e.key.length === 1) {
          pendingChar.current = e.key;
          pendingCaret.current = null;
        } else pendingCaret.current = -1;
        beginEdit(el.id);
      } else if (el?.kind === 'table' && (e.key === 'Enter' || e.key === 'F2')) {
        e.preventDefault();
        beginEdit(el.id, [0, 0]);
      }
    }
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => tabActive.current && keyHandler.current(e);
    const onPaste = (e: ClipboardEvent) => {
      if (!tabActive.current || showRef.current !== null) return;
      const target = e.target as HTMLElement | null;
      if (editable.current && target && editable.current.contains(target)) {
        // into a text box: plain text only, so no foreign markup comes along
        e.preventDefault();
        document.execCommand('insertText', false, e.clipboardData?.getData('text/plain') ?? '');
        return;
      }
      if (target && /^(INPUT|TEXTAREA)$/.test(target.tagName)) return;
      const file = Array.from(e.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
      if (file) {
        e.preventDefault();
        void addPictureRef.current(file);
        return;
      }
      const text = e.clipboardData?.getData('text/plain');
      if (text && !clipboard.length) {
        e.preventDefault();
        const d = deckRef.current;
        addElementRef.current(textBox(Math.round(d.width * 0.15), Math.round(d.height * 0.4), Math.round(d.width * 0.7), 80, text.split(/\r?\n/).slice(0, 200).map((l) => para(l))));
      }
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('paste', onPaste);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('paste', onPaste);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const showRef = useRef(show);
  showRef.current = show;
  const addPictureRef = useRef(addPicture);
  addPictureRef.current = addPicture;
  const addElementRef = useRef(addElement);
  addElementRef.current = addElement;

  // ── editable overlay geometry ───────────────────────────────────────────
  const editEl = editing ? slide.elements.find((e) => e.id === editing.id) ?? null : null;
  let editBox: { style: CSSProperties; inner: CSSProperties } | null = null;
  if (editEl?.kind === 'shape') {
    const st = shapeTextStyle(editEl, deck);
    editBox = {
      style: { left: editEl.x, top: editEl.y, width: editEl.w, height: editEl.h, transform: editEl.rotation ? `rotate(${editEl.rotation}deg)` : undefined, padding: editEl.padding, display: 'flex', flexDirection: 'column', justifyContent: editEl.valign === 'middle' ? 'center' : editEl.valign === 'bottom' ? 'flex-end' : 'flex-start' },
      inner: { fontFamily: st.font, fontSize: st.size * PX_PER_PT, color: st.color, width: '100%', minHeight: st.size * PX_PER_PT * 1.2 },
    };
  } else if (editEl?.kind === 'table' && editing?.cell) {
    const [r, c] = editing.cell;
    const cell = editEl.cells[r]?.[c];
    const st = cellTextStyle(deck, editEl, r);
    const sum = (a: number[], n: number) => a.slice(0, n).reduce((x, y) => x + y, 0);
    editBox = {
      style: { left: editEl.x + sum(editEl.cols, c), top: editEl.y + sum(editEl.rows, r), width: sum(editEl.cols, c + (cell?.colSpan ?? 1)) - sum(editEl.cols, c), minHeight: sum(editEl.rows, r + (cell?.rowSpan ?? 1)) - sum(editEl.rows, r), padding: '5px 8px' },
      inner: { fontFamily: st.font, fontSize: st.size * PX_PER_PT, color: st.color, fontWeight: st.bold ? 700 : undefined, width: '100%', minHeight: st.size * PX_PER_PT * 1.2 },
    };
  }

  const stop = (e: React.MouseEvent) => e.preventDefault();
  const sizeNow = cur.run?.size ?? cur.style?.size ?? 18;
  const fontNow = cur.run?.font ?? '';
  const bulletNow = cur.para?.bullet ?? (one?.kind === 'shape' && textDefaults(one, deck).bullets ? 'bullet' : 'none');
  const hasText = selEls.some((e) => e.kind === 'shape' || e.kind === 'table');
  const shapeSel = selEls.filter((e): e is ShapeElement => e.kind === 'shape');
  const patchShapes = (patch: Partial<ShapeElement>, coalesce?: string) => patchSelected((e) => (e.kind === 'shape' ? { ...e, ...patch } : e), coalesce);
  const bg: Background | null = slide.background;
  const THUMB_W = 140;

  const homeTab = (
    <>
      <Group label="Slides">
        <Popover label="New slide" button={<span className="sl-swatch"><Plus size={14} /> New slide</span>}>
          {(close) => (
            <div className="format-menu">
              {LAYOUTS.map((l) => <button key={l.id} type="button" className="menu-item" onClick={() => { close(); addSlide(l.id); }}>{l.label}</button>)}
            </div>
          )}
        </Popover>
        <Popover label="Layout" button={<span>Layout</span>}>
          {(close) => (
            <div className="format-menu">
              {LAYOUTS.map((l) => <button key={l.id} type="button" className="menu-item" onClick={() => { close(); applyLayout(l.id); }}>{l.label}</button>)}
            </div>
          )}
        </Popover>
        <button type="button" className="btn btn-icon" title="Duplicate slide (Ctrl+D)" aria-label="Duplicate slide" onClick={duplicateSlide}><Copy size={14} /></button>
        <button type="button" className="btn btn-icon" title="Delete slide" aria-label="Delete slide" onClick={deleteSlide}><Trash2 size={14} /></button>
      </Group>
      <Group label="Font">
        <select className="tb-select" aria-label="Font" style={{ width: 132 }} disabled={!hasText} value={FONTS.some(([v]) => v === fontNow) ? fontNow : ''} onChange={(e) => runFormat({ font: e.target.value || undefined }, ['fontName', e.target.value || (cur.style?.font ?? 'Arial')])}>
          {FONTS.map(([v, n]) => <option key={n} value={v}>{n}</option>)}
        </select>
        <select className="tb-select" aria-label="Font size" style={{ width: 62 }} disabled={!hasText} value={SIZES.includes(Math.round(sizeNow)) ? Math.round(sizeNow) : ''} onChange={(e) => e.target.value && runFormat({ size: Number(e.target.value) })}>
          {!SIZES.includes(Math.round(sizeNow)) && <option value="">{Math.round(sizeNow * 10) / 10}</option>}
          {SIZES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        <button type="button" className={cx('btn btn-icon', cur.run?.bold && 'is-active')} disabled={!hasText} title="Bold (Ctrl+B)" aria-label="Bold" onMouseDown={stop} onClick={() => toggle('bold', 'bold')}><Bold size={14} /></button>
        <button type="button" className={cx('btn btn-icon', cur.run?.italic && 'is-active')} disabled={!hasText} title="Italic (Ctrl+I)" aria-label="Italic" onMouseDown={stop} onClick={() => toggle('italic', 'italic')}><Italic size={14} /></button>
        <button type="button" className={cx('btn btn-icon', cur.run?.underline && 'is-active')} disabled={!hasText} title="Underline (Ctrl+U)" aria-label="Underline" onMouseDown={stop} onClick={() => toggle('underline', 'underline')}><Underline size={14} /></button>
        <button type="button" className={cx('btn btn-icon', cur.run?.strike && 'is-active')} disabled={!hasText} title="Strikethrough" aria-label="Strikethrough" onMouseDown={stop} onClick={() => toggle('strike', 'strikeThrough')}><Strikethrough size={14} /></button>
        <Swatch label="Text" value={cur.run?.color ?? cur.style?.color} theme={deck.theme} onPick={(c) => c && runFormat({ color: c }, ['foreColor', c])} />
        <button type="button" className="btn btn-icon" disabled={!hasText} title="Link" aria-label="Link" onMouseDown={stop} onClick={addLink}><LinkIcon size={14} /></button>
      </Group>
      <Group label="Paragraph">
        <button type="button" className={cx('btn btn-icon', bulletNow === 'bullet' && 'is-active')} disabled={!hasText} title="Bullets" aria-label="Bullets" onMouseDown={stop} onClick={() => paraFormat((p) => ({ bullet: p.bullet === 'bullet' ? 'none' : 'bullet' }))}><List size={14} /></button>
        <button type="button" className={cx('btn btn-icon', bulletNow === 'number' && 'is-active')} disabled={!hasText} title="Numbering" aria-label="Numbering" onMouseDown={stop} onClick={() => paraFormat((p) => ({ bullet: p.bullet === 'number' ? 'none' : 'number' }))}><ListOrdered size={14} /></button>
        <button type="button" className="btn btn-icon" disabled={!hasText} title="Decrease list level (Shift+Tab)" aria-label="Decrease list level" onMouseDown={stop} onClick={() => paraFormat((p) => ({ level: p.level - 1 }))}><IndentDecrease size={14} /></button>
        <button type="button" className="btn btn-icon" disabled={!hasText} title="Increase list level (Tab)" aria-label="Increase list level" onMouseDown={stop} onClick={() => paraFormat((p) => ({ level: p.level + 1 }))}><IndentIncrease size={14} /></button>
        {([['left', AlignLeft], ['center', AlignCenter], ['right', AlignRight], ['justify', AlignJustify]] as const).map(([a, Icon]) => (
          <button key={a} type="button" className={cx('btn btn-icon', (cur.para?.align ?? 'left') === a && hasText && 'is-active')} disabled={!hasText} title={`Align ${a}`} aria-label={`Align ${a}`} onMouseDown={stop} onClick={() => paraFormat(() => ({ align: a }))}><Icon size={14} /></button>
        ))}
        <select className="tb-select" aria-label="Line spacing" style={{ width: 62 }} disabled={!hasText} value={String(cur.para?.lineSpacing ?? 1.2)} onChange={(e) => paraFormat(() => ({ ls: e.target.value }))}>
          {[['1.2', '1.0'], ['1.38', '1.15'], ['1.8', '1.5'], ['2.4', '2.0']].map(([v, n]) => <option key={v} value={v}>{n}</option>)}
        </select>
        <select className="tb-select" aria-label="Vertical alignment" style={{ width: 84 }} disabled={!shapeSel.length} value={shapeSel[0]?.valign ?? 'top'} onChange={(e) => patchShapes({ valign: e.target.value as ShapeElement['valign'] })}>
          <option value="top">Top</option>
          <option value="middle">Middle</option>
          <option value="bottom">Bottom</option>
        </select>
      </Group>
      <Group label="Shape">
        <Swatch label="Fill" value={shapeSel[0]?.fill} theme={deck.theme} allowNone onPick={(c) => (one?.kind === 'table' && editing?.cell ? cellFillSet(c) : patchShapes({ fill: c, fill2: undefined }))} />
        <Swatch label="Outline" value={shapeSel[0]?.line ?? (one?.kind === 'line' ? one.color : one?.kind === 'image' ? one.line : null)} theme={deck.theme} allowNone onPick={(c) => patchSelected((e) => (e.kind === 'shape' ? { ...e, line: c } : e.kind === 'line' ? { ...e, color: c ?? e.color } : e.kind === 'image' ? { ...e, line: c, lineWidth: e.lineWidth ?? 2 } : e.kind === 'table' ? { ...e, border: c } : e))} />
        <select className="tb-select" aria-label="Outline width" style={{ width: 70 }} disabled={!selEls.length} value={String(one && 'lineWidth' in one ? one.lineWidth ?? 1 : 1)} onChange={(e) => patchSelected((el) => (el.kind === 'shape' || el.kind === 'line' || el.kind === 'image' ? { ...el, lineWidth: Number(e.target.value) } : el.kind === 'table' ? { ...el, borderWidth: Number(e.target.value) } : el))}>
          {[0.5, 1, 1.5, 2, 3, 4, 6, 8].map((w) => <option key={w} value={w}>{w} px</option>)}
        </select>
        <select className="tb-select" aria-label="Outline style" style={{ width: 74 }} disabled={!selEls.some((e) => e.kind === 'shape' || e.kind === 'line')} value={(one && (one.kind === 'shape' || one.kind === 'line') && one.lineDash) || 'solid'} onChange={(e) => patchSelected((el) => (el.kind === 'shape' || el.kind === 'line' ? { ...el, lineDash: e.target.value as 'solid' | 'dash' | 'dot' } : el))}>
          <option value="solid">Solid</option>
          <option value="dash">Dashed</option>
          <option value="dot">Dotted</option>
        </select>
        <label><input type="checkbox" disabled={!selEls.some((e) => e.kind === 'shape' || e.kind === 'image')} checked={!!(one && (one.kind === 'shape' || one.kind === 'image') && one.shadow)} onChange={(e) => patchSelected((el) => (el.kind === 'shape' || el.kind === 'image' ? { ...el, shadow: e.target.checked } : el))} /> Shadow</label>
        {one?.kind === 'image' && <label><input type="checkbox" checked={!!one.radius} onChange={(e) => patchSelected((el) => (el.kind === 'image' ? { ...el, radius: e.target.checked ? 0.1 : undefined } : el))} /> Rounded</label>}
        {one?.kind === 'line' && (
          <>
            <label><input type="checkbox" checked={!!one.startArrow} onChange={(e) => patchSelected((el) => (el.kind === 'line' ? { ...el, startArrow: e.target.checked } : el))} /> Start arrow</label>
            <label><input type="checkbox" checked={!!one.endArrow} onChange={(e) => patchSelected((el) => (el.kind === 'line' ? { ...el, endArrow: e.target.checked } : el))} /> End arrow</label>
          </>
        )}
      </Group>
      {one?.kind === 'table' && (
        <Group label="Table">
          <button type="button" className="btn" onClick={() => tableOp('rowAdd')}>+ Row</button>
          <button type="button" className="btn" onClick={() => tableOp('colAdd')}>+ Column</button>
          <button type="button" className="btn" onClick={() => tableOp('rowDel')}>− Row</button>
          <button type="button" className="btn" onClick={() => tableOp('colDel')}>− Column</button>
          <label><input type="checkbox" checked={one.header} onChange={(e) => patchSelected((el) => (el.kind === 'table' ? { ...el, header: e.target.checked } : el))} /> Header row</label>
          <label><input type="checkbox" checked={one.banded} onChange={(e) => patchSelected((el) => (el.kind === 'table' ? { ...el, banded: e.target.checked } : el))} /> Banded rows</label>
        </Group>
      )}
      <Group label="Arrange">
        <button type="button" className="btn btn-icon" disabled={!selEls.length} title="Bring to front" aria-label="Bring to front" onClick={() => reorder('front')}><ArrowUpToLine size={14} /></button>
        <button type="button" className="btn btn-icon" disabled={!selEls.length} title="Bring forward" aria-label="Bring forward" onClick={() => reorder('up')}><ChevronUp size={14} /></button>
        <button type="button" className="btn btn-icon" disabled={!selEls.length} title="Send backward" aria-label="Send backward" onClick={() => reorder('down')}><ChevronDown size={14} /></button>
        <button type="button" className="btn btn-icon" disabled={!selEls.length} title="Send to back" aria-label="Send to back" onClick={() => reorder('back')}><ArrowDownToLine size={14} /></button>
        <Popover label="Align" button={<span>Align</span>} disabled={!selEls.length}>
          {(close) => (
            <div className="format-menu">
              {([['left', 'Align left'], ['center', 'Align centre'], ['right', 'Align right'], ['top', 'Align top'], ['middle', 'Align middle'], ['bottom', 'Align bottom'], ['hdist', 'Distribute horizontally'], ['vdist', 'Distribute vertically']] as const).map(([k, n]) => (
                <button key={k} type="button" className="menu-item" disabled={(k === 'hdist' || k === 'vdist') && selEls.length < 3} onClick={() => { close(); alignEls(k); }}>{n}</button>
              ))}
            </div>
          )}
        </Popover>
        {one && (
          <>
            <label>W <input type="number" value={Math.round(one.w)} min={1} onChange={(e) => Number(e.target.value) > 0 && patchSelected((el) => (el.kind === 'table' ? { ...el, w: Number(e.target.value), cols: el.cols.map((c) => (c * Number(e.target.value)) / el.w) } : { ...el, w: Number(e.target.value) }), 'size')} /></label>
            <label>H <input type="number" value={Math.round(one.h)} min={0} onChange={(e) => Number(e.target.value) >= 0 && patchSelected((el) => (el.kind === 'table' ? { ...el, h: Number(e.target.value), rows: el.rows.map((r) => (r * Number(e.target.value)) / (el.h || 1)) } : { ...el, h: Number(e.target.value) }), 'size')} /></label>
            <label>° <input type="number" value={Math.round(one.rotation)} onChange={(e) => patchSelected((el) => ({ ...el, rotation: ((Number(e.target.value) % 360) + 360) % 360 }), 'rot')} /></label>
          </>
        )}
      </Group>
    </>
  );

  function cellFillSet(c: string | null) {
    const ed = editingRef.current;
    if (!ed?.cell) return;
    const [r, col] = ed.cell;
    setElements((els) => els.map((e) => (e.id === ed.id && e.kind === 'table' ? { ...e, cells: e.cells.map((row, ri) => row.map((cell, ci) => (cell && ri === r && ci === col ? { ...cell, fill: c } : cell))) } : e)));
  }

  const insertTab = (
    <>
      <Group label="Text">
        <button type="button" className="btn" onClick={addTextBox}><Type size={14} /> Text box</button>
      </Group>
      <Group label="Illustrations">
        <button type="button" className="btn" onClick={() => fileInput.current?.click()}><ImageIcon size={14} /> Picture</button>
        <input ref={fileInput} type="file" hidden accept="image/*" onChange={(e) => { void addPicture(e.target.files?.[0]); e.target.value = ''; }} />
        <Popover label="Shapes" button={<span className="sl-swatch"><Shapes size={14} /> Shapes</span>}>
          {(close) => (
            <div className="sl-gallery">
              {SHAPES.map((s) => (
                <button key={s} type="button" title={SHAPE_LABELS[s]} aria-label={SHAPE_LABELS[s]} onClick={() => { close(); addShape(s); }}>
                  <svg width="22" height="18" viewBox="-1 -1 24 20"><path d={shapePath(s, 22, 18)} fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" /></svg>
                </button>
              ))}
            </div>
          )}
        </Popover>
        <button type="button" className="btn" onClick={() => addLine(false)}><Minus size={14} /> Line</button>
        <button type="button" className="btn" onClick={() => addLine(true)}><MoveUpRight size={14} /> Arrow</button>
      </Group>
      <Group label="Tables">
        <Popover label="Table" button={<span className="sl-swatch"><TableIcon size={14} /> Table</span>}>
          {(close) => (
            <div className="format-menu">
              {([[2, 2], [3, 3], [4, 3], [4, 4], [5, 4], [6, 5]] as const).map(([r, c]) => <button key={`${r}x${c}`} type="button" className="menu-item" onClick={() => { close(); addTable(r, c); }}>{r} rows × {c} columns</button>)}
            </div>
          )}
        </Popover>
      </Group>
      <Group label="Links">
        <button type="button" className="btn" disabled={!hasText} onMouseDown={stop} onClick={addLink}><LinkIcon size={14} /> Link</button>
      </Group>
    </>
  );

  const designTab = (
    <>
      <Group label="Themes">
        <div className="sl-themes">
          {[...(THEMES.some((t) => t.id === deck.theme.id) ? [] : [deck.theme]), ...THEMES].map((t) => (
            <button key={t.id} type="button" className={cx('sl-theme', deck.theme.id === t.id && 'is-active')} style={{ background: t.background, color: t.heading, fontFamily: t.headingFont }} title={t.name} onClick={() => commit({ ...deckRef.current, theme: t })}>
              <b>{t.name}</b>
              <span>{t.accents.map((a, i) => <i key={i} style={{ background: a }} />)}</span>
            </button>
          ))}
        </div>
      </Group>
      <Group label="Slide size">
        <select
          className="tb-select"
          aria-label="Slide size"
          value={SLIDE_SIZES.find(([, w, h]) => w === deck.width && h === deck.height)?.[0] ?? ''}
          onChange={(e) => {
            const s = SLIDE_SIZES.find(([n]) => n === e.target.value);
            if (s) commit(resizeDeck(deckRef.current, s[1], s[2]));
          }}
        >
          {!SLIDE_SIZES.some(([, w, h]) => w === deck.width && h === deck.height) && <option value="">Custom ({deck.width} × {deck.height})</option>}
          {SLIDE_SIZES.map(([n]) => <option key={n} value={n}>{n}</option>)}
        </select>
      </Group>
      <Group label="Background of this slide">
        <Swatch label="Colour" value={bg?.type === 'color' ? bg.color : bg?.type === 'gradient' ? bg.from : deck.theme.background} theme={deck.theme} onPick={(c) => c && patchSlide({ background: { type: 'color', color: c } }, 'bg')} />
        <Swatch label="Gradient to" value={bg?.type === 'gradient' ? bg.to : null} theme={deck.theme} allowNone onPick={(c) => patchSlide({ background: c ? { type: 'gradient', from: bg?.type === 'color' ? bg.color : bg?.type === 'gradient' ? bg.from : deck.theme.background, to: c, angle: 180 } : bg?.type === 'gradient' ? { type: 'color', color: bg.from } : bg }, 'bg')} />
        <button type="button" className="btn" onClick={() => bgInput.current?.click()}><ImageIcon size={14} /> Picture</button>
        <input ref={bgInput} type="file" hidden accept="image/*" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; try { patchSlide({ background: { type: 'image', src: (await readPicture(f)).src } }); } catch (err) { onError(err instanceof Error ? err.message : String(err)); } }} />
        <button type="button" className="btn btn-text" disabled={!bg} onClick={() => patchSlide({ background: null })}>Reset</button>
        <button type="button" className="btn btn-text" onClick={() => commit({ ...deckRef.current, slides: deckRef.current.slides.map((s) => ({ ...s, background: curSlide().background })) })}>Apply to all</button>
      </Group>
    </>
  );

  const transitionsTab = (
    <>
      <Group label="Transition to this slide">
        {TRANSITIONS.map((t) => (
          <button key={t} type="button" className={cx('btn', slide.transition.type === t && 'is-active')} onClick={() => patchSlide({ transition: { ...slide.transition, type: t as TransitionType } })}>
            {t === 'none' ? 'None' : t[0].toUpperCase() + t.slice(1)}
          </button>
        ))}
      </Group>
      <Group label="Timing">
        <label>Duration (s) <input type="number" min={0.1} max={5} step={0.1} value={slide.transition.duration} disabled={slide.transition.type === 'none'} onChange={(e) => Number(e.target.value) > 0 && patchSlide({ transition: { ...slide.transition, duration: Math.min(5, Number(e.target.value)) } }, 'tr')} /></label>
        <button type="button" className="btn btn-text" onClick={() => commit({ ...deckRef.current, slides: deckRef.current.slides.map((s) => ({ ...s, transition: { ...curSlide().transition } })) })}>Apply to all</button>
      </Group>
    </>
  );

  const showTab = (
    <>
      <Group label="Start slide show">
        <button type="button" className="btn btn-primary" onClick={() => startShow(true)}><Play size={14} /> From beginning</button>
        <button type="button" className="btn" onClick={() => startShow(false)}><Play size={14} /> From current slide</button>
      </Group>
      <Group label="Set up">
        <label><input type="checkbox" checked={!!slide.hidden} onChange={(e) => patchSlide({ hidden: e.target.checked })} /> <EyeOff size={13} /> Hide this slide</label>
      </Group>
      <Group label="During the show">
        <span className="sl-group-label" style={{ textAlign: 'left', maxWidth: 380 }}>→ Space or click: next · ← previous · Home / End · B: black screen · Esc: exit</span>
      </Group>
    </>
  );

  return (
    <div className="sl-root">
      <div className="sl-tabs" role="tablist">
        {([['home', 'Home'], ['insert', 'Insert'], ['design', 'Design'], ['transitions', 'Transitions'], ['show', 'Slide Show']] as const).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={tab === id} className={cx('sl-tab', tab === id && 'is-active')} onClick={() => setTab(id)}>{label}</button>
        ))}
        <span style={{ flex: 1 }} />
        <button type="button" className="btn btn-icon" title="Undo (Ctrl+Z)" aria-label="Undo" disabled={!hist.past.length} onClick={undo}><Undo2 size={15} /></button>
        <button type="button" className="btn btn-icon" title="Redo (Ctrl+Y)" aria-label="Redo" disabled={!hist.future.length} onClick={redo}><Redo2 size={15} /></button>
        <button type="button" className="btn btn-icon" title="Find and replace (Ctrl+F)" aria-label="Find and replace" onClick={() => setFindOpen(true)}><Search size={15} /></button>
        <button type="button" className={cx('btn btn-icon', sorter && 'is-active')} title="Slide sorter: see every slide, drag to reorder" aria-label="Slide sorter" aria-pressed={sorter} onClick={() => { endEdit(); setSorter((v) => !v); }}><LayoutGrid size={15} /></button>
        <button type="button" className="btn btn-icon" title="Start slide show (F5)" aria-label="Start slide show" onClick={() => startShow(true)}><Play size={15} /></button>
        <button type="button" className="btn btn-icon" title="Presentations guide" aria-label="Presentations guide" onClick={() => openGuide('slides')}><CircleHelp size={15} /></button>
      </div>
      <div className="sl-ribbon" role="toolbar" aria-label="Ribbon">
        {tab === 'home' ? homeTab : tab === 'insert' ? insertTab : tab === 'design' ? designTab : tab === 'transitions' ? transitionsTab : showTab}
      </div>
      {sorter && (
        <div className="sl-body">
          <div className="sl-sorter" role="listbox" aria-label="Slide sorter">
            {deck.slides.map((s, i) => (
              <div
                key={s.id}
                role="option"
                aria-selected={i === slideIndex}
                aria-label={`Slide ${i + 1}${s.hidden ? ' (hidden)' : ''}`}
                tabIndex={0}
                className={cx('sl-thumb', i === slideIndex && 'is-active', s.hidden && 'is-hidden', dropAt === i && 'is-drop')}
                draggable
                onClick={() => goto(i)}
                onDoubleClick={() => { goto(i); setSorter(false); }}
                onDragStart={(e) => { e.dataTransfer.setData('text/x-slide', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
                onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-slide')) { e.preventDefault(); setDropAt(i); } }}
                onDragLeave={() => setDropAt((v) => (v === i ? null : v))}
                onDrop={(e) => { e.preventDefault(); setDropAt(null); const from = Number(e.dataTransfer.getData('text/x-slide')); if (Number.isFinite(from)) moveSlide(from, i); }}
              >
                <Thumb deck={deck} slide={s} width={240} />
                <span className="sl-thumb-num">{i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      <div className="sl-body" hidden={sorter} style={sorter ? { display: 'none' } : undefined}>
        <div className="sl-list" role="listbox" aria-label="Slides">
          {deck.slides.map((s, i) => (
            <div
              key={s.id}
              role="option"
              aria-selected={i === slideIndex}
              aria-label={`Slide ${i + 1}${s.hidden ? ' (hidden)' : ''}`}
              tabIndex={0}
              className={cx('sl-thumb', i === slideIndex && 'is-active', s.hidden && 'is-hidden', dropAt === i && 'is-drop')}
              draggable
              onClick={() => goto(i)}
              onDragStart={(e) => { e.dataTransfer.setData('text/x-slide', String(i)); e.dataTransfer.effectAllowed = 'move'; }}
              onDragOver={(e) => { if (e.dataTransfer.types.includes('text/x-slide')) { e.preventDefault(); setDropAt(i); } }}
              onDragLeave={() => setDropAt((v) => (v === i ? null : v))}
              onDrop={(e) => { e.preventDefault(); setDropAt(null); const from = Number(e.dataTransfer.getData('text/x-slide')); if (Number.isFinite(from)) moveSlide(from, i); }}
            >
              <span className="sl-thumb-num">{i + 1}</span>
              <Thumb deck={deck} slide={s} width={THUMB_W} />
            </div>
          ))}
        </div>
        <div className="sl-center">
          <div className="sl-stage-wrap" ref={wrap} onPointerDown={onStageDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
            <div ref={stage} className="sl-stage" style={{ left: stageLeft, top: stageTop, width: deck.width, height: deck.height, transform: `scale(${scale})` }}>
              <div className="sl-bg" style={{ background: backgroundCss(slide.background, deck.theme).slice('background:'.length) }} />
              {slide.elements.map((el) => (
                <ElementView key={el.id} el={el} deck={deck} hideText={editing?.id === el.id ? editing : null} onDown={onElementDown} onDouble={onElementDouble} />
              ))}
              {editBox && (
                <div className="sl-edit" style={editBox.style} onPointerDown={(e) => e.stopPropagation()}>
                  <div ref={editable} contentEditable suppressContentEditableWarning spellCheck style={{ ...editBox.inner, outline: 'none' }} onInput={() => syncText()} role="textbox" aria-multiline aria-label="Text" />
                </div>
              )}
              {selEls.map((el) => {
                const hs = 9 / scale;
                const handles: [number, number][] = el.kind === 'line' ? [[-1, -1], [1, 1]] : [[-1, -1], [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0]];
                return (
                  <div key={el.id} className={cx('sl-sel', editing?.id === el.id && 'is-editing')} style={{ left: el.x, top: el.y, width: el.w, height: el.h, transform: el.rotation ? `rotate(${el.rotation}deg)` : undefined, borderWidth: 1 / scale }}>
                    {selEls.length === 1 && !el.locked && (
                      <>
                        {handles.map(([hx, hy]) => (
                          <span key={`${hx},${hy}`} className="sl-handle" style={{ left: `${(hx + 1) * 50}%`, top: `${(hy + 1) * 50}%`, width: hs, height: hs, borderWidth: 1 / scale, cursor: hx && hy ? (hx === hy ? 'nwse-resize' : 'nesw-resize') : hx ? 'ew-resize' : 'ns-resize' }} onPointerDown={(e) => onHandleDown(e, el, hx, hy)} />
                        ))}
                        <span className="sl-rot" style={{ top: -22 / scale, width: hs, height: hs, borderWidth: 1 / scale }} title="Rotate" onPointerDown={(e) => onRotateDown(e, el)} />
                      </>
                    )}
                  </div>
                );
              })}
              {guides.map((g, i) => (g.x !== undefined ? <div key={i} className="sl-guide" style={{ left: g.x, top: 0, width: 1 / scale, height: deck.height }} /> : <div key={i} className="sl-guide" style={{ top: g.y, left: 0, height: 1 / scale, width: deck.width }} />))}
              {marquee && <div className="sl-marquee" style={{ left: marquee.x, top: marquee.y, width: marquee.w, height: marquee.h, borderWidth: 1 / scale }} />}
            </div>
          </div>
          <div className="sl-notes">
            <textarea aria-label="Speaker notes" placeholder="Click to add speaker notes" value={slide.notes} onChange={(e) => patchSlide({ notes: e.target.value }, `notes:${slide.id}`)} />
          </div>
          <div className="sl-status">
            <span>Slide {slideIndex + 1} of {deck.slides.length}</span>
            <span>{deck.theme.name}</span>
            {slide.hidden && <span>Hidden in the slide show</span>}
            <span className="spacer" />
            <button type="button" className="btn btn-icon" aria-label="Zoom out" onClick={() => setZoom((z) => Math.max(0.25, z / 1.2))}><Minus size={13} /></button>
            <button type="button" className="btn btn-text" title="Fit slide to window" onClick={() => setZoom(1)}>{Math.round(scale * 100)}%</button>
            <button type="button" className="btn btn-icon" aria-label="Zoom in" onClick={() => setZoom((z) => Math.min(4, z * 1.2))}><Plus size={13} /></button>
          </div>
        </div>
      </div>
      {linkOpen !== null && <PromptModal title="Link" label="Address (leave empty to remove the link)" initial={linkOpen} placeholder="https://example.com" confirmLabel="Apply" onSubmit={applyLink} onClose={() => setLinkOpen(null)} />}
      {findOpen && (
        <Modal
          title="Find and replace"
          width={420}
          onClose={() => setFindOpen(false)}
          footer={
            <>
              <span className="dialog-hint" role="status">{find.note}</span>
              <span className="spacer" />
              <button type="button" className="btn" disabled={!find.text} onClick={findNext}>Find next</button>
              <button type="button" className="btn btn-primary" disabled={!find.text} onClick={replaceAll}>Replace all</button>
            </>
          }
        >
          <form className="sl-find" onSubmit={(e) => { e.preventDefault(); findNext(); }}>
            <label>Find<input className="input" value={find.text} data-autofocus onChange={(e) => setFind({ ...find, text: e.target.value, note: '' })} /></label>
            <label>Replace with<input className="input" value={find.replace} onChange={(e) => setFind({ ...find, replace: e.target.value, note: '' })} /></label>
            <label className="check"><input type="checkbox" checked={find.matchCase} onChange={(e) => setFind({ ...find, matchCase: e.target.checked })} /> Match case</label>
          </form>
        </Modal>
      )}
      {show !== null && <SlideShow deck={deck} start={show} onExit={(at) => { setShow(null); setIndex(at); }} />}
    </div>
  );
});
