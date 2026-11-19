/**
 * Git output parsing and argument checks, shared by the desktop main process (which runs git,
 * electron/git-runner.ts) and the renderer (which shows the results, src/ui/git).
 *
 * Every command is run with machine-readable output (porcelain v2, NUL-separated fields), so
 * file names with spaces, quotes or newlines come through intact. No Node or DOM APIs here.
 */

// ── status ─────────────────────────────────────────────────────────────────
/** One letter of `git status` XY: '.' unchanged, M modified, A added, D deleted, R renamed, C copied, T type changed, U unmerged. */
export type GitCode = '.' | 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '?' | '!';

export interface GitFileChange {
  /** path from the repository's top level, '/'-separated */
  path: string;
  /** a rename's or copy's previous path */
  origPath?: string;
  /** change in the index (staged) */
  index: GitCode;
  /** change in the working tree (not staged) */
  worktree: GitCode;
  conflict?: boolean;
  untracked?: boolean;
}

export type GitOperation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | 'bisect' | null;

export interface GitStatus {
  /** null when HEAD is detached */
  branch: string | null;
  /** the commit HEAD points at (null in a repository with no commits yet) */
  oid: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFileChange[];
  /** an operation that stopped half way and needs continuing or aborting */
  operation: GitOperation;
}

const code = (c: string | undefined): GitCode => ('.MADRCTU?!'.includes(c ?? '') && c ? (c as GitCode) : '.');

/** Parses `git status --porcelain=v2 --branch -z`. */
export function parseStatus(out: string): Omit<GitStatus, 'operation'> {
  const status: Omit<GitStatus, 'operation'> = { branch: null, oid: null, upstream: null, ahead: 0, behind: 0, files: [] };
  const parts = out.split('\0');
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i];
    if (!p) continue;
    if (p.startsWith('# ')) {
      const [key, ...rest] = p.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid') status.oid = value === '(initial)' ? null : value;
      else if (key === 'branch.head') status.branch = value === '(detached)' ? null : value;
      else if (key === 'branch.upstream') status.upstream = value;
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }
    const kind = p[0];
    if (kind === '1' || kind === '2' || kind === 'u') {
      // fields before the path: 1 → 8, 2 → 9, u → 10
      const before = kind === '1' ? 8 : kind === '2' ? 9 : 10;
      let at = 0;
      for (let f = 0; f < before; f++) at = p.indexOf(' ', at) + 1;
      const xy = p.slice(2, 4);
      const change: GitFileChange = { path: p.slice(at), index: code(xy[0]), worktree: code(xy[1]) };
      if (kind === 'u') change.conflict = true;
      if (kind === '2') change.origPath = parts[++i];
      status.files.push(change);
    } else if (kind === '?') {
      status.files.push({ path: p.slice(2), index: '?', worktree: '?', untracked: true });
    }
  }
  return status;
}

/** The files of a status, in the groups the panel shows. */
export function groupChanges(files: GitFileChange[]): { conflicts: GitFileChange[]; staged: GitFileChange[]; unstaged: GitFileChange[] } {
  const conflicts = files.filter((f) => f.conflict);
  const staged = files.filter((f) => !f.conflict && !f.untracked && f.index !== '.');
  const unstaged = files.filter((f) => !f.conflict && (f.untracked || f.worktree !== '.'));
  return { conflicts, staged, unstaged };
}

// ── refs ───────────────────────────────────────────────────────────────────
export interface GitBranch {
  /** short name: "main", "origin/main" */
  name: string;
  remote: boolean;
  current: boolean;
  commit: string;
  upstream: string | null;
  /** "[ahead 1, behind 2]", "[gone]" or "" */
  track: string;
  date: string;
  subject: string;
}

/** The --format for parseBranches (fields NUL-separated, one ref per line). */
export const BRANCH_FORMAT = '%(refname)%00%(refname:short)%00%(objectname:short)%00%(upstream:short)%00%(upstream:track)%00%(HEAD)%00%(committerdate:iso8601-strict)%00%(contents:subject)';

export function parseBranches(out: string): GitBranch[] {
  const list: GitBranch[] = [];
  for (const line of out.split('\n')) {
    if (!line) continue;
    const [ref, name, commit, upstream, track, head, date, subject] = line.split('\0');
    if (!ref || ref.endsWith('/HEAD')) continue; // origin/HEAD is an alias, not a branch
    list.push({ name, remote: ref.startsWith('refs/remotes/'), current: head === '*', commit, upstream: upstream || null, track: track ?? '', date: date ?? '', subject: subject ?? '' });
  }
  return list;
}

