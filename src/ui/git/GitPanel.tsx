/**
 * The Git panel: the changed files of the repository an opened folder (the Files | Git switch
 * in the folder sidebar) or an opened file (the Git button at the bottom left of the editor)
 * belongs to. Stage, unstage, discard, diff, commit, pull, push and fetch from here; the ⋯ menu
 * and GitManager hold everything else (branches, remotes, stashes, tags, worktrees, history,
 * GitHub, typed git commands).
 *
 * git itself runs in the desktop main process (electron/git.ts); this is desktop-only.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  ChevronRight,
  CloudDownload,
  ExternalLink,
  FileCode,
  FolderGit2,
  GitBranch,
  GitCommitHorizontal,
  Minus,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Undo2,
  X,
} from 'lucide-react';
import type { GitBranch as Branch, GitDiffLine, GitFileChange, GitStatus } from '../../core/git/parse';
import { MenuItem, Modal, Popover, PromptModal, cx } from '../components';
import { GitManager, type ManagerTab } from './GitManager';
import { STATUS_LABEL, ctxKey, git, GitCallError, type GitContext } from './git-client';

interface RepoInfo {
  isRepo: boolean;
  name?: string;
  /** the opened folder's place in the repository ("" or "src/") */
  prefix?: string;
  folderName: string;
}

type Status = GitStatus & { groups: { conflicts: GitFileChange[]; staged: GitFileChange[]; unstaged: GitFileChange[] } };

export interface GitPanelProps {
  ctx: GitContext;
  /** 'sidebar' in the folder view, 'popup' above the status bar of a single file */
  variant: 'sidebar' | 'popup';
  /** on screen (refreshes only while visible) */
  active: boolean;
  toast: (text: string, kind?: 'error' | 'info') => void;
  /** open a file of the repository (path from its top level) */
  onOpenFile: (repoPath: string, prefix: string) => void;
  /** a clone or worktree to open as the working folder */
  onOpenFolder: (folder: { id: string; name: string }) => void;
  onClose?: () => void;
}

const leaf = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const dir = (p: string) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

