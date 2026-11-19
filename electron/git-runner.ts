/**
 * Runs the user's own `git` for the Git panel (main process; no Electron APIs here, so it is
 * tested against real repositories in tests/git.test.ts).
 *
 * Safety:
 * - git is started directly (no shell), with an argument list this module builds. Names,
 *   refs, URLs and paths from the renderer are checked first (src/core/git/parse.ts) and
 *   passed after "--" where git allows it; pathspecs are literal (GIT_LITERAL_PATHSPECS).
 * - A repository's own config can't run programs behind the user's back during the panel's
 *   routine calls: core.fsmonitor is off, diffs never use an external diff tool, and the
 *   ext:: transport is refused. (Hooks still run on commit, as in any git client.)
 * - git never waits on a terminal prompt (GIT_TERMINAL_PROMPT=0). Sign-in uses the system's
 *   credential helper (e.g. Git Credential Manager), or the GitHub token the user connected
 *   in the app, handed to git through a one-command credential helper and an environment
 *   variable, never on the command line.
 */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { lstat, readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import {
  BRANCH_FORMAT,
  LOG_FORMAT,
  STASH_FORMAT,
  TAG_FORMAT,
  groupChanges,
  isRefName,
  isRemoteName,
  isRemoteUrl,
  isRepoPath,
  isRevision,
  isStashRef,
  parseBranches,
  parseLog,
  parseRemotes,
  parseStashes,
  parseStatus,
  parseTags,
  parseUnifiedDiff,
  parseWorktrees,
  type GitOperation,
  type GitStatus,
} from '../src/core/git/parse';

const SAFE_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'protocol.ext.allow=never', '-c', 'core.quotepath=false', '-c', 'color.ui=false'];
const LOCAL_TIMEOUT_MS = 60_000;
const NETWORK_TIMEOUT_MS = 10 * 60_000;
const MAX_OUTPUT = 64 * 1024 * 1024;
const MAX_DIFF_CHARS = 2 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    public code: 'not-installed' | 'not-repo' | 'failed' | 'timeout' | 'cancelled' | 'auth' | 'invalid',
    public output = '',
  ) {
    super(message);
  }
}

export interface RunOptions {
  timeoutMs?: number;
  /** exit codes that aren't failures (e.g. 1 for "differences found") */
  okCodes?: number[];
  /** progress lines (stderr) of long commands such as clone, fetch and push */
  onProgress?: (line: string) => void;
  signal?: AbortSignal;
  /** extra environment (the GitHub token) */
  env?: Record<string, string>;
  /** extra `-c` settings placed before the command */
  config?: string[];
}

export interface RunResult {
  stdout: string;
  stderr: string;
  code: number;
}

/** The last meaningful lines of git's error output, for the user. */
function errorText(stderr: string, stdout: string): string {
  const lines = (stderr || stdout)
    .split(/\r?\n|\r/)
    .map((l) => l.trim())
    .filter((l) => l && !/^(hint:|remote: (Counting|Compressing|Enumerating|Total))/.test(l));
  const text = lines.slice(-6).join('\n');
  return text.length > 1200 ? `…${text.slice(-1200)}` : text || 'git failed without saying why.';
}

