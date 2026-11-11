import { IMAGE_EXTENSIONS_ALL } from '../core/media/media-formats';

export interface LoadedImage {
  dataUrl: string;
  width: number;
  height: number;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image.'));
    reader.readAsDataURL(blob);
  });
}

async function sniffType(blob: Blob): Promise<string> {
  const h = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (h[0] === 0x89 && h[1] === 0x50) return 'image/png';
  if (h[0] === 0xff && h[1] === 0xd8) return 'image/jpeg';
  return blob.type;
}

/**
 * Reads any supported image (incl. HEIC, TIFF, JPEG XL, AVIF) into a PNG or JPEG data URL for
 * embedding in a document or PDF. Images larger than `maxDim` on the long edge are scaled down
 * so documents don't balloon. Camera metadata is dropped in the process.
 */
export async function loadImageFile(blob: Blob, name = '', maxDim = 2400): Promise<LoadedImage> {
  const [{ decodeImage, encodeImage, resizePixels }] = await Promise.all([import('../core/media/image-codecs')]);
  const type = await sniffType(blob);
  const { pixels } = await decodeImage(blob, name || (type === 'image/png' ? 'image.png' : type === 'image/jpeg' ? 'image.jpg' : 'image'));
  const scale = Math.min(1, maxDim / Math.max(pixels.width, pixels.height));
  // a PNG/JPEG that needs no scaling is embedded byte-for-byte… minus its metadata, so re-encode
  const px = scale < 1 ? resizePixels(pixels, pixels.width * scale, pixels.height * scale) : pixels;
  const isJpeg = type === 'image/jpeg';
  const bytes = await encodeImage(px, isJpeg ? 'jpeg' : 'png', { quality: 90 });
  const dataUrl = await blobToDataUrl(new Blob([bytes as BlobPart], { type: isJpeg ? 'image/jpeg' : 'image/png' }));
  return { dataUrl, width: px.width, height: px.height };
}

export const IMAGE_EXTENSIONS = IMAGE_EXTENSIONS_ALL;

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '');
}
