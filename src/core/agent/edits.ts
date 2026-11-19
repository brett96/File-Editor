/**
 * Text edits the coding agent proposes, and the diffs shown before they are applied.
 * Pure functions (no React, no DOM), unit-tested in tests/agent.test.ts.
 */

/**
 * Replaces `oldString` with `newString` in `text`. `oldString` must occur exactly once unless
 * `replaceAll` is set, so an edit can't land in the wrong place. Windows line endings in the
 * file are matched by an `oldString` written with plain "\n".
 */
export function applyEdit(text: string, oldString: string, newString: string, replaceAll = false): { text: string; count: number } | { error: string } {
  if (!oldString) return { error: 'old_string is empty. Use write_file to create or replace a whole file.' };
  if (oldString === newString) return { error: 'old_string and new_string are the same.' };
  let find = oldString;
  let put = newString;
  if (!text.includes(find) && text.includes('\r\n') && !find.includes('\r\n')) {
    find = find.replace(/\n/g, '\r\n');
    put = put.replace(/\r?\n/g, '\r\n');
  }
  const count = countOf(text, find);
  if (count === 0) return { error: 'old_string was not found in the file. Read the file again and copy the text exactly, including indentation.' };
  if (count > 1 && !replaceAll) return { error: `old_string occurs ${count} times. Include more of the surrounding lines so it is unique, or set replace_all.` };
  return { text: replaceAll ? text.split(find).join(put) : text.replace(find, () => put), count };
}

function countOf(text: string, find: string): number {
  let n = 0;
  for (let i = text.indexOf(find); i >= 0; i = text.indexOf(find, i + find.length)) n++;
  return n;
}

/** The smallest single change that turns `a` into `b`: keeps the cursor and makes one undo step. */
export function minimalChange(a: string, b: string): { from: number; to: number; insert: string } | null {
  if (a === b) return null;
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) {
    endA--;
    endB--;
  }
  return { from: start, to: endA, insert: b.slice(start, endB) };
}

export interface DiffLine {
  kind: 'same' | 'add' | 'del' | 'gap';
  text: string;
  /** line numbers in the old / new text (1-based) */
  a?: number;
  b?: number;
}

export interface Diff {
  lines: DiffLine[];
  added: number;
  removed: number;
}

const MAX_DIFF_CELLS = 4_000_000;

/**
 * A line diff with `context` unchanged lines around each change; longer unchanged stretches
 * become one 'gap' line. Very large rewrites fall back to "all old lines out, all new lines in".
 */
export function lineDiff(before: string, after: string, context = 3): Diff {
  const a = splitLines(before);
  const b = splitLines(after);
  // trim the common head and tail first: most edits touch a few lines of a long file
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);

  const ops: DiffLine[] = [];
  for (let i = 0; i < head; i++) ops.push({ kind: 'same', text: a[i], a: i + 1, b: i + 1 });
  if (midA.length * midB.length > MAX_DIFF_CELLS) {
    midA.forEach((t, i) => ops.push({ kind: 'del', text: t, a: head + i + 1 }));
    midB.forEach((t, i) => ops.push({ kind: 'add', text: t, b: head + i + 1 }));
  } else {
    // LCS table over the changed middle
    const n = midA.length;
    const m = midB.length;
    const w = m + 1;
    const dp = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n || j < m) {
      if (i < n && j < m && midA[i] === midB[j]) {
        ops.push({ kind: 'same', text: midA[i], a: head + i + 1, b: head + j + 1 });
        i++;
        j++;
      } else if (i < n && (j >= m || dp[(i + 1) * w + j] >= dp[i * w + j + 1])) {
        // removals before additions, as diffs are usually read
        ops.push({ kind: 'del', text: midA[i], a: head + i + 1 });
        i++;
      } else {
        ops.push({ kind: 'add', text: midB[j], b: head + j + 1 });
        j++;
      }
    }
  }
  const offA = a.length - tail;
  const offB = b.length - tail;
  for (let k = 0; k < tail; k++) ops.push({ kind: 'same', text: a[offA + k], a: offA + k + 1, b: offB + k + 1 });

  // keep `context` lines around changes
  const keep = new Uint8Array(ops.length);
  ops.forEach((op, k) => {
    if (op.kind === 'same') return;
    for (let x = Math.max(0, k - context); x <= Math.min(ops.length - 1, k + context); x++) keep[x] = 1;
  });
  const lines: DiffLine[] = [];
  let added = 0;
  let removed = 0;
  for (let k = 0; k < ops.length; k++) {
    const op = ops[k];
    if (op.kind === 'add') added++;
    if (op.kind === 'del') removed++;
    if (keep[k]) lines.push(op);
    else if (lines[lines.length - 1]?.kind !== 'gap') lines.push({ kind: 'gap', text: '' });
  }
  if (lines.length && lines[lines.length - 1].kind === 'gap' && !lines.some((l) => l.kind !== 'gap')) lines.length = 0;
  return { lines, added, removed };
}

function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.split(/\r?\n/);
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** True for content that is not text (a NUL byte near the start, as git decides). */
export function looksBinary(bytes: Uint8Array): boolean {
  const n = Math.min(bytes.length, 8000);
  for (let i = 0; i < n; i++) if (bytes[i] === 0) return true;
  return false;
}

/** Cuts `text` to `max` characters on a line boundary, saying how much was left out. */
export function clip(text: string, max: number): { text: string; clipped: boolean } {
  if (text.length <= max) return { text, clipped: false };
  const cut = text.lastIndexOf('\n', max);
  return { text: text.slice(0, cut > max * 0.6 ? cut : max), clipped: true };
}

/** Lines `start`–`end` (1-based, inclusive) of `text`. */
export function sliceLines(text: string, start?: number, end?: number): { text: string; from: number; to: number; total: number } {
  const lines = text.split('\n');
  const total = lines.length;
  const from = Math.max(1, Math.min(total, Math.floor(start ?? 1)));
  const to = Math.max(from, Math.min(total, Math.floor(end ?? total)));
  return { text: lines.slice(from - 1, to).join('\n'), from, to, total };
}