export function GitPanel({ ctx, variant, active, toast, onOpenFile, onOpenFolder, onClose }: GitPanelProps) {
  const [info, setInfo] = useState<RepoInfo | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [fatal, setFatal] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const cancelRef = useRef<(() => void) | null>(null);
  const [message, setMessage] = useState('');
  const [manager, setManager] = useState<ManagerTab | null>(null);
  const [diff, setDiff] = useState<GitFileChange & { staged: boolean } | null>(null);
  const [prompt, setPrompt] = useState<null | { kind: 'branch' | 'stash' | 'clone' }>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const key = ctxKey(ctx);
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  // ── reading the repository ──
  const refresh = useCallback(async () => {
    try {
      const i = await git<RepoInfo>(ctxRef.current, 'info');
      setInfo(i);
      setFatal(null);
      if (!i.isRepo) return setStatus(null);
      setStatus(await git<Status>(ctxRef.current, 'status'));
    } catch (err) {
      setFatal(err instanceof Error ? err.message : 'Git could not be run.');
    }
  }, []);

  useEffect(() => {
    setInfo(null);
    setStatus(null);
    void refresh();
  }, [key, refresh]);

  // while on screen: every few seconds, when the window gets focus, after saves and other git actions
  useEffect(() => {
    if (!active) return;
    void refresh();
    const timer = window.setInterval(() => document.visibilityState === 'visible' && !busyRef.current && void refresh(), 5000);
    const again = () => void refresh();
    window.addEventListener('focus', again);
    window.addEventListener('fe:saved', again);
    window.addEventListener('fe:git-ran', again);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', again);
      window.removeEventListener('fe:saved', again);
      window.removeEventListener('fe:git-ran', again);
    };
  }, [active, refresh]);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  /** Runs an action with a busy label, reports failures, refreshes after. */
  const run = useCallback(
    async <T,>(label: string, op: string, args: Record<string, unknown> = {}, done?: string): Promise<T | null> => {
      setBusy(label);
      setProgress(null);
      try {
        const res = await git<T>(ctxRef.current, op, args, { onProgress: setProgress, onStart: (c) => (cancelRef.current = c) });
        if (done) toast(done, 'info');
        return res;
      } catch (err) {
        if (!(err instanceof GitCallError && err.code === 'cancelled')) toast(err instanceof Error ? err.message : 'Git failed.');
        return null;
      } finally {
        cancelRef.current = null;
        setBusy(null);
        setProgress(null);
        void refresh();
      }
    },
    [refresh, toast],
  );

  const groups = status?.groups;
  const counts = useMemo(() => ({ staged: groups?.staged.length ?? 0, unstaged: groups?.unstaged.length ?? 0, conflicts: groups?.conflicts.length ?? 0 }), [groups]);

  // ── commit ──
  const commit = async (opts: { push?: boolean; amend?: boolean } = {}) => {
    const msg = message.trim();
    if (!opts.amend && !msg) return toast('Write a commit message first.', 'info');
    // nothing staged: commit every change, as most editors do (after asking once)
    const all = !opts.amend && counts.staged === 0;
    if (all) {
      if (!counts.unstaged) return toast('There is nothing to commit.', 'info');
      if (!window.confirm('Nothing is staged. Stage all changes and commit them?')) return;
      if (!(await run('Staging…', 'stage', { all: true }))) return;
    }
    const ok = await run<{ output: string }>(opts.amend ? 'Amending…' : 'Committing…', 'commit', { message: msg, amend: !!opts.amend });
    if (!ok) return;
    setMessage('');
    if (opts.push) await run('Pushing…', 'push', {}, 'Pushed.');
    else toast(opts.amend ? 'Last commit amended.' : 'Committed.', 'info');
  };

  const sync = async () => {
    if (!status) return;
    if (!status.upstream) return void run('Publishing branch…', 'push', {}, `Branch ${status.branch} published.`);
    if (status.behind) {
      const pulled = await run('Pulling…', 'pull', {});
      if (pulled === null) return;
    }
    if (status.ahead || status.behind) await run('Pushing…', 'push', {}, 'In sync with the remote.');
    else await run('Fetching…', 'fetch', {}, 'Up to date.');
  };

  const stageFiles = (files: GitFileChange[]) => run('Staging…', 'stage', { paths: files.map((f) => f.path) });
  const unstageFiles = (files: GitFileChange[]) => run('Unstaging…', 'unstage', { paths: files.map((f) => f.path) });
  const discardFiles = (files: GitFileChange[]) => {
    const names = files.length === 1 ? `the changes to ${leaf(files[0].path)}` : `the changes to ${files.length} files`;
    const removes = files.some((f) => f.untracked);
    if (!window.confirm(`Discard ${names}? ${removes ? 'New files are deleted. ' : ''}This can’t be undone.`)) return;
    void run('Discarding…', 'discard', { paths: files.filter((f) => !f.untracked).map((f) => f.path), untracked: files.filter((f) => f.untracked).map((f) => f.path) });
  };

  const openFile = (f: GitFileChange) => {
    if (f.worktree === 'D' || (f.index === 'D' && f.worktree === '.')) return toast(`${leaf(f.path)} was deleted.`, 'info');
    onOpenFile(f.path, info?.prefix ?? '');
  };

  // ── not a repository / git missing ──
  if (fatal) {
    return (
      <div className={cx('git-panel', `is-${variant}`)}>
        <PanelHead title="Git" onClose={onClose} onRefresh={refresh} />
        <div className="git-empty">
          <AlertTriangle size={22} />
          <p>{fatal}</p>
        </div>
      </div>
    );
  }
  if (!info) {
    return (
      <div className={cx('git-panel', `is-${variant}`)}>
        <PanelHead title="Git" onClose={onClose} onRefresh={refresh} />
        <div className="git-empty"><span className="spinner" /></div>
      </div>
    );
  }

  const managerEl = manager && (
    <GitManager ctx={ctx} tab={manager} onTab={setManager} onClose={() => setManager(null)} toast={toast} onOpenFolder={onOpenFolder} isRepo={info.isRepo} status={status} onRefresh={refresh} />
  );
  const promptEl = prompt && (
    <PromptModal
      title={prompt.kind === 'branch' ? 'New branch' : prompt.kind === 'stash' ? 'Stash changes' : 'Clone a repository'}
      label={prompt.kind === 'branch' ? 'Branch name (from the current commit)' : prompt.kind === 'stash' ? 'Message (optional)' : 'Repository URL'}
      placeholder={prompt.kind === 'clone' ? 'https://github.com/owner/repo.git' : prompt.kind === 'branch' ? 'feature/my-change' : ''}
      confirmLabel={prompt.kind === 'branch' ? 'Create and switch' : prompt.kind === 'stash' ? 'Stash' : 'Choose folder…'}
      onClose={() => setPrompt(null)}
      onSubmit={async (v) => {
        const kind = prompt.kind;
        setPrompt(null);
        if (kind === 'branch' && v) await run('Creating branch…', 'createBranch', { name: v }, `Switched to the new branch ${v}.`);
        if (kind === 'stash') await run('Stashing…', 'stash', { message: v }, 'Changes stashed.');
        if (kind === 'clone' && v) {
          const res = await run<{ folder?: { id: string; name: string }; cancelled?: boolean }>('Cloning…', 'clone', { url: v });
          if (res?.folder) onOpenFolder(res.folder);
        }
      }}
    />
  );

  if (!info.isRepo) {
    return (
      <div className={cx('git-panel', `is-${variant}`)}>
        <PanelHead title="Git" onClose={onClose} onRefresh={refresh} />
        <div className="git-empty">
          <FolderGit2 size={26} />
          <p>
            <strong>{info.folderName}</strong> isn’t in a Git repository.
          </p>
          <button type="button" className="btn btn-primary btn-sm" disabled={!!busy} onClick={() => void run('Initializing…', 'init', {}, 'Repository created.')}>
            Initialize repository
          </button>
          <button type="button" className="btn btn-sm git-outline" disabled={!!busy} onClick={() => setPrompt({ kind: 'clone' })}>
            <CloudDownload size={14} /> Clone a repository…
          </button>
          <button type="button" className="btn btn-sm git-outline" onClick={() => setManager('github')}>
            GitHub account…
          </button>
          {busy && <p className="git-busy"><span className="spinner" /> {busy} {progress}</p>}
        </div>
        {managerEl}
        {promptEl}
      </div>
    );
  }

  // ── the repository ──
  const s = status;
  const op = s?.operation;
  const section = (id: 'conflicts' | 'staged' | 'unstaged', title: string, files: GitFileChange[], actions: ReactNode) => {
    if (!files.length && id !== 'unstaged') return null;
    const open = !collapsed[id];
    return (
      <div className="git-section">
        <div className="git-section-head">
          <button type="button" className="git-section-toggle" onClick={() => setCollapsed((c) => ({ ...c, [id]: open }))} aria-expanded={open}>
            {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            {title}
            <span className="git-count">{files.length}</span>
          </button>
          {files.length > 0 && <span className="git-section-actions">{actions}</span>}
        </div>
        {open && (
          <ul className="git-files">
            {!files.length && <li className="git-note">No changes</li>}
            {files.slice(0, 2000).map((f) => {
              const letter = f.conflict ? 'U' : id === 'staged' ? f.index : f.untracked ? '?' : f.worktree;
              return (
                <li key={`${id}:${f.path}`}>
                  <div
                    className="git-file"
                    role="button"
                    tabIndex={0}
                    aria-label={`${f.path}, ${STATUS_LABEL[letter] ?? letter}: show the changes`}
                    title={`${f.path}${f.origPath ? ` (was ${f.origPath})` : ''} · ${STATUS_LABEL[letter] ?? letter}. Click for the changes, double-click to open.`}
                    onClick={() => !f.conflict && setDiff({ ...f, staged: id === 'staged' })}
                    onDoubleClick={() => openFile(f)}
                    onKeyDown={(e) => e.key === 'Enter' && openFile(f)}
                  >
                    <span className="git-file-name">{leaf(f.path)}</span>
                    <span className="git-file-dir">{dir(f.path)}</span>
                    <span className="git-file-actions">
                      <button type="button" title="Open file" aria-label={`Open ${leaf(f.path)}`} onClick={(e) => (e.stopPropagation(), openFile(f))}>
                        <FileCode size={13} />
                      </button>
                      {id !== 'staged' && (
                        <button type="button" title="Discard changes" aria-label={`Discard changes to ${leaf(f.path)}`} onClick={(e) => (e.stopPropagation(), discardFiles([f]))}>
                          <Undo2 size={13} />
                        </button>
                      )}
                      {id === 'staged' ? (
                        <button type="button" title="Unstage" aria-label={`Unstage ${leaf(f.path)}`} onClick={(e) => (e.stopPropagation(), void unstageFiles([f]))}>
                          <Minus size={13} />
                        </button>
                      ) : (
                        <button type="button" title={f.conflict ? 'Mark resolved (stage)' : 'Stage'} aria-label={`Stage ${leaf(f.path)}`} onClick={(e) => (e.stopPropagation(), void stageFiles([f]))}>
                          <Plus size={13} />
                        </button>
                      )}
                    </span>
                    <span className={cx('git-letter', `is-${letter === '?' ? 'u' : letter.toLowerCase()}`)}>{letter === '?' ? 'U' : letter === 'U' ? '!' : letter}</span>
                  </div>
                </li>
              );
            })}
            {files.length > 2000 && <li className="git-note">…and {files.length - 2000} more</li>}
          </ul>
        )}
      </div>
    );
  };

  const menu = (
    <Popover label="More Git actions" align={variant === 'popup' ? 'left' : 'right'} button={<MoreHorizontal size={15} />}>
      {(close) => {
        const item = (label: string, fn: () => void, hint?: string, disabled?: boolean) => (
          <MenuItem key={label} hint={hint} disabled={disabled || !!busy} onClick={() => (close(), fn())}>
            {label}
          </MenuItem>
        );
        const sep = (k: string) => <div key={k} className="menu-sep" role="separator" />;
        return (
          <div className="format-menu git-menu" role="menu" aria-label="Git">
            {item('Pull', () => void run('Pulling…', 'pull', {}, 'Pulled.'))}
            {item('Pull (rebase)', () => void run('Pulling…', 'pull', { rebase: true }, 'Pulled and rebased.'))}
            {item('Push', () => void run('Pushing…', 'push', {}, 'Pushed.'))}
            {item('Force push (with lease)…', () => window.confirm('Force push? This replaces the remote branch with yours, unless someone pushed in the meantime.') && void run('Pushing…', 'push', { force: true }, 'Force-pushed.'))}
            {item('Fetch', () => void run('Fetching…', 'fetch', {}, 'Fetched.'))}
            {item('Fetch all & prune', () => void run('Fetching…', 'fetch', { all: true, prune: true }, 'Fetched; deleted remote branches removed.'))}
            {sep('s1')}
            {item('Commit', () => void commit())}
            {item('Commit & push', () => void commit({ push: true }))}
            {item('Amend last commit', () => void commit({ amend: true }), message.trim() ? 'new message' : 'same message')}
            {item('Undo last commit', () => window.confirm('Undo the last commit? Its changes stay, staged.') && void run('Undoing…', 'undoCommit', {}, 'Last commit undone; its changes are staged.'), undefined, !s?.oid)}
            {sep('s2')}
            {item('Stage all changes', () => void run('Staging…', 'stage', { all: true }))}
            {item('Unstage all', () => void run('Unstaging…', 'unstage', { all: true }), undefined, !counts.staged)}
            {item('Discard all changes…', () => window.confirm('Discard ALL changes, staged and not, and delete new files? This can’t be undone.') && void run('Discarding…', 'discard', { all: true }, 'All changes discarded.'))}
            {sep('s3')}
            {item('Branches…', () => setManager('branches'))}
            {item('New branch…', () => setPrompt({ kind: 'branch' }))}
            {item('Merge into current branch…', () => setManager('branches'))}
            {item('Rebase current branch…', () => setManager('branches'))}
            {sep('s4')}
            {item('Stash changes…', () => setPrompt({ kind: 'stash' }), undefined, !counts.staged && !counts.unstaged)}
            {item('Pop latest stash', () => void run('Applying stash…', 'stashApply', { ref: 'stash@{0}', pop: true }, 'Stash applied and removed.'))}
            {item('Stashes…', () => setManager('stashes'))}
            {sep('s5')}
            {item('History…', () => setManager('history'))}
            {item('Tags…', () => setManager('tags'))}
            {item('Remotes…', () => setManager('remotes'))}
            {item('Worktrees…', () => setManager('worktrees'))}
            {sep('s6')}
            {item('GitHub…', () => setManager('github'))}
            {item('Open on GitHub', () => void run('Opening…', 'githubOpen', {}))}
            {item('Create pull request', () => void run('Opening…', 'githubOpen', { page: 'pull', branch: s?.branch }), undefined, !s?.branch)}
            {sep('s7')}
            {item('Clone a repository…', () => setPrompt({ kind: 'clone' }))}
            {item('Run git command…', () => setManager('command'))}
            {item('Output', () => setManager('output'))}
            {item('Your name & email…', () => setManager('settings'))}
          </div>
        );
      }}
    </Popover>
  );

  return (
    <div className={cx('git-panel', `is-${variant}`)}>
      <div className="git-head">
        <BranchPicker ctx={ctx} status={s} busy={!!busy} onSwitch={(b, remote) => void run('Switching…', 'checkout', { branch: b, remote }, `Switched to ${remote ? b.replace(/^[^/]+\//, '') : b}.`)} onNew={() => setPrompt({ kind: 'branch' })} onManage={() => setManager('branches')} />
        <span className="spacer" />
        {s && (
          <button type="button" className="git-icon git-sync" disabled={!!busy || !s.branch} onClick={() => void sync()} title={s.upstream ? `Sync with ${s.upstream}: pull ${s.behind}, push ${s.ahead}` : 'Publish this branch'}>
            {s.upstream ? (
              <>
                <ArrowDown size={13} />
                {s.behind}
                <ArrowUp size={13} />
                {s.ahead}
              </>
            ) : (
              <>
                <ArrowUp size={13} /> Publish
              </>
            )}
          </button>
        )}
        <button type="button" className="git-icon" title="Refresh" aria-label="Refresh" onClick={() => void refresh()} disabled={!!busy}>
          <RefreshCw size={14} />
        </button>
        {menu}
        {onClose && (
          <button type="button" className="git-icon" title="Close" aria-label="Close Git" onClick={onClose}>
            <X size={14} />
          </button>
        )}
      </div>
      <div className="git-repo-line" title={info.prefix ? `This folder is ${info.prefix} in the ${info.name} repository` : undefined}>
        <FolderGit2 size={12} /> {info.name}
        {info.prefix ? <span className="git-file-dir"> · {info.prefix.replace(/\/$/, '')}</span> : null}
      </div>

      {busy && (
        <div className="git-busy" role="status">
          <span className="spinner" />
          <span className="git-busy-text">
            {busy}
            {progress && <span className="git-progress">{progress}</span>}
          </span>
          {cancelRef.current && (
            <button type="button" className="btn btn-text btn-sm" onClick={() => cancelRef.current?.()}>
              Cancel
            </button>
          )}
        </div>
      )}

      {op && (
        <div className="git-operation" role="alert">
          <AlertTriangle size={14} />
          <span>
            {op === 'merge' ? 'Merging' : op === 'rebase' ? 'Rebasing' : op === 'cherry-pick' ? 'Cherry-picking' : op === 'revert' ? 'Reverting' : 'Bisecting'}
            {counts.conflicts ? `: resolve ${counts.conflicts} conflict${counts.conflicts === 1 ? '' : 's'}, stage them, then continue.` : ': ready to continue.'}
          </span>
          {op !== 'bisect' && (
            <span className="git-operation-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || counts.conflicts > 0} onClick={() => void run('Continuing…', 'operation', { action: 'continue' }, 'Done.')}>
                Continue
              </button>
              {op === 'rebase' && (
                <button type="button" className="btn btn-sm git-outline" disabled={!!busy} onClick={() => void run('Skipping…', 'operation', { action: 'skip' })}>
                  Skip
                </button>
              )}
              <button type="button" className="btn btn-sm git-outline" disabled={!!busy} onClick={() => void run('Aborting…', 'operation', { action: 'abort' }, 'Aborted.')}>
                Abort
              </button>
            </span>
          )}
        </div>
      )}

      <div className="git-commit">
        <textarea
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          placeholder={s?.branch ? `Message (Ctrl+Enter to commit on ${s.branch})` : 'Commit message'}
          rows={2}
          aria-label="Commit message"
          onKeyDown={(e: KeyboardEvent<HTMLTextAreaElement>) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              void commit();
            }
            e.stopPropagation();
          }}
        />
        <div className="git-commit-actions">
          <button type="button" className="btn btn-primary btn-sm git-commit-btn" disabled={!!busy || (!counts.staged && !counts.unstaged)} onClick={() => void commit()}>
            <Check size={14} /> Commit{counts.staged ? '' : ' all'}
          </button>
          <Popover label="Commit options" align={variant === 'popup' ? 'left' : 'right'} button={<></>} disabled={!!busy}>
            {(close) => (
              <div className="format-menu" role="menu">
                <MenuItem onClick={() => (close(), void commit({ push: true }))}>Commit & push</MenuItem>
                <MenuItem onClick={() => (close(), void commit({ amend: true }))} hint={message.trim() ? 'new message' : 'same message'}>
                  Amend last commit
                </MenuItem>
              </div>
            )}
          </Popover>
        </div>
      </div>

      <div className="git-changes">
        {groups && section('conflicts', 'Conflicts', groups.conflicts, (
          <button type="button" title="Mark all resolved (stage)" onClick={() => void stageFiles(groups.conflicts)}><Plus size={13} /></button>
        ))}
        {groups && section('staged', 'Staged changes', groups.staged, (
          <button type="button" title="Unstage all" onClick={() => void run('Unstaging…', 'unstage', { all: true })}><Minus size={13} /></button>
        ))}
        {groups && section('unstaged', 'Changes', groups.unstaged, (
          <>
            <button type="button" title="Discard all changes" onClick={() => discardFiles(groups.unstaged)}><Undo2 size={13} /></button>
            <button type="button" title="Stage all" onClick={() => void stageFiles(groups.unstaged)}><Plus size={13} /></button>
          </>
        ))}
        {!s && <div className="git-empty"><span className="spinner" /></div>}
      </div>

      {diff && <DiffModal ctx={ctx} file={diff} onClose={() => setDiff(null)} onOpen={() => (openFile(diff), setDiff(null))} />}
      {managerEl}
      {promptEl}
    </div>
  );
}

