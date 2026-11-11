import {
  BlendMode,
  LineCapStyle,
  PDFDocument,
  PDFFont,
  PDFImage,
  PDFPage,
  PDFString,
  StandardFonts,
  concatTransformationMatrix,
  degrees,
  popGraphicsState,
  pushGraphicsState,
  rgb,
} from '@cantoo/pdf-lib';
import { cssColorToHex, parseDataUrl } from '../dom';
import {
  PDF_FONTS,
  PDF_LINE_HEIGHT,
  type PdfFontFamily,
  type PdfObject,
  type PdfPageModel,
  type PdfProtection,
  type PdfSaveOptions,
  type PdfSession,
  type PdfTextObject,
} from './types';

type Matrix = [number, number, number, number, number, number];

function color(hex: string | null | undefined, fallback = '000000') {
  const h = cssColorToHex(hex) ?? fallback;
  return rgb(parseInt(h.slice(0, 2), 16) / 255, parseInt(h.slice(2, 4), 16) / 255, parseInt(h.slice(4, 6), 16) / 255);
}

function normRotation(angle: number): 0 | 90 | 180 | 270 {
  const a = (((Math.round(angle / 90) * 90) % 360) + 360) % 360;
  return a as 0 | 90 | 180 | 270;
}

/**
 * Geometry of a page: maps "view space, y up" (origin bottom-left of the page as displayed
 * with its intrinsic rotation) into PDF default user space.
 */
export function pageGeometry(box: { x: number; y: number; width: number; height: number }, rotation: number) {
  const r = normRotation(rotation);
  const x0 = box.x;
  const y0 = box.y;
  const x1 = box.x + box.width;
  const y1 = box.y + box.height;
  let matrix: Matrix;
  switch (r) {
    case 90:
      matrix = [0, 1, -1, 0, x1, y0];
      break;
    case 180:
      matrix = [-1, 0, 0, -1, x1, y1];
      break;
    case 270:
      matrix = [0, -1, 1, 0, x0, y1];
      break;
    default:
      matrix = [1, 0, 0, 1, x0, y0];
  }
  const swap = r === 90 || r === 270;
  return {
    rotation: r,
    matrix,
    viewWidth: swap ? box.height : box.width,
    viewHeight: swap ? box.width : box.height,
  };
}

function applyMatrix(m: Matrix, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

const FONT_TABLE: Record<PdfFontFamily, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  // [regular, bold, italic, bold-italic]
  Helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  Times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  Courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

class FontCache {
  private cache = new Map<string, PDFFont>();
  private charsets = new Map<string, Set<number>>();
  constructor(private doc: PDFDocument) {}

  async get(family: PdfFontFamily, bold: boolean, italic: boolean): Promise<{ font: PDFFont; charset: Set<number> }> {
    const name = FONT_TABLE[family][(bold ? 1 : 0) + (italic ? 2 : 0)];
    let font = this.cache.get(name);
    if (!font) {
      font = await this.doc.embedFont(name);
      this.cache.set(name, font);
      this.charsets.set(name, new Set(font.getCharacterSet()));
    }
    return { font, charset: this.charsets.get(name)! };
  }
}

const FALLBACK_CHARS: Record<string, string> = {
  '‐': '-', '‑': '-', '−': '-', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ', ' ': ' ',
  '​': '', '﻿': '', '→': '->', '←': '<-', '✓': 'v', '✔': 'v', '●': '•', '◦': 'o',
  '▪': '•', '•': '•',
};

/** The standard 14 fonts only cover WinAnsi; map what we can and replace the rest. */
export function fitToCharset(text: string, charset: Set<number>): string {
  let out = '';
  for (const ch of text.replace(/\t/g, '    ')) {
    const cp = ch.codePointAt(0)!;
    if (charset.has(cp)) {
      out += ch;
      continue;
    }
    const mapped = FALLBACK_CHARS[ch];
    if (mapped !== undefined && [...mapped].every((c) => charset.has(c.codePointAt(0)!))) {
      out += mapped;
      continue;
    }
    // strip combining marks from decomposed forms (é typed as e + ´ etc.)
    const base = ch.normalize('NFKD').replace(/[̀-ͯ]/g, '');
    if (base && base !== ch && [...base].every((c) => charset.has(c.codePointAt(0)!))) {
      out += base;
      continue;
    }
    out += '?';
  }
  return out;
}

async function embedImage(doc: PDFDocument, dataUrl: string, cache: Map<string, PDFImage>): Promise<PDFImage | null> {
  const hit = cache.get(dataUrl);
  if (hit) return hit;
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return null;
  try {
    const img = /jpe?g/i.test(parsed.mime) ? await doc.embedJpg(parsed.bytes) : await doc.embedPng(parsed.bytes);
    cache.set(dataUrl, img);
    return img;
  } catch {
    return null;
  }
}

function addLinkAnnotation(doc: PDFDocument, page: PDFPage, m: Matrix, viewH: number, rect: { x: number; y: number; width: number; height: number }, url: string) {
  const safe = /^(https?:|mailto:|tel:)/i.test(url) ? url : `https://${url.replace(/^\/+/, '')}`;
  const [ax, ay] = applyMatrix(m, rect.x, viewH - rect.y);
  const [bx, by] = applyMatrix(m, rect.x + rect.width, viewH - rect.y - rect.height);
  const annot = doc.context.obj({
    Type: 'Annot',
    Subtype: 'Link',
    Rect: [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)],
    Border: [0, 0, 0],
    A: { Type: 'Action', S: 'URI', URI: PDFString.of(safe) },
  });
  page.node.addAnnot(doc.context.register(annot));
}

