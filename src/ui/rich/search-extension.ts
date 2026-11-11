/**
 * Find & replace for the rich-text editor. A ProseMirror plugin keeps the match list (recomputed
 * as the document changes) and draws the highlights as decorations, so the document itself is
 * never touched until something is replaced.
 */
import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey, TextSelection, type EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import { DEFAULT_SEARCH, findMatches, type SearchOptions } from '../../core/search';

export interface DocMatch {
  from: number;
  to: number;
}

interface FindState {
  query: string;
  options: SearchOptions;
  matches: DocMatch[];
  current: number;
  decorations: DecorationSet;
}

interface FindMeta {
  query?: string;
  options?: SearchOptions;
  current?: number;
}

export const findKey = new PluginKey<FindState>('find');

/** Matches never span paragraphs; inline images / breaks act as separators. */
function computeMatches(doc: PMNode, query: string, options: SearchOptions): DocMatch[] {
  const out: DocMatch[] = [];
  if (!query) return out;
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return true;
    let text = '';
    const map: number[] = [];
    node.forEach((child, offset) => {
      const start = pos + 1 + offset;
      if (child.isText && child.text) {
        for (let i = 0; i < child.text.length; i++) map.push(start + i);
        text += child.text;
      } else {
        map.push(start);
        text += '￼';
      }
    });
    for (const m of findMatches(text, query, options)) out.push({ from: map[m.start], to: map[m.end - 1] + 1 });
    return false;
  });
  return out;
}

function decorate(doc: PMNode, matches: DocMatch[], current: number): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) => Decoration.inline(m.from, m.to, { class: i === current ? 'search-match search-match-current' : 'search-match' })),
  );
}

export const FindReplace = Extension.create({
  name: 'findReplace',
  addProseMirrorPlugins() {
    return [
      new Plugin<FindState>({
        key: findKey,
        state: {
          init: () => ({ query: '', options: DEFAULT_SEARCH, matches: [], current: -1, decorations: DecorationSet.empty }),
          apply(tr: Transaction, prev: FindState, _old: EditorState, state: EditorState): FindState {
            const meta = tr.getMeta(findKey) as FindMeta | undefined;
            if (!meta && !tr.docChanged) return prev;
            const query = meta?.query ?? prev.query;
            const options = meta?.options ?? prev.options;
            const matches = meta?.query !== undefined || meta?.options || tr.docChanged ? computeMatches(state.doc, query, options) : prev.matches;
            let current: number;
            if (meta?.current !== undefined) current = meta.current;
            else if (meta?.query !== undefined || meta?.options) {
              // start from the match at / after the cursor, like a word processor
              const from = state.selection.from;
              const idx = matches.findIndex((m) => m.to > from);
              current = matches.length ? (idx < 0 ? 0 : idx) : -1;
            } else current = Math.min(prev.current, matches.length - 1);
            if (matches.length && current < 0) current = 0;
            return { query, options, matches, current, decorations: decorate(state.doc, matches, current) };
          },
        },
        props: {
          decorations: (state) => findKey.getState(state)?.decorations,
        },
      }),
    ];
  },
});

export function getFind(view: EditorView): FindState {
  return findKey.getState(view.state)!;
}

export function setSearch(view: EditorView, query: string, options: SearchOptions): void {
  view.dispatch(view.state.tr.setMeta(findKey, { query, options } satisfies FindMeta).setMeta('addToHistory', false));
}

/** Selects and scrolls to match `index` (wrapping around). */
export function gotoMatch(view: EditorView, index: number): void {
  const { matches } = getFind(view);
  if (!matches.length) return;
  const i = ((index % matches.length) + matches.length) % matches.length;
  const m = matches[i];
  const tr = view.state.tr.setMeta(findKey, { current: i } satisfies FindMeta).setSelection(TextSelection.create(view.state.doc, m.from, m.to)).setMeta('addToHistory', false);
  view.dispatch(tr);
  scrollMatchIntoView(view, m.from);
}

/** The decorations are already in the DOM once dispatch returns, so this can run straight away. */
function scrollMatchIntoView(view: EditorView, pos: number): void {
  const el = view.dom.querySelector('.search-match-current') as HTMLElement | null;
  const target = el ?? (() => {
    const at = view.domAtPos(pos).node as HTMLElement;
    return at.nodeType === 1 ? at : at.parentElement;
  })();
  target?.scrollIntoView({ block: 'center', inline: 'nearest' });
}

/** Replaces the current match, keeping its formatting, and moves on to the next one. */
export function replaceCurrent(view: EditorView, replacement: string): boolean {
  const { matches, current } = getFind(view);
  const m = matches[current];
  if (!m) return false;
  const tr = view.state.tr;
  if (replacement) tr.insertText(replacement, m.from, m.to);
  else tr.delete(m.from, m.to);
  tr.setMeta(findKey, { current } satisfies FindMeta);
  view.dispatch(tr);
  const after = getFind(view);
  if (after.matches.length) gotoMatch(view, Math.min(current, after.matches.length - 1));
  return true;
}

/** Replaces every match in one undoable step. Returns how many were replaced. */
export function replaceAll(view: EditorView, replacement: string): number {
  const { matches } = getFind(view);
  if (!matches.length) return 0;
  const tr = view.state.tr;
  for (const m of [...matches].reverse()) {
    if (replacement) tr.insertText(replacement, m.from, m.to);
    else tr.delete(m.from, m.to);
  }
  view.dispatch(tr);
  return matches.length;
}
