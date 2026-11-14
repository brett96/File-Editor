/**
 * Colour maths for the vector editor: hex / RGB / HSB / CMYK conversion, CSS colour parsing
 * (for SVG import) and colour harmonies (the Color Guide).
 */

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

export function rgbToHex({ r, g, b }: Rgb): string {
  return '#' + [r, g, b].map((v) => clamp255(v).toString(16).padStart(2, '0')).join('');
}

export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-f]{6}|[0-9a-f]{3})/i.exec(hex.trim());
  if (!m) return { r: 0, g: 0, b: 0 };
  const h = m[1].length === 3 ? m[1].split('').map((c) => c + c).join('') : m[1];
  return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16) };
}

/** h 0–360, s and v 0–100 (Illustrator's HSB). */
export function rgbToHsv({ r, g, b }: Rgb): { h: number; s: number; v: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const d = max - Math.min(R, G, B);
  let h = 0;
  if (d) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? (d / max) * 100 : 0, v: max * 100 };
}

export function hsvToRgb(h: number, s: number, v: number): Rgb {
  h = ((h % 360) + 360) % 360;
  const S = Math.max(0, Math.min(100, s)) / 100;
  const V = Math.max(0, Math.min(100, v)) / 100;
  const c = V * S;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = V - c;
  const [R, G, B] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return { r: clamp255((R + m) * 255), g: clamp255((G + m) * 255), b: clamp255((B + m) * 255) };
}

/** Naive (uncalibrated) CMYK, 0–100 each: what a designer expects to read, not a print profile. */
export function rgbToCmyk({ r, g, b }: Rgb): { c: number; m: number; y: number; k: number } {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const k = 1 - Math.max(R, G, B);
  if (k >= 1) return { c: 0, m: 0, y: 0, k: 100 };
  return { c: ((1 - R - k) / (1 - k)) * 100, m: ((1 - G - k) / (1 - k)) * 100, y: ((1 - B - k) / (1 - k)) * 100, k: k * 100 };
}

export function cmykToRgb(c: number, m: number, y: number, k: number): Rgb {
  const K = 1 - k / 100;
  return { r: clamp255(255 * (1 - c / 100) * K), g: clamp255(255 * (1 - m / 100) * K), b: clamp255(255 * (1 - y / 100) * K) };
}

const NAMED: Record<string, string> = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', cyan: '#00ffff', aqua: '#00ffff',
  magenta: '#ff00ff', fuchsia: '#ff00ff', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000', olive: '#808000', lime: '#00ff00',
  teal: '#008080', navy: '#000080', purple: '#800080', orange: '#ffa500', pink: '#ffc0cb', brown: '#a52a2a', gold: '#ffd700', indigo: '#4b0082',
  violet: '#ee82ee', beige: '#f5f5dc', ivory: '#fffff0', khaki: '#f0e68c', coral: '#ff7f50', salmon: '#fa8072', tomato: '#ff6347', crimson: '#dc143c',
  turquoise: '#40e0d0', tan: '#d2b48c', plum: '#dda0dd', orchid: '#da70d6', lavender: '#e6e6fa', skyblue: '#87ceeb', steelblue: '#4682b4',
  royalblue: '#4169e1', midnightblue: '#191970', darkblue: '#00008b', darkgreen: '#006400', darkred: '#8b0000', darkgray: '#a9a9a9', darkgrey: '#a9a9a9',
  lightgray: '#d3d3d3', lightgrey: '#d3d3d3', lightblue: '#add8e6', lightgreen: '#90ee90', dimgray: '#696969', dimgrey: '#696969', slategray: '#708090',
  whitesmoke: '#f5f5f5', gainsboro: '#dcdcdc', firebrick: '#b22222', chocolate: '#d2691e', sienna: '#a0522d', peru: '#cd853f', forestgreen: '#228b22',
  seagreen: '#2e8b57', limegreen: '#32cd32', dodgerblue: '#1e90ff', deepskyblue: '#00bfff', hotpink: '#ff69b4', deeppink: '#ff1493', orangered: '#ff4500',
  darkorange: '#ff8c00', goldenrod: '#daa520', wheat: '#f5deb3', linen: '#faf0e6', snow: '#fffafa', mintcream: '#f5fffa', azure: '#f0ffff',
  aliceblue: '#f0f8ff', ghostwhite: '#f8f8ff', honeydew: '#f0fff0', seashell: '#fff5ee', rebeccapurple: '#663399', slateblue: '#6a5acd',
};

