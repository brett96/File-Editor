/**
 * Bridges the slide model and the browser's rich-text editing. A text box being edited is a
 * contentEditable element seeded with paragraphsHtml(); when editing ends (or formatting is
 * applied) its DOM is read back into Paragraph[] here. Whatever the browser or a paste left
 * in the DOM, only text and the formatting the model knows comes out.
 */
import { PX_PER_PT, normalizeParagraph, type Align, type Paragraph, type TextRun } from '../../core/slides/model';
import type { TextStyle } from '../../core/slides/render';

function toHex(color: string): string | null {
  const c = color.trim();
  if (/^#[0-9a-f]{6}$/i.test(c)) return c.toLowerCase();
  if (/^#[0-9a-f]{3}$/i.test(c)) return `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`.toLowerCase();
  const m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/i.exec(c);
  if (!m) return null;
  return `#${[m[1], m[2], m[3]].map((v) => Math.min(255, Number(v)).toString(16).padStart(2, '0')).join('')}`;
}

const BLOCKS = /^(DIV|P|LI|H[1-6]|BLOCKQUOTE|PRE|TR)$/;

/** Formatting an element adds to the text inside it. */
function styleOf(el: HTMLElement, into: Omit<TextRun, 'text'>): void {
  const tag = el.tagName;
  const st = el.style;
  if (tag === 'B' || tag === 'STRONG') into.bold = true;
  if (tag === 'I' || tag === 'EM') into.italic = true;
  if (tag === 'U') into.underline = true;
  if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') into.strike = true;
  if (el.dataset.b === '1') into.bold = true;
  else if (el.dataset.b === '0') into.bold = false;
  if (st.fontWeight) into.bold = st.fontWeight === 'bold' || Number(st.fontWeight) >= 600;
  if (st.fontStyle) into.italic = st.fontStyle === 'italic';
  const deco = `${st.textDecorationLine} ${st.textDecoration}`;
  if (/underline/.test(deco)) into.underline = true;
  if (/line-through/.test(deco)) into.strike = true;
  const color = st.color ? toHex(st.color) : tag === 'FONT' && el.getAttribute('color') ? toHex(el.getAttribute('color')!) : null;
  if (color) into.color = color;
  if (st.fontSize && st.fontSize.endsWith('px')) into.size = Math.round((parseFloat(st.fontSize) / PX_PER_PT) * 10) / 10;
  else if (st.fontSize && st.fontSize.endsWith('pt')) into.size = parseFloat(st.fontSize);
  const face = st.fontFamily || (tag === 'FONT' ? el.getAttribute('face') ?? '' : '');
  if (face) into.font = face.replace(/"/g, "'").replace(/[^\w\s,'-]/g, '');
  const link = el.dataset.link ?? (tag === 'A' ? el.getAttribute('href') : null);
  if (link && /^(https?:|mailto:)/i.test(link)) into.link = link;
}

/** Reads the paragraphs of an editable text box back out of its DOM. */
export function readEditable(root: HTMLElement, d: TextStyle): Paragraph[] {
  const out: Paragraph[] = [];
  let cur: Paragraph | null = null;
  const start = (block: HTMLElement | null) => {
    cur = { runs: [] };
    const ds = block?.dataset ?? {};
    const bullet = ds.bullet;
    if (bullet === 'bullet' || bullet === 'number' || bullet === 'none') cur.bullet = bullet;
    const level = Number(ds.level);
    if (level > 0) cur.level = Math.min(8, level);
    const align = (ds.align ?? block?.style.textAlign) as Align | undefined;
    if (align === 'center' || align === 'right' || align === 'justify') cur.align = align;
    if (ds.ls && Number(ds.ls) > 0) cur.lineSpacing = Number(ds.ls);
    out.push(cur);
  };
  const walk = (node: Node, style: Omit<TextRun, 'text'>) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = (node.nodeValue ?? '').replace(/​/g, '');
      if (!text) return;
      if (!cur) start(null);
      cur!.runs.push({ text, ...style });
      return;
    }
    if (!(node instanceof HTMLElement)) return;
    if (node.tagName === 'BR') {
      // a <br> that is the only thing in a paragraph just holds the empty line open
      const only = node.parentElement && node.parentElement.textContent === '' && !node.nextSibling && !node.previousSibling;
      const last = !node.nextSibling;
      if (!only && !last && cur) cur.runs.push({ text: '\n', ...style });
      return;
    }
    const mine = { ...style };
    styleOf(node, mine);
    if (BLOCKS.test(node.tagName) && node !== root) {
      // a block directly holding other blocks is only a wrapper
      const nested = Array.from(node.children).some((c) => BLOCKS.test(c.tagName));
      if (!nested) {
        start(node);
        node.childNodes.forEach((c) => walk(c, mine));
        if (!cur!.runs.length) cur!.runs.push({ text: '', ...mine });
        cur = null;
        return;
      }
    }
    node.childNodes.forEach((c) => walk(c, mine));
  };
  root.childNodes.forEach((c) => walk(c, {}));
  const paragraphs = out.filter((p) => p.runs.length).map((p) => {
    // drop formatting that only repeats the box's defaults
    const runs = p.runs.map((r) => {
      const run: TextRun = { ...r };
      if (run.size !== undefined && Math.abs(run.size - d.size) < 0.05) delete run.size;
      if (run.color && run.color.toLowerCase() === (toHex(d.color) ?? '').toLowerCase()) delete run.color;
      if (run.bold === false && !d.bold) delete run.bold;
      if (run.italic === false) delete run.italic;
      return run;
    });
    return normalizeParagraph({ ...p, runs });
  });
  return paragraphs.length ? paragraphs : [{ runs: [{ text: '' }] }];
}

