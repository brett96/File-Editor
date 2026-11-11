/**
 * Small DOM / encoding helpers shared by the converters. Everything here works in the
 * browser, in the Electron renderer and under jsdom (tests).
 */

export function parseHtml(html: string): HTMLElement {
  const doc = new DOMParser().parseFromString(`<!doctype html><html><body>${html}</body></html>`, 'text/html');
  return doc.body;
}

export function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const err = doc.getElementsByTagName('parsererror')[0];
  if (err) throw new Error('Malformed XML: ' + (err.textContent ?? '').slice(0, 200));
  return doc;
}

export function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function escapeXml(text: string): string {
  return escapeHtml(text)
    .replace(/'/g, '&apos;')
    // strip characters that are illegal in XML 1.0
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
}

export function utf8Encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** Decodes text, honouring UTF-8 / UTF-16 byte-order marks; falls back to windows-1252. */
export function decodeText(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder('utf-16le').decode(bytes.subarray(2));
  }
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return decodeWindows1252(bytes);
  }
}

// 0x80–0x9F of windows-1252 (some runtimes' TextDecoder treat the label as ISO-8859-1)
const CP1252_HIGH = [
  0x20ac, 0x81, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152, 0x8d, 0x017d, 0x8f,
  0x90, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x9d, 0x017e, 0x0178,
];

export function decodeWindows1252(bytes: Uint8Array): string {
  let out = '';
  const chunk: number[] = [];
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    chunk.push(b >= 0x80 && b <= 0x9f ? CP1252_HIGH[b - 0x80] : b);
    if (chunk.length === 8192) {
      out += String.fromCharCode(...chunk);
      chunk.length = 0;
    }
  }
  return out + String.fromCharCode(...chunk);
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64.replace(/\s+/g, ''));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export interface DataUrl {
  mime: string;
  bytes: Uint8Array;
}

export function parseDataUrl(url: string): DataUrl | null {
  const m = /^data:([^;,]+)?((?:;[^;,]+)*?)(;base64)?,(.*)$/s.exec(url);
  if (!m) return null;
  const mime = m[1] || 'application/octet-stream';
  try {
    const bytes = m[3] ? base64ToBytes(m[4]) : utf8Encode(decodeURIComponent(m[4]));
    return { mime, bytes };
  } catch {
    return null;
  }
}

export function toDataUrl(mime: string, bytes: Uint8Array): string {
  return `data:${mime};base64,${bytesToBase64(bytes)}`;
}

/** Reads pixel dimensions from PNG / JPEG / GIF / BMP headers without decoding. */
export function imageSize(bytes: Uint8Array): { width: number; height: number } | null {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    return { width: v.getUint32(16), height: v.getUint32(20) };
  }
  if (bytes.length > 10 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46) {
    return { width: v.getUint16(6, true), height: v.getUint16(8, true) };
  }
  if (bytes.length > 26 && bytes[0] === 0x42 && bytes[1] === 0x4d) {
    return { width: Math.abs(v.getInt32(18, true)), height: Math.abs(v.getInt32(22, true)) };
  }
  if (bytes.length > 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    let off = 2;
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off++;
        continue;
      }
      const marker = bytes[off + 1];
      if (marker === 0xff) {
        off++;
        continue;
      }
      // SOF0..SOF15 except DHT(C4), JPG(C8), DAC(CC)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { height: v.getUint16(off + 5), width: v.getUint16(off + 7) };
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        off += 2;
        continue;
      }
      off += 2 + v.getUint16(off + 2);
    }
  }
  return null;
}

/** Parses a CSS length to points. Unitless values are treated as px. */
export function cssLengthToPt(value: string | null | undefined): number | null {
  if (!value) return null;
  const m = /^\s*(-?\d*\.?\d+)\s*(pt|px|em|rem|in|cm|mm|%)?\s*$/i.exec(value);
  if (!m) return null;
  const n = parseFloat(m[1]);
  switch ((m[2] || 'px').toLowerCase()) {
    case 'pt':
      return n;
    case 'px':
      return n * 0.75;
    case 'em':
    case 'rem':
      return n * 12;
    case 'in':
      return n * 72;
    case 'cm':
      return (n * 72) / 2.54;
    case 'mm':
      return (n * 72) / 25.4;
    case '%':
      return (n / 100) * 12;
    default:
      return null;
  }
}

