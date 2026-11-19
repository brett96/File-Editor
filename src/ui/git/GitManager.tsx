/**
 * Everything in the Git panel's ⋯ menu that needs more room than the panel: branches, remotes,
 * stashes, tags, worktrees, history, the GitHub account, typed git commands, the output log and
 * the commit identity. One window with a tab per area.
 */
import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Check, Copy, ExternalLink, GitBranch, RefreshCw } from 'lucide-react';
import type { GitBranch as Branch, GitCommit, GitRemote, GitStash, GitStatus, GitTag } from '../../core/git/parse';
import { Modal, cx } from '../components';
import { DiffModal } from './GitPanel';
import { GitCallError, git, gitLog, onGitLog, timeAgo, type GitContext } from './git-client';

export type ManagerTab = 'branches' | 'remotes' | 'stashes' | 'tags' | 'worktrees' | 'history' | 'github' | 'command' | 'output' | 'settings';

const TABS: [ManagerTab, string, boolean][] = [
  // [id, label, needs a repository]
  ['branches', 'Branches', true],
  ['history', 'History', true],
  ['remotes', 'Remotes', true],
  ['stashes', 'Stashes', true],
  ['tags', 'Tags', true],
  ['worktrees', 'Worktrees', true],
  ['github', 'GitHub', false],
  ['command', 'Command', true],
  ['output', 'Output', false],
  ['settings', 'Name & email', true],
];

interface Props {
  ctx: GitContext;
  tab: ManagerTab;
  onTab: (t: ManagerTab) => void;
  onClose: () => void;
  toast: (text: string, kind?: 'error' | 'info') => void;
  onOpenFolder: (folder: { id: string; name: string }) => void;
  isRepo: boolean;
  status: GitStatus | null;
  onRefresh: () => void;
}

/** Shared by the tabs: run an action, report, reload. */
function useAction(ctx: GitContext, toast: Props['toast'], reload: () => void) {
  const [busy, setBusy] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const act = useCallback(
    async <T,>(label: string, op: string, args: Record<string, unknown> = {}, done?: string): Promise<T | null> => {
      setBusy(label);
      try {
        const res = await git<T>(ctx, op, args, { onProgress: setProgress });
        if (done) toast(done, 'info');
        return res;
      } catch (err) {
        if (!(err instanceof GitCallError && err.code === 'cancelled')) toast(err instanceof Error ? err.message : 'Git failed.');
        return null;
      } finally {
        setBusy(null);
        setProgress(null);
        reload();
      }
    },
    [ctx, toast, reload],
  );
  return { busy, progress, act };
}

function useList<T>(ctx: GitContext, op: string): [T[] | null, () => void, string | null] {
  const [list, setList] = useState<T[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    git<T[]>(ctx, op).then(
      (l) => {
        setList(l);
        setError(null);
      },
      (e) => setError(e instanceof Error ? e.message : 'Couldn’t load.'),
    );
  }, [ctx, op]);
  useEffect(load, [load]);
  return [list, load, error];
}

export function GitManager(props: Props) {
  const { tab, onTab, onClose, isRepo } = props;
  return (
    <Modal title="Git" width={820} onClose={onClose}>
      <div className="git-manager">
        <nav className="git-tabs" role="tablist" aria-label="Git">
          {TABS.filter(([, , repo]) => isRepo || !repo).map(([id, label]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={cx('git-tab', tab === id && 'is-active')} onClick={() => onTab(id)}>
              {label}
            </button>
          ))}
        </nav>
        <div className="git-tab-body">
          {tab === 'branches' && <Branches {...props} />}
          {tab === 'history' && <History {...props} />}
          {tab === 'remotes' && <Remotes {...props} />}
          {tab === 'stashes' && <Stashes {...props} />}
          {tab === 'tags' && <Tags {...props} />}
          {tab === 'worktrees' && <Worktrees {...props} />}
          {tab === 'github' && <GitHub {...props} />}
          {tab === 'command' && <Command {...props} />}
          {tab === 'output' && <Output />}
          {tab === 'settings' && <Identity {...props} />}
        </div>
      </div>
    </Modal>
  );
}

function Busy({ busy, progress }: { busy: string | null; progress?: string | null }) {
  return busy ? (
    <p className="git-busy" role="status">
      <span className="spinner" /> {busy} {progress && <span className="git-progress">{progress}</span>}
    </p>
  ) : null;
}

