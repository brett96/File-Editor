/**
 * The Git panel's bridge (main process): resolves which repository a request is about, runs
 * git through git-runner.ts, and keeps the optional GitHub connection.
 *
 * - The renderer names a repository only by the opened folder's id or an opened file's token
 *   (the same grants as every other file call); the repository is the one that folder or file
 *   is in. Paths the renderer never sees (clone destinations, worktree folders) are picked in
 *   native dialogs here.
 * - "Run git command" shows the exact command in a native confirmation dialog before it runs,
 *   so nothing but the user can run an arbitrary git command.
 * - GitHub: the user's personal access token is checked against api.github.com, encrypted
 *   with the OS keychain (safeStorage) and given to git only for github.com remotes, through
 *   a credential helper that reads it from the environment. API calls use their own session
 *   that can reach only api.github.com.
 */
import { app, dialog, ipcMain, safeStorage, session, shell, type BrowserWindow, type IpcMainInvokeEvent, type Session } from 'electron';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative } from 'node:path';
import { cloneFolderName, isRefName, isRemoteUrl, isRepoPath, parseGithubRemote, parseRemotes, parseWorktrees, splitCommandLine } from '../src/core/git/parse';
import {
  CHANGES_WORKTREE,
  GitError,
  NETWORK_OPS,
  OPS,
  addWorktree,
  cloneRepo,
  findRepo,
  initRepo,
  removeWorktree,
  runCustom,
  runGit,
  type Repo,
  type RunOptions,
} from './git-runner';

export interface GitDeps {
  window: () => BrowserWindow | null;
  assertSender: (e: IpcMainInvokeEvent | Electron.IpcMainEvent) => void;
  folderRoot: (id: string) => string | undefined;
  filePath: (token: string) => string | undefined;
  /** opens a folder as the app's working folder (same as Open folder); returns what the renderer gets */
  addFolder: (path: string) => { id: string; name: string };
  /** reads a file and grants it, as File ▸ Open does */
  openFile: (path: string) => Promise<{ name: string; bytes: Uint8Array; token: string }>;
}

type Ctx = { folder?: unknown; file?: unknown };

const running = new Map<string, AbortController>();

// ── GitHub ─────────────────────────────────────────────────────────────────
const GITHUB_API = 'https://api.github.com';
const githubFile = () => join(app.getPath('userData'), 'github.json');
let githubToken: string | null | undefined;
let githubLogin: string | null = null;
let githubSession: Session | null = null;

function apiSession(): Session {
  if (!githubSession) {
    githubSession = session.fromPartition('file-editor-github');
    githubSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    githubSession.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !d.url.startsWith(`${GITHUB_API}/`) }));
  }
  return githubSession;
}

async function loadGithub(): Promise<string | null> {
  if (githubToken !== undefined) return githubToken;
  githubToken = null;
  try {
    const saved = JSON.parse(await readFile(githubFile(), 'utf8')) as { token?: string; login?: string };
    if (saved.token && safeStorage.isEncryptionAvailable()) {
      githubToken = safeStorage.decryptString(Buffer.from(saved.token, 'base64'));
      githubLogin = saved.login ?? null;
    }
  } catch {
    /* not connected */
  }
  return githubToken;
}

async function github<T>(path: string, init: { method?: string; body?: unknown; token?: string } = {}): Promise<T> {
  const token = init.token ?? (await loadGithub());
  if (!token) throw new GitError('Connect your GitHub account first.', 'auth');
  const res = await apiSession().fetch(`${GITHUB_API}${path}`, {
    method: init.method ?? 'GET',
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `FileEditor/${app.getVersion()}`,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: init.body ? JSON.stringify(init.body) : undefined,
    signal: AbortSignal.timeout(30_000),
  });
  const json = (await res.json().catch(() => null)) as { message?: string; errors?: { message?: string }[] } | null;
  if (!res.ok) {
    const detail = json?.errors?.[0]?.message ?? json?.message ?? `HTTP ${res.status}`;
    if (res.status === 401) throw new GitError('GitHub didn’t accept the token. It may have expired: connect again with a new one.', 'auth');
    throw new GitError(`GitHub: ${detail}`, 'failed');
  }
  return json as T;
}

