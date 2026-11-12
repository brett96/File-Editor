/**
 * Shared types for the format engine.
 *
 * Flow documents (DOCX, ODT, RTF, DOC, Markdown, HTML, TXT) are all converted to and
 * from one intermediate representation: an HTML fragment that follows the contract
 * below. The rich-text editor produces exactly this HTML, so every importer feeds the
 * editor and every exporter consumes what the editor emits.
 *
 * ── HTML contract ────────────────────────────────────────────────────────────
 * Blocks : <p> <h1>…<h6> <blockquote> <pre><code> <hr> <ul>/<ol>/<li> (nestable)
 *          <table><tbody><tr><th|td colspan rowspan> (cells contain blocks)
 *          <div data-page-break="true"></div>   (hard page break)
 * Inline : <strong> <em> <u> <s> <sub> <sup> <code> <br>
 *          <a href="…">   <img src="data:…" width height alt>
 *          <span style="color:#rrggbb; font-family:…; font-size:12pt">
 *          <mark data-color="#rrggbb" style="background-color:#rrggbb">
 * Block style: style="text-align:left|center|right|justify" on <p>/<h*>, plus optionally
 *          line-height (unitless or pt), margin-top / margin-bottom (pt), margin-left /
 *          text-indent (pt) and background-color (paragraph shading)
 * Tables : <td>/<th colwidth="px[,px…]"> (one width per spanned column) and
 *          style="background-color; border-top|right|bottom|left: <w>px <style> #rrggbb | none;
 *          vertical-align:top|middle|bottom; padding: T R B L (px, Word's cell margins)";
 *          <tr style="height:Npx"> (minimum row height)
 * Floating images (drawings / ink): <img … data-float-x="px" data-float-y="px" width height> is
 *          positioned relative to the top-left of the block that contains it, outside the text flow
 *          (the editor may wrap the node view for move/resize; HTML still serialises as a plain img);
 *          data-ink="true" marks freehand drawings made in the editor; data-behind="true" puts
 *          the image behind the text. In headers / footers the position is from the page corner.
 *          data-drawingml="…" holds a base64 DrawingML payload so Word shape groups round-trip
 *          as editable shapes (not flattened pictures).
 * Images are always embedded as data: URLs (incl. SVG) — never remote references.
 */

/**
 * CSS line-height that corresponds to Word's "single" (auto, 240) line spacing for the editor's
 * fonts. Word's default 1.08 lines (259) is the editor's default of 1.32.
 */
export const CSS_LINE_PER_WORD_LINE = 1.22;

export type FlowFormat = 'docx' | 'doc' | 'odt' | 'rtf' | 'md' | 'html' | 'txt' | 'css' | 'js';
export type DocFormat = FlowFormat | 'pdf';
export type CodeLanguage = 'html' | 'css' | 'js';

/** Formats edited as source text in the code editor (not TipTap). */
export function isCodeFormat(format: DocFormat): format is CodeLanguage {
  return format === 'html' || format === 'css' || format === 'js';
}

export type PageSize = 'letter' | 'a4' | 'legal';

export interface PageSetup {
  size: PageSize;
  orientation: 'portrait' | 'landscape';
  /** Margins in points (1/72 in). */
  margins: { top: number; right: number; bottom: number; left: number };
  /** Distance from the page edge to the header / footer, in points (default 0.5 in). */
  headerDistance?: number;
  footerDistance?: number;
  /** First page uses headerFirst / footerFirst when set. */
  differentFirstPage?: boolean;
  /** Even pages use headerEven / footerEven when set. */
  differentOddEven?: boolean;
}

/** Word's default header / footer distance (708 twips ≈ 0.49 in), in points. */
export const DEFAULT_HF_DISTANCE = 35.4;

export const DEFAULT_PAGE_SETUP: PageSetup = {
  size: 'letter',
  orientation: 'portrait',
  margins: { top: 72, right: 72, bottom: 72, left: 72 },
};

/** Page dimensions in points, portrait. */
export const PAGE_SIZES: Record<PageSize, { width: number; height: number }> = {
  letter: { width: 612, height: 792 },
  a4: { width: 595.28, height: 841.89 },
  legal: { width: 612, height: 1008 },
};

export function pageDimensions(setup: PageSetup): { width: number; height: number } {
  const s = PAGE_SIZES[setup.size];
  return setup.orientation === 'landscape' ? { width: s.height, height: s.width } : { ...s };
}

/** A flow (word-processor style) document. */
export interface RichDocument {
  /** HTML fragment (no <html>/<body> wrapper) following the contract above. */
  html: string;
  title?: string;
  pageSetup?: PageSetup;
  /**
   * Page header / footer content (same HTML contract), repeated on every page. Floating images
   * in them are positioned from the top-left corner of the page, not of their paragraph.
   */
  header?: string;
  footer?: string;
  /** First-page header / footer when pageSetup.differentFirstPage is set. */
  headerFirst?: string;
  footerFirst?: string;
  /** Even-page header / footer when pageSetup.differentOddEven is set. */
  headerEven?: string;
  footerEven?: string;
}

export type Importer = (bytes: Uint8Array) => Promise<RichDocument>;
export type Exporter = (doc: RichDocument) => Promise<Uint8Array>;

/** Thrown when a file needs a password (none given) or the given one is wrong. */
export class PasswordError extends Error {
  readonly code: 'password-required' | 'password-incorrect';
  constructor(code: 'password-required' | 'password-incorrect', message?: string) {
    super(message ?? (code === 'password-required' ? 'This document is password protected.' : 'Incorrect password.'));
    this.name = 'PasswordError';
    this.code = code;
  }
}

/** Thrown for files we recognise but cannot process (e.g. unsupported encryption scheme). */
export class UnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsupportedError';
  }
}
