/**
 * Pieces of the document ribbon's Insert, Design and Layout tabs: the table size picker, the
 * symbol grid, date formats, document themes and page-margin presets.
 *
 * Themes and document spacing are applied as ordinary character and paragraph formatting on
 * the text that is in the document, so every file format keeps them (there is no separate
 * "theme" to lose on export).
 */
import { useState } from 'react';
import type { Editor } from '@tiptap/react';
import { CSS_LINE_PER_WORD_LINE, type PageSetup } from '../../core/types';
import { cx } from '../components';

// ── Insert ▸ Table ──────────────────────────────────────────────────────────
const GRID_ROWS = 8;
const GRID_COLS = 10;

/** Word's "drag out a table" grid: hover to size, click to insert. */
export function TableGridPicker({ onPick }: { onPick: (rows: number, cols: number) => void }) {
  const [hover, setHover] = useState<{ r: number; c: number }>({ r: 0, c: 0 });
  return (
    <div className="table-grid-picker">
      <div className="table-grid-label">{hover.r ? `${hover.c} × ${hover.r} table` : 'Insert table'}</div>
      <div className="table-grid" style={{ gridTemplateColumns: `repeat(${GRID_COLS}, 16px)` }} onMouseLeave={() => setHover({ r: 0, c: 0 })}>
        {Array.from({ length: GRID_ROWS * GRID_COLS }, (_, i) => {
          const r = Math.floor(i / GRID_COLS) + 1;
          const c = (i % GRID_COLS) + 1;
          return (
            <button
              key={i}
              type="button"
              className={cx('table-grid-cell', r <= hover.r && c <= hover.c && 'is-on')}
              aria-label={`${c} columns by ${r} rows`}
              onMouseEnter={() => setHover({ r, c })}
              onFocus={() => setHover({ r, c })}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onPick(r, c)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ── Insert ▸ Symbol ─────────────────────────────────────────────────────────
export const SYMBOLS: { ch: string; name: string }[] = [
  ['©', 'Copyright'], ['®', 'Registered'], ['™', 'Trademark'], ['§', 'Section'], ['¶', 'Paragraph'], ['†', 'Dagger'], ['‡', 'Double dagger'], ['•', 'Bullet'],
  ['…', 'Ellipsis'], ['–', 'En dash'], ['—', 'Em dash'], ['‘', 'Left single quote'], ['’', 'Right single quote'], ['“', 'Left double quote'], ['”', 'Right double quote'], ['«', 'Left guillemet'],
  ['»', 'Right guillemet'], ['€', 'Euro'], ['£', 'Pound'], ['¥', 'Yen'], ['¢', 'Cent'], ['₹', 'Rupee'], ['₿', 'Bitcoin'], ['°', 'Degree'],
  ['±', 'Plus-minus'], ['×', 'Multiply'], ['÷', 'Divide'], ['≠', 'Not equal'], ['≈', 'Approximately'], ['≤', 'Less or equal'], ['≥', 'Greater or equal'], ['∞', 'Infinity'],
  ['√', 'Square root'], ['∑', 'Sum'], ['∏', 'Product'], ['∫', 'Integral'], ['∂', 'Partial'], ['∆', 'Delta'], ['µ', 'Micro'], ['π', 'Pi'],
  ['α', 'Alpha'], ['β', 'Beta'], ['γ', 'Gamma'], ['θ', 'Theta'], ['λ', 'Lambda'], ['σ', 'Sigma'], ['φ', 'Phi'], ['Ω', 'Omega'],
  ['½', 'One half'], ['⅓', 'One third'], ['¼', 'One quarter'], ['¾', 'Three quarters'], ['¹', 'Superscript one'], ['²', 'Superscript two'], ['³', 'Superscript three'], ['‰', 'Per mille'],
  ['←', 'Left arrow'], ['→', 'Right arrow'], ['↑', 'Up arrow'], ['↓', 'Down arrow'], ['↔', 'Left-right arrow'], ['⇒', 'Implies'], ['✓', 'Check mark'], ['✗', 'Cross mark'],
  ['★', 'Star'], ['☆', 'Outline star'], ['♥', 'Heart'], ['♦', 'Diamond'], ['☐', 'Empty box'], ['☑', 'Checked box'], ['¿', 'Inverted question mark'], ['¡', 'Inverted exclamation mark'],
].map(([ch, name]) => ({ ch, name }));

export function SymbolGrid({ onPick }: { onPick: (ch: string) => void }) {
  return (
    <div className="symbol-grid" role="group" aria-label="Symbols">
      {SYMBOLS.map((s) => (
        <button key={s.ch} type="button" className="symbol-cell" title={s.name} aria-label={s.name} onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(s.ch)}>
          {s.ch}
        </button>
      ))}
    </div>
  );
}

// ── Insert ▸ Date & time ────────────────────────────────────────────────────
export function dateFormats(now = new Date()): string[] {
  const d = (o: Intl.DateTimeFormatOptions) => now.toLocaleDateString(undefined, o);
  const t = (o: Intl.DateTimeFormatOptions) => now.toLocaleTimeString(undefined, o);
  const pad = (n: number) => String(n).padStart(2, '0');
  const out = [
    d({ dateStyle: 'short' }),
    d({ dateStyle: 'medium' }),
    d({ dateStyle: 'long' }),
    d({ dateStyle: 'full' }),
    `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    d({ month: 'long', year: 'numeric' }),
    t({ timeStyle: 'short' }),
    t({ timeStyle: 'medium' }),
    `${d({ dateStyle: 'medium' })} ${t({ timeStyle: 'short' })}`,
  ];
  return [...new Set(out)];
}

// ── Design ▸ Themes ─────────────────────────────────────────────────────────
export interface DocTheme {
  id: string;
  label: string;
  body: string;
  heading: string;
  /** Heading colour; null leaves headings the text colour. */
  headingColor: string | null;
}

export const DOC_THEMES: DocTheme[] = [
  { id: 'office', label: 'Office', body: 'Calibri', heading: 'Calibri', headingColor: '#2f5496' },
  { id: 'classic', label: 'Classic', body: 'Times New Roman', heading: 'Times New Roman', headingColor: null },
  { id: 'modern', label: 'Modern', body: 'Arial', heading: 'Arial', headingColor: '#1a56db' },
  { id: 'elegant', label: 'Elegant', body: 'Garamond', heading: 'Garamond', headingColor: '#741b47' },
  { id: 'editorial', label: 'Editorial', body: 'Georgia', heading: 'Trebuchet MS', headingColor: '#38761d' },
  { id: 'technical', label: 'Technical', body: 'Verdana', heading: 'Tahoma', headingColor: '#45818e' },
  { id: 'report', label: 'Report', body: 'Cambria', heading: 'Calibri', headingColor: '#c00000' },
  { id: 'typewriter', label: 'Typewriter', body: 'Courier New', heading: 'Courier New', headingColor: null },
];

export const HEADING_COLORS: { label: string; color: string | null }[] = [
  { label: 'Automatic', color: null },
  { label: 'Blue', color: '#2f5496' },
  { label: 'Bright blue', color: '#1a56db' },
  { label: 'Teal', color: '#45818e' },
  { label: 'Green', color: '#38761d' },
  { label: 'Red', color: '#c00000' },
  { label: 'Plum', color: '#741b47' },
  { label: 'Purple', color: '#674ea7' },
  { label: 'Orange', color: '#b45f06' },
  { label: 'Grey', color: '#434343' },
];

export interface DesignChange {
  /** Font for paragraphs, lists and tables; null clears it, undefined leaves it. */
  bodyFont?: string | null;
  headingFont?: string | null;
  headingColor?: string | null;
}

/**
 * Applies fonts / heading colour to all the text in the document as character formatting
 * (code blocks keep their own font). Returns false when the document has no text to format.
 */
export function applyDesign(editor: Editor, change: DesignChange): boolean {
  const { state, view } = editor;
  const type = state.schema.marks.textStyle;
  if (!type) return false;
  const tr = state.tr;
  let touched = false;
  state.doc.descendants((node, pos) => {
    if (node.type.name === 'codeBlock') return false;
    if (!node.isTextblock) return true;
    const heading = node.type.name === 'heading';
    const font = heading ? change.headingFont : change.bodyFont;
    const color = heading ? change.headingColor : undefined;
    if (font === undefined && color === undefined) return false;
    node.forEach((child, offset) => {
      if (!child.isText) return;
      const from = pos + 1 + offset;
      const to = from + child.nodeSize;
      const attrs: Record<string, unknown> = { ...(child.marks.find((m) => m.type === type)?.attrs ?? {}) };
      if (font !== undefined) attrs.fontFamily = font;
      if (color !== undefined) attrs.color = color;
      if (Object.values(attrs).every((v) => v === null || v === undefined)) tr.removeMark(from, to, type);
      else tr.addMark(from, to, type.create(attrs));
      touched = true;
    });
    return false;
  });
  if (!touched) return false;
  if (tr.docChanged) view.dispatch(tr);
  view.focus();
  return true;
}

// ── Design ▸ Paragraph spacing ──────────────────────────────────────────────
export interface SpacingPreset {
  id: string;
  label: string;
  /** Line spacing as Word shows it (1 = single); null = the default. */
  line: number | null;
  /** Space after each paragraph, pt; null = the default. */
  after: number | null;
}

export const SPACING_PRESETS: SpacingPreset[] = [
  { id: 'default', label: 'Default', line: null, after: null },
  { id: 'none', label: 'No paragraph space', line: 1, after: 0 },
  { id: 'compact', label: 'Compact', line: 1, after: 4 },
  { id: 'tight', label: 'Tight', line: 1.15, after: 6 },
  { id: 'open', label: 'Open', line: 1.15, after: 10 },
  { id: 'relaxed', label: 'Relaxed', line: 1.5, after: 6 },
  { id: 'double', label: 'Double', line: 2, after: 8 },
];

/** Line and paragraph spacing for every paragraph and heading of the document. */
export function applyDocumentSpacing(editor: Editor, preset: SpacingPreset): void {
  const { state, view } = editor;
  const tr = state.tr;
  const lineHeight = preset.line === null ? null : String(Math.round(preset.line * CSS_LINE_PER_WORD_LINE * 100) / 100);
  const spaceAfter = preset.after === null ? null : `${preset.after}pt`;
  state.doc.descendants((node, pos) => {
    if (node.type.name !== 'paragraph' && node.type.name !== 'heading') return !node.isTextblock;
    // headings keep their own space above; only body paragraphs lose "space before"
    const next = { ...node.attrs, lineHeight, spaceAfter, ...(node.type.name === 'paragraph' ? { spaceBefore: null } : {}) };
    tr.setNodeMarkup(pos, undefined, next);
    return false;
  });
  if (tr.docChanged) view.dispatch(tr);
  view.focus();
}

// ── Layout ▸ Margins / Size ─────────────────────────────────────────────────
const IN = 72;
export const MARGIN_PRESETS: { id: string; label: string; hint: string; margins: PageSetup['margins'] }[] = [
  { id: 'normal', label: 'Normal', hint: '1" all round', margins: { top: IN, bottom: IN, left: IN, right: IN } },
  { id: 'narrow', label: 'Narrow', hint: '0.5" all round', margins: { top: IN / 2, bottom: IN / 2, left: IN / 2, right: IN / 2 } },
  { id: 'moderate', label: 'Moderate', hint: '1" top and bottom, 0.75" sides', margins: { top: IN, bottom: IN, left: IN * 0.75, right: IN * 0.75 } },
  { id: 'wide', label: 'Wide', hint: '1" top and bottom, 2" sides', margins: { top: IN, bottom: IN, left: IN * 2, right: IN * 2 } },
];

export function marginPresetOf(m: PageSetup['margins']): string | null {
  const same = (a: number, b: number) => Math.abs(a - b) < 0.5;
  return MARGIN_PRESETS.find((p) => same(p.margins.top, m.top) && same(p.margins.bottom, m.bottom) && same(p.margins.left, m.left) && same(p.margins.right, m.right))?.id ?? null;
}

export const PAGE_SIZES: { value: PageSetup['size']; label: string; hint: string }[] = [
  { value: 'letter', label: 'Letter', hint: '8.5 × 11 in' },
  { value: 'a4', label: 'A4', hint: '210 × 297 mm' },
  { value: 'legal', label: 'Legal', hint: '8.5 × 14 in' },
];
