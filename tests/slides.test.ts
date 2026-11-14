// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import JSZip from 'jszip';
import {
  THEMES, chart, chartFromText, chartToText, cloneSlide, findInSlide, image, isEmptyText, layoutElements, line, newDeck, newSlide, normalizeParagraph, para, plainText, replaceInDeck, resizeDeck, shape, styleAll, table, textBox,
  type ImageElement, type LineElement, type ShapeElement, type TableElement,
} from '../src/core/slides/model';
import { isPptx, readPptx } from '../src/core/slides/pptx-read';
import { colorParts, writePptx } from '../src/core/slides/pptx-write';
import { niceScale, paragraphsHtml, shapePath, slideHtml, slideSvg } from '../src/core/slides/render';

function crc32(bytes: Uint8Array): number {
  let c = ~0;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
/** A valid 2×2 red PNG as a data URL. */
function pngUrl(): string {
  const chunk = (type: string, data: Uint8Array) => {
    const body = new Uint8Array([...type].map((ch) => ch.charCodeAt(0)).concat([...data]));
    const out = new Uint8Array(12 + data.length);
    new DataView(out.buffer).setUint32(0, data.length);
    out.set(body, 4);
    new DataView(out.buffer).setUint32(8 + data.length, crc32(body));
    return out;
  };
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 2);
  new DataView(ihdr.buffer).setUint32(4, 2);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const raw = new Uint8Array([0, 255, 0, 0, 255, 0, 0, 0, 255, 0, 0, 255, 0, 0]);
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', new Uint8Array())];
  return 'data:image/png;base64,' + Buffer.concat(parts).toString('base64');
}

function sampleDeck() {
  const deck = newDeck(THEMES[3]);
  (deck.slides[0].elements[0] as ShapeElement).text = [para('Quarterly Review', { align: 'center' })];
  deck.slides[0].notes = 'Welcome everyone.\nSecond line.';
  const s2 = newSlide(deck, 'titleContent');
  (s2.elements[0] as ShapeElement).text = [para('Agenda')];
  (s2.elements[1] as ShapeElement).text = [
    para('Revenue'),
    para('Costs', { level: 1 }),
    { runs: [{ text: 'Bold ', bold: true }, { text: 'link', link: 'https://example.com/a?b=1&c=2', color: '#0563c1', underline: true }, { text: ' <tail> & "quotes"', italic: true, strike: true, size: 30 }] },
    para('One', { bullet: 'number' }),
    para('No bullet, centred, spaced', { bullet: 'none', align: 'center', lineSpacing: 1.8 }),
  ];
  s2.transition = { type: 'push', duration: 1.2 };
  s2.hidden = true;
  const s3 = newSlide(deck, 'blank');
  const star = { ...shape('star5', 80, 80, 200, 200, '#f59e0b', '#92400e'), lineDash: 'dash' as const, text: [para('Star', { align: 'center' })] };
  const grad = { ...shape('roundRect', 320, 80, 260, 120, '#0284c7'), fill2: '#0d9488', shadow: true, rotation: 30, flipH: true, valign: 'bottom' as const, opacity: 1 };
  const tb = table(80, 330, 600, 150, 3, 3);
  tb.cells[0][0]!.text = [para('Item')];
  tb.cells[1][1] = { text: [para('10')], fill: '#ffeeaa', valign: 'middle' };
  tb.cells[2][0] = { text: [para('Merged')], colSpan: 2 };
  tb.cells[2][1] = null;
  const pic = { ...image(pngUrl(), 720, 80, 320, 180), crop: [0.1, 0, 0.2, 0] as [number, number, number, number], radius: 0.1, alt: 'A red square' };
  const ln = { ...line(720, 320, 300, 120, '#e11d48', true), flipV: true, lineDash: 'dot' as const, startArrow: true };
  s3.elements.push(star, grad, pic, ln, tb, textBox(720, 470, 400, 80, [para('Plain', { italic: true })]), { ...image(pngUrl(), 10, 10, 20, 20) });
  s3.elements.push({ ...chart('line', 700, 560, 400, 150), title: 'Sales & <costs>', series: [{ name: 'A', values: [1, null, 3.5, -2] }, { name: 'B', values: [2, 4, 6, 8] }] });
  s3.background = { type: 'gradient', from: '#f0f9ff', to: '#bae6fd', angle: 180 };
  deck.slides.push(s2, s3);
  return deck;
}

