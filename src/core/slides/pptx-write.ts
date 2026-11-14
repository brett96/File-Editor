/**
 * Writes a deck as a PowerPoint file (.pptx, Office Open XML). The package is built from
 * scratch: one theme, one slide master with four layouts (title, title + content, title
 * only, blank), the slides, their speaker notes and pictures. Every shape carries its own
 * position, fill and text formatting, so the file looks the same in PowerPoint, Google
 * Slides and Keynote whatever their defaults are.
 */
import JSZip from 'jszip';
import {
  EMU_PER_PX,
  isEmptyText,
  type Deck,
  type ImageElement,
  type LineElement,
  type Paragraph,
  type ShapeElement,
  type Slide,
  type SlideElement,
  type TableElement,
  type Theme,
} from './model';
import { cellFill, cellTextStyle, shapeTextStyle, type TextStyle } from './render';

const NS = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
/** The theme name marks files this app wrote, so they read back with their theme intact. */
export const THEME_MARK = 'File Editor ';

const x = (t: string) =>
  t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    // characters XML 1.0 does not allow
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g, '');
const emu = (px: number) => Math.round(px * EMU_PER_PX);

/** A CSS colour as RRGGBB plus opacity 0–1 (PowerPoint has no colour names or rgba()). */
export function colorParts(c: string, over = '#ffffff'): { hex: string; alpha: number } {
  const s = c.trim();
  let m = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(s);
  if (m) return { hex: (m[1] + m[1] + m[2] + m[2] + m[3] + m[3]).toUpperCase(), alpha: 1 };
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(s);
  if (m) return { hex: m[1].toUpperCase(), alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)(?:[\s,/]+([\d.]+))?\s*\)$/i.exec(s);
  if (m) {
    const h = [m[1], m[2], m[3]].map((v) => Math.max(0, Math.min(255, Math.round(Number(v)))).toString(16).padStart(2, '0')).join('');
    return { hex: h.toUpperCase(), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  }
  const named: Record<string, string> = { white: 'FFFFFF', black: '000000', transparent: colorParts(over).hex };
  return { hex: named[s.toLowerCase()] ?? '000000', alpha: s.toLowerCase() === 'transparent' ? 0 : 1 };
}

/** A translucent colour flattened onto what is behind it. */
export function flatten(c: string, behind: string): string {
  const { hex, alpha } = colorParts(c);
  if (alpha >= 1) return hex;
  const b = colorParts(behind).hex;
  const mix = (i: number) => Math.round(parseInt(hex.slice(i, i + 2), 16) * alpha + parseInt(b.slice(i, i + 2), 16) * (1 - alpha)).toString(16).padStart(2, '0');
  return (mix(0) + mix(2) + mix(4)).toUpperCase();
}

function solidFill(c: string, opacity = 1): string {
  const { hex, alpha } = colorParts(c);
  const a = Math.round(alpha * opacity * 100000);
  return `<a:solidFill><a:srgbClr val="${hex}">${a < 100000 ? `<a:alpha val="${a}"/>` : ''}</a:srgbClr></a:solidFill>`;
}

