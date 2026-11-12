import { describe, expect, it } from 'vitest';
import { findMatches, replaceMatches } from '../src/core/search';

describe('findMatches', () => {
  it('is case-insensitive by default and finds every occurrence', () => {
    expect(findMatches('Cat cat CAT scatter', 'cat')).toEqual([
      { start: 0, end: 3 },
      { start: 4, end: 7 },
      { start: 8, end: 11 },
      { start: 13, end: 16 },
    ]);
  });

  it('honours match case and whole word', () => {
    expect(findMatches('Cat cat CAT', 'cat', { caseSensitive: true, wholeWord: false })).toEqual([{ start: 4, end: 7 }]);
    expect(findMatches('cat scatter cat_x cat.', 'cat', { caseSensitive: false, wholeWord: true })).toEqual([
      { start: 0, end: 3 },
      { start: 18, end: 21 },
    ]);
    // Unicode letters count as word characters
    expect(findMatches('café cafés', 'café', { caseSensitive: false, wholeWord: true })).toEqual([{ start: 0, end: 4 }]);
  });

  it('treats regex characters literally', () => {
    expect(findMatches('a.b axb (x) $5', '.')).toEqual([{ start: 1, end: 2 }]);
    expect(findMatches('cost (x) $5', '(x)')).toEqual([{ start: 5, end: 8 }]);
    expect(findMatches('cost $5', '$5')).toEqual([{ start: 5, end: 7 }]);
  });

  it('returns nothing for an empty query', () => {
    expect(findMatches('abc', '')).toEqual([]);
  });
});

describe('replaceMatches', () => {
  it('replaces one or all matches, longer or shorter', () => {
    const t = 'one two one two';
    const m = findMatches(t, 'one');
    expect(replaceMatches(t, m, 'three')).toBe('three two three two');
    expect(replaceMatches(t, [m[1]], '1')).toBe('one two 1 two');
    expect(replaceMatches(t, m, '')).toBe(' two  two');
  });
});