/** The paragraph block a DOM position is in. The browser may put the caret between blocks, on the root itself. */
function blockAt(root: HTMLElement, node: Node | null, offset: number): HTMLElement | null {
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-p]'));
  if (!node || !root.contains(node)) return null;
  if (node === root) {
    const child = root.childNodes[Math.min(offset, root.childNodes.length - 1)] ?? null;
    return blocks.find((b) => b === child || (child && b.contains(child))) ?? blocks[blocks.length - 1] ?? null;
  }
  return blocks.find((b) => b.contains(node)) ?? null;
}

/** The paragraph blocks the selection touches inside `root` (all of them when nothing in it is selected). */
export function selectedBlocks(root: HTMLElement): HTMLElement[] {
  const sel = window.getSelection();
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-p]'));
  if (!sel || !sel.rangeCount || !root.contains(sel.anchorNode)) return blocks;
  if (sel.isCollapsed) {
    // just the caret: its own paragraph, not the neighbours whose edge it touches
    const b = blockAt(root, sel.anchorNode, sel.anchorOffset);
    return b ? [b] : blocks;
  }
  const range = sel.getRangeAt(0);
  const hit = blocks.filter((b) => {
    if (!range.intersectsNode(b)) return false;
    // a selection that only touches a block's very start or end does not include it
    const r = document.createRange();
    r.selectNodeContents(b);
    return range.compareBoundaryPoints(Range.END_TO_START, r) < 0 && range.compareBoundaryPoints(Range.START_TO_END, r) > 0;
  });
  return hit.length ? hit : blocks;
}

/** Index of the paragraph the caret is in (for putting it back after the text is re-drawn). */
export function caretParagraph(root: HTMLElement): number {
  const sel = window.getSelection();
  const blocks = Array.from(root.querySelectorAll<HTMLElement>('[data-p]'));
  const b = sel ? blockAt(root, sel.anchorNode, sel.anchorOffset) : null;
  const i = b ? blocks.indexOf(b) : -1;
  return i < 0 ? blocks.length - 1 : i;
}

export function placeCaret(root: HTMLElement, paragraph = -1): void {
  const blocks = root.querySelectorAll<HTMLElement>('[data-p]');
  const target = blocks[paragraph < 0 ? blocks.length - 1 : Math.min(paragraph, blocks.length - 1)] ?? root;
  const range = document.createRange();
  range.selectNodeContents(target);
  range.collapse(false);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

export function selectAllText(root: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(root);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}

/**
 * Applies a font size (pt) to the selected text. The browser's own command only knows seven
 * sizes, so it is used to mark the selection and the marks are then given the real size.
 */
export function applyFontSize(root: HTMLElement, pt: number): void {
  document.execCommand('styleWithCSS', false, 'true');
  document.execCommand('fontSize', false, '7');
  root.querySelectorAll<HTMLElement>('font[size="7"], span').forEach((el) => {
    if (el.tagName === 'FONT') {
      const span = document.createElement('span');
      span.style.fontSize = `${pt * PX_PER_PT}px`;
      while (el.firstChild) span.appendChild(el.firstChild);
      el.replaceWith(span);
    } else if (/xxx-large|-webkit-xxx-large/.test(el.style.fontSize)) el.style.fontSize = `${pt * PX_PER_PT}px`;
  });
  // text inside the marked range keeps any smaller size it had: the new size wins
  root.querySelectorAll<HTMLElement>('span span').forEach((el) => {
    const parent = el.parentElement;
    if (parent && parent.style.fontSize === `${pt * PX_PER_PT}px` && el.style.fontSize) el.style.fontSize = '';
  });
}