export function runGit(cwd: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise((resolvePromise, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GIT_LITERAL_PATHSPECS: '1',
      GIT_OPTIONAL_LOCKS: '0',
      ...opts.env,
    };
    let child: ChildProcessWithoutNullStreams;
    try {
      child = spawn('git', [...SAFE_CONFIG, ...(opts.config ?? []), ...args], { cwd, env, windowsHide: true }) as ChildProcessWithoutNullStreams;
      child.stdin.end();
    } catch {
      reject(new GitError('Git is not installed (or not on the PATH). Install it from git-scm.com, then restart File Editor.', 'not-installed'));
      return;
    }
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let size = 0;
    let finished = false;
    let partial = '';
    const timer = setTimeout(() => stop('timeout'), opts.timeoutMs ?? LOCAL_TIMEOUT_MS);
    const onAbort = () => stop('cancelled');
    opts.signal?.addEventListener('abort', onAbort);
    function stop(why: 'timeout' | 'cancelled') {
      if (finished) return;
      child.kill();
      finish(() => reject(why === 'timeout' ? new GitError('Git took too long and was stopped.', 'timeout') : new GitError('Cancelled.', 'cancelled')));
    }
    function finish(fn: () => void) {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
      fn();
    }
    child.stdout.on('data', (d: Buffer) => {
      size += d.length;
      if (size > MAX_OUTPUT) return stop('cancelled');
      out.push(d);
    });
    child.stderr.on('data', (d: Buffer) => {
      err.push(d);
      if (opts.onProgress) {
        partial += d.toString('utf8');
        const pieces = partial.split(/\r\n|\r|\n/);
        partial = pieces.pop() ?? '';
        for (const p of pieces) if (p.trim()) opts.onProgress(p.trim());
      }
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish(() =>
        reject(e.code === 'ENOENT' ? new GitError('Git is not installed (or not on the PATH). Install it from git-scm.com, then restart File Editor.', 'not-installed') : new GitError(e.message, 'failed')),
      ),
    );
    child.on('close', (codeNum) => {
      const code = codeNum ?? -1;
      const stdout = Buffer.concat(out).toString('utf8');
      const stderr = Buffer.concat(err).toString('utf8');
      finish(() => {
        if (code === 0 || opts.okCodes?.includes(code)) return resolvePromise({ stdout, stderr, code });
        const msg = errorText(stderr, stdout);
        const auth = /Authentication failed|could not read Username|Permission denied \(publickey\)|terminal prompts disabled|403|Invalid username or password/i.test(msg);
        reject(new GitError(auth ? `${msg}\n\nSign in to the remote: connect your GitHub account in the Git menu (GitHub…), or set up a credential helper or SSH key for git.` : msg, auth ? 'auth' : 'failed', `${stdout}${stderr}`));
      });
    });
  });
}

// ── the repository a folder or file belongs to ─────────────────────────────
export interface Repo {
  /** the working tree's top level */
  root: string;
  /** the opened folder's path inside it ("" or "src/app/"), '/'-separated */
  prefix: string;
  gitDir: string;
}

/** The repository `dir` is in, or null when it isn't in one. */
export async function findRepo(dir: string): Promise<Repo | null> {
  try {
    const { stdout } = await runGit(dir, ['rev-parse', '--show-toplevel', '--show-prefix', '--absolute-git-dir']);
    const [root, prefix, gitDir] = stdout.split('\n');
    if (!root) return null;
    return { root: resolve(root), prefix: prefix ?? '', gitDir: gitDir ?? join(root, '.git') };
  } catch (err) {
    if (err instanceof GitError && err.code === 'not-installed') throw err;
    return null;
  }
}

const exists = (p: string) => lstat(p).then(() => true, () => false);

async function operationInProgress(gitDir: string): Promise<GitOperation> {
  if ((await exists(join(gitDir, 'rebase-merge'))) || (await exists(join(gitDir, 'rebase-apply')))) return 'rebase';
  if (await exists(join(gitDir, 'MERGE_HEAD'))) return 'merge';
  if (await exists(join(gitDir, 'CHERRY_PICK_HEAD'))) return 'cherry-pick';
  if (await exists(join(gitDir, 'REVERT_HEAD'))) return 'revert';
  if (await exists(join(gitDir, 'BISECT_LOG'))) return 'bisect';
  return null;
}

