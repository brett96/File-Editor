/**
 * The renderer's side of the Git panel: calls into the desktop main process (electron/git.ts),
 * keeps an output log of what ran, and tells the rest of the app when files changed.
 */
import type { GitContext } from '../../platform/host';

export type { GitContext };

export class GitCallError extends Error {
  constructor(
    message: string,
    public code: string,
  ) {
    super(message);
  }
}

export interface GitLogEntry {
  at: number;
  op: string;
  ok: boolean;
  text: string;
}

const log: GitLogEntry[] = [];
const logListeners = new Set<() => void>();

export function gitLog(): readonly GitLogEntry[] {
  return log;
}

export function onGitLog(listener: () => void): () => void {
  logListeners.add(listener);
  return () => logListeners.delete(listener);
}

function record(op: string, ok: boolean, text: string) {
  log.push({ at: Date.now(), op, ok, text });
  if (log.length > 300) log.splice(0, log.length - 300);
  logListeners.forEach((l) => l());
}

/** The Git bridge, or null in the browser (git runs in the desktop app only). */
export function gitAvailable(): boolean {
  return typeof window !== 'undefined' && !!window.desktop?.git;
}

/** Same repository? (A folder and a file in it are different contexts, so compare by key.) */
export const ctxKey = (ctx: GitContext) => ('folder' in ctx ? `d:${ctx.folder}` : `f:${ctx.file}`);

let opSeq = 0;
/** Read-only calls that run every few seconds: kept out of the output log. */
const QUIET = new Set(['info', 'status', 'branches', 'remotes', 'stashes', 'tags', 'worktrees', 'log', 'diff', 'commitFiles', 'stashFiles', 'identity', 'githubStatus', 'githubRepos']);

/**
 * Runs one git action. `onProgress` gets git's progress lines (clone, fetch, push…), and
 * `onStart` the id to cancel it with.
 */
export async function git<T = unknown>(
  ctx: GitContext | null,
  op: string,
  args: Record<string, unknown> = {},
  opts: { onProgress?: (line: string) => void; onStart?: (cancel: () => void) => void } = {},
): Promise<T> {
  const bridge = window.desktop?.git;
  if (!bridge) throw new GitCallError('Git works in the File Editor desktop app.', 'unavailable');
  const opId = `g${Date.now().toString(36)}${(opSeq++).toString(36)}`;
  const off = opts.onProgress ? bridge.onProgress((id, line) => id === opId && opts.onProgress!(line)) : null;
  opts.onStart?.(() => bridge.cancel(opId));
  try {
    const res = await bridge.call(ctx ?? ({} as GitContext), op, args, opId);
    if (!res.ok) {
      if (!QUIET.has(op) || res.code !== 'not-repo') record(op, false, res.error);
      throw new GitCallError(res.error, res.code);
    }
    if (!QUIET.has(op)) {
      const out = (res.data as { output?: string } | null)?.output;
      record(op, true, out || 'Done.');
    }
    const data = res.data as T & { changed?: boolean };
    if (data && typeof data === 'object' && data.changed) window.dispatchEvent(new CustomEvent('fe:git-changed', { detail: ctx }));
    // panels refresh after actions; read-only calls must not announce themselves, or each
    // refresh would set off the next one
    if (!QUIET.has(op)) window.dispatchEvent(new CustomEvent('fe:git-ran', { detail: { op } }));
    return data;
  } finally {
    off?.();
  }
}

export const STATUS_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'Untracked',
};

/** "2 hours ago" for an ISO date. */
export function timeAgo(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  const units: [number, string][] = [
    [60, 'minute'],
    [3600, 'hour'],
    [86400, 'day'],
    [604800, 'week'],
    [2629800, 'month'],
    [31557600, 'year'],
  ];
  let unit = units[0];
  for (const u of units) if (s >= u[0]) unit = u;
  const n = Math.floor(s / unit[0]);
  return `${n} ${unit[1]}${n === 1 ? '' : 's'} ago`;
}
