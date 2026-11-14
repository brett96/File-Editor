/**
 * Paths inside an opened folder. They are always relative to the folder's root, use '/' and
 * never start with one; '' is the root itself. The same checks run in the renderer and in the
 * desktop main process, which never trusts a path it is handed.
 */

/** Characters no path segment may contain (path separators, Windows drive / stream markers, NUL). */
const BAD_SEGMENT = /[\\/:*?"<>|\u0000-\u001f]/;

/** Whether `name` can be one file or folder name (no separators, not '.', '..' or empty). */
export function isSafeName(name: string): boolean {
  return typeof name === 'string' && name.length > 0 && name.length <= 255 && name !== '.' && name !== '..' && !BAD_SEGMENT.test(name) && !/[. ]$/.test(name);
}

/**
 * Splits a folder-relative path into its segments, or returns null when it is not one: an
 * absolute path, a drive letter, a backslash, an empty or '.' / '..' segment. '' (the root)
 * gives [].
 */
export function safeSegments(path: unknown): string[] | null {
  if (typeof path !== 'string' || path.length > 4096) return null;
  if (path === '') return [];
  const parts = path.split('/');
  for (const p of parts) if (p === '' || p === '.' || p === '..' || BAD_SEGMENT.test(p)) return null;
  return parts;
}

export function joinPath(dir: string, name: string): string {
  return dir ? `${dir}/${name}` : name;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf('/');
  return i < 0 ? '' : path.slice(0, i);
}

export function leafOf(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

/**
 * Resolves a URL-style reference found in the file `from` ("../img/a.png", "/css/site.css",
 * "x.js?v=2#top") to a folder-relative path. A leading '/' means the folder's root. Returns
 * null when the reference leaves the folder or is not a path at all.
 */
export function resolveReference(from: string, ref: string): string | null {
  let r = ref.trim().replace(/[?#].*$/, '');
  if (!r) return null;
  try {
    r = decodeURIComponent(r);
  } catch {
    /* a stray %: use it as written */
  }
  r = r.replace(/\\/g, '/');
  const out = r.startsWith('/') ? [] : dirOf(from).split('/').filter(Boolean);
  for (const part of r.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (!out.length) return null;
      out.pop();
    } else out.push(part);
  }
  const path = out.join('/');
  return safeSegments(path) && path ? path : null;
}

/** What kind of reference a URL in a page is. */
export function referenceKind(ref: string): 'relative' | 'remote' | 'inline' {
  const r = ref.trim();
  if (!r || r.startsWith('#')) return 'inline';
  if (r.startsWith('//')) return 'remote';
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(r)?.[1].toLowerCase();
  if (!scheme) return 'relative';
  return scheme === 'http' || scheme === 'https' || scheme === 'ftp' || scheme === 'ws' || scheme === 'wss' ? 'remote' : 'inline';
}