function Row({ title, meta, children, current }: { title: ReactNode; meta?: ReactNode; children?: ReactNode; current?: boolean }) {
  return (
    <li className={cx('git-row', current && 'is-current')}>
      <div className="git-row-main">
        <span className="git-row-title">{title}</span>
        {meta && <span className="git-row-meta">{meta}</span>}
      </div>
      {children && <div className="git-row-actions">{children}</div>}
    </li>
  );
}

const B = ({ children, onClick, danger, disabled, title }: { children: ReactNode; onClick: () => void; danger?: boolean; disabled?: boolean; title?: string }) => (
  <button type="button" className={cx('btn btn-sm git-outline', danger && 'git-danger')} onClick={onClick} disabled={disabled} title={title}>
    {children}
  </button>
);

// ── branches ───────────────────────────────────────────────────────────────
function Branches({ ctx, toast, onRefresh }: Props) {
  const [list, load, error] = useList<Branch>(ctx, 'branches');
  const { busy, progress, act } = useAction(ctx, toast, () => (load(), onRefresh()));
  const [name, setName] = useState('');
  const [showRemote, setShowRemote] = useState(false);
  const current = list?.find((b) => b.current);
  const create = (e: FormEvent) => {
    e.preventDefault();
    const n = name.trim();
    if (!n) return;
    void act('Creating…', 'createBranch', { name: n }, `Switched to the new branch ${n}.`).then((r) => r !== null && setName(''));
  };
  const shown = list?.filter((b) => showRemote || !b.remote) ?? [];
  return (
    <>
      <form className="git-form" onSubmit={create}>
        <input className="input" placeholder={`New branch from ${current?.name ?? 'HEAD'}`} value={name} onChange={(e) => setName(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !name.trim()}>
          Create and switch
        </button>
        <label className="git-check">
          <input type="checkbox" checked={showRemote} onChange={(e) => setShowRemote(e.target.checked)} /> Remote branches
        </label>
      </form>
      <Busy busy={busy} progress={progress} />
      {error && <p className="git-note is-error">{error}</p>}
      <ul className="git-rows">
        {shown.map((b) => (
          <Row
            key={b.name}
            current={b.current}
            title={
              <>
                <GitBranch size={13} /> {b.name} {b.current && <span className="git-pill">current</span>}
              </>
            }
            meta={
              <>
                {b.commit} · {b.subject} · {timeAgo(b.date)}
                {b.upstream && ` · tracks ${b.upstream} ${b.track}`}
              </>
            }
          >
            {!b.current && <B disabled={!!busy} onClick={() => void act('Switching…', 'checkout', { branch: b.name, remote: b.remote }, 'Switched.')}>Switch</B>}
            {!b.current && current && (
              <B disabled={!!busy} title={`Merge ${b.name} into ${current.name}`} onClick={() => window.confirm(`Merge ${b.name} into ${current.name}?`) && void act('Merging…', 'merge', { branch: b.name }, 'Merged.')}>
                Merge
              </B>
            )}
            {!b.current && current && (
              <B disabled={!!busy} title={`Replay ${current.name}’s commits on top of ${b.name}`} onClick={() => window.confirm(`Rebase ${current.name} onto ${b.name}?`) && void act('Rebasing…', 'rebase', { onto: b.name }, 'Rebased.')}>
                Rebase onto
              </B>
            )}
            {!b.remote && (
              <B
                disabled={!!busy}
                onClick={() => {
                  const to = window.prompt(`Rename ${b.name} to:`, b.name)?.trim();
                  if (to && to !== b.name) void act('Renaming…', 'renameBranch', { from: b.name, to }, 'Renamed.');
                }}
              >
                Rename
              </B>
            )}
            {!b.current && (
              <B
                danger
                disabled={!!busy}
                onClick={async () => {
                  if (b.remote) {
                    if (window.confirm(`Delete the branch ${b.name} on the remote? Others lose it too.`)) void act('Deleting…', 'deleteBranch', { name: b.name, remote: true }, 'Remote branch deleted.');
                    return;
                  }
                  if (!window.confirm(`Delete the branch ${b.name}?`)) return;
                  const ok = await act('Deleting…', 'deleteBranch', { name: b.name }, 'Branch deleted.');
                  if (ok === null && window.confirm(`${b.name} has commits that aren’t merged anywhere. Delete it anyway? Those commits are lost.`)) {
                    void act('Deleting…', 'deleteBranch', { name: b.name, force: true }, 'Branch deleted.');
                  }
                }}
              >
                Delete
              </B>
            )}
          </Row>
        ))}
        {list && !shown.length && <li className="git-note">No branches yet: make a first commit.</li>}
        {!list && !error && <li className="git-note"><span className="spinner" /></li>}
      </ul>
    </>
  );
}

// ── history ────────────────────────────────────────────────────────────────
function History({ ctx, toast, onRefresh, status }: Props) {
  const [all, setAll] = useState(false);
  const [list, setList] = useState<GitCommit[] | null>(null);
  const load = useCallback(() => {
    git<GitCommit[]>(ctx, 'log', { limit: 200, all }).then(setList, () => setList([]));
  }, [ctx, all]);
  useEffect(load, [load]);
  const { busy, act } = useAction(ctx, toast, () => (load(), onRefresh()));
  const [open, setOpen] = useState<string | null>(null);
  const [files, setFiles] = useState<{ status: string; path: string }[] | null>(null);
  const [diff, setDiff] = useState<{ path: string; commit: string } | null>(null);
  const expand = (hash: string) => {
    if (open === hash) return setOpen(null);
    setOpen(hash);
    setFiles(null);
    git<{ status: string; path: string }[]>(ctx, 'commitFiles', { commit: hash }).then(setFiles, () => setFiles([]));
  };
  return (
    <>
      <div className="git-form">
        <label className="git-check">
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> All branches
        </label>
        <span className="spacer" />
        <button type="button" className="btn btn-sm git-outline" onClick={load}>
          <RefreshCw size={13} /> Refresh
        </button>
      </div>
      <Busy busy={busy} />
      <ul className="git-rows">
        {list?.map((c) => (
          <li key={c.hash} className={cx('git-row', 'git-commit-row', open === c.hash && 'is-open')}>
            <button type="button" className="git-row-main git-row-button" onClick={() => expand(c.hash)}>
              <span className="git-row-title">
                <code>{c.short}</code> {c.subject}
              </span>
              <span className="git-row-meta">
                {c.author} · {timeAgo(c.date)}
                {c.refs && <span className="git-refs"> · {c.refs}</span>}
              </span>
            </button>
            {open === c.hash && (
              <div className="git-commit-detail">
                <div className="git-row-actions">
                  <B onClick={() => void navigator.clipboard?.writeText(c.hash).then(() => toast('Commit hash copied.', 'info'))}>
                    <Copy size={12} /> Copy hash
                  </B>
                  <B disabled={!!busy} onClick={() => window.confirm(`Check out ${c.short}? You’ll be on a detached HEAD (no branch).`) && void act('Checking out…', 'checkoutCommit', { commit: c.hash }, 'Checked out.')}>
                    Check out
                  </B>
                  <B
                    disabled={!!busy}
                    onClick={() => {
                      const n = window.prompt('New branch name (starting at this commit):')?.trim();
                      if (n) void act('Creating…', 'createBranch', { name: n, from: c.hash }, `Switched to ${n}.`);
                    }}
                  >
                    Branch here
                  </B>
                  <B
                    disabled={!!busy}
                    onClick={() => {
                      const n = window.prompt('Tag name:')?.trim();
                      if (n) void act('Tagging…', 'createTag', { name: n, commit: c.hash }, `Tagged ${n}.`);
                    }}
                  >
                    Tag
                  </B>
                  <B disabled={!!busy} onClick={() => window.confirm(`Apply the changes of ${c.short} on top of ${status?.branch ?? 'HEAD'}?`) && void act('Cherry-picking…', 'cherryPick', { commit: c.hash }, 'Cherry-picked.')}>
                    Cherry-pick
                  </B>
                  <B disabled={!!busy} onClick={() => window.confirm(`Make a new commit that undoes ${c.short}?`) && void act('Reverting…', 'revert', { commit: c.hash }, 'Reverted.')}>
                    Revert
                  </B>
                  <B
                    danger
                    disabled={!!busy}
                    onClick={() => {
                      const mode = window.prompt(`Reset ${status?.branch ?? 'HEAD'} to ${c.short}. Type soft (keep changes staged), mixed (keep changes, unstaged) or hard (discard everything after it):`, 'mixed')?.trim();
                      if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') return;
                      if (mode === 'hard' && !window.confirm('A hard reset discards all uncommitted changes and the commits after this one. Continue?')) return;
                      void act('Resetting…', 'reset', { commit: c.hash, mode }, `Reset (${mode}).`);
                    }}
                  >
                    Reset to here…
                  </B>
                  <B onClick={() => void act('Opening…', 'githubOpen', { page: 'commit', commit: c.hash })}>
                    <ExternalLink size={12} /> GitHub
                  </B>
                </div>
                <ul className="git-commit-files">
                  {!files && <li className="git-note"><span className="spinner" /></li>}
                  {files?.map((f) => (
                    <li key={f.path}>
                      <button type="button" onClick={() => setDiff({ path: f.path, commit: c.hash })}>
                        <span className={cx('git-letter', `is-${f.status.toLowerCase()}`)}>{f.status}</span> {f.path}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </li>
        ))}
        {list && !list.length && <li className="git-note">No commits yet.</li>}
        {!list && <li className="git-note"><span className="spinner" /></li>}
      </ul>
      {diff && <DiffModal ctx={ctx} file={{ path: diff.path, index: '.', worktree: '.' }} commit={diff.commit} onClose={() => setDiff(null)} />}
    </>
  );
}

// ── remotes ────────────────────────────────────────────────────────────────
function Remotes({ ctx, toast, onRefresh }: Props) {
  const [list, load, error] = useList<GitRemote>(ctx, 'remotes');
  const { busy, progress, act } = useAction(ctx, toast, () => (load(), onRefresh()));
  const [name, setName] = useState('origin');
  const [url, setUrl] = useState('');
  return (
    <>
      <form
        className="git-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('Adding…', 'addRemote', { name: name.trim(), url: url.trim() }, `Remote ${name.trim()} added.`).then((r) => r !== null && setUrl(''));
        }}
      >
        <input className="input git-input-short" placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="https://github.com/owner/repo.git" value={url} onChange={(e) => setUrl(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !url.trim() || !name.trim()}>
          Add remote
        </button>
      </form>
      <Busy busy={busy} progress={progress} />
      {error && <p className="git-note is-error">{error}</p>}
      <ul className="git-rows">
        {list?.map((r) => (
          <Row key={r.name} title={r.name} meta={r.pushUrl && r.pushUrl !== r.fetchUrl ? `${r.fetchUrl} (push: ${r.pushUrl})` : r.fetchUrl}>
            <B disabled={!!busy} onClick={() => void act('Fetching…', 'fetch', { remote: r.name }, `Fetched ${r.name}.`)}>Fetch</B>
            <B disabled={!!busy} onClick={() => void act('Pulling…', 'pull', { remote: r.name }, 'Pulled.')}>Pull</B>
            <B disabled={!!busy} onClick={() => void act('Pushing…', 'push', { remote: r.name }, `Pushed to ${r.name}.`)}>Push</B>
            <B
              disabled={!!busy}
              onClick={() => {
                const u = window.prompt(`New URL for ${r.name}:`, r.fetchUrl)?.trim();
                if (u && u !== r.fetchUrl) void act('Saving…', 'setRemoteUrl', { name: r.name, url: u }, 'URL changed.');
              }}
            >
              Edit URL
            </B>
            <B
              disabled={!!busy}
              onClick={() => {
                const to = window.prompt(`Rename ${r.name} to:`, r.name)?.trim();
                if (to && to !== r.name) void act('Renaming…', 'renameRemote', { from: r.name, to }, 'Renamed.');
              }}
            >
              Rename
            </B>
            <B danger disabled={!!busy} onClick={() => window.confirm(`Remove the remote ${r.name}? (Nothing is deleted on the server.)`) && void act('Removing…', 'removeRemote', { name: r.name }, 'Remote removed.')}>
              Remove
            </B>
          </Row>
        ))}
        {list && !list.length && <li className="git-note">No remotes. Add one above, or publish the repository to GitHub (GitHub tab).</li>}
      </ul>
    </>
  );
}

// ── stashes ────────────────────────────────────────────────────────────────
function Stashes({ ctx, toast, onRefresh }: Props) {
  const [list, load, error] = useList<GitStash>(ctx, 'stashes');
  const { busy, act } = useAction(ctx, toast, () => (load(), onRefresh()));
  const [message, setMessage] = useState('');
  const [untracked, setUntracked] = useState(true);
  const [files, setFiles] = useState<Record<string, { status: string; path: string }[]>>({});
  return (
    <>
      <form
        className="git-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('Stashing…', 'stash', { message, untracked }, 'Changes stashed.').then((r) => r !== null && setMessage(''));
        }}
      >
        <input className="input" placeholder="Message (optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <label className="git-check">
          <input type="checkbox" checked={untracked} onChange={(e) => setUntracked(e.target.checked)} /> Include new files
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy}>
          Stash changes
        </button>
      </form>
      <Busy busy={busy} />
      {error && <p className="git-note is-error">{error}</p>}
      <ul className="git-rows">
        {list?.map((s) => (
          <li key={s.ref} className="git-row">
            <div className="git-row-main">
              <span className="git-row-title">
                <code>{s.ref}</code> {s.message}
              </span>
              <span className="git-row-meta">{timeAgo(s.date)}</span>
              {files[s.ref] && <span className="git-row-meta">{files[s.ref].map((f) => `${f.status} ${f.path}`).join(' · ') || 'No files'}</span>}
            </div>
            <div className="git-row-actions">
              <B onClick={() => git<{ status: string; path: string }[]>(ctx, 'stashFiles', { ref: s.ref }).then((f) => setFiles((m) => ({ ...m, [s.ref]: f })), () => undefined)}>Files</B>
              <B disabled={!!busy} onClick={() => void act('Applying…', 'stashApply', { ref: s.ref }, 'Stash applied (kept).')}>Apply</B>
              <B disabled={!!busy} onClick={() => void act('Applying…', 'stashApply', { ref: s.ref, pop: true }, 'Stash applied and removed.')}>Pop</B>
              <B
                disabled={!!busy}
                onClick={() => {
                  const n = window.prompt('New branch for this stash:')?.trim();
                  if (n) void act('Creating…', 'stashBranch', { ref: s.ref, name: n }, `Stash applied on the new branch ${n}.`);
                }}
              >
                To branch
              </B>
              <B danger disabled={!!busy} onClick={() => window.confirm(`Delete ${s.ref}? Its changes are lost.`) && void act('Dropping…', 'stashDrop', { ref: s.ref }, 'Stash deleted.')}>
                Drop
              </B>
            </div>
          </li>
        ))}
        {list && !list.length && <li className="git-note">No stashes.</li>}
      </ul>
      {list && list.length > 1 && (
        <p>
          <B danger disabled={!!busy} onClick={() => window.confirm('Delete every stash? Their changes are lost.') && void act('Clearing…', 'stashDrop', { all: true }, 'All stashes deleted.')}>
            Delete all stashes
          </B>
        </p>
      )}
    </>
  );
}

// ── tags ───────────────────────────────────────────────────────────────────
function Tags({ ctx, toast, onRefresh }: Props) {
  const [list, load, error] = useList<GitTag>(ctx, 'tags');
  const { busy, progress, act } = useAction(ctx, toast, () => (load(), onRefresh()));
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  return (
    <>
      <form
        className="git-form"
        onSubmit={(e) => {
          e.preventDefault();
          void act('Tagging…', 'createTag', { name: name.trim(), message }, `Tagged ${name.trim()}.`).then((r) => r !== null && (setName(''), setMessage('')));
        }}
      >
        <input className="input git-input-short" placeholder="v1.0.0" value={name} onChange={(e) => setName(e.target.value)} />
        <input className="input" placeholder="Message (makes an annotated tag; optional)" value={message} onChange={(e) => setMessage(e.target.value)} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !name.trim()}>
          Tag current commit
        </button>
      </form>
      <div className="git-form">
        <B disabled={!!busy} onClick={() => void act('Pushing tags…', 'pushTags', {}, 'Tags pushed to origin.')}>Push all tags</B>
        <B disabled={!!busy} onClick={() => void act('Fetching tags…', 'fetch', { tags: true }, 'Tags fetched.')}>Fetch tags</B>
      </div>
      <Busy busy={busy} progress={progress} />
      {error && <p className="git-note is-error">{error}</p>}
      <ul className="git-rows">
        {list?.map((t) => (
          <Row key={t.name} title={<>{t.name} {t.annotated && <span className="git-pill">annotated</span>}</>} meta={`${t.commit} · ${t.subject} · ${timeAgo(t.date)}`}>
            <B disabled={!!busy} onClick={() => void act('Pushing…', 'pushTags', { name: t.name }, `${t.name} pushed.`)}>Push</B>
            <B
              danger
              disabled={!!busy}
              onClick={() => {
                if (!window.confirm(`Delete the tag ${t.name}?`)) return;
                const remote = window.confirm(`Delete ${t.name} on origin too?`);
                void act('Deleting…', 'deleteTag', { name: t.name, remote: remote ? 'origin' : undefined }, 'Tag deleted.');
              }}
            >
              Delete
            </B>
          </Row>
        ))}
        {list && !list.length && <li className="git-note">No tags.</li>}
      </ul>
    </>
  );
}

// ── worktrees ──────────────────────────────────────────────────────────────
interface Tree {
  id: string;
  name: string;
  branch: string | null;
  head: string;
  bare: boolean;
  locked: boolean;
  prunable: boolean;
  current: boolean;
}

function Worktrees({ ctx, toast, onRefresh, onOpenFolder, onClose }: Props) {
  const [list, load, error] = useList<Tree>(ctx, 'worktrees');
  const [branches] = useList<Branch>(ctx, 'branches');
  const { busy, act } = useAction(ctx, toast, () => (load(), onRefresh()));
  const [mode, setMode] = useState<'new' | 'existing'>('new');
  const [name, setName] = useState('');
  const [existing, setExisting] = useState('');
  const [openAfter, setOpenAfter] = useState(true);
  const free = branches?.filter((b) => !b.remote && !b.current && !list?.some((t) => t.branch === b.name)) ?? [];
  return (
    <>
      <p className="git-note">A worktree is a second folder with another branch checked out, sharing this repository: work on two branches at once.</p>
      <form
        className="git-form"
        onSubmit={async (e) => {
          e.preventDefault();
          const args = mode === 'new' ? { newBranch: name.trim(), open: openAfter } : { branch: existing, open: openAfter };
          const res = await act<{ folder: { id: string; name: string } | null; cancelled?: boolean }>('Creating worktree…', 'addWorktree', args);
          if (res && !res.cancelled) {
            toast('Worktree created.', 'info');
            setName('');
            if (res.folder) {
              onOpenFolder(res.folder);
              onClose();
            }
          }
        }}
      >
        <select className="input git-input-short" value={mode} onChange={(e) => setMode(e.target.value as 'new' | 'existing')}>
          <option value="new">New branch</option>
          <option value="existing">Existing branch</option>
        </select>
        {mode === 'new' ? (
          <input className="input" placeholder="Branch name" value={name} onChange={(e) => setName(e.target.value)} />
        ) : (
          <select className="input" value={existing} onChange={(e) => setExisting(e.target.value)}>
            <option value="">Pick a branch…</option>
            {free.map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </select>
        )}
        <label className="git-check">
          <input type="checkbox" checked={openAfter} onChange={(e) => setOpenAfter(e.target.checked)} /> Open it
        </label>
        <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || (mode === 'new' ? !name.trim() : !existing)}>
          Add worktree…
        </button>
      </form>
      <Busy busy={busy} />
      {error && <p className="git-note is-error">{error}</p>}
      <ul className="git-rows">
        {list?.map((t) => (
          <Row
            key={t.id}
            current={t.current}
            title={<>{t.name} {t.current && <span className="git-pill">this one</span>} {t.locked && <span className="git-pill">locked</span>} {t.prunable && <span className="git-pill">missing</span>}</>}
            meta={t.bare ? 'bare' : `${t.branch ?? `detached at ${t.head}`}`}
          >
            {!t.current && !t.bare && (
              <B
                disabled={!!busy}
                onClick={async () => {
                  const res = await act<{ folder: { id: string; name: string } }>('Opening…', 'openWorktree', { id: t.id });
                  if (res?.folder) {
                    onOpenFolder(res.folder);
                    onClose();
                  }
                }}
              >
                Open
              </B>
            )}
            {!t.current && !t.bare && (
              <B
                danger
                disabled={!!busy}
                onClick={async () => {
                  if (!window.confirm(`Remove the worktree ${t.name}? Its folder is deleted (the branch stays).`)) return;
                  const ok = await act('Removing…', 'removeWorktree', { id: t.id }, 'Worktree removed.');
                  if (ok === null && window.confirm(`${t.name} has changes that aren’t committed. Remove it anyway? They are lost.`)) void act('Removing…', 'removeWorktree', { id: t.id, force: true }, 'Worktree removed.');
                }}
              >
                Remove
              </B>
            )}
          </Row>
        ))}
      </ul>
      {list?.some((t) => t.prunable) && <B onClick={() => void act('Pruning…', 'pruneWorktrees', {}, 'Missing worktrees forgotten.')}>Forget missing worktrees</B>}
    </>
  );
}

// ── GitHub ─────────────────────────────────────────────────────────────────
interface GhRepo {
  fullName: string;
  cloneUrl: string;
  private: boolean;
  description: string;
  updatedAt: string;
}

function GitHub({ ctx, toast, onOpenFolder, onClose, isRepo, status, onRefresh }: Props) {
  const [state, setState] = useState<{ connected: boolean; login: string | null; secure?: boolean } | null>(null);
  const [token, setToken] = useState('');
  const [repos, setRepos] = useState<GhRepo[] | null>(null);
  const [filter, setFilter] = useState('');
  const [publish, setPublish] = useState({ name: '', private: true });
  const { busy, progress, act } = useAction(ctx, toast, onRefresh);
  const load = useCallback(() => {
    git<{ connected: boolean; login: string | null; secure: boolean }>(ctx, 'githubStatus').then(setState, () => setState({ connected: false, login: null }));
  }, [ctx]);
  useEffect(load, [load]);
  useEffect(() => {
    if (state?.connected) git<GhRepo[]>(ctx, 'githubRepos').then(setRepos, (e) => (toast(e instanceof Error ? e.message : 'Couldn’t list repositories.'), setRepos([])));
  }, [ctx, state?.connected, toast]);

  if (!state) return <p className="git-note"><span className="spinner" /></p>;
  if (!state.connected) {
    return (
      <div className="git-github">
        <p>
          Connect your GitHub account to clone your repositories, push and pull without signing in again, publish a repository and open pull
          requests. Create a <strong>personal access token</strong> with the <code>repo</code> scope (or a fine-grained token with <em>Contents</em>{' '}
          read & write), then paste it here.
        </p>
        <p>
          <a href="https://github.com/settings/tokens/new?scopes=repo,workflow&description=File%20Editor" target="_blank" rel="noopener noreferrer">
            Create a token on GitHub <ExternalLink size={12} />
          </a>
        </p>
        <form
          className="git-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act<{ login: string }>('Connecting…', 'githubConnect', { token });
            if (res) {
              setToken('');
              toast(`Connected as ${res.login}.`, 'info');
              load();
            }
          }}
        >
          <input className="input" type="password" autoComplete="off" placeholder="ghp_… or github_pat_…" value={token} onChange={(e) => setToken(e.target.value)} />
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !token.trim()}>
            Connect
          </button>
        </form>
        <Busy busy={busy} />
        <p className="git-note">
          The token is encrypted with your system’s keychain and used only to talk to github.com. Without it, git uses your usual sign-in (Git
          Credential Manager, SSH keys).
        </p>
      </div>
    );
  }
  const q = filter.trim().toLowerCase();
  return (
    <div className="git-github">
      <div className="git-form">
        <span>
          <Check size={14} /> Connected as <strong>{state.login}</strong>
        </span>
        <span className="spacer" />
        {isRepo && <B onClick={() => void act('Opening…', 'githubOpen', {})}><ExternalLink size={12} /> Open on GitHub</B>}
        {isRepo && status?.branch && <B onClick={() => void act('Opening…', 'githubOpen', { page: 'pull', branch: status.branch })}>Create pull request</B>}
        <B danger onClick={() => window.confirm('Disconnect GitHub? The token is removed from this computer.') && void act('Disconnecting…', 'githubDisconnect', {}, 'GitHub disconnected.').then(load)}>
          Disconnect
        </B>
      </div>
      {isRepo && (
        <form
          className="git-form"
          onSubmit={async (e) => {
            e.preventDefault();
            const res = await act<{ url: string }>('Publishing…', 'githubPublish', { name: publish.name.trim(), private: publish.private });
            if (res) toast(`Published to ${res.url}.`, 'info');
          }}
        >
          <span className="git-form-label">Publish this repository:</span>
          <input className="input" placeholder="repository-name" value={publish.name} onChange={(e) => setPublish({ ...publish, name: e.target.value })} />
          <label className="git-check">
            <input type="checkbox" checked={publish.private} onChange={(e) => setPublish({ ...publish, private: e.target.checked })} /> Private
          </label>
          <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !publish.name.trim()}>
            Publish
          </button>
        </form>
      )}
      <Busy busy={busy} progress={progress} />
      <div className="git-form">
        <span className="git-form-label">Your repositories</span>
        <input className="input" placeholder="Find…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <ul className="git-rows">
        {!repos && <li className="git-note"><span className="spinner" /></li>}
        {repos
          ?.filter((r) => !q || r.fullName.toLowerCase().includes(q))
          .slice(0, 100)
          .map((r) => (
            <Row key={r.fullName} title={<>{r.fullName} {r.private && <span className="git-pill">private</span>}</>} meta={`${r.description || 'No description'} · updated ${timeAgo(r.updatedAt)}`}>
              <B
                disabled={!!busy}
                onClick={async () => {
                  const res = await act<{ folder?: { id: string; name: string }; cancelled?: boolean }>('Cloning…', 'clone', { url: r.cloneUrl });
                  if (res?.folder) {
                    toast(`Cloned ${r.fullName}.`, 'info');
                    onOpenFolder(res.folder);
                    onClose();
                  }
                }}
              >
                Clone…
              </B>
            </Row>
          ))}
      </ul>
    </div>
  );
}

