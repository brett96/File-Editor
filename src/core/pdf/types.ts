/**
 * The PDF editing model. Original PDF bytes are immutable "sources"; the document is an
 * ordered list of pages that each point at a source page (or are blank) and carry overlay
 * objects. Saving replays this model into a new PDF (see apply-edits.ts).
 *
 * Object coordinates are in *view space*: points (1/72 in), origin at the top-left of the
 * page as it is displayed with its intrinsic /Rotate applied but before the user's extra
 * `rotation`. This means objects stay glued to the page content when the user rotates a page.
 */

export type PdfFontFamily = 'Helvetica' | 'Times' | 'Courier';

export interface PdfSource {
  id: string;
  bytes: Uint8Array;
  name?: string;
}

interface Base {
  id: string;
}

export interface PdfTextObject extends Base {
  type: 'text';
  x: number;
  y: number;
  text: string;
  fontSize: number;
  fontFamily: PdfFontFamily;
  bold: boolean;
  italic: boolean;
  /** #rrggbb */
  color: string;
  /** Makes the text a clickable link. */
  url?: string;
  /**
   * Present when this object replaces existing page text: the original run is painted over
   * with `color` before the new text is drawn.
   */
  cover?: { x: number; y: number; width: number; height: number; color: string };
}

export interface PdfImageObject extends Base {
  type: 'image';
  x: number;
  y: number;
  width: number;
  height: number;
  /** PNG or JPEG data URL (other formats are converted on insert). */
  dataUrl: string;
}

export interface PdfShapeObject extends Base {
  type: 'rect' | 'ellipse';
  x: number;
  y: number;
  width: number;
  height: number;
  stroke: string | null;
  fill: string | null;
  strokeWidth: number;
}

export interface PdfLineObject extends Base {
  type: 'line';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  stroke: string;
  strokeWidth: number;
}

export interface PdfHighlightObject extends Base {
  type: 'highlight';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface PdfWhiteoutObject extends Base {
  type: 'whiteout';
  x: number;
  y: number;
  width: number;
  height: number;
  color: string;
}

export interface PdfInkObject extends Base {
  type: 'ink';
  points: [number, number][];
  stroke: string;
  strokeWidth: number;
}

export interface PdfLinkObject extends Base {
  type: 'link';
  x: number;
  y: number;
  width: number;
  height: number;
  url: string;
}

export type PdfObject =
  | PdfTextObject
  | PdfImageObject
  | PdfShapeObject
  | PdfLineObject
  | PdfHighlightObject
  | PdfWhiteoutObject
  | PdfInkObject
  | PdfLinkObject;

export type PdfBoxObject = Exclude<PdfObject, PdfLineObject | PdfInkObject | PdfTextObject>;

export interface PdfPageModel {
  id: string;
  /** null for a blank page. */
  sourceId: string | null;
  /** Zero-based page index inside the source. */
  sourcePage: number;
  /** View-space size in points (intrinsic rotation applied, user rotation not). */
  width: number;
  height: number;
  /** Extra clockwise rotation chosen by the user. */
  rotation: 0 | 90 | 180 | 270;
  objects: PdfObject[];
}

export interface PdfSession {
  sources: PdfSource[];
  pages: PdfPageModel[];
}

export interface PdfPermissions {
  printing: boolean;
  modifying: boolean;
  copying: boolean;
  annotating: boolean;
}

export interface PdfProtection {
  /** Required to open the document. Empty string = anyone can open, restrictions only. */
  userPassword: string;
  /** Required to change permissions / remove protection. Defaults to the user password. */
  ownerPassword?: string;
  permissions?: Partial<PdfPermissions>;
}

export interface PdfSaveOptions {
  title?: string;
  protection?: PdfProtection | null;
}

/** CSS font stack + metrics used so on-screen text boxes match what is written to the PDF. */
export const PDF_FONTS: Record<PdfFontFamily, { css: string; baseline: number; label: string }> = {
  // baseline = distance from the top of a 1.2 line box to the text baseline, in em
  Helvetica: { css: 'Arial, Helvetica, sans-serif', baseline: 0.9465, label: 'Sans (Helvetica)' },
  Times: { css: '"Times New Roman", Times, serif', baseline: 0.9375, label: 'Serif (Times)' },
  Courier: { css: '"Courier New", Courier, monospace', baseline: 0.8665, label: 'Mono (Courier)' },
};

export const PDF_LINE_HEIGHT = 1.2;

let counter = 0;
export function newId(prefix = 'o'): string {
  counter += 1;
  return `${prefix}${Date.now().toString(36)}${counter.toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}
