/**
 * Excel colour references → "#rrggbb". Cells name colours as ARGB, as an index into the legacy
 * 64-colour palette, or as a theme colour (index into the workbook theme) with an optional tint.
 */

/** Office 2013–2022 default theme, in Excel's colour-index order (lt1, dk1, lt2, dk2, accents, links). */
export const DEFAULT_THEME = ['FFFFFF', '000000', 'E7E6E6', '44546A', '4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47', '0563C1', '954F72'];

/** The legacy indexed palette (indexes 0–63; 64 = system foreground, 65 = system background). */
const INDEXED = [
  '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF',
  '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF',
  '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99',
  '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333',
  '000000', 'FFFFFF',
];

/**
 * Theme colours from a workbook's theme1.xml (clrScheme), reordered to Excel's colour indexes.
 * Falls back to the Office default for anything missing.
 */
export function parseThemeColors(themeXml: string | undefined | null): string[] {
  if (!themeXml) return DEFAULT_THEME;
  const scheme = /<a:clrScheme\b[\s\S]*?<\/a:clrScheme>/.exec(themeXml)?.[0];
  if (!scheme) return DEFAULT_THEME;
  const pick = (tag: string): string | null => {
    const m = new RegExp(`<a:${tag}>([\\s\\S]*?)</a:${tag}>`).exec(scheme)?.[1];
    if (!m) return null;
    return /srgbClr val="([0-9A-Fa-f]{6})"/.exec(m)?.[1] ?? /lastClr="([0-9A-Fa-f]{6})"/.exec(m)?.[1] ?? null;
  };
  const order = ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink'];
  return order.map((t, i) => (pick(t) ?? DEFAULT_THEME[i]).toUpperCase());
}

function rgbToHsl(hex: string): [number, number, number] {
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}

function hslToRgb(h: number, s: number, l: number): string {
  const hue = (p: number, q: number, t: number) => {
    if (t < 0) t += 1;
    if (t > 1) t -= 1;
    if (t < 1 / 6) return p + (q - p) * 6 * t;
    if (t < 1 / 2) return q;
    if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
    return p;
  };
  let r: number, g: number, b: number;
  if (s === 0) r = g = b = l;
  else {
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
    const p = 2 * l - q;
    r = hue(p, q, h + 1 / 3);
    g = hue(p, q, h);
    b = hue(p, q, h - 1 / 3);
  }
  const hex = (x: number) => Math.round(Math.min(1, Math.max(0, x)) * 255).toString(16).padStart(2, '0');
  return (hex(r) + hex(g) + hex(b)).toUpperCase();
}

/** Excel's tint: darken (tint < 0) or lighten (tint > 0) the colour's luminance. */
export function applyTint(hex: string, tint: number | undefined): string {
  if (!tint) return hex;
  const [h, s, l] = rgbToHsl(hex);
  const nl = tint < 0 ? l * (1 + tint) : l * (1 - tint) + tint;
  return hslToRgb(h, s, nl);
}

export interface ExcelColor {
  argb?: string;
  theme?: number;
  tint?: number;
  indexed?: number;
}

/** "#rrggbb", or null for "automatic"/unknown. */
export function excelColorToHex(c: ExcelColor | undefined | null, theme: string[] = DEFAULT_THEME): string | null {
  if (!c) return null;
  let hex: string | null = null;
  if (typeof c.argb === 'string' && /^[0-9A-Fa-f]{6,8}$/.test(c.argb)) hex = c.argb.slice(-6).toUpperCase();
  else if (typeof c.theme === 'number') hex = theme[c.theme] ?? null;
  else if (typeof c.indexed === 'number' && c.indexed < 64) hex = INDEXED[c.indexed] ?? null;
  if (!hex) return null;
  return `#${applyTint(hex, c.tint)}`;
}

/** "#rgb", "#rrggbb", "rgb(r,g,b)" → "FFRRGGBB" (ExcelJS ARGB), or null. */
export function cssToArgb(css: string | null | undefined): string | null {
  if (!css) return null;
  const s = css.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return `FF${m[1].split('').map((x) => x + x).join('')}`.toUpperCase();
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return `FF${m[1]}`.toUpperCase();
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(s);
  if (m) return `FF${[m[1], m[2], m[3]].map((x) => Math.min(255, Number(x)).toString(16).padStart(2, '0')).join('')}`.toUpperCase();
  return null;
}
