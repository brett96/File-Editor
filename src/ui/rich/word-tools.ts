/**
 * Word-style commands for the rich-text editor: change case, sort, format painter and
 * grow / shrink font. Each works on the current selection (or the word at the cursor).
 */
import type { Editor } from '@tiptap/react';
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import { TextSelection, type EditorState } from '@tiptap/pm/state';
import { CSS_LINE_PER_WORD_LINE } from '../../core/types';

// ── word at the cursor ──────────────────────────────────────────────────────

const WORD_CHAR = /[\p{L}\p{N}'’_-]/u;

/** The selection, or the word around the cursor when nothing is selected. */
export function selectionOrWord(state: EditorState): { from: number; to: number } | null {
  const { from, to, empty, $from } = state.selection;
  if (!empty) return { from, to };
  if (!$from.parent.isTextblock) return null;
  const chars: { ch: string; pos: number }[] = [];
  const start = $from.start();
  $from.parent.forEach((child, offset) => {
    if (child.isText) for (let i = 0; i < child.text!.length; i++) chars.push({ ch: child.text![i], pos: start + offset + i });
    else chars.push({ ch: ' ', pos: start + offset });
  });
  let idx = chars.findIndex((c) => c.pos >= $from.pos);
  if (idx < 0) idx = chars.length;
  let s = idx;
  let e = idx;
  while (s > 0 && WORD_CHAR.test(chars[s - 1].ch)) s--;
  while (e < chars.length && WORD_CHAR.test(chars[e].ch)) e++;
  if (s === e) return null;
  return { from: chars[s].pos, to: chars[e - 1].pos + 1 };
}

// ── change case ─────────────────────────────────────────────────────────────

export type CaseMode = 'sentence' | 'lower' | 'upper' | 'title' | 'toggle';

export const CASE_MODES: { mode: CaseMode; label: string }[] = [
  { mode: 'sentence', label: 'Sentence case.' },
  { mode: 'lower', label: 'lowercase' },
  { mode: 'upper', label: 'UPPERCASE' },
  { mode: 'title', label: 'Capitalize Each Word' },
  { mode: 'toggle', label: 'tOGGLE cASE' },
];

function transformCase(text: string, mode: CaseMode): string {
  switch (mode) {
    case 'lower':
      return text.toLocaleLowerCase();
    case 'upper':
      return text.toLocaleUpperCase();
    case 'title':
      return text.toLocaleLowerCase().replace(/(^|[^\p{L}\p{N}'’])(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase());
    case 'sentence':
      return text.toLocaleLowerCase().replace(/(^\s*|[.!?]\s+|\n\s*)(\p{L})/gu, (_m, pre: string, ch: string) => pre + ch.toLocaleUpperCase());
    case 'toggle':
      return Array.from(text, (ch) => (ch === ch.toLocaleUpperCase() ? ch.toLocaleLowerCase() : ch.toLocaleUpperCase())).join('');
  }
}

export function changeCase(editor: Editor, mode: CaseMode): boolean {
  const { state, view } = editor;
  const range = selectionOrWord(state);
  if (!range) return false;
  // text segments (keeping their marks); paragraphs are joined with \n so sentences restart
  const segs: { from: number; to: number; text: string; marks: readonly Mark[]; at: number }[] = [];
  let combined = '';
  let lastParent: PMNode | null = null;
  state.doc.nodesBetween(range.from, range.to, (node, pos, parent) => {
    if (!node.isText) return true;
    const s = Math.max(range.from, pos);
    const e = Math.min(range.to, pos + node.nodeSize);
    if (e <= s) return false;
    if (lastParent && parent !== lastParent) combined += '\n';
    lastParent = parent;
    const text = node.text!.slice(s - pos, e - pos);
    segs.push({ from: s, to: e, text, marks: node.marks, at: combined.length });
    combined += text;
    return false;
  });
  if (!segs.length) return false;
  const out = transformCase(combined, mode);
  const sameLength = out.length === combined.length;
  const tr = state.tr;
  for (let i = segs.length - 1; i >= 0; i--) {
    const seg = segs[i];
    const next = sameLength ? out.slice(seg.at, seg.at + seg.text.length) : transformCase(seg.text, mode);
    if (next === seg.text) continue;
    tr.replaceWith(seg.from, seg.to, state.schema.text(next, seg.marks));
  }
  if (!tr.docChanged) return true;
  tr.setSelection(TextSelection.create(tr.doc, tr.mapping.map(range.from, -1), tr.mapping.map(range.to)));
  view.dispatch(tr);
  view.focus();
  return true;
}

// ── grow / shrink font ──────────────────────────────────────────────────────

const STEP_SIZES = [8, 9, 10, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72];

export function stepFontSize(editor: Editor, direction: 1 | -1): void {
  const raw = (editor.getAttributes('textStyle').fontSize as string | undefined) ?? '';
  const current = parseFloat(raw) || (editor.isActive('heading', { level: 1 }) ? 20 : editor.isActive('heading', { level: 2 }) ? 16 : editor.isActive('heading', { level: 3 }) ? 14 : 11);
  const next =
    direction > 0
      ? (STEP_SIZES.find((s) => s > current) ?? current + 12)
      : ([...STEP_SIZES].reverse().find((s) => s < current) ?? Math.max(1, current - 1));
  editor.chain().focus().setFontSize(`${next}pt`).run();
}

// ── line spacing ────────────────────────────────────────────────────────────

/** Word's line-spacing choices and the CSS line-height each one is stored as. */
export const LINE_SPACINGS = [1, 1.15, 1.5, 2, 2.5, 3].map((word) => ({
  word,
  css: String(Math.round(word * CSS_LINE_PER_WORD_LINE * 100) / 100),
}));

// ── sort ────────────────────────────────────────────────────────────────────

const LISTS = new Set(['bulletList', 'orderedList']);

/**
 * Sorts the selected paragraphs (or the items of the list the cursor is in) alphabetically,
 * numbers in numeric order. Returns false when there is nothing to sort.
 */
export function sortSelection(editor: Editor, descending: boolean): boolean {
  const { state, view } = editor;
  const { $from, $to } = state.selection;
  let target: { parent: PMNode; startIndex: number; endIndex: number; start: number; end: number } | null = null;
  const list = $from.blockRange($to, (node) => LISTS.has(node.type.name));
  if (list) {
    target =
      list.endIndex - list.startIndex >= 2
        ? list
        : // one item selected → sort the whole list
          { parent: list.parent, startIndex: 0, endIndex: list.parent.childCount, start: $from.start(list.depth), end: $from.end(list.depth) };
  } else {
    target = $from.blockRange($to);
  }
  if (!target || target.endIndex - target.startIndex < 2) return false;
  const items: PMNode[] = [];
  for (let i = target.startIndex; i < target.endIndex; i++) items.push(target.parent.child(i));
  const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });
  const sorted = [...items].sort((a, b) => collator.compare(a.textContent.trim(), b.textContent.trim()));
  if (descending) sorted.reverse();
  if (sorted.every((n, i) => n === items[i])) return true;
  const tr = state.tr.replaceWith(target.start, target.end, sorted);
  view.dispatch(tr);
  view.focus();
  return true;
}

// ── format painter ──────────────────────────────────────────────────────────

const BLOCK_FORMAT_KEYS = ['textAlign', 'lineHeight', 'spaceBefore', 'spaceAfter', 'indent', 'textIndent', 'shading'];

export interface PaintFormat {
  marks: Mark[];
  block: Record<string, unknown> | null;
}

/** Character formatting of the selection's first text, plus its paragraph formatting. */
export function captureFormat(state: EditorState): PaintFormat {
  const { from, to, empty, $from } = state.selection;
  let marks: readonly Mark[] = empty ? (state.storedMarks ?? $from.marks()) : [];
  if (!empty) {
    let found = false;
    state.doc.nodesBetween(from, to, (node) => {
      if (found) return false;
      if (node.isText) {
        marks = node.marks;
        found = true;
      }
      return !found;
    });
  }
  const parent = $from.parent;
  const block = parent.isTextblock ? Object.fromEntries(BLOCK_FORMAT_KEYS.filter((k) => k in parent.attrs).map((k) => [k, parent.attrs[k]])) : null;
  return { marks: marks.filter((m) => m.type.name !== 'link'), block };
}

/** Applies a captured format to the selection (or the word at the cursor). */
export function applyFormat(editor: Editor, fmt: PaintFormat): void {
  const { state, view } = editor;
  const range = selectionOrWord(state);
  if (!range) return;
  const tr = state.tr;
  for (const type of Object.values(state.schema.marks)) {
    if (type.name !== 'link') tr.removeMark(range.from, range.to, type);
  }
  for (const m of fmt.marks) tr.addMark(range.from, range.to, m);
  if (fmt.block) {
    state.doc.nodesBetween(range.from, range.to, (node, pos) => {
      if (!node.isTextblock) return true;
      const next = { ...node.attrs };
      for (const [k, v] of Object.entries(fmt.block!)) if (k in next) next[k] = v;
      tr.setNodeMarkup(pos, undefined, next);
      return false;
    });
  }
  view.dispatch(tr);
  view.focus();
}