/** The first family of a CSS font list: what PowerPoint calls the typeface. */
const typeface = (font: string) => font.split(',')[0].trim().replace(/^["']|["']$/g, '') || 'Calibri';

const SHADOW = '<a:effectLst><a:outerShdw blurRad="76200" dist="38100" dir="5400000" algn="t" rotWithShape="0"><a:srgbClr val="000000"><a:alpha val="35000"/></a:srgbClr></a:outerShdw></a:effectLst>';

interface SlideParts {
  rels: string[];
  media: Map<string, { name: string; bytes: Uint8Array }>;
  nextId: number;
}

function addRel(parts: SlideParts, type: string, target: string, external = false): string {
  const id = `rId${parts.rels.length + 1}`;
  parts.rels.push(`<Relationship Id="${id}" Type="${REL}/${type}" Target="${x(target)}"${external ? ' TargetMode="External"' : ''}/>`);
  return id;
}

function paragraphXml(p: Paragraph, d: TextStyle, parts: SlideParts): string {
  const bullet = p.bullet ?? (d.bullets ? 'bullet' : 'none');
  const level = Math.min(8, Math.max(0, p.level ?? 0));
  const algn = { left: 'l', center: 'ctr', right: 'r', justify: 'just' }[p.align ?? d.align ?? 'left'];
  // hanging indent for bullets, in EMU (one "em" of 18 pt text is about 228600)
  const step = 342900;
  const marL = bullet === 'none' ? level * step : (level + 1) * step;
  const pPr: string[] = [`algn="${algn}"`];
  if (level) pPr.push(`lvl="${level}"`);
  pPr.push(`marL="${marL}"`, `indent="${bullet === 'none' ? 0 : -step}"`);
  // the editor's 1.2 line height is PowerPoint's "single" (100 %)
  const spacing = `<a:lnSpc><a:spcPct val="${Math.round(((p.lineSpacing ?? 1.2) / 1.2) * 100000)}"/></a:lnSpc>`;
  const bu = bullet === 'bullet' ? `<a:buFont typeface="Arial"/><a:buChar char="${level % 2 ? '–' : '•'}"/>` : bullet === 'number' ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>' : '<a:buNone/>';
  const rPr = (r: Paragraph['runs'][number], tag: string, withLink: boolean) => {
    const size = Math.round((r.size ?? d.size) * 100);
    const bold = r.bold ?? d.bold ?? false;
    const attrs = [`lang="en-US"`, `sz="${size}"`, `b="${bold ? 1 : 0}"`, `i="${r.italic ? 1 : 0}"`];
    if (r.underline || r.link) attrs.push('u="sng"');
    if (r.strike) attrs.push('strike="sngStrike"');
    attrs.push('dirty="0"');
    const face = typeface(r.font ?? d.font);
    const link = withLink && r.link && /^(https?:|mailto:)/i.test(r.link) ? `<a:hlinkClick r:id="${addRel(parts, 'hyperlink', r.link, true)}"/>` : '';
    return `<${tag} ${attrs.join(' ')}>${solidFill(r.color ?? d.color)}<a:latin typeface="${x(face)}"/><a:cs typeface="${x(face)}"/>${link}</${tag}>`;
  };
  const runs = p.runs
    .filter((r) => r.text)
    .map((r) => {
      // a line break inside a paragraph (Shift+Enter) is its own element
      const pieces = r.text.split('\n');
      return pieces.map((t, i) => `${i ? `<a:br>${rPr(r, 'a:rPr', false)}</a:br>` : ''}${t ? `<a:r>${rPr(r, 'a:rPr', true)}<a:t>${x(t)}</a:t></a:r>` : ''}`).join('');
    })
    .join('');
  const last = p.runs[p.runs.length - 1] ?? { text: '' };
  return `<a:p><a:pPr ${pPr.join(' ')}>${spacing}${bu}</a:pPr>${runs}${rPr(last, 'a:endParaRPr', false)}</a:p>`;
}

function xfrm(el: SlideElement, tag = 'a:xfrm'): string {
  const attrs = [el.rotation ? ` rot="${Math.round((((el.rotation % 360) + 360) % 360) * 60000)}"` : '', el.flipH ? ' flipH="1"' : '', el.flipV ? ' flipV="1"' : ''].join('');
  return `<${tag}${attrs}><a:off x="${emu(el.x)}" y="${emu(el.y)}"/><a:ext cx="${Math.max(0, emu(el.w))}" cy="${Math.max(0, emu(el.h))}"/></${tag}>`;
}

function lineXml(color: string | null, width: number, dash?: string, ends = ''): string {
  if (!color) return '<a:ln><a:noFill/></a:ln>';
  const d = dash === 'dash' ? '<a:prstDash val="dash"/>' : dash === 'dot' ? '<a:prstDash val="sysDot"/>' : '';
  return `<a:ln w="${Math.max(1, emu(width))}">${solidFill(color)}${d}${ends}</a:ln>`;
}

function shapeXml(el: ShapeElement, deck: Deck, parts: SlideParts): string {
  const id = parts.nextId++;
  const style = shapeTextStyle(el, deck);
  const ph = el.placeholder ? `<p:ph type="${el.placeholder}"${el.placeholder === 'body' ? ` idx="${id}"` : ''}/>` : '';
  const isTextBox = !el.fill && !el.line && el.shape === 'rect';
  let fill = '<a:noFill/>';
  if (el.fill && el.fill2) {
    const a = colorParts(el.fill).hex;
    const b = colorParts(el.fill2).hex;
    fill = `<a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${a}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${b}"/></a:gs></a:gsLst><a:lin ang="5400000" scaled="0"/></a:gradFill>`;
  } else if (el.fill) fill = solidFill(el.fill, el.opacity ?? 1);
  const pad = emu(el.padding);
  const anchor = el.valign === 'middle' ? 'ctr' : el.valign === 'bottom' ? 'b' : 't';
  const paragraphs = (el.text.length ? el.text : [{ runs: [{ text: '' }] }]).map((p) => paragraphXml(p, style, parts)).join('');
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${x(el.name ?? (el.placeholder ? `Placeholder ${id}` : isTextBox ? `TextBox ${id}` : `Shape ${id}`))}"/><p:cNvSpPr${isTextBox && !ph ? ' txBox="1"' : ''}/><p:nvPr>${ph}</p:nvPr></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="${x(el.shape)}"><a:avLst/></a:prstGeom>${fill}${lineXml(el.line, el.lineWidth, el.lineDash)}${el.shadow ? SHADOW : ''}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${pad}" tIns="${pad}" rIns="${pad}" bIns="${pad}" rtlCol="0" anchor="${anchor}"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`;
}

function connectorXml(el: LineElement, parts: SlideParts): string {
  const id = parts.nextId++;
  const ends = `${el.startArrow ? '<a:headEnd type="triangle"/>' : ''}${el.endArrow ? '<a:tailEnd type="triangle"/>' : ''}`;
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${x(el.name ?? `Line ${id}`)}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="line"><a:avLst/></a:prstGeom>${lineXml(el.color, el.lineWidth, el.lineDash, ends)}</p:spPr></p:cxnSp>`;
}

const MIME_EXT: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/bmp': 'bmp', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'image/avif': 'avif' };

function decodeDataUrl(src: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(src);
  if (!m) return null;
  const bin = atob(m[2]);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: m[1].toLowerCase(), bytes };
}

/** Stores a picture once per file, however many slides use it; returns its path under ppt/media. */
function mediaFor(src: string, parts: SlideParts): string | null {
  const hit = parts.media.get(src);
  if (hit) return hit.name;
  const data = decodeDataUrl(src);
  if (!data || !MIME_EXT[data.mime]) return null;
  const name = `image${parts.media.size + 1}.${MIME_EXT[data.mime]}`;
  parts.media.set(src, { name, bytes: data.bytes });
  return name;
}

function pictureXml(el: ImageElement, parts: SlideParts): string {
  const id = parts.nextId++;
  const file = mediaFor(el.src, parts);
  if (!file) return '';
  const rid = addRel(parts, 'image', `../media/${file}`);
  const [l, t, r, b] = el.crop ?? [0, 0, 0, 0];
  const pct = (v: number) => Math.round(v * 100000);
  const crop = l || t || r || b ? `<a:srcRect l="${pct(l)}" t="${pct(t)}" r="${pct(r)}" b="${pct(b)}"/>` : '';
  const alpha = el.opacity !== undefined && el.opacity < 1 ? `<a:alphaModFix amt="${pct(el.opacity)}"/>` : '';
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${x(el.name ?? `Picture ${id}`)}"${el.alt ? ` descr="${x(el.alt)}"` : ''}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}">${alpha}</a:blip>${crop}<a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="${el.radius ? 'roundRect' : 'rect'}"><a:avLst/></a:prstGeom>${el.line ? lineXml(el.line, el.lineWidth ?? 1) : ''}${el.shadow ? SHADOW : ''}</p:spPr></p:pic>`;
}

function tableXml(el: TableElement, deck: Deck, parts: SlideParts): string {
  const id = parts.nextId++;
  const bg = deck.theme.background;
  const edge = (tag: string) => (el.border ? `<a:${tag} w="${Math.max(1, emu(el.borderWidth))}" cap="flat" cmpd="sng" algn="ctr">${solidFill(el.border)}<a:prstDash val="solid"/></a:${tag}>` : `<a:${tag}><a:noFill/></a:${tag}>`);
  const rows = el.cells
    .map((row, ri) => {
      const cells = row
        .map((cell, ci) => {
          if (!cell) {
            // covered by a merged cell: which way it is covered decides the flag
            const fromLeft = row.slice(0, ci).some((c, k) => c && (c.colSpan ?? 1) > ci - k);
            return `<a:tc ${fromLeft ? 'hMerge="1"' : 'vMerge="1"'}><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></a:txBody><a:tcPr/></a:tc>`;
          }
          const style = cellTextStyle(deck, el, ri);
          const fill = cellFill(deck.theme, el, ri, cell.fill);
          const span = `${cell.colSpan && cell.colSpan > 1 ? ` gridSpan="${cell.colSpan}"` : ''}${cell.rowSpan && cell.rowSpan > 1 ? ` rowSpan="${cell.rowSpan}"` : ''}`;
          const anchor = cell.valign === 'middle' ? 'ctr' : cell.valign === 'bottom' ? 'b' : 't';
          const paragraphs = (cell.text.length ? cell.text : [{ runs: [{ text: '' }] }]).map((p) => paragraphXml(p, style, parts)).join('');
          return `<a:tc${span}><a:txBody><a:bodyPr/><a:lstStyle/>${paragraphs}</a:txBody><a:tcPr marL="76200" marR="76200" marT="47625" marB="47625" anchor="${anchor}">${edge('lnL')}${edge('lnR')}${edge('lnT')}${edge('lnB')}${fill === 'transparent' ? '<a:noFill/>' : `<a:solidFill><a:srgbClr val="${flatten(fill, bg)}"/></a:solidFill>`}</a:tcPr></a:tc>`;
        })
        .join('');
      return `<a:tr h="${emu(el.rows[ri])}">${cells}</a:tr>`;
    })
    .join('');
  const grid = el.cols.map((c) => `<a:gridCol w="${emu(c)}"/>`).join('');
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${x(el.name ?? `Table ${id}`)}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr>${xfrm(el, 'p:xfrm')}<a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${el.header ? 1 : 0}" bandRow="${el.banded ? 1 : 0}"/><a:tblGrid>${grid}</a:tblGrid>${rows}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

function elementXml(el: SlideElement, deck: Deck, parts: SlideParts): string {
  switch (el.kind) {
    case 'shape':
      return shapeXml(el, deck, parts);
    case 'line':
      return connectorXml(el, parts);
    case 'image':
      return pictureXml(el, parts);
    case 'table':
      return tableXml(el, deck, parts);
    default:
      return '';
  }
}

const GROUP = '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

function backgroundXml(slide: Slide, parts: SlideParts): string {
  const bg = slide.background;
  if (!bg) return '';
  if (bg.type === 'color') return `<p:bg><p:bgPr>${solidFill(bg.color)}<a:effectLst/></p:bgPr></p:bg>`;
  if (bg.type === 'gradient') {
    // CSS angles run clockwise from "up"; DrawingML's from "right"
    const ang = Math.round(((((bg.angle - 90) % 360) + 360) % 360) * 60000);
    return `<p:bg><p:bgPr><a:gradFill rotWithShape="1"><a:gsLst><a:gs pos="0"><a:srgbClr val="${colorParts(bg.from).hex}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${colorParts(bg.to).hex}"/></a:gs></a:gsLst><a:lin ang="${ang}" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
  }
  const file = mediaFor(bg.src, parts);
  if (!file) return '';
  return `<p:bg><p:bgPr><a:blipFill dpi="0" rotWithShape="1"><a:blip r:embed="${addRel(parts, 'image', `../media/${file}`)}"/><a:srcRect/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
}

function transitionXml(slide: Slide): string {
  const t = slide.transition;
  if (!t || t.type === 'none') return '';
  const spd = t.duration <= 0.4 ? 'fast' : t.duration >= 1 ? 'slow' : 'med';
  const inner = { fade: '<p:fade/>', push: '<p:push dir="l"/>', wipe: '<p:wipe dir="l"/>', cover: '<p:cover dir="l"/>', zoom: '<p:zoom dir="in"/>' }[t.type];
  return `<p:transition spd="${spd}">${inner}</p:transition>`;
}

/** Which of the written layouts suits a slide: 1 title, 2 title + content, 3 title only, 4 blank. */
function layoutFor(slide: Slide): number {
  const ph = new Set(slide.elements.map((e) => (e.kind === 'shape' ? e.placeholder : undefined)));
  if (ph.has('ctrTitle')) return 1;
  if (ph.has('title') && (ph.has('body') || ph.has('subTitle'))) return 2;
  if (ph.has('title')) return 3;
  return 4;
}

function themeXml(t: Theme, deckName: string): string {
  const c = (v: string) => colorParts(v).hex;
  const major = x(typeface(t.headingFont));
  const minor = x(typeface(t.bodyFont));
  const fills = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3);
  const ln = (w: number) => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/><a:miter lim="800000"/></a:ln>`;
  return `${HEAD}<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="${x(THEME_MARK + deckName)}"><a:themeElements><a:clrScheme name="${x(t.name)}"><a:dk1><a:srgbClr val="${c(t.text)}"/></a:dk1><a:lt1><a:srgbClr val="${c(t.background)}"/></a:lt1><a:dk2><a:srgbClr val="${c(t.heading)}"/></a:dk2><a:lt2><a:srgbClr val="${flatten('rgba(128,128,128,0.15)', t.background)}"/></a:lt2>${t.accents.map((a, i) => `<a:accent${i + 1}><a:srgbClr val="${c(a)}"/></a:accent${i + 1}>`).join('')}<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink></a:clrScheme><a:fontScheme name="${x(t.name)}"><a:majorFont><a:latin typeface="${major}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${minor}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Office"><a:fillStyleLst>${fills}</a:fillStyleLst><a:lnStyleLst>${ln(6350)}${ln(12700)}${ln(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${fills}</a:bgFillStyleLst></a:fmtScheme></a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

/** A placeholder of the master / a layout, as fractions of the slide. */
function phXml(id: number, type: string, name: string, deck: Deck, box: [number, number, number, number], idx?: number): string {
  const [fx, fy, fw, fh] = box;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="${type}"${idx !== undefined ? ` idx="${idx}"` : ''}/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="${emu(deck.width * fx)}" y="${emu(deck.height * fy)}"/><a:ext cx="${emu(deck.width * fw)}" cy="${emu(deck.height * fh)}"/></a:xfrm></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>`;
}