describe('presentation model', () => {
  it('starts with a title slide and builds layouts', () => {
    const deck = newDeck();
    expect([deck.width, deck.height]).toEqual([1280, 720]);
    expect(deck.slides[0].elements.map((e) => (e as ShapeElement).placeholder)).toEqual(['ctrTitle', 'subTitle']);
    expect(layoutElements(deck, 'twoContent').map((e) => e.placeholder)).toEqual(['title', 'body', 'body']);
    expect(layoutElements(deck, 'blank')).toEqual([]);
    expect(isEmptyText(deck.slides[0].elements[0].kind === 'shape' ? deck.slides[0].elements[0].text : [])).toBe(true);
  });
  it('copies slides with fresh ids, merges like runs and restyles text', () => {
    const deck = sampleDeck();
    const copy = cloneSlide(deck.slides[2]);
    expect(copy.id).not.toBe(deck.slides[2].id);
    expect(copy.elements.map((e) => e.id)).not.toEqual(deck.slides[2].elements.map((e) => e.id));
    expect(copy.elements.map((e) => e.kind)).toEqual(deck.slides[2].elements.map((e) => e.kind));
    const merged = normalizeParagraph({ runs: [{ text: 'a', bold: true }, { text: 'b', bold: true }, { text: '' }, { text: 'c' }] });
    expect(merged.runs).toEqual([{ text: 'ab', bold: true }, { text: 'c' }]);
    expect(normalizeParagraph({ runs: [{ text: '' }, { text: '' }] }).runs).toHaveLength(1);
    expect(styleAll([para('x'), para('y')], { color: '#ff0000' }).every((p) => p.runs[0].color === '#ff0000')).toBe(true);
    expect(plainText([para('a'), para('b')])).toBe('a\nb');
  });
  it('rescales everything when the slide size changes', () => {
    const deck = sampleDeck();
    const small = resizeDeck(deck, 960, 720);
    const t0 = deck.slides[2].elements.find((e) => e.kind === 'table') as TableElement;
    const t1 = small.slides[2].elements.find((e) => e.kind === 'table') as TableElement;
    expect(t1.w).toBeCloseTo(t0.w * 0.75, 6);
    expect(t1.cols.reduce((a, b) => a + b, 0)).toBeCloseTo(t1.w, 6);
    // 4:3 is taller than 16:9 scaled down: content is centred vertically
    expect(t1.y).toBeCloseTo(t0.y * 0.75 + 90, 6);
  });
});