export function measureTextObject(obj: PdfTextObject, widthOf: (line: string) => number): { width: number; height: number } {
  const lines = obj.text.split('\n');
  const width = Math.max(0, ...lines.map(widthOf));
  return { width, height: lines.length * obj.fontSize * PDF_LINE_HEIGHT };
}

async function drawObjects(doc: PDFDocument, page: PDFPage, model: PdfPageModel, fonts: FontCache, images: Map<string, PDFImage>) {
  if (model.objects.length === 0) return;
  const geo = pageGeometry(page.getCropBox(), page.getRotation().angle);
  const H = geo.viewHeight;
  const m = geo.matrix;
  const links: { rect: { x: number; y: number; width: number; height: number }; url: string }[] = [];

  page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...m));
  try {
    for (const obj of model.objects) {
      await drawObject(doc, page, obj, H, fonts, images, links);
    }
  } finally {
    page.pushOperators(popGraphicsState());
  }
  for (const l of links) addLinkAnnotation(doc, page, m, H, l.rect, l.url);
}

async function drawObject(
  doc: PDFDocument,
  page: PDFPage,
  obj: PdfObject,
  H: number,
  fonts: FontCache,
  images: Map<string, PDFImage>,
  links: { rect: { x: number; y: number; width: number; height: number }; url: string }[],
) {
  switch (obj.type) {
    case 'text': {
      if (obj.cover) {
        const c = obj.cover;
        page.drawRectangle({ x: c.x, y: H - c.y - c.height, width: c.width, height: c.height, color: color(c.color, 'ffffff') });
      }
      if (!obj.text.trim()) return;
      const { font, charset } = await fonts.get(obj.fontFamily, obj.bold, obj.italic);
      const lines = obj.text.split('\n').map((l) => fitToCharset(l, charset));
      const lh = obj.fontSize * PDF_LINE_HEIGHT;
      const base = obj.y + PDF_FONTS[obj.fontFamily].baseline * obj.fontSize;
      const col = color(obj.color);
      let maxW = 0;
      lines.forEach((line, i) => {
        const y = H - (base + i * lh);
        if (line) page.drawText(line, { x: obj.x, y, size: obj.fontSize, font, color: col });
        const w = font.widthOfTextAtSize(line, obj.fontSize);
        maxW = Math.max(maxW, w);
        if (obj.url && line.trim()) {
          page.drawLine({
            start: { x: obj.x, y: y - obj.fontSize * 0.1 },
            end: { x: obj.x + w, y: y - obj.fontSize * 0.1 },
            thickness: Math.max(0.5, obj.fontSize / 18),
            color: col,
          });
        }
      });
      if (obj.url) links.push({ rect: { x: obj.x, y: obj.y, width: maxW, height: lines.length * lh }, url: obj.url });
      return;
    }
    case 'image': {
      const img = await embedImage(doc, obj.dataUrl, images);
      if (img) page.drawImage(img, { x: obj.x, y: H - obj.y - obj.height, width: obj.width, height: obj.height });
      return;
    }
    case 'rect':
      page.drawRectangle({
        x: obj.x,
        y: H - obj.y - obj.height,
        width: obj.width,
        height: obj.height,
        color: obj.fill ? color(obj.fill) : undefined,
        borderColor: obj.stroke ? color(obj.stroke) : undefined,
        borderWidth: obj.stroke ? obj.strokeWidth : 0,
      });
      return;
    case 'ellipse':
      page.drawEllipse({
        x: obj.x + obj.width / 2,
        y: H - obj.y - obj.height / 2,
        xScale: obj.width / 2,
        yScale: obj.height / 2,
        color: obj.fill ? color(obj.fill) : undefined,
        borderColor: obj.stroke ? color(obj.stroke) : undefined,
        borderWidth: obj.stroke ? obj.strokeWidth : 0,
      });
      return;
    case 'line':
      page.drawLine({
        start: { x: obj.x1, y: H - obj.y1 },
        end: { x: obj.x2, y: H - obj.y2 },
        thickness: obj.strokeWidth,
        color: color(obj.stroke),
        lineCap: LineCapStyle.Round,
      });
      return;
    case 'highlight':
      page.drawRectangle({
        x: obj.x,
        y: H - obj.y - obj.height,
        width: obj.width,
        height: obj.height,
        color: color(obj.color, 'ffe066'),
        opacity: 0.45,
        blendMode: BlendMode.Multiply,
      });
      return;
    case 'whiteout':
      page.drawRectangle({ x: obj.x, y: H - obj.y - obj.height, width: obj.width, height: obj.height, color: color(obj.color, 'ffffff') });
      return;
    case 'ink': {
      if (obj.points.length === 0) return;
      const pts = obj.points.length === 1 ? [obj.points[0], obj.points[0]] : obj.points;
      for (let i = 1; i < pts.length; i++) {
        page.drawLine({
          start: { x: pts[i - 1][0], y: H - pts[i - 1][1] },
          end: { x: pts[i][0], y: H - pts[i][1] },
          thickness: obj.strokeWidth,
          color: color(obj.stroke),
          lineCap: LineCapStyle.Round,
        });
      }
      return;
    }
    case 'link':
      links.push({ rect: { x: obj.x, y: obj.y, width: obj.width, height: obj.height }, url: obj.url });
      return;
  }
}