export interface GitCommit {
  hash: string;
  short: string;
  author: string;
  email: string;
  date: string;
  /** branch and tag names pointing here ("HEAD -> main, origin/main, tag: v1") */
  refs: string;
  subject: string;
}

/** The --format for parseLog (fields NUL-separated, commits ended by \x1e). */
export const LOG_FORMAT = '%H%x00%h%x00%an%x00%ae%x00%aI%x00%D%x00%s%x1e';

export function parseLog(out: string): GitCommit[] {
  return out
    .split('\x1e')
    .map((r) => r.replace(/^\n/, ''))
    .filter(Boolean)
    .map((r) => {
      const [hash, short, author, email, date, refs, subject] = r.split('\0');
      return { hash, short, author, email, date, refs: refs ?? '', subject: subject ?? '' };
    });
}

export interface GitStash {
  /** "stash@{0}" */
  ref: string;
  date: string;
  message: string;
}

export const STASH_FORMAT = '%gd%x00%cI%x00%gs';

export function parseStashes(out: string): GitStash[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [ref, date, message] = l.split('\0');
      return { ref, date: date ?? '', message: message ?? '' };
    });
}

export interface GitTag {
  name: string;
  commit: string;
  date: string;
  subject: string;
  annotated: boolean;
}

export const TAG_FORMAT = '%(refname:short)%00%(objectname:short)%00%(creatordate:iso8601-strict)%00%(contents:subject)%00%(objecttype)';

export function parseTags(out: string): GitTag[] {
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [name, commit, date, subject, type] = l.split('\0');
      return { name, commit, date: date ?? '', subject: subject ?? '', annotated: type === 'tag' };
    });
}

export interface GitRemote {
  name: string;
  fetchUrl: string;
  pushUrl: string;
}

/** Parses `git remote -v`. */
export function parseRemotes(out: string): GitRemote[] {
  const map = new Map<string, GitRemote>();
  for (const line of out.split('\n')) {
    const m = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line);
    if (!m) continue;
    const r = map.get(m[1]) ?? { name: m[1], fetchUrl: '', pushUrl: '' };
    if (m[3] === 'fetch') r.fetchUrl = m[2];
    else r.pushUrl = m[2];
    map.set(m[1], r);
  }
  return [...map.values()];
}

export interface GitWorktree {
  path: string;
  head: string;
  /** short branch name, or null when detached */
  branch: string | null;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
}

/** Parses `git worktree list --porcelain`. */
export function parseWorktrees(out: string): GitWorktree[] {
  const list: GitWorktree[] = [];
  let cur: GitWorktree | null = null;
  for (const line of out.split('\n')) {
    if (line.startsWith('worktree ')) {
      cur = { path: line.slice(9), head: '', branch: null, bare: false, locked: false, prunable: false };
      list.push(cur);
    } else if (!cur) continue;
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5);
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace(/^refs\/heads\//, '');
    else if (line === 'bare') cur.bare = true;
    else if (line.startsWith('locked')) cur.locked = true;
    else if (line.startsWith('prunable')) cur.prunable = true;
  }
  return list;
}

// ── diffs ──────────────────────────────────────────────────────────────────
export interface GitDiffLine {
  kind: 'same' | 'add' | 'del' | 'hunk' | 'meta';
  text: string;
  /** old / new line numbers */
  a?: number;
  b?: number;
}

/** Parses the unified diff of one file (`git diff -- path`). */
export function parseUnifiedDiff(out: string): { lines: GitDiffLine[]; added: number; removed: number; binary: boolean } {
  const lines: GitDiffLine[] = [];
  let a = 0;
  let b = 0;
  let added = 0;
  let removed = 0;
  let inHunk = false;
  let binary = false;
  for (const raw of out.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/.exec(raw);
    if (hunk) {
      a = Number(hunk[1]);
      b = Number(hunk[2]);
      inHunk = true;
      lines.push({ kind: 'hunk', text: raw });
      continue;
    }
    if (!inHunk || raw.startsWith('diff --git ')) {
      inHunk = false;
      if (/^Binary files .* differ$/.test(raw) || raw.startsWith('GIT binary patch')) binary = true;
      if (/^(new|deleted) file mode|^rename (from|to)|^similarity index/.test(raw)) lines.push({ kind: 'meta', text: raw });
      continue;
    }
    if (raw.startsWith('+')) {
      lines.push({ kind: 'add', text: raw.slice(1), b: b++ });
      added++;
    } else if (raw.startsWith('-')) {
      lines.push({ kind: 'del', text: raw.slice(1), a: a++ });
      removed++;
    } else if (raw.startsWith(' ')) {
      lines.push({ kind: 'same', text: raw.slice(1), a: a++, b: b++ });
    } else if (raw.startsWith('\\')) {
      lines.push({ kind: 'meta', text: raw });
    }
  }
  return { lines, added, removed, binary };
}

