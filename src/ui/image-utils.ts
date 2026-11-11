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

function decode(blob: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('This image could not be decoded.'));
    };
    img.src = url;
  });
}

/**
 * Reads an image file into a PNG or JPEG data URL. Other formats (GIF, WebP, BMP, SVG…) are
 * rasterised to PNG, and anything larger than `maxDim` on its long edge is scaled down so
 * documents don't balloon.
 */
export async function loadImageFile(blob: Blob, maxDim = 2400): Promise<LoadedImage> {
  const img = await decode(blob);
  const w = img.naturalWidth || 300;
  const h = img.naturalHeight || 150;
  const scale = Math.min(1, maxDim / Math.max(w, h));
  const isJpeg = /image\/jpe?g/i.test(blob.type);
  const isPng = /image\/png/i.test(blob.type);
  if (scale === 1 && (isJpeg || isPng)) {
    return { dataUrl: await blobToDataUrl(blob), width: w, height: h };
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  const dataUrl = isJpeg ? canvas.toDataURL('image/jpeg', 0.9) : canvas.toDataURL('image/png');
  return { dataUrl, width: canvas.width, height: canvas.height };
}

export const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg'];

export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.includes(name.split('.').pop()?.toLowerCase() ?? '');
}

export function imageMime(name: string): string {
  const ext = name.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'svg':
      return 'image/svg+xml';
    default:
      return `image/${ext}`;
  }
}