// ── typed commands, output, identity ───────────────────────────────────────
function Command({ ctx, toast, onRefresh }: Props) {
  const [cmd, setCmd] = useState('');
  const [out, setOut] = useState<{ cmd: string; text: string; error?: boolean }[]>([]);
  const [busy, setBusy] = useState(false);
  const runIt = async (e: FormEvent) => {
    e.preventDefault();
    const c = cmd.trim();
    if (!c) return;
    setBusy(true);
    try {
      const res = await git<{ output?: string; cancelled?: boolean }>(ctx, 'custom', { command: c });
      if (!res.cancelled) setOut((o) => [{ cmd: c, text: res.output ?? '' }, ...o].slice(0, 20));
    } catch (err) {
      setOut((o) => [{ cmd: c, text: err instanceof Error ? err.message : 'Failed.', error: true }, ...o].slice(0, 20));
    } finally {
      setBusy(false);
      onRefresh();
    }
  };
  void toast;
  return (
    <>
      <p className="git-note">Run any git command in this repository. You’ll be asked to confirm it first. There is no shell: no pipes, globbing or variables.</p>
      <form className="git-form" onSubmit={runIt}>
        <span className="git-prompt">git</span>
        <input className="input git-mono" placeholder="log --oneline --graph -20" value={cmd} onChange={(e) => setCmd(e.target.value)} autoFocus spellCheck={false} onKeyDown={(e) => e.stopPropagation()} />
        <button type="submit" className="btn btn-primary btn-sm" disabled={busy || !cmd.trim()}>
          {busy ? <span className="spinner" /> : 'Run'}
        </button>
      </form>
      {out.map((o, i) => (
        <div key={i} className="git-output">
          <div className="git-output-cmd">git {o.cmd}</div>
          <pre className={cx(o.error && 'is-error')}>{o.text}</pre>
        </div>
      ))}
    </>
  );
}