/** Parses a CSS colour. Returns null for none / unsupported values (url(), currentColor…). */
export function parseCssColor(value: string): { color: string; alpha: number } | null {
  const v = value.trim().toLowerCase();
  if (!v || v === 'none' || v === 'transparent') return null;
  if (v[0] === '#') {
    const h = v.slice(1);
    if (/^[0-9a-f]{3}$/.test(h) || /^[0-9a-f]{6}$/.test(h)) return { color: rgbToHex(hexToRgb(v)), alpha: 1 };
    if (/^[0-9a-f]{4}$/.test(h)) return { color: rgbToHex(hexToRgb('#' + h.slice(0, 3))), alpha: parseInt(h[3] + h[3], 16) / 255 };
    if (/^[0-9a-f]{8}$/.test(h)) return { color: '#' + h.slice(0, 6), alpha: parseInt(h.slice(6), 16) / 255 };
    return null;
  }
  const fn = /^(rgba?|hsla?)\(([^)]*)\)$/.exec(v);
  if (fn) {
    const parts = fn[2].split(/[\s,/]+/).filter(Boolean);
    const n = (s: string, scale: number) => (s.endsWith('%') ? (parseFloat(s) / 100) * scale : parseFloat(s));
    const alpha = parts[3] !== undefined ? Math.max(0, Math.min(1, n(parts[3], 1))) : 1;
    if (fn[1].startsWith('rgb')) return { color: rgbToHex({ r: n(parts[0], 255), g: n(parts[1], 255), b: n(parts[2], 255) }), alpha };
    // hsl → hsv
    const h = parseFloat(parts[0]);
    const s = parseFloat(parts[1]) / 100;
    const l = parseFloat(parts[2]) / 100;
    const vv = l + s * Math.min(l, 1 - l);
    const sv = vv ? 2 * (1 - l / vv) : 0;
    return { color: rgbToHex(hsvToRgb(h, sv * 100, vv * 100)), alpha };
  }
  return NAMED[v] ? { color: NAMED[v], alpha: 1 } : null;
}

export function mixHex(a: string, b: string, t: number): string {
  const A = hexToRgb(a);
  const B = hexToRgb(b);
  return rgbToHex({ r: A.r + (B.r - A.r) * t, g: A.g + (B.g - A.g) * t, b: A.b + (B.b - A.b) * t });
}

export type HarmonyRule = 'complementary' | 'split-complementary' | 'analogous' | 'triad' | 'tetrad' | 'square' | 'monochromatic' | 'shades' | 'tints';

export const HARMONY_RULES: { id: HarmonyRule; label: string }[] = [
  { id: 'complementary', label: 'Complementary' },
  { id: 'split-complementary', label: 'Split complementary' },
  { id: 'analogous', label: 'Analogous' },
  { id: 'triad', label: 'Triad' },
  { id: 'tetrad', label: 'Tetrad' },
  { id: 'square', label: 'Square' },
  { id: 'monochromatic', label: 'Monochromatic' },
  { id: 'shades', label: 'Shades' },
  { id: 'tints', label: 'Tints' },
];

/** The colours that go with `base` under a harmony rule (the base colour comes first). */
export function harmony(base: string, rule: HarmonyRule): string[] {
  const { h, s, v } = rgbToHsv(hexToRgb(base));
  const at = (dh: number, ds = 0, dv = 0) => rgbToHex(hsvToRgb(h + dh, Math.max(0, Math.min(100, s + ds)), Math.max(0, Math.min(100, v + dv))));
  switch (rule) {
    case 'complementary':
      return [at(0), at(0, -30, 10), at(180), at(180, -30, 10), at(180, 0, -30)];
    case 'split-complementary':
      return [at(0), at(150), at(210), at(150, -25), at(210, -25)];
    case 'analogous':
      return [at(-60), at(-30), at(0), at(30), at(60)];
    case 'triad':
      return [at(0), at(120), at(240), at(120, -30), at(240, -30)];
    case 'tetrad':
      return [at(0), at(60), at(180), at(240)];
    case 'square':
      return [at(0), at(90), at(180), at(270)];
    case 'monochromatic':
      return [at(0, 0, -40), at(0, -20, -20), at(0), at(0, -35, 10), at(0, -60, 20)];
    case 'shades':
      return [0, 0.2, 0.4, 0.6, 0.8].map((t) => mixHex(base, '#000000', t));
    case 'tints':
      return [0, 0.2, 0.4, 0.6, 0.8].map((t) => mixHex(base, '#ffffff', t));
  }
}