/** git settings that make it sign in to github.com with the connected token (from the environment). */
async function githubCredentials(): Promise<Pick<RunOptions, 'config' | 'env'>> {
  const token = await loadGithub();
  if (!token) return {};
  return {
    // the empty value drops any other helper for github.com, then ours answers "get" only
    config: [
      '-c', 'credential.https://github.com.helper=',
      '-c', 'credential.https://github.com.helper=!f() { test "$1" = get && echo username=x-access-token && echo "password=$FE_GITHUB_TOKEN"; }; f',
    ],
    env: { FE_GITHUB_TOKEN: token },
  };
}

// ── resolving the repository ───────────────────────────────────────────────
async function contextDir(deps: GitDeps, ctx: Ctx): Promise<string> {
  if (typeof ctx?.folder === 'string') {
    const root = deps.folderRoot(ctx.folder);
    if (root) return root;
    throw new GitError('This folder is no longer open.', 'invalid');
  }
  if (typeof ctx?.file === 'string') {
    const path = deps.filePath(ctx.file);
    if (path) return realpath(dirname(path));
    throw new GitError('This file can no longer be read. Open it again.', 'invalid');
  }
  throw new GitError('Open a folder or a file first.', 'invalid');
}

async function repoFor(deps: GitDeps, ctx: Ctx): Promise<Repo> {
  const repo = await findRepo(await contextDir(deps, ctx));
  if (!repo) throw new GitError('This folder isn’t in a Git repository.', 'not-repo');
  return repo;
}

/** worktree folders listed to the renderer by an id, so their paths stay here */
const worktreeIds = new Map<string, string>();
const idForPath = (path: string) => {
  for (const [id, p] of worktreeIds) if (p === path) return id;
  const id = randomUUID();
  worktreeIds.set(id, path);
  return id;
};

function progressTarget(deps: GitDeps, opId: string | null) {
  return (line: string) => {
    const w = deps.window();
    if (opId && w && !w.isDestroyed()) w.webContents.send('git-progress', opId, line.slice(0, 300));
  };
}