// ── remotes and GitHub ─────────────────────────────────────────────────────
/** owner/repo of a github.com remote URL (https, ssh or scp-like), or null. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = /^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/.exec(url.trim());
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** The folder name `git clone` would make for a URL ("…/my-app.git" → "my-app"). */
export function cloneFolderName(url: string): string {
  const leaf = url.trim().replace(/[/\\]+$/, '').replace(/\.git$/i, '').split(/[/:\\]/).pop() ?? '';
  return isSafeFolderName(leaf) ? leaf : 'repository';
}

const isSafeFolderName = (s: string) => /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..';

// ── argument checks ────────────────────────────────────────────────────────
/**
 * A branch, tag or other ref name git accepts (the rules of `git check-ref-format`), never
 * starting with "-" so it can't be read as an option.
 */
export function isRefName(name: unknown): name is string {
  if (typeof name !== 'string' || !name || name.length > 250) return false;
  if (name.startsWith('-') || name.startsWith('/') || name.endsWith('/') || name.endsWith('.') || name.endsWith('.lock')) return false;
  if (name === '@' || name.includes('..') || name.includes('//') || name.includes('@{')) return false;
  if (/[\x00-\x20\x7f~^:?*[\\]/.test(name)) return false;
  return name.split('/').every((part) => part && !part.startsWith('.'));
}

/** A remote's name ("origin", "upstream"). */
export const isRemoteName = (name: unknown): name is string => typeof name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name);

/**
 * A repository URL to clone, fetch or push: https, http, ssh, git or scp-like (git@host:path),
 * or a local path. Never an option ("-…") or an ext:: / fd:: transport (those run commands).
 */
export function isRemoteUrl(url: unknown): url is string {
  if (typeof url !== 'string' || !url || url.length > 2000 || url.startsWith('-') || /[\s\x00-\x1f]/.test(url)) return false;
  if (/^(ext|fd)::/i.test(url)) return false;
  return /^(https?|ssh|git):\/\/[^/]+/i.test(url) || /^[\w.-]+@[\w.-]+:[^:]/.test(url) || /^(\/|[A-Za-z]:[\\/]|\.\.?[\\/]|file:\/\/)/.test(url);
}

/** A commit-ish the user picked from a list: a ref name or a hash. */
export const isRevision = (rev: unknown): rev is string => isRefName(rev) || (typeof rev === 'string' && /^[0-9a-f]{4,64}$/i.test(rev)) || rev === 'HEAD';

export const isStashRef = (ref: unknown): ref is string => typeof ref === 'string' && /^stash@\{\d{1,5}\}$/.test(ref);

/**
 * A path inside the repository as status lists it (relative, no NUL, no ".."). It may start
 * with "-": paths are always passed after "--", as literal pathspecs.
 */
export function isRepoPath(path: unknown): path is string {
  if (typeof path !== 'string' || !path || path.length > 4096 || path.includes('\0') || path.startsWith('/') || /^[A-Za-z]:/.test(path)) return false;
  return !path.split('/').includes('..');
}

/**
 * Splits a command line typed in the "Run git command" box into arguments: spaces separate,
 * single and double quotes group, backslash escapes inside double quotes. A leading "git" is
 * dropped. No shell is involved, so there is no globbing, piping or variable expansion.
 */
export function splitCommandLine(line: string): string[] {
  const args: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length && '"\\'.includes(line[i + 1])) cur += line[++i];
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      has = true;
    } else if (/\s/.test(ch)) {
      if (has || cur) args.push(cur);
      cur = '';
      has = false;
    } else {
      cur += ch;
      has = true;
    }
  }
  if (quote) throw new Error('A quote is not closed.');
  if (has || cur) args.push(cur);
  if (args[0] === 'git') args.shift();
  return args;
}
