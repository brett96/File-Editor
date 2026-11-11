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
 * Block style: style="text-align:left|center|right|justify" on <p>/<h*>
 * Images are always embedded as data: URLs — never remote references.
 */

export type FlowFormat = 'docx' | 'doc' | 'odt' | 'rtf' | 'md' | 'html' | 'txt';
export type DocFormat = FlowFormat | 'pdf';

export type PageSize = 'letter' | 'a4' | 'legal';

export interface PageSetup {
  size: PageSize;
  orientation: 'portrait' | 'landscape';
  /** Margins in points (1/72 in). */
  margins: { top: number; right: number; bottom: number; left: number };
}

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