const TITLE_BOX: [number, number, number, number] = [0.07, 0.06, 0.86, 0.18];
const BODY_BOX: [number, number, number, number] = [0.07, 0.27, 0.86, 0.63];

function masterXml(deck: Deck): string {
  const lvl = (i: number, sz: number, bullet: boolean) => `<a:lvl${i}pPr marL="${bullet ? 342900 * i : 0}" indent="${bullet ? -342900 : 0}" algn="l" rtl="0">${bullet ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>'}<a:defRPr sz="${sz}"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl${i}pPr>`;
  return `${HEAD}<p:sldMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}${phXml(2, 'title', 'Title Placeholder 1', deck, TITLE_BOX)}${phXml(3, 'body', 'Text Placeholder 2', deck, BODY_BOX, 1)}</p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst>${[1, 2, 3, 4].map((i) => `<p:sldLayoutId id="${2147483648 + i}" r:id="rId${i}"/>`).join('')}</p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr algn="l" rtl="0"><a:buNone/><a:defRPr sz="4000"><a:solidFill><a:schemeClr val="tx2"/></a:solidFill><a:latin typeface="+mj-lt"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle>${[2400, 2000, 1800, 1600, 1600].map((sz, i) => lvl(i + 1, sz, true)).join('')}</p:bodyStyle><p:otherStyle>${lvl(1, 1800, false)}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

function layoutXml(deck: Deck, n: number): string {
  const defs: [string, string, string][] = [
    ['title', 'Title Slide', `${phXml(2, 'ctrTitle', 'Title 1', deck, [0.105, 0.24, 0.79, 0.3])}${phXml(3, 'subTitle', 'Subtitle 2', deck, [0.105, 0.57, 0.79, 0.2], 1)}`],
    ['obj', 'Title and Content', `${phXml(2, 'title', 'Title 1', deck, TITLE_BOX)}${phXml(3, 'body', 'Content Placeholder 2', deck, BODY_BOX, 1)}`],
    ['titleOnly', 'Title Only', phXml(2, 'title', 'Title 1', deck, TITLE_BOX)],
    ['blank', 'Blank', ''],
  ];
  const [type, name, shapes] = defs[n - 1];
  return `${HEAD}<p:sldLayout ${NS} type="${type}" preserve="1"><p:cSld name="${name}"><p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
}

