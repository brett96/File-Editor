/** Slides as pictures and PDF: each slide is drawn once through the shared renderer's SVG. */
import JSZip from 'jszip';
import type { Deck, Slide } from '../../core/slides/model';
import { slideSvg } from '../../core/slides/render';

/** A slide as a canvas, `scale` × its size in slide pixels. */
export async function slideToCanvas(deck: Deck, slide: Slide, scale = 2): Promise<HTMLCanvasElement> {
  const svg = slideSvg(deck, slide, scale);
  const img = new Image();
  // a data: URL (not a blob: URL) keeps the canvas readable afterwards
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  await new Promise<void>((res, rej) => {
    img.onload = () => res();
    img.onerror = () => rej(new Error('A slide could not be drawn.'));
    img.src = url;
  });
  const cv = document.createElement('canvas');
  cv.width = Math.round(deck.width * scale);
  cv.height = Math.round(deck.height * scale);
  const ctx = cv.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cv.width, cv.height);
  ctx.drawImage(img, 0, 0, cv.width, cv.height);
  return cv;
}

const toBytes = (cv: HTMLCanvasElement, type: string, quality?: number) =>
  new Promise<Uint8Array>((res, rej) => cv.toBlob(async (b) => (b ? res(new Uint8Array(await b.arrayBuffer())) : rej(new Error('The picture could not be encoded.'))), type, quality));

export type Progress = (done: number, total: number) => void;

/** One page per slide (hidden slides are left out, as when printing from PowerPoint). */
export async function deckToPdf(deck: Deck, title: string, progress?: Progress): Promise<Uint8Array> {
  const { PDFDocument } = await import('@cantoo/pdf-lib');
  const pdf = await PDFDocument.create();
  pdf.setTitle(title);
  pdf.setCreator('File Editor');
  const slides = deck.slides.filter((s) => !s.hidden);
  const list = slides.length ? slides : deck.slides;
  const w = deck.width * 0.75;
  const h = deck.height * 0.75;
  for (let i = 0; i < list.length; i++) {
    progress?.(i, list.length);
    const cv = await slideToCanvas(deck, list[i], 2);
    const jpg = await pdf.embedJpg(await toBytes(cv, 'image/jpeg', 0.92));
    pdf.addPage([w, h]).drawImage(jpg, { x: 0, y: 0, width: w, height: h });
  }
  return pdf.save();
}

/** Every slide as a PNG, in a zip (Slide 01.png …). */
export async function deckToPngZip(deck: Deck, progress?: Progress): Promise<Uint8Array> {
  const zip = new JSZip();
  const pad = String(deck.slides.length).length;
  for (let i = 0; i < deck.slides.length; i++) {
    progress?.(i, deck.slides.length);
    zip.file(`Slide ${String(i + 1).padStart(Math.max(2, pad), '0')}.png`, await toBytes(await slideToCanvas(deck, deck.slides[i], 2), 'image/png'));
  }
  return zip.generateAsync({ type: 'uint8array', compression: 'STORE' });
}

/** Reads a picture file as a data: URL and its size. Vector and unusual formats are redrawn as PNG so PowerPoint can open them. */
export async function readPicture(file: Blob): Promise<{ src: string; width: number; height: number }> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    await new Promise<void>((res, rej) => {
      img.onload = () => res();
      img.onerror = () => rej(new Error('That file is not a picture that can be shown.'));
      img.src = url;
    });
    const width = img.naturalWidth || 400;
    const height = img.naturalHeight || 300;
    const keep = /^image\/(png|jpeg|gif)$/.test(file.type) && Math.max(width, height) <= 4000;
    if (keep) {
      const src = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result));
        fr.onerror = () => rej(new Error('The picture could not be read.'));
        fr.readAsDataURL(file);
      });
      return { src, width, height };
    }
    // very large photos are brought down to a size a slide can use
    const k = Math.min(1, 4000 / Math.max(width, height)) * (file.type === 'image/svg+xml' ? Math.max(1, 1600 / Math.max(width, height)) : 1);
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(width * k));
    cv.height = Math.max(1, Math.round(height * k));
    cv.getContext('2d')!.drawImage(img, 0, 0, cv.width, cv.height);
    const photo = file.type === 'image/jpeg';
    return { src: cv.toDataURL(photo ? 'image/jpeg' : 'image/png', 0.9), width, height };
  } finally {
    URL.revokeObjectURL(url);
  }
}