function Output() {
  const [, setTick] = useState(0);
  useEffect(() => onGitLog(() => setTick((n) => n + 1)), []);
  const entries = [...gitLog()].reverse();
  return (
    <div className="git-log">
      {!entries.length && <p className="git-note">Nothing has run yet.</p>}
      {entries.map((e, i) => (
        <div key={i} className={cx('git-log-entry', !e.ok && 'is-error')}>
          <span className="git-log-time">{new Date(e.at).toLocaleTimeString()}</span> <strong>{e.op}</strong>
          <pre>{e.text}</pre>
        </div>
      ))}
    </div>
  );
}

function Identity({ ctx, toast }: Props) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [global, setGlobal] = useState(true);
  const { busy, act } = useAction(ctx, toast, () => undefined);
  useEffect(() => {
    git<{ name: string; email: string }>(ctx, 'identity').then(
      (i) => {
        setName(i.name);
        setEmail(i.email);
      },
      () => undefined,
    );
  }, [ctx]);
  return (
    <form
      className="git-identity"
      onSubmit={(e) => {
        e.preventDefault();
        void act('Saving…', 'setIdentity', { name, email, global }, 'Saved. New commits use this name and email.');
      }}
    >
      <p className="git-note">Every commit records an author. Set the name and email to use.</p>
      <label className="field">
        <span className="field-label">Name</span>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <label className="field">
        <span className="field-label">Email</span>
        <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
      </label>
      <label className="git-check">
        <input type="checkbox" checked={global} onChange={(e) => setGlobal(e.target.checked)} /> For all repositories on this computer (otherwise just this one)
      </label>
      <button type="submit" className="btn btn-primary btn-sm" disabled={!!busy || !name.trim() || !email.trim()}>
        Save
      </button>
    </form>
  );
}