const NOTES_MASTER = `${HEAD}<p:notesMaster ${NS}><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg" idx="2"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="1143000"/><a:ext cx="5486400" cy="3086100"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/><a:ln w="12700"><a:solidFill><a:prstClr val="black"/></a:solidFill></a:ln></p:spPr></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" sz="quarter" idx="3"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US"/><a:t>Notes</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:notesStyle><a:lvl1pPr marL="0" algn="l"><a:defRPr sz="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/></a:defRPr></a:lvl1pPr></p:notesStyle></p:notesMaster>`;

function notesXml(text: string): string {
  const paras = text.split('\n').map((l) => `<a:p>${l ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${x(l)}</a:t></a:r>` : '<a:endParaRPr lang="en-US" dirty="0"/>'}</a:p>`).join('');
  return `${HEAD}<p:notes ${NS}><p:cSld><p:spTree>${GROUP}<p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes Placeholder 2"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

const rels = (items: string[]) => `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${items.join('')}</Relationships>`;
const rel = (id: number, type: string, target: string) => `<Relationship Id="rId${id}" Type="${REL}/${type}" Target="${target}"/>`;

export interface PptxWriteOptions {
  title?: string;
  /** 'show' writes a .ppsx, which opens straight into the slide show */
  as?: 'presentation' | 'show';
}

export async function writePptx(deck: Deck, o: PptxWriteOptions = {}): Promise<Uint8Array> {
  const zip = new JSZip();
  const media = new Map<string, { name: string; bytes: Uint8Array }>();
  const slides = deck.slides.length ? deck.slides : [{ id: 's', elements: [], background: null, notes: '', transition: { type: 'none' as const, duration: 0.6 } }];
  const withNotes = slides.some((s) => s.notes.trim());
  const P = 'application/vnd.openxmlformats-officedocument.presentationml';
  const overrides: string[] = [
    `<Override PartName="/ppt/presentation.xml" ContentType="${P}.${o.as === 'show' ? 'slideshow' : 'presentation'}.main+xml"/>`,
    `<Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="${P}.slideMaster+xml"/>`,
    ...[1, 2, 3, 4].map((i) => `<Override PartName="/ppt/slideLayouts/slideLayout${i}.xml" ContentType="${P}.slideLayout+xml"/>`),
    '<Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>',
    '<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>',
    '<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>',
  ];

  slides.forEach((slide, i) => {
    const num = i + 1;
    const parts: SlideParts = { rels: [], media, nextId: 2 };
    addRel(parts, 'slideLayout', `../slideLayouts/slideLayout${layoutFor(slide)}.xml`);
    const bg = backgroundXml(slide, parts);
    // empty placeholders are an editing aid, not content: they are left out of the file
    const shapes = slide.elements.filter((e) => !(e.kind === 'shape' && e.placeholder && isEmptyText(e.text) && !e.fill && !e.line)).map((e) => elementXml(e, deck, parts)).join('');
    if (slide.notes.trim()) {
      addRel(parts, 'notesSlide', `../notesSlides/notesSlide${num}.xml`);
      zip.file(`ppt/notesSlides/notesSlide${num}.xml`, notesXml(slide.notes));
      zip.file(`ppt/notesSlides/_rels/notesSlide${num}.xml.rels`, rels([rel(1, 'notesMaster', '../notesMasters/notesMaster1.xml'), rel(2, 'slide', `../slides/slide${num}.xml`)]));
      overrides.push(`<Override PartName="/ppt/notesSlides/notesSlide${num}.xml" ContentType="${P}.notesSlide+xml"/>`);
    }
    zip.file(`ppt/slides/slide${num}.xml`, `${HEAD}<p:sld ${NS}${slide.hidden ? ' show="0"' : ''}><p:cSld>${bg}<p:spTree>${GROUP}${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transitionXml(slide)}</p:sld>`);
    zip.file(`ppt/slides/_rels/slide${num}.xml.rels`, rels(parts.rels));
    overrides.push(`<Override PartName="/ppt/slides/slide${num}.xml" ContentType="${P}.slide+xml"/>`);
  });

  for (const m of media.values()) zip.file(`ppt/media/${m.name}`, m.bytes);
  const name = o.title ?? 'Presentation';
  zip.file('ppt/theme/theme1.xml', themeXml(deck.theme, deck.theme.name));
  zip.file('ppt/slideMasters/slideMaster1.xml', masterXml(deck));
  zip.file('ppt/slideMasters/_rels/slideMaster1.xml.rels', rels([...[1, 2, 3, 4].map((i) => rel(i, 'slideLayout', `../slideLayouts/slideLayout${i}.xml`)), rel(5, 'theme', '../theme/theme1.xml')]));
  for (const i of [1, 2, 3, 4]) {
    zip.file(`ppt/slideLayouts/slideLayout${i}.xml`, layoutXml(deck, i));
    zip.file(`ppt/slideLayouts/_rels/slideLayout${i}.xml.rels`, rels([rel(1, 'slideMaster', '../slideMasters/slideMaster1.xml')]));
  }
  const presRels = [rel(1, 'slideMaster', 'slideMasters/slideMaster1.xml'), ...slides.map((_, i) => rel(i + 2, 'slide', `slides/slide${i + 1}.xml`)), rel(slides.length + 2, 'theme', 'theme/theme1.xml')];
  let notesMasterList = '';
  if (withNotes) {
    zip.file('ppt/notesMasters/notesMaster1.xml', NOTES_MASTER);
    zip.file('ppt/notesMasters/_rels/notesMaster1.xml.rels', rels([rel(1, 'theme', '../theme/theme2.xml')]));
    zip.file('ppt/theme/theme2.xml', themeXml(deck.theme, `${deck.theme.name} notes`));
    overrides.push(`<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="${P}.notesMaster+xml"/>`, '<Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>');
    presRels.push(rel(slides.length + 3, 'notesMaster', 'notesMasters/notesMaster1.xml'));
    notesMasterList = `<p:notesMasterIdLst><p:notesMasterId r:id="rId${slides.length + 3}"/></p:notesMasterIdLst>`;
  }
  zip.file('ppt/presentation.xml', `${HEAD}<p:presentation ${NS} saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${notesMasterList}<p:sldIdLst>${slides.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${emu(deck.width)}" cy="${emu(deck.height)}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`);
  zip.file('ppt/_rels/presentation.xml.rels', rels(presRels));
  zip.file('_rels/.rels', `${HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${REL}/officeDocument" Target="ppt/presentation.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="${REL}/extended-properties" Target="docProps/app.xml"/></Relationships>`);
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  zip.file('docProps/core.xml', `${HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${x(name)}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`);
  zip.file('docProps/app.xml', `${HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>File Editor</Application><Slides>${slides.length}</Slides></Properties>`);
  const exts = new Set([...media.values()].map((m) => m.name.split('.').pop()!));
  const mimeOf = (ext: string) => Object.entries(MIME_EXT).find(([, e]) => e === ext)?.[0] ?? 'application/octet-stream';
  zip.file('[Content_Types].xml', `${HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map((e) => `<Default Extension="${e}" ContentType="${mimeOf(e)}"/>`).join('')}${overrides.join('')}</Types>`);
  return zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
}
