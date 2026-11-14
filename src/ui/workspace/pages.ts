/**
 * Finds the web pages of an opened folder, for previewing a stylesheet or script in the page
 * that uses it. The scan is breadth-first and bounded (a repository can hold a million files),
 * and skips dependency and build folders.
 */
import type { OpenedFolder } from '../../platform/folders';

const MAX_PAGES = 60;
const MAX_DIRS = 400;
const MAX_DEPTH = 6;
const CACHE_MS = 4000;

const cache = new Map<string, { at: number; pages: Promise<string[]> }>();

async function scan(folder: OpenedFolder): Promise<string[]> {
  const pages: string[] = [];
  let queue = [''];
  let seen = 0;
  for (let depth = 0; depth <= MAX_DEPTH && queue.length && pages.length < MAX_PAGES; depth++) {
    const next: string[] = [];
    for (const dir of queue) {
      if (++seen > MAX_DIRS || pages.length >= MAX_PAGES) break;
      const entries = await folder.list(dir).catch(() => []);
      for (const e of entries) {
        if (e.kind === 'dir') {
          if (!e.ignored && !e.name.startsWith('.')) next.push(e.path);
        } else if (/\.(html?|xhtml)$/i.test(e.name) && pages.length < MAX_PAGES) pages.push(e.path);
      }
    }
    queue = next;
  }
  return pages;
}

/** The folder's HTML files (nearest the root first), found at most once every few seconds. */
export function folderPages(folder: OpenedFolder): Promise<string[]> {
  const hit = cache.get(folder.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.pages;
  const pages = scan(folder);
  cache.set(folder.id, { at: Date.now(), pages });
  return pages;
}