describe('charts', () => {
  it('turns chart data into editable text and back', () => {
    const c = chart('column', 0, 0, 400, 300);
    const text = chartToText(c);
    expect(text.split('\n')[0]).toBe('\tSeries 1\tSeries 2');
    expect(chartFromText(text)).toEqual({ categories: c.categories, series: c.series });
    const typed = chartFromText('Month, "Sales, net", Costs\nJan, 1 200, 3\nFeb, , 4.5\n\n');
    expect(typed.categories).toEqual(['Jan', 'Feb']);
    expect(typed.series).toEqual([{ name: 'Sales, net', values: [1200, null] }, { name: 'Costs', values: [3, 4.5] }]);
    // pasted from a spreadsheet: tabs, and a decimal comma
    expect(chartFromText('\tA\nx\t4,5').series[0].values).toEqual([4.5]);
    expect(() => chartFromText('only one row')).toThrow(/first row/);
  });
  it('picks round axis steps and draws every chart type', () => {
    expect(niceScale(0, 4.5)).toEqual({ lo: 0, hi: 5, step: 1 });
    expect(niceScale(-30, 120)).toMatchObject({ lo: -50, hi: 150, step: 50 });
    expect(niceScale(0, 0).hi).toBeGreaterThan(0);
    const deck = newDeck();
    for (const type of ['column', 'bar', 'line', 'pie'] as const) {
      deck.slides[0].elements = [{ ...chart(type, 10, 10, 500, 300), title: '<b>T</b>' }];
      const html = slideHtml(deck, deck.slides[0]);
      expect(html).toContain('&lt;b&gt;T&lt;/b&gt;');
      expect(html).toMatch(type === 'pie' ? /<path d="M\d/ : type === 'line' ? /stroke-linejoin="round"/ : /<rect x=/);
      expect(new DOMParser().parseFromString(slideSvg(deck, deck.slides[0]), 'image/svg+xml').getElementsByTagName('parsererror').length).toBe(0);
    }
  });
});

describe('find and replace', () => {
  it('replaces text everywhere, keeping formatting, and finds the elements that contain it', () => {
    const deck = sampleDeck();
    expect(findInSlide(deck.slides[1], 'REVENUE')).toHaveLength(1);
    expect(findInSlide(deck.slides[1], 'REVENUE', true)).toHaveLength(0);
    expect(findInSlide(deck.slides[2], 'item')).toHaveLength(1);
    expect(findInSlide(deck.slides[1], '')).toEqual([]);
    const { deck: next, count } = replaceInDeck(deck, 'e', '3');
    expect(count).toBeGreaterThan(8);
    expect(plainText((next.slides[0].elements[0] as ShapeElement).text)).toBe('Quart3rly R3vi3w');
    expect(next.slides[0].notes).toBe('W3lcom3 3v3ryon3.\nS3cond lin3.');
    const body = next.slides[1].elements[1] as ShapeElement;
    expect(body.text[2].runs[0]).toMatchObject({ text: 'Bold ', bold: true });
    expect(body.text[2].runs[2]).toMatchObject({ text: ' <tail> & "quot3s"', italic: true, size: 30 });
    expect(plainText((next.slides[2].elements.find((e) => e.kind === 'table') as TableElement).cells[2][0]!.text)).toBe('M3rg3d');
    // special characters are literal, and nothing found changes nothing
    expect(replaceInDeck(deck, '<tail>', 'x').count).toBe(1);
    expect(replaceInDeck(deck, '.*', 'x').count).toBe(0);
    expect(replaceInDeck(deck, 'zzz', 'x').deck).toBe(deck);
    expect(replaceInDeck(deck, 'bold', 'B', true).count).toBe(0);
  });
});

describe('slide rendering', () => {
  it('escapes text and refuses unsafe colours, links and pictures', () => {
    const deck = newDeck();
    const s = deck.slides[0];
    (s.elements[0] as ShapeElement).text = [{ runs: [{ text: '<img src=x onerror=alert(1)>', color: 'red;background:url(x)', link: 'javascript:alert(1)', font: 'Arial;}</style>' }] }];
    s.elements.push(image('javascript:alert(1)', 0, 0, 10, 10), { ...shape('rect', 0, 0, 10, 10, 'url(x)') });
    const html = slideHtml(deck, s);
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('url(x)');
    expect(html).not.toContain('</style>');
    expect(html).not.toMatch(/src="javascript/);
    const doc = new DOMParser().parseFromString(html, 'text/html');
    expect(doc.querySelectorAll('script, [onerror]').length).toBe(0);
  });
  it('draws bullets, numbering and prompts', () => {
    const html = paragraphsHtml([para('a', { bullet: 'bullet' }), para('b', { bullet: 'number' }), para('c', { bullet: 'none', level: 2 })], { size: 18, color: '#000', font: 'Arial', bullets: false });
    expect(html).toMatch(/list-style:disc/);
    expect(html).toMatch(/list-style:decimal/);
    expect(html).toMatch(/counter-reset:list-item/);
    const deck = newDeck();
    expect(slideHtml(deck, deck.slides[0], { prompts: true })).toContain('Click to add title');
    expect(slideHtml(deck, deck.slides[0])).not.toContain('Click to add title');
    expect(shapePath('ellipse', 100, 50)).toMatch(/^M0 25 A50 25/);
    expect(shapePath('someFuturePreset', 10, 20)).toBe('M0 0 H10 V20 H0 Z');
  });
  it('makes a well-formed SVG of a slide', () => {
    const deck = sampleDeck();
    for (const s of deck.slides) {
      const doc = new DOMParser().parseFromString(slideSvg(deck, s, 0.5), 'image/svg+xml');
      expect(doc.getElementsByTagName('parsererror').length).toBe(0);
      expect(doc.documentElement.getAttribute('width')).toBe('640');
    }
  });
});

describe('PowerPoint files', () => {
  it('writes a package PowerPoint accepts and reads its own files back unchanged', async () => {
    const deck = sampleDeck();
    const bytes = await writePptx(deck, { title: 'Test' });
    expect(await isPptx(bytes)).toBe(true);
    const zip = await JSZip.loadAsync(bytes);
    for (const f of ['[Content_Types].xml', '_rels/.rels', 'ppt/presentation.xml', 'ppt/slides/slide3.xml', 'ppt/slideMasters/slideMaster1.xml', 'ppt/slideLayouts/slideLayout4.xml', 'ppt/theme/theme1.xml', 'ppt/notesSlides/notesSlide1.xml', 'ppt/notesMasters/notesMaster1.xml']) {
      expect(zip.file(f), f).not.toBeNull();
    }
    // every XML part parses, and the same picture is stored once
    for (const name of Object.keys(zip.files)) {
      if (!/\.(xml|rels)$/.test(name)) continue;
      const doc = new DOMParser().parseFromString(await zip.file(name)!.async('string'), 'application/xml');
      expect(doc.getElementsByTagName('parsererror').length, name).toBe(0);
    }
    expect(Object.keys(zip.files).filter((n) => n.startsWith('ppt/media/') && !zip.files[n].dir)).toEqual(['ppt/media/image1.png']);

    const { deck: back, warnings } = await readPptx(bytes);
    expect(warnings).toEqual([]);
    expect([back.width, back.height, back.slides.length]).toEqual([1280, 720, 3]);
    expect(back.theme).toEqual(THEMES[3]);
    expect(back.slides[0].notes).toBe('Welcome everyone.\nSecond line.');
    // empty placeholders are not written
    expect(back.slides[0].elements).toHaveLength(1);
    const title = back.slides[0].elements[0] as ShapeElement;
    expect(title.placeholder).toBe('ctrTitle');
    expect(plainText(title.text)).toBe('Quarterly Review');
    expect(title.text[0].align).toBe('center');
    expect(title.valign).toBe('bottom');

    const s2 = back.slides[1];
    expect(s2.hidden).toBe(true);
    expect(s2.transition).toEqual({ type: 'push', duration: 1.2 });
    const body = s2.elements[1] as ShapeElement;
    expect(body.text.map((p) => p.bullet)).toEqual(['bullet', 'bullet', 'bullet', 'number', 'none']);
    expect(body.text[1].level).toBe(1);
    expect(body.text[4]).toMatchObject({ align: 'center', lineSpacing: 1.8 });
    const [b, l, t] = body.text[2].runs;
    expect(b).toMatchObject({ text: 'Bold ', bold: true });
    expect(l).toMatchObject({ text: 'link', link: 'https://example.com/a?b=1&c=2', color: '#0563c1', underline: true });
    expect(t).toMatchObject({ text: ' <tail> & "quotes"', italic: true, strike: true, size: 30 });

    const s3 = back.slides[2];
    expect(s3.background).toEqual({ type: 'gradient', from: '#f0f9ff', to: '#bae6fd', angle: 180 });
    expect(s3.elements.map((e) => e.kind)).toEqual(['shape', 'shape', 'image', 'line', 'table', 'shape', 'image', 'chart']);
    expect(s3.elements[7]).toMatchObject({ chart: 'line', title: 'Sales & <costs>', legend: true, categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'A', values: [1, null, 3.5, -2] }, { name: 'B', values: [2, 4, 6, 8] }], x: 700, w: 400 });
    expect(zip.file('ppt/charts/chart1.xml')).not.toBeNull();
    const star = s3.elements[0] as ShapeElement;
    expect(star).toMatchObject({ shape: 'star5', fill: '#f59e0b', line: '#92400e', lineDash: 'dash', x: 80, y: 80, w: 200, h: 200 });
    expect(s3.elements[1]).toMatchObject({ shape: 'roundRect', fill: '#0284c7', fill2: '#0d9488', shadow: true, rotation: 30, flipH: true, valign: 'bottom' });
    const pic = s3.elements[2] as ImageElement;
    expect(pic.src).toBe(pngUrl());
    expect(pic.crop).toEqual([0.1, 0, 0.2, 0]);
    expect(pic).toMatchObject({ radius: 0.1, alt: 'A red square' });
    expect(s3.elements[3] as LineElement).toMatchObject({ color: '#e11d48', flipV: true, lineDash: 'dot', startArrow: true, endArrow: true });
    const tb = s3.elements[4] as TableElement;
    expect(tb).toMatchObject({ header: true, banded: true, border: '#bfbfbf' });
    expect(tb.cols).toHaveLength(3);
    expect(tb.cells[2][0]).toMatchObject({ colSpan: 2 });
    expect(tb.cells[2][1]).toBeNull();
    expect(tb.cells[1][1]).toMatchObject({ fill: '#ffeeaa', valign: 'middle' });
    // cells that only had the table style's colours come back without a fill of their own
    expect(tb.cells[0][0]!.fill).toBeNull();
    expect(tb.cells[1][0]!.fill).toBeNull();
    expect(plainText(tb.cells[0][0]!.text)).toBe('Item');

    // writing what was read gives the same deck again
    const again = (await readPptx(await writePptx(back))).deck;
    const strip = (d: typeof back) => JSON.parse(JSON.stringify(d, (k, v) => (k === 'id' || k === 'name' ? undefined : v)));
    expect(strip(again)).toEqual(strip(back));
  });

  it('writes a slide show (.ppsx) and an empty deck', async () => {
    const show = await JSZip.loadAsync(await writePptx(newDeck(), { as: 'show' }));
    expect(await show.file('[Content_Types].xml')!.async('string')).toContain('slideshow.main+xml');
    const empty = await readPptx(await writePptx({ ...newDeck(), slides: [] }));
    expect(empty.deck.slides).toHaveLength(1);
  });

  it('reads a deck made elsewhere: inherited positions, sizes and bullets', async () => {
    const { deck, warnings } = await readPptx(new Uint8Array(readFileSync('tests/fixtures/sample.pptx')));
    expect([deck.width, deck.height]).toEqual([960, 720]);
    expect(deck.slides).toHaveLength(3);
    expect(deck.slides[0].notes).toBe('Speaker note here');
    const title = deck.slides[0].elements.find((e) => e.kind === 'shape' && e.placeholder === 'ctrTitle') as ShapeElement;
    expect(plainText(title.text)).toBe('Foreign Deck');
    // the slide itself says nothing about where its title is or how big its text is: both come from the layout and master
    expect(title.w).toBeGreaterThan(600);
    expect(title.y).toBeGreaterThan(150);
    expect(title.text[0].runs[0].size).toBe(44);
    expect(title.text[0].align).toBe('center');
    const body = deck.slides[1].elements.find((e) => e.kind === 'shape' && e.placeholder === 'body') as ShapeElement;
    expect(body.text.map((p) => p.bullet)).toEqual(['bullet', 'bullet', 'bullet']);
    expect(body.text[0].runs[0].size).toBe(32);
    expect(body.text[1]).toMatchObject({ level: 1 });
    expect(body.text[1].runs[0].size).toBe(28);
    expect(body.text[2].runs[0]).toMatchObject({ text: 'Red bold', bold: true, color: '#ff0000', size: 30 });
    const kinds = deck.slides[2].elements.map((e) => e.kind);
    expect(kinds).toEqual(['image', 'shape', 'table', 'chart']);
    expect(deck.slides[2].elements[3]).toMatchObject({ chart: 'column', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] });
    const rounded = deck.slides[2].elements[1] as ShapeElement;
    expect(rounded.shape).toBe('roundRect');
    // the fill and white text of an accent-styled shape come from its style and the theme
    expect(rounded.fill).toMatch(/^#[0-9a-f]{6}$/);
    expect(rounded.text[0].runs[0].color).toBe('#ffffff');
    expect(warnings).toEqual([]);
    // and it can be written back out and read again
    const again = await readPptx(await writePptx(deck));
    expect(again.deck.slides.map((s) => s.elements.length)).toEqual([2, 2, 4]);
    expect(again.deck.slides[2].elements[3]).toMatchObject({ kind: 'chart', categories: ['a', 'b'], series: [{ name: 's', values: [1, 2] }] });
  });

  it('rejects files that are not presentations', async () => {
    await expect(readPptx(new Uint8Array([1, 2, 3]))).rejects.toThrow(/not a PowerPoint/);
    const zip = new JSZip();
    zip.file('word/document.xml', '<w/>');
    await expect(readPptx(await zip.generateAsync({ type: 'uint8array' }))).rejects.toThrow(/no presentation/);
    expect(await isPptx(new Uint8Array([1, 2, 3]))).toBe(false);
    expect(colorParts('#abc')).toEqual({ hex: 'AABBCC', alpha: 1 });
    expect(colorParts('rgba(255, 0, 0, 0.5)')).toEqual({ hex: 'FF0000', alpha: 0.5 });
  });
});