// ── checks ─────────────────────────────────────────────────────────────────
function need<T>(ok: boolean, value: T, what: string): T {
  if (!ok) throw new GitError(`That isn't a valid ${what}.`, 'invalid');
  return value;
}
const ref = (v: unknown, what = 'branch name') => need(isRefName(v), v as string, what);
const rev = (v: unknown) => need(isRevision(v), v as string, 'commit or branch');
const remote = (v: unknown) => need(isRemoteName(v), v as string, 'remote name');
const url = (v: unknown) => need(isRemoteUrl(v), v as string, 'repository URL');
const paths = (v: unknown): string[] => {
  const list = Array.isArray(v) ? v : [v];
  if (!list.length || list.length > 5000 || !list.every(isRepoPath)) throw new GitError('That isn’t a file in the repository.', 'invalid');
  return list as string[];
};
const text = (v: unknown, max = 65_536) => (typeof v === 'string' ? v.slice(0, max) : '');

// ── operations ─────────────────────────────────────────────────────────────
export interface OpContext {
  repo: Repo;
  /** options for network commands: credentials, progress, cancel */
  network: RunOptions;
}

type Args = Record<string, unknown>;

const net = (c: OpContext, extra: RunOptions = {}): RunOptions => ({ timeoutMs: NETWORK_TIMEOUT_MS, ...c.network, ...extra });

/**
 * Everything the panel can ask for, by name. Each builds its own argument list from checked
 * values; nothing from the renderer becomes an option.
 */
