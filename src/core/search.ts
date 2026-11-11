/** Text search shared by the document and PDF editors' find & replace. */

export interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
}

export interface TextMatch {
  start: number;
  end: number;
}

export const DEFAULT_SEARCH: SearchOptions = { caseSensitive: false, wholeWord: false };

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Builds the matcher, or null for an empty query. */
export function searchRegExp(query: string, opts: SearchOptions): RegExp | null {
  if (!query) return null;
  let src = escapeRegExp(query);
  // "whole word": not touching another letter, digit or underscore (Unicode-aware)
  if (opts.wholeWord) src = `(?<![\\p{L}\\p{N}_])${src}(?![\\p{L}\\p{N}_])`;
  return new RegExp(src, opts.caseSensitive ? 'gu' : 'giu');
}

/** All non-overlapping matches of `query` in `text`. */
export function findMatches(text: string, query: string, opts: SearchOptions = DEFAULT_SEARCH): TextMatch[] {
  const re = searchRegExp(query, opts);
  if (!re) return [];
  const out: TextMatch[] = [];
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length });
  }
  return out;
}

/** Replaces the given matches (any order) in `text`. */
export function replaceMatches(text: string, matches: TextMatch[], replacement: string): string {
  let out = text;
  for (const m of [...matches].sort((a, b) => b.start - a.start)) out = out.slice(0, m.start) + replacement + out.slice(m.end);
  return out;
}
