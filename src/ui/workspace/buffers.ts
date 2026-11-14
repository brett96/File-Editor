/**
 * The text of open code tabs that belong to an opened folder, as it is on screen right now
 * (saved or not). The web preview reads a file from here before it reads it from disk, so a
 * page is previewed with the unsaved edits of every tab that takes part in it.
 */

const buffers = new Map<string, () => string>();
const listeners = new Set<(sourceId: string, path: string) => void>();

const key = (sourceId: string, path: string) => `${sourceId}\n${path}`;

/** Registers a tab's live text; returns the function that removes it again. */
export function registerBuffer(sourceId: string, path: string, getText: () => string): () => void {
  const k = key(sourceId, path);
  buffers.set(k, getText);
  return () => {
    if (buffers.get(k) === getText) buffers.delete(k);
  };
}

/** The live text of an open tab, or null when no tab has that file open. */
export function liveBuffer(sourceId: string, path: string): string | null {
  return buffers.get(key(sourceId, path))?.() ?? null;
}

/** Tells previews that a tab's text changed. */
export function bufferChanged(sourceId: string, path: string): void {
  listeners.forEach((l) => l(sourceId, path));
}

export function onBufferChange(listener: (sourceId: string, path: string) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