const NAMED_COLORS: Record<string, string> = {
  black: '000000', white: 'ffffff', red: 'ff0000', green: '008000', blue: '0000ff', yellow: 'ffff00',
  orange: 'ffa500', purple: '800080', gray: '808080', grey: '808080', silver: 'c0c0c0', maroon: '800000',
  navy: '000080', teal: '008080', lime: '00ff00', aqua: '00ffff', cyan: '00ffff', fuchsia: 'ff00ff',
  magenta: 'ff00ff', olive: '808000', pink: 'ffc0cb', brown: 'a52a2a',
};

/** Normalises a CSS colour (#rgb, #rrggbb, rgb(), rgba(), a few names) to "rrggbb"; null if unknown/transparent. */
export function cssColorToHex(value: string | null | undefined): string | null {
  if (!value) return null;
  const v = value.trim().toLowerCase();
  if (!v || v === 'transparent' || v === 'inherit' || v === 'initial' || v === 'auto') return null;
  let m = /^#([0-9a-f]{3})$/.exec(v);
  if (m) return m[1].split('').map((c) => c + c).join('');
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return m[1];
  m = /^rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)(?:[\s,/]+([\d.]+%?))?\s*\)$/.exec(v);
  if (m) {
    if (m[4] !== undefined && parseFloat(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((n) => Math.min(255, parseInt(n, 10)).toString(16).padStart(2, '0')).join('');
  }
  return NAMED_COLORS[v] ?? null;
}

export interface BorderSide {
  /** CSS border style: solid, dashed, dotted, double — or none. */
  style: string;
  widthPx: number;
  /** "rrggbb" */
  color: string;
}

const BORDER_KEYWORD_WIDTHS: Record<string, number> = { thin: 1, medium: 3, thick: 5 };

/**
 * One side of an element's inline border, however it was written (border-top, border,
 * border-width/style/color shorthands — browsers rewrite these when they serialise styles).
 * Null when the element's style says nothing about that side.
 */
export function cssBorderSide(el: Element, side: 'top' | 'right' | 'bottom' | 'left'): BorderSide | null {
  const st = (el as HTMLElement).style;
  if (!st) return null;
  const style = st.getPropertyValue(`border-${side}-style`).trim().toLowerCase();
  if (!style) return null;
  if (style === 'none' || style === 'hidden') return { style: 'none', widthPx: 0, color: '000000' };
  const w = st.getPropertyValue(`border-${side}-width`).trim().toLowerCase();
  const pt = BORDER_KEYWORD_WIDTHS[w] !== undefined ? BORDER_KEYWORD_WIDTHS[w] * 0.75 : cssLengthToPt(w || 'medium');
  const widthPx = pt === null ? 3 : Math.round((pt / 0.75) * 10) / 10;
  if (widthPx <= 0) return { style: 'none', widthPx: 0, color: '000000' };
  return { style, widthPx, color: cssColorToHex(st.getPropertyValue(`border-${side}-color`)) ?? '000000' };
}

/** A border side as a CSS value: "1px solid #808080" or "none". */
export function borderSideCss(b: BorderSide): string {
  return b.style === 'none' ? 'none' : `${b.widthPx}px ${b.style} #${b.color}`;
}

/** Parses an inline style attribute into a lowercase-keyed map. */
export function parseStyle(el: Element): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = el.getAttribute('style');
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const k = part.slice(0, i).trim().toLowerCase();
    const val = part.slice(i + 1).trim();
    if (k && val) out[k] = val;
  }
  return out;
}

/** First family name from a CSS font-family list, unquoted. */
export function primaryFontFamily(value: string | null | undefined): string | null {
  if (!value) return null;
  const first = value.split(',')[0].trim().replace(/^["']|["']$/g, '');
  return first || null;
}