// ── requests ───────────────────────────────────────────────────────────────
async function handle(deps: GitDeps, ctx: Ctx, op: string, a: Record<string, unknown>, opId: string | null) {
  const ctrl = new AbortController();
  if (opId) running.set(opId, ctrl);
  const network = async (): Promise<RunOptions> => ({ ...(await githubCredentials()), onProgress: progressTarget(deps, opId), signal: ctrl.signal });
  try {
    switch (op) {
      case 'info': {
        const dir = await contextDir(deps, ctx);
        const repo = await findRepo(dir);
        if (!repo) return { isRepo: false, folderName: basename(dir) };
        return { isRepo: true, name: basename(repo.root), prefix: repo.prefix, folderName: basename(dir) };
      }
      case 'init': {
        const dir = await contextDir(deps, ctx);
        await initRepo(dir, typeof a.branch === 'string' ? a.branch : 'main');
        return { changed: false };
      }
      case 'clone': {
        if (!isRemoteUrl(a.url)) throw new GitError('That isn’t a repository URL. Use https://…, git@host:owner/repo.git or ssh://…', 'invalid');
        const w = deps.window();
        const pick = await (w ? dialog.showOpenDialog(w, { title: 'Clone into which folder?', buttonLabel: 'Clone here', properties: ['openDirectory', 'createDirectory'] }) : null);
        if (!pick || pick.canceled || !pick.filePaths[0]) return { cancelled: true };
        const name = typeof a.folderName === 'string' && a.folderName.trim() ? a.folderName.trim() : cloneFolderName(a.url);
        const dest = await cloneRepo(await realpath(pick.filePaths[0]), a.url, name, {
          ...(await network()),
          branch: typeof a.branch === 'string' && a.branch ? a.branch : undefined,
          depth: Number(a.depth) || undefined,
        });
        return { folder: deps.addFolder(await realpath(dest)) };
      }
      case 'openFile': {
        const repo = await repoFor(deps, ctx);
        if (!isRepoPath(a.path)) throw new GitError('That isn’t a file in the repository.', 'invalid');
        const full = join(repo.root, ...a.path.split('/'));
        const real = await realpath(full);
        const back = relative(await realpath(repo.root), real);
        if (!back || back.startsWith('..') || isAbsolute(back)) throw new GitError('That file is outside the repository.', 'invalid');
        return deps.openFile(real);
      }
      case 'worktrees': {
        const repo = await repoFor(deps, ctx);
        const list = parseWorktrees((await runGit(repo.root, ['worktree', 'list', '--porcelain'])).stdout);
        return list.map((w) => ({ id: idForPath(w.path), name: basename(w.path), branch: w.branch, head: w.head.slice(0, 8), bare: w.bare, locked: w.locked, prunable: w.prunable, current: w.path === repo.root }));
      }
      case 'addWorktree': {
        const repo = await repoFor(deps, ctx);
        const w = deps.window();
        const label = String(a.newBranch || a.branch || 'worktree');
        if (!isRefName(label)) throw new GitError('That isn’t a valid branch name.', 'invalid');
        const pick = await (w ? dialog.showOpenDialog(w, { title: 'Create the worktree in which folder?', buttonLabel: 'Create here', defaultPath: dirname(repo.root), properties: ['openDirectory', 'createDirectory'] }) : null);
        if (!pick || pick.canceled || !pick.filePaths[0]) return { cancelled: true };
        const dest = join(await realpath(pick.filePaths[0]), `${basename(repo.root)}-${label.replace(/[^A-Za-z0-9._-]+/g, '-')}`);
        await addWorktree(repo, dest, a);
        return { folder: a.open ? deps.addFolder(dest) : null, name: basename(dest) };
      }
      case 'removeWorktree': {
        const repo = await repoFor(deps, ctx);
        const path = worktreeIds.get(String(a.id));
        if (!path) throw new GitError('That worktree is no longer listed. Refresh.', 'invalid');
        await removeWorktree(repo, path, a.force === true);
        return null;
      }
      case 'openWorktree': {
        const path = worktreeIds.get(String(a.id));
        if (!path || !(await stat(path).then((s) => s.isDirectory(), () => false))) throw new GitError('That worktree folder is gone.', 'invalid');
        return { folder: deps.addFolder(await realpath(path)) };
      }
      case 'custom': {
        const repo = await repoFor(deps, ctx);
        let args: string[];
        try {
          args = splitCommandLine(String(a.command ?? '').slice(0, 4000));
        } catch (err) {
          throw new GitError(err instanceof Error ? err.message : 'That command can’t be read.', 'invalid');
        }
        if (!args.length) throw new GitError('Type a git command, for example: log --oneline -5', 'invalid');
        const shown = `git ${args.map((x) => (/[\s"']/.test(x) || !x ? JSON.stringify(x) : x)).join(' ')}`;
        const w = deps.window();
        const answer = w
          ? await dialog.showMessageBox(w, { type: 'question', title: 'Run git command', message: `Run this command in ${basename(repo.root)}?`, detail: shown, buttons: ['Run', 'Cancel'], defaultId: 0, cancelId: 1 })
          : { response: 1 };
        if (answer.response !== 0) return { cancelled: true };
        return { output: await runCustom(repo.root, args, await network()), changed: true };
      }
      // ── GitHub ──
      case 'githubStatus': {
        const token = await loadGithub();
        return { connected: !!token, login: githubLogin, secure: safeStorage.isEncryptionAvailable() };
      }
      case 'githubConnect': {
        const token = typeof a.token === 'string' ? a.token.trim() : '';
        if (!/^(gh[pousr]_[A-Za-z0-9]{20,255}|github_pat_[A-Za-z0-9_]{20,255})$/.test(token)) {
          throw new GitError('That doesn’t look like a GitHub token. It starts with ghp_ or github_pat_.', 'invalid');
        }
        if (!safeStorage.isEncryptionAvailable()) throw new GitError('This computer can’t store the token securely, so it wasn’t saved.', 'failed');
        const user = await github<{ login: string }>('/user', { token });
        await mkdir(dirname(githubFile()), { recursive: true });
        await writeFile(githubFile(), JSON.stringify({ token: safeStorage.encryptString(token).toString('base64'), login: user.login }), { mode: 0o600 });
        githubToken = token;
        githubLogin = user.login;
        return { connected: true, login: user.login };
      }
      case 'githubDisconnect': {
        await writeFile(githubFile(), '{}', { mode: 0o600 }).catch(() => undefined);
        githubToken = null;
        githubLogin = null;
        return { connected: false };
      }
      case 'githubRepos': {
        const list = await github<{ full_name: string; clone_url: string; private: boolean; description: string | null; updated_at: string; default_branch: string }[]>(
          '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member',
        );
        return list.map((r) => ({ fullName: r.full_name, cloneUrl: r.clone_url, private: r.private, description: r.description ?? '', updatedAt: r.updated_at, defaultBranch: r.default_branch }));
      }
      case 'githubOpen': {
        // the repository's page, its compare page (pull request) or a commit, in the browser
        const repo = await repoFor(deps, ctx);
        const remotes = parseRemotes((await runGit(repo.root, ['remote', '-v'])).stdout);
        const gh = remotes.map((r) => parseGithubRemote(r.fetchUrl)).find(Boolean);
        if (!gh) throw new GitError('This repository has no GitHub remote.', 'invalid');
        let target = `https://github.com/${gh.owner}/${gh.repo}`;
        if (a.page === 'pull' && isRefName(a.branch)) target += `/compare/${encodeURIComponent(a.branch).replace(/%2F/g, '/')}?expand=1`;
        else if (a.page === 'commit' && typeof a.commit === 'string' && /^[0-9a-f]{7,64}$/i.test(a.commit)) target += `/commit/${a.commit}`;
        await shell.openExternal(target);
        return null;
      }
      case 'githubPublish': {
        // create a repository on GitHub, add it as origin and push the current branch
        const repo = await repoFor(deps, ctx);
        const name = typeof a.name === 'string' ? a.name.trim() : '';
        if (!/^[A-Za-z0-9._-]{1,100}$/.test(name)) throw new GitError('Use letters, numbers, ".", "-" and "_" for the repository name.', 'invalid');
        const remotes = parseRemotes((await runGit(repo.root, ['remote', '-v'])).stdout);
        if (remotes.some((r) => r.name === 'origin')) throw new GitError('This repository already has a remote called origin.', 'invalid');
        const created = await github<{ clone_url: string; html_url: string }>('/user/repos', { method: 'POST', body: { name, private: a.private !== false, description: typeof a.description === 'string' ? a.description.slice(0, 300) : undefined } });
        await runGit(repo.root, ['remote', 'add', 'origin', created.clone_url]);
        await OPS.push({ repo, network: await network() }, {});
        return { url: created.html_url };
      }
    }
    const fn = OPS[op];
    if (!fn) throw new GitError(`Unknown git action: ${op}`, 'invalid');
    const repo = await repoFor(deps, ctx);
    const data = await fn({ repo, network: NETWORK_OPS.has(op) ? await network() : {} }, a);
    return CHANGES_WORKTREE.has(op) ? { ...(typeof data === 'object' && data ? data : { value: data }), changed: true } : data;
  } finally {
    if (opId) running.delete(opId);
  }
}

export function registerGitIpc(deps: GitDeps) {
  ipcMain.handle('git', async (e, ctx: Ctx, op: unknown, args: unknown, opId: unknown) => {
    deps.assertSender(e);
    const id = typeof opId === 'string' && /^[\w-]{1,64}$/.test(opId) ? opId : null;
    try {
      const data = await handle(deps, ctx ?? {}, String(op), args && typeof args === 'object' ? (args as Record<string, unknown>) : {}, id);
      return { ok: true, data };
    } catch (err) {
      if (err instanceof GitError) return { ok: false, code: err.code, error: err.message };
      return { ok: false, code: 'failed', error: err instanceof Error ? err.message : 'Git failed.' };
    }
  });
  ipcMain.on('git-cancel', (e, opId: unknown) => {
    try {
      deps.assertSender(e);
      running.get(String(opId))?.abort();
    } catch {
      /* ignore */
    }
  });
}