function applyProtection(doc: PDFDocument, protection: PdfProtection) {
  const p = protection.permissions ?? {};
  const owner = protection.ownerPassword || protection.userPassword;
  if (!owner) throw new Error('A password is required to protect the document.');
  doc.encrypt({
    userPassword: protection.userPassword,
    ownerPassword: owner,
    permissions: {
      printing: p.printing === false ? false : 'highResolution',
      modifying: p.modifying !== false,
      copying: p.copying !== false,
      annotating: p.annotating !== false,
      fillingForms: p.annotating !== false,
      contentAccessibility: true,
      documentAssembly: p.modifying !== false,
    },
  });
}

/**
 * True when the page list is exactly the first source's pages in their original order.
 * In that case the original document is edited in place, which keeps forms, bookmarks
 * and metadata that page-copying would lose.
 */
function isIdentityLayout(session: PdfSession, pageCount: number): boolean {
  const first = session.sources[0];
  if (!first || session.pages.length !== pageCount) return false;
  return session.pages.every((p, i) => p.sourceId === first.id && p.sourcePage === i);
}

/** Builds the final PDF bytes from an editing session. */
export async function buildPdf(session: PdfSession, options: PdfSaveOptions = {}): Promise<Uint8Array> {
  if (session.pages.length === 0) throw new Error('A PDF needs at least one page.');

  const loaded = new Map<string, PDFDocument>();
  const load = async (id: string): Promise<PDFDocument> => {
    let d = loaded.get(id);
    if (!d) {
      const src = session.sources.find((s) => s.id === id);
      if (!src) throw new Error('Missing PDF source ' + id);
      d = await PDFDocument.load(src.bytes, { updateMetadata: false });
      loaded.set(id, d);
    }
    return d;
  };

  let out: PDFDocument;
  let outPages: PDFPage[];

  const first = session.sources[0] ? await load(session.sources[0].id) : null;
  if (first && isIdentityLayout(session, first.getPageCount())) {
    out = first;
    outPages = out.getPages();
  } else {
    out = await PDFDocument.create();
    if (first) {
      const t = first.getTitle();
      const a = first.getAuthor();
      if (t) out.setTitle(t);
      if (a) out.setAuthor(a);
    }
    // copy source pages in batches per source so shared resources are de-duplicated
    const wanted = new Map<string, number[]>();
    for (const p of session.pages) {
      if (p.sourceId) {
        const list = wanted.get(p.sourceId) ?? [];
        if (!list.includes(p.sourcePage)) list.push(p.sourcePage);
        wanted.set(p.sourceId, list);
      }
    }
    const copied = new Map<string, PDFPage>();
    for (const [sourceId, indices] of wanted) {
      const src = await load(sourceId);
      const pages = await out.copyPages(src, indices);
      indices.forEach((idx, i) => copied.set(`${sourceId}:${idx}`, pages[i]));
    }
    const used = new Set<string>();
    outPages = [];
    for (const p of session.pages) {
      if (!p.sourceId) {
        outPages.push(out.addPage([p.width, p.height]));
        continue;
      }
      const key = `${p.sourceId}:${p.sourcePage}`;
      let page = copied.get(key)!;
      if (used.has(key)) {
        // the same source page appears twice (duplicated page): copy it again
        [page] = await out.copyPages(await load(p.sourceId), [p.sourcePage]);
      }
      used.add(key);
      outPages.push(out.addPage(page));
    }
  }

  const fonts = new FontCache(out);
  const images = new Map<string, PDFImage>();
  for (let i = 0; i < session.pages.length; i++) {
    const model = session.pages[i];
    const page = outPages[i];
    await drawObjects(out, page, model, fonts, images);
    if (model.rotation) {
      page.setRotation(degrees(normRotation(page.getRotation().angle + model.rotation)));
    }
  }

  if (options.title) out.setTitle(options.title);
  out.setProducer('Document Editor');
  out.setModificationDate(new Date());
  if (options.protection) applyProtection(out, options.protection);
  return out.save();
}
