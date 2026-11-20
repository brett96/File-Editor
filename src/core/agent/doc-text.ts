/**
 * A Word-style document as the coding agent sees it, and its edits applied to the document
 * itself (src/ui/rich), so formatting around an edit is kept.
 *
 * The agent works with plain text: one line per paragraph (headings, list items and table cells
 * are paragraphs too), a line break inside a paragraph is also a newline. Every character of
 * that text knows where it sits in the ProseMirror document, so "replace this text with that"
 * becomes a change to exactly those characters. Pure ProseMirror model code: unit-tested
 * without an editor (tests/agent-docs.test.ts).
 */
import type { Mark, Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { minimalChange } from './edits';

export interface LinearText {
  text: string;
  /** document position where character i starts */
  starts: number[];
  /** document position where character i ends */
  ends: number[];
  /** paragraph styles, for the agent's outline: [line index, label] */
  outline: [number, string][];
}

const blockLabel = (node: PMNode, parent: PMNode | null): string | null => {
  if (node.type.name === 'heading') return `Heading ${node.attrs.level ?? 1}`;
  if (parent?.type.name === 'listItem') return 'List item';
  if (node.type.name === 'codeBlock') return 'Code';
  return null;
};

/** The document's text, and where each character of it is. */
export function linearize(doc: PMNode): LinearText {
  let text = '';
  const starts: number[] = [];
  const ends: number[] = [];
  const outline: [number, string][] = [];
  let line = 0;
  let prevEnd = -1;
  doc.descendants((node, pos, parent) => {
    if (!node.isTextblock) return true;
    if (prevEnd >= 0) {
      // the newline between two paragraphs spans from the end of one to the start of the next
      text += '\n';
      starts.push(prevEnd);
      ends.push(pos + 1);
      line++;
    }
    const label = blockLabel(node, parent);
    if (label) outline.push([line, label]);
    node.forEach((child, offset) => {
      const at = pos + 1 + offset;
      if (child.isText) {
        const t = child.text ?? '';
        for (let i = 0; i < t.length; i++) {
          text += t[i];
          starts.push(at + i);
          ends.push(at + i + 1);
        }
      } else if (child.type.name === 'hardBreak') {
        text += '\n';
        starts.push(at);
        ends.push(at + 1);
        line++;
      }
      // other inline nodes (pictures, drawings) aren't text: the agent doesn't see them
    });
    prevEnd = pos + node.nodeSize - 1;
    return false;
  });
  return { text, starts, ends, outline };
}

/** Where `find` occurs in `text` (at most `limit` times). */
function occurrences(text: string, find: string, limit = 10_000): number[] {
  const out: number[] = [];
  for (let i = text.indexOf(find); i >= 0 && out.length < limit; i = text.indexOf(find, i + find.length)) out.push(i);
  return out;
}

/**
 * Replaces `oldString` with `newString` in the document, as one transaction: the same rules as
 * a code edit (it must occur exactly once unless `replaceAll`). New text takes the formatting
 * of the text it replaces; a newline in it starts a new paragraph of the same kind.
 */
export function editDocument(tr: Transaction, oldString: string, newString: string, replaceAll = false): { count: number } | { error: string } {
  if (!oldString) return { error: 'old_string is empty. Use write_file to rewrite the whole document.' };
  if (oldString === newString) return { error: 'old_string and new_string are the same.' };
  const lin = linearize(tr.doc);
  const found = occurrences(lin.text, oldString);
  if (!found.length) return { error: 'old_string was not found in the document. Read it again and copy the text exactly (one line per paragraph).' };
  if (found.length > 1 && !replaceAll) return { error: `old_string occurs ${found.length} times. Include more of the surrounding text so it is unique, or set replace_all.` };
  // only the part that differs is replaced, so unchanged words keep their own formatting
  const change = minimalChange(oldString, newString)!;
  // last first, so earlier positions stay valid
  for (const i of [...found].reverse()) {
    const a = i + change.from;
    const b = i + change.to;
    // an insertion goes after the character before it (or before the first one at the start)
    const from = b > a ? lin.starts[a] : a > 0 ? lin.ends[a - 1] : lin.starts[0];
    const to = b > a ? lin.ends[b - 1] : from;
    replaceRange(tr, from, to, change.insert);
  }
  return { count: found.length };
}

/** Puts `text` (newlines start paragraphs) in place of the document range from–to. */
export function replaceRange(tr: Transaction, from: number, to: number, text: string): void {
  const schema = tr.doc.type.schema;
  // the formatting of the first replaced character (or of the text just before an insertion)
  const first = to > from ? tr.doc.nodeAt(from) : null;
  const marks: readonly Mark[] = first?.isText ? first.marks : tr.doc.resolve(from).marks();
  if (to > from) tr.delete(from, to);
  let at = from;
  text.split('\n').forEach((line, k) => {
    if (k > 0) {
      tr.split(at);
      at += 2;
    }
    if (line) {
      tr.insert(at, schema.text(line, marks));
      at += line.length;
    }
  });
}

/** The text of the document between two positions, lines as in linearize. */
export function lineOf(lin: LinearText, pos: number): number {
  let line = 1;
  for (let i = 0; i < lin.text.length && lin.starts[i] < pos; i++) if (lin.text[i] === '\n') line++;
  return line;
}