function PanelHead({ title, onClose, onRefresh }: { title: string; onClose?: () => void; onRefresh: () => void }) {
  return (
    <div className="git-head">
      <GitBranch size={14} />
      <strong>{title}</strong>
      <span className="spacer" />
      <button type="button" className="git-icon" title="Refresh" aria-label="Refresh" onClick={onRefresh}>
        <RefreshCw size={14} />
      </button>
      {onClose && (
        <button type="button" className="git-icon" title="Close" aria-label="Close Git" onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

function BranchPicker({
  ctx,
  status,
  busy,
  onSwitch,
  onNew,
  onManage,
}: {
  ctx: GitContext;
  status: Status | null;
  busy: boolean;
  onSwitch: (branch: string, remote: boolean) => void;
  onNew: () => void;
  onManage: () => void;
}) {
  const [branches, setBranches] = useState<Branch[] | null>(null);
  const [filter, setFilter] = useState('');
  const loading = useRef(false);
  const loadBranches = () => {
    if (loading.current) return;
    loading.current = true;
    void git<Branch[]>(ctx, 'branches')
      .then(setBranches, () => setBranches([]))
      .finally(() => (loading.current = false));
  };
  // a fresh list each time the branch changes (switches, new branches)
  useEffect(() => setBranches(null), [status?.branch, status?.oid]);
  const label = status ? (status.branch ?? `detached at ${status.oid?.slice(0, 7) ?? '?'}`) : '…';
  return (
    <Popover
      label={`Branch: ${label}`}
      text
      align="left"
      disabled={busy}
      button={
        <span className="git-branch-btn" title={`Branch: ${label}. Click to switch.`}>
          <GitBranch size={13} />
          <span className="git-branch-name">{label}</span>
        </span>
      }
    >
      {(close) => {
        if (!branches) {
          queueMicrotask(loadBranches);
          return <div className="format-menu"><div className="menu-empty"><span className="spinner" /> Loading branches…</div></div>;
        }
        const q = filter.trim().toLowerCase();
        const shown = branches.filter((b) => !q || b.name.toLowerCase().includes(q));
        const local = shown.filter((b) => !b.remote);
        const remote = shown.filter((b) => b.remote && !branches.some((l) => !l.remote && b.name.replace(/^[^/]+\//, '') === l.name));
        return (
          <div className="format-menu git-branch-menu" role="menu" aria-label="Branches">
            <input className="input git-branch-filter" placeholder="Find a branch…" value={filter} onChange={(e) => setFilter(e.target.value)} autoFocus onKeyDown={(e) => e.stopPropagation()} />
            <MenuItem onClick={() => (close(), onNew())}>+ New branch…</MenuItem>
            <MenuItem onClick={() => (close(), onManage())}>Manage branches…</MenuItem>
            <div className="menu-sep" role="separator" />
            {local.map((b) => (
              <MenuItem key={b.name} disabled={b.current} hint={b.current ? 'current' : b.track.replace(/[[\]]/g, '')} onClick={() => (close(), setBranches(null), onSwitch(b.name, false))}>
                {b.name}
              </MenuItem>
            ))}
            {remote.length > 0 && <div className="format-menu-group">Remote branches</div>}
            {remote.slice(0, 50).map((b) => (
              <MenuItem key={b.name} hint="check out" onClick={() => (close(), setBranches(null), onSwitch(b.name, true))}>
                {b.name}
              </MenuItem>
            ))}
            {!shown.length && <div className="menu-empty">No branches match</div>}
          </div>
        );
      }}
    </Popover>
  );
}

// ── diff viewer ────────────────────────────────────────────────────────────
interface DiffResult {
  lines: GitDiffLine[];
  added: number;
  removed: number;
  binary: boolean;
  tooLarge?: boolean;
}

export function DiffLines({ diff }: { diff: DiffResult }) {
  if (diff.binary) return <p className="git-note">{diff.tooLarge ? 'This file is too large to show.' : 'Binary file: the changes can’t be shown as text.'}</p>;
  if (!diff.lines.length) return <p className="git-note">No changes to show (for example, only the file mode changed).</p>;
  return (
    <div className="agent-diff git-diff">
      {diff.lines.slice(0, 5000).map((l, i) =>
        l.kind === 'hunk' || l.kind === 'meta' ? (
          <div key={i} className="agent-diff-gap git-diff-hunk">{l.text}</div>
        ) : (
          <div key={i} className={cx('agent-diff-line', `is-${l.kind}`)}>
            <span className="agent-diff-no">{l.a ?? ''}</span>
            <span className="agent-diff-no">{l.b ?? ''}</span>
            <span className="agent-diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="agent-diff-text">{l.text || ' '}</span>
          </div>
        ),
      )}
      {diff.lines.length > 5000 && <div className="agent-diff-gap">…{diff.lines.length - 5000} more lines</div>}
      {diff.tooLarge && <div className="agent-diff-gap">The diff was cut: it is too large to show whole.</div>}
    </div>
  );
}

export function DiffModal({ ctx, file, commit, onClose, onOpen }: { ctx: GitContext; file: GitFileChange & { staged?: boolean }; commit?: string; onClose: () => void; onOpen?: () => void }) {
  const [diff, setDiff] = useState<DiffResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    git<DiffResult>(ctx, 'diff', { path: file.path, staged: file.staged, untracked: file.untracked, commit }).then(
      (d) => live && setDiff(d),
      (e) => live && setError(e instanceof Error ? e.message : 'The changes couldn’t be read.'),
    );
    return () => {
      live = false;
    };
  }, [ctx, file, commit]);
  return (
    <Modal
      title={`${leaf(file.path)}${commit ? ` @ ${commit.slice(0, 7)}` : file.staged ? ' (staged)' : file.untracked ? ' (new file)' : ''}`}
      width={900}
      onClose={onClose}
      footer={
        <>
          <span className="git-file-dir">{file.path}</span>
          {diff && !diff.binary && (
            <span className="agent-edit-stat">
              <span className="is-add">+{diff.added}</span> <span className="is-del">−{diff.removed}</span>
            </span>
          )}
          <span className="spacer" />
          {onOpen && (
            <button type="button" className="btn btn-sm git-outline" onClick={onOpen}>
              <ExternalLink size={14} /> Open file
            </button>
          )}
          <button type="button" className="btn btn-primary btn-sm" onClick={onClose}>
            Close
          </button>
        </>
      }
    >
      {error ? <p className="git-note is-error">{error}</p> : diff ? <DiffLines diff={diff} /> : <p className="git-note"><span className="spinner" /> Loading…</p>}
    </Modal>
  );
}

/** Icon for a commit row (shared with GitManager). */
export const CommitIcon = GitCommitHorizontal;