describe('reading text back from the editable box', () => {
  const style = { size: 24, color: '#262626', font: 'Arial', bullets: true };
  const box = (html: string) => {
    const el = document.createElement('div');
    el.innerHTML = html;
    document.body.appendChild(el);
    return el;
  };
  it('round-trips what the renderer wrote', async () => {
    const { readEditable } = await import('../src/ui/slides/text-edit');
    const text = [
      para('Plain'),
      { runs: [{ text: 'Bold ', bold: true }, { text: 'red', color: '#ff0000', size: 30, italic: true }, { text: ' link', link: 'https://example.com', underline: true }], align: 'center' as const, level: 2, bullet: 'number' as const, lineSpacing: 1.8 },
      para('', { bullet: 'none' }),
    ];
    const back = readEditable(box(paragraphsHtml(text, style)), style);
    expect(back[0]).toEqual({ runs: [{ text: 'Plain' }], bullet: 'bullet' });
    expect(back[1]).toMatchObject({ align: 'center', level: 2, bullet: 'number', lineSpacing: 1.8 });
    expect(back[1].runs).toEqual([{ text: 'Bold ', bold: true }, { text: 'red', color: '#ff0000', size: 30, italic: true }, { text: ' link', link: 'https://example.com', underline: true }]);
    expect(back[2]).toEqual({ runs: [{ text: '' }], bullet: 'none' });
  });
  it('understands browser formatting tags and drops everything else', async () => {
    const { readEditable } = await import('../src/ui/slides/text-edit');
    const back = readEditable(
      box('<div data-p="1" data-bullet="none"><b>B</b><i>I</i><u>U</u><strike>S</strike><span style="font-weight:700;color:rgb(0, 128, 0)">G</span><script>alert(1)</script><img src=x onerror=alert(1)><a href="javascript:alert(1)">bad</a></div><p>second<br>line</p>'),
      style,
    );
    expect(back).toHaveLength(2);
    expect(back[0].runs.slice(0, 5)).toEqual([{ text: 'B', bold: true }, { text: 'I', italic: true }, { text: 'U', underline: true }, { text: 'S', strike: true }, { text: 'G', bold: true, color: '#008000' }]);
    // a javascript: link is just text
    expect(back[0].runs.some((r) => r.link)).toBe(false);
    expect(back[1].runs.map((r) => r.text).join('')).toBe('second\nline');
    // formatting equal to the box's defaults is not stored on the run
    const same = readEditable(box('<div data-p="1"><span style="font-size:32px;color:#262626">x</span></div>'), style);
    expect(same[0].runs).toEqual([{ text: 'x' }]);
    expect(readEditable(box(''), style)).toEqual([{ runs: [{ text: '' }] }]);
  });
});