export const OPS: Record<string, (c: OpContext, a: Args) => Promise<unknown>> = {
  async status({ repo }) {
    const { stdout } = await runGit(repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=all']);
    const s: GitStatus = { ...parseStatus(stdout), operation: await operationInProgress(repo.gitDir) };
    return { ...s, groups: groupChanges(s.files) };
  },

  async diff({ repo }, a) {
    const [path] = paths(a.path);
    if (a.untracked) {
      const full = join(repo.root, ...path.split('/'));
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) return { lines: [], added: 0, removed: 0, binary: false };
      if (info.size > MAX_DIFF_CHARS) return { lines: [], added: 0, removed: 0, binary: true, tooLarge: true };
      const body = await readFile(full);
      if (body.subarray(0, 8000).includes(0)) return { lines: [], added: 0, removed: 0, binary: true };
      const lines = body.toString('utf8').replace(/\n$/, '').split('\n').map((t, i) => ({ kind: 'add' as const, text: t.replace(/\r$/, ''), b: i + 1 }));
      return { lines, added: lines.length, removed: 0, binary: false };
    }
    const args = ['diff', '--no-ext-diff', '--no-color', '--find-renames'];
    if (a.staged) args.push('--cached');
    if (a.commit) args.splice(0, args.length, 'show', '--no-ext-diff', '--no-color', '--format=', rev(a.commit));
    const { stdout } = await runGit(repo.root, [...args, '--', path]);
    return { ...parseUnifiedDiff(stdout.slice(0, MAX_DIFF_CHARS)), tooLarge: stdout.length > MAX_DIFF_CHARS };
  },

  async stage({ repo }, a) {
    await runGit(repo.root, a.all ? ['add', '--all'] : ['add', '--', ...paths(a.paths)]);
  },
  async unstage({ repo }, a) {
    // `restore --staged` needs a commit to restore from; a new repository has none yet
    const head = await runGit(repo.root, ['rev-parse', '--verify', '--quiet', 'HEAD'], { okCodes: [1] });
    const files = a.all ? ['.'] : paths(a.paths);
    if (head.code === 0) await runGit(repo.root, ['restore', '--staged', '--', ...files]);
    else await runGit(repo.root, ['rm', '-r', '--cached', '--quiet', '--', ...files]);
  },
  async discard({ repo }, a) {
    // tracked files go back to their last committed / staged state; untracked ones are removed
    const tracked = a.all ? ['.'] : paths(a.paths ?? []);
    const untracked = a.all ? [] : (Array.isArray(a.untracked) ? paths(a.untracked) : []);
    if (a.all) {
      await runGit(repo.root, ['restore', '--worktree', '--', '.']).catch(() => undefined);
      await runGit(repo.root, ['clean', '-fd', '--', '.']);
      return;
    }
    if (tracked.length) await runGit(repo.root, ['restore', '--worktree', '--', ...tracked]);
    if (untracked.length) await runGit(repo.root, ['clean', '-f', '--', ...untracked]);
  },

  async commit({ repo }, a) {
    const message = text(a.message).trim();
    if (!message && !a.amend) throw new GitError('Write a commit message first.', 'invalid');
    const args = ['commit'];
    if (a.amend) args.push('--amend');
    if (a.all) args.push('--all');
    if (message) args.push('-m', message);
    else args.push('--no-edit');
    if (a.signoff) args.push('--signoff');
    const { stdout } = await runGit(repo.root, args);
    return { output: stdout.trim() };
  },
  async undoCommit({ repo }) {
    // keeps the changes staged
    await runGit(repo.root, ['reset', '--soft', 'HEAD~1']);
  },

  async log({ repo }, a) {
    const n = Math.max(1, Math.min(1000, Math.floor(Number(a.limit) || 100)));
    const args = ['log', `-n${n}`, `--format=${LOG_FORMAT}`];
    if (a.all) args.push('--all');
    if (a.path) args.push('--', ...paths(a.path));
    const res = await runGit(repo.root, args, { okCodes: [128] });
    return res.code === 0 ? parseLog(res.stdout) : [];
  },
  async commitFiles({ repo }, a) {
    const { stdout } = await runGit(repo.root, ['show', '--no-ext-diff', '--format=', '--name-status', '-z', rev(a.commit)]);
    const parts = stdout.split('\0').filter(Boolean);
    const files: { status: string; path: string }[] = [];
    for (let i = 0; i < parts.length; i++) {
      const status = parts[i];
      if (/^[RC]/.test(status)) {
        files.push({ status: status[0], path: parts[i + 2] ?? '' });
        i += 2;
      } else files.push({ status: status[0], path: parts[++i] ?? '' });
    }
    return files;
  },

  // ── branches ──
  async branches({ repo }) {
    const { stdout } = await runGit(repo.root, ['for-each-ref', `--format=${BRANCH_FORMAT}`, '--sort=-committerdate', 'refs/heads', 'refs/remotes']);
    return parseBranches(stdout);
  },
  async checkout({ repo }, a) {
    const name = ref(a.branch);
    if (a.remote) {
      // a remote branch: make a local branch that tracks it
      const local = name.replace(/^[^/]+\//, '');
      const has = await runGit(repo.root, ['rev-parse', '--verify', '--quiet', `refs/heads/${local}`], { okCodes: [1] });
      if (has.code === 0) await runGit(repo.root, ['switch', '--', local]);
      else await runGit(repo.root, ['switch', '--track', '-c', local, name]);
      return;
    }
    await runGit(repo.root, ['switch', '--', name]);
  },
  async checkoutCommit({ repo }, a) {
    await runGit(repo.root, ['switch', '--detach', rev(a.commit)]);
  },
  async createBranch({ repo }, a) {
    const name = ref(a.name);
    const from = a.from ? rev(a.from) : 'HEAD';
    if (a.checkout === false) await runGit(repo.root, ['branch', name, from]);
    else await runGit(repo.root, ['switch', '-c', name, from]);
  },
  async renameBranch({ repo }, a) {
    await runGit(repo.root, ['branch', '-m', ref(a.from), ref(a.to)]);
  },
  async deleteBranch(c, a) {
    const name = ref(a.name);
    if (a.remote) {
      const [rem, ...rest] = name.split('/');
      await runGit(c.repo.root, ['push', remote(rem), '--delete', ref(rest.join('/'))], net(c));
      return;
    }
    await runGit(c.repo.root, ['branch', a.force ? '-D' : '-d', name]);
  },
  async setUpstream({ repo }, a) {
    await runGit(repo.root, ['branch', `--set-upstream-to=${ref(a.upstream, 'remote branch')}`]);
  },
  async merge({ repo }, a) {
    const args = ['merge', '--no-edit'];
    if (a.noFF) args.push('--no-ff');
    if (a.squash) args.push('--squash');
    const { stdout } = await runGit(repo.root, [...args, rev(a.branch)]);
    return { output: stdout.trim() };
  },
  async rebase({ repo }, a) {
    const { stdout } = await runGit(repo.root, ['rebase', rev(a.onto)]);
    return { output: stdout.trim() };
  },
  async cherryPick({ repo }, a) {
    await runGit(repo.root, ['cherry-pick', rev(a.commit)]);
  },
  async revert({ repo }, a) {
    await runGit(repo.root, ['revert', '--no-edit', rev(a.commit)]);
  },
  async reset({ repo }, a) {
    const mode = a.mode === 'hard' ? '--hard' : a.mode === 'mixed' ? '--mixed' : '--soft';
    await runGit(repo.root, ['reset', mode, rev(a.commit)]);
  },
  /** continue / abort / skip a merge, rebase, cherry-pick or revert that stopped */
  async operation({ repo }, a) {
    const op = await operationInProgress(repo.gitDir);
    if (!op || op === 'bisect') throw new GitError('Nothing is in progress.', 'invalid');
    const action = a.action === 'abort' ? '--abort' : a.action === 'skip' ? '--skip' : '--continue';
    if (op === 'merge' && action === '--continue') {
      await runGit(repo.root, ['commit', '--no-edit']);
      return;
    }
    if (op === 'merge' && action === '--skip') throw new GitError('A merge can’t be skipped; abort it instead.', 'invalid');
    // continuing a rebase would open an editor for the message: keep the one git proposes
    await runGit(repo.root, [op, action], { env: { GIT_EDITOR: 'true' } });
  },

  // ── remotes ──
  async remotes({ repo }) {
    const { stdout } = await runGit(repo.root, ['remote', '-v']);
    return parseRemotes(stdout);
  },
  async addRemote({ repo }, a) {
    await runGit(repo.root, ['remote', 'add', '--', remote(a.name), url(a.url)]);
  },
  async removeRemote({ repo }, a) {
    await runGit(repo.root, ['remote', 'remove', remote(a.name)]);
  },
  async renameRemote({ repo }, a) {
    await runGit(repo.root, ['remote', 'rename', remote(a.from), remote(a.to)]);
  },
  async setRemoteUrl({ repo }, a) {
    await runGit(repo.root, ['remote', 'set-url', '--', remote(a.name), url(a.url)]);
  },
  async fetch(c, a) {
    const args = ['fetch', '--progress'];
    if (a.prune) args.push('--prune');
    if (a.tags) args.push('--tags');
    if (a.all || !a.remote) args.push('--all');
    else args.push(remote(a.remote));
    await runGit(c.repo.root, args, net(c));
  },
  async pull(c, a) {
    const args = ['pull', '--progress', a.rebase ? '--rebase' : '--no-rebase'];
    if (a.remote) args.push(remote(a.remote), ...(a.branch ? [ref(a.branch)] : []));
    const { stdout } = await runGit(c.repo.root, args, net(c, { env: { ...c.network.env, GIT_EDITOR: 'true' } }));
    return { output: stdout.trim() };
  },
  async push(c, a) {
    const args = ['push', '--progress'];
    if (a.force) args.push('--force-with-lease');
    if (a.tags) args.push('--follow-tags');
    const st = parseStatus((await runGit(c.repo.root, ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=no'])).stdout);
    if (a.remote || !st.upstream) {
      // first push of a branch: publish it and track it
      if (!st.branch) throw new GitError('HEAD is detached: switch to a branch before pushing.', 'invalid');
      const remotes = parseRemotes((await runGit(c.repo.root, ['remote', '-v'])).stdout);
      const target = a.remote ? remote(a.remote) : remotes.find((r) => r.name === 'origin')?.name ?? remotes[0]?.name;
      if (!target) throw new GitError('This repository has no remote to push to. Add one under Remotes, or publish it to GitHub.', 'invalid');
      args.push('--set-upstream', target, st.branch);
    }
    await runGit(c.repo.root, args, net(c));
  },

  // ── stashes ──
  async stashes({ repo }) {
    const { stdout } = await runGit(repo.root, ['stash', 'list', `--format=${STASH_FORMAT}`]);
    return parseStashes(stdout);
  },
  async stash({ repo }, a) {
    const args = ['stash', 'push'];
    if (a.untracked !== false) args.push('--include-untracked');
    if (a.staged) args.push('--staged');
    const message = text(a.message, 500).trim();
    if (message) args.push('-m', message);
    // no paths here; with literal pathspecs on, `stash push -u` would leave untracked files behind
    await runGit(repo.root, args, { env: { GIT_LITERAL_PATHSPECS: '0' } });
  },
  async stashApply({ repo }, a) {
    await runGit(repo.root, ['stash', a.pop ? 'pop' : 'apply', '--index', need(isStashRef(a.ref), a.ref as string, 'stash')]).catch(async (err) => {
      // --index fails when the staged state can't be restored; try again without it
      if (err instanceof GitError && /index/i.test(err.message)) await runGit(repo.root, ['stash', a.pop ? 'pop' : 'apply', a.ref as string]);
      else throw err;
    });
  },
  async stashDrop({ repo }, a) {
    if (a.all) await runGit(repo.root, ['stash', 'clear']);
    else await runGit(repo.root, ['stash', 'drop', need(isStashRef(a.ref), a.ref as string, 'stash')]);
  },
  async stashFiles({ repo }, a) {
    const { stdout } = await runGit(repo.root, ['stash', 'show', '--name-status', '--include-untracked', need(isStashRef(a.ref), a.ref as string, 'stash')], { okCodes: [1] });
    return stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => ({ status: l[0], path: l.slice(l.indexOf('\t') + 1) }));
  },
  async stashBranch({ repo }, a) {
    await runGit(repo.root, ['stash', 'branch', ref(a.name), need(isStashRef(a.ref), a.ref as string, 'stash')]);
  },

  // ── tags ──
  async tags({ repo }) {
    const { stdout } = await runGit(repo.root, ['for-each-ref', '--sort=-creatordate', `--format=${TAG_FORMAT}`, 'refs/tags']);
    return parseTags(stdout);
  },
  async createTag({ repo }, a) {
    const name = ref(a.name, 'tag name');
    const at = a.commit ? rev(a.commit) : 'HEAD';
    const message = text(a.message, 10_000).trim();
    await runGit(repo.root, message ? ['tag', '-a', name, '-m', message, at] : ['tag', name, at]);
  },
  async deleteTag(c, a) {
    const name = ref(a.name, 'tag name');
    await runGit(c.repo.root, ['tag', '-d', name]);
    if (a.remote) await runGit(c.repo.root, ['push', remote(a.remote), '--delete', `refs/tags/${name}`], net(c));
  },
  async pushTags(c, a) {
    const target = a.remote ? remote(a.remote) : 'origin';
    await runGit(c.repo.root, a.name ? ['push', target, `refs/tags/${ref(a.name, 'tag name')}`] : ['push', '--tags', target], net(c));
  },

  // ── worktrees (paths come from electron/git.ts: picked in a dialog, never from the renderer) ──
  async worktrees({ repo }) {
    const { stdout } = await runGit(repo.root, ['worktree', 'list', '--porcelain']);
    return parseWorktrees(stdout);
  },
  async pruneWorktrees({ repo }) {
    await runGit(repo.root, ['worktree', 'prune']);
  },

  // ── settings ──
  async identity({ repo }) {
    const get = async (key: string) => (await runGit(repo.root, ['config', '--get', key], { okCodes: [1] })).stdout.trim();
    return { name: await get('user.name'), email: await get('user.email') };
  },
  async setIdentity({ repo }, a) {
    const name = text(a.name, 200).trim();
    const email = text(a.email, 200).trim();
    if (!name || !/^[^\s@]+@[^\s@]+$/.test(email)) throw new GitError('Enter your name and a valid email address.', 'invalid');
    const scope = a.global ? '--global' : '--local';
    await runGit(repo.root, ['config', scope, 'user.name', name]);
    await runGit(repo.root, ['config', scope, 'user.email', email]);
  },
};

/** Ops that change files in the working tree (open tabs may need re-reading afterwards). */
export const CHANGES_WORKTREE = new Set([
  'discard', 'checkout', 'checkoutCommit', 'createBranch', 'merge', 'rebase', 'cherryPick', 'revert', 'reset', 'operation', 'pull', 'stash', 'stashApply', 'stashBranch', 'undoCommit',
]);

/** Ops that talk to a remote (they get credentials, progress and a longer timeout). */
export const NETWORK_OPS = new Set(['fetch', 'pull', 'push', 'deleteBranch', 'deleteTag', 'pushTags']);

// ── outside a repository ───────────────────────────────────────────────────
export async function initRepo(dir: string, branch?: string): Promise<void> {
  const args = ['init'];
  if (branch && isRefName(branch)) args.push(`--initial-branch=${branch}`);
  await runGit(dir, args);
}

export async function cloneRepo(parent: string, repoUrl: string, folderName: string, opts: RunOptions & { branch?: string; depth?: number }): Promise<string> {
  url(repoUrl);
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(folderName) || folderName === '.' || folderName === '..') throw new GitError('That folder name can’t be used.', 'invalid');
  const dest = join(parent, folderName);
  if (await exists(dest)) throw new GitError(`${folderName} already exists in that folder. Pick another place or name.`, 'invalid');
  const args = ['clone', '--progress'];
  if (opts.branch) args.push('--branch', ref(opts.branch));
  if (opts.depth) args.push(`--depth=${Math.max(1, Math.min(100_000, Math.floor(opts.depth)))}`);
  await runGit(parent, [...args, '--', repoUrl, dest], { timeoutMs: NETWORK_TIMEOUT_MS, ...opts });
  return dest;
}

/** `git worktree add`: `dest` is a new folder picked by the user. */
export async function addWorktree(repo: Repo, dest: string, a: { branch?: unknown; newBranch?: unknown; from?: unknown }): Promise<void> {
  if (!isAbsolute(dest)) throw new GitError('Pick a folder for the worktree.', 'invalid');
  if (await exists(dest)) throw new GitError(`${basename(dest)} already exists. Pick another name.`, 'invalid');
  const args = ['worktree', 'add'];
  if (a.newBranch) args.push('-b', ref(a.newBranch));
  args.push('--', dest);
  if (a.newBranch) args.push(a.from ? rev(a.from) : 'HEAD');
  else args.push(rev(a.branch));
  await runGit(repo.root, args);
}

export async function removeWorktree(repo: Repo, path: string, force: boolean): Promise<void> {
  await runGit(repo.root, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', path]);
}

/** Runs a command the user typed (after they confirmed it in a dialog). */
export async function runCustom(cwd: string, args: string[], opts: RunOptions): Promise<string> {
  if (!args.length) throw new GitError('Type a git command, for example: log --oneline -5', 'invalid');
  const res = await runGit(cwd, args, { timeoutMs: NETWORK_TIMEOUT_MS, okCodes: [1], ...opts });
  return `${res.stdout}${res.stderr}`.trimEnd() || '(no output)';
}
