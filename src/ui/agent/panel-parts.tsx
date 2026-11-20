/**
 * Pieces of the agent panel: the context ring beside the usage meter, attachment chips, the
 * earlier-sessions list and the folder file picker.
 */
import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, FileCode, Image as ImageIcon, MessageSquare, Search, SquarePen, Trash2 } from 'lucide-react';
import { Modal, cx } from '../components';
import type { AttachmentChip } from './attachments';
import { deleteSession, listSessions, type SessionMeta } from './session-store';
import { folderFiles, type AgentWorkspace } from './tools';

const fmt = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(n));

/**
 * How much of the model's context window the conversation takes (the system prompt, the files
 * it read, the history and what is about to be sent), as a ring with the share in the middle.
 */
export function ContextRing({ used, total, dropped }: { used: number; total: number; dropped: boolean }) {
  const share = Math.max(0, Math.min(1, used / total));
  const pct = Math.round(share * 100);
  const r = 13;
  const c = 2 * Math.PI * r;
  const level = share >= 0.9 ? 'is-full' : share >= 0.7 ? 'is-warn' : '';
  return (
    <div
      className={cx('agent-context-ring', level)}
      role="meter"
      aria-label="Context used"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct}
      title={
        `Context: about ${fmt(used)} of ${fmt(total)} tokens (${pct}%) — the instructions, the files the agent read, the conversation and what you're about to send.` +
        (dropped ? ' The oldest turns are already left out so it fits; start a new session for a fresh start.' : ' When it fills, the oldest turns are left out.')
      }
    >
      <svg viewBox="0 0 32 32" width="32" height="32" aria-hidden="true">
        <circle cx="16" cy="16" r={r} className="agent-ring-track" />
        <circle cx="16" cy="16" r={r} className="agent-ring-fill" strokeDasharray={`${c * share} ${c}`} transform="rotate(-90 16 16)" />
      </svg>
      <span>{pct < 1 && used > 0 ? '<1' : pct}%</span>
    </div>
  );
}

export function AttachmentChips({ chips }: { chips: AttachmentChip[] }) {
  return (
    <div className="agent-sent-attachments">
      {chips.map((c, i) =>
        c.thumb ? (
          <img key={i} className="agent-sent-thumb" src={c.thumb} alt={c.name} title={c.name} />
        ) : (
          <span key={i} className="agent-attachment is-sent" title={c.name}>
            {c.kind === 'image' ? <ImageIcon size={12} /> : <FileCode size={12} />}
            <span className="agent-attachment-name">{c.name}</span>
          </span>
        ),
      )}
    </div>
  );
}

function ago(t: number): string {
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)} d ago`;
  return new Date(t).toLocaleDateString();
}

/** Earlier sessions: open one to read it and carry on, or delete it. */
export function SessionHistory({ currentId, busy, onOpen, onNew, onBack }: { currentId: string; busy: boolean; onOpen: (m: SessionMeta) => void; onNew: () => void; onBack: () => void }) {
  const [list, setList] = useState<SessionMeta[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const load = () => void listSessions().then(setList, (e) => setError(e instanceof Error ? e.message : 'Sessions couldn’t be read.'));
  useEffect(load, []);
  const q = query.trim().toLowerCase();
  const shown = (list ?? []).filter((s) => !q || `${s.title} ${s.where} ${s.model}`.toLowerCase().includes(q));
  return (
    <div className="agent-history">
      <div className="agent-history-head">
        <button type="button" className="agent-icon" title="Back to the conversation" aria-label="Back to the conversation" onClick={onBack}>
          <ArrowLeft size={15} />
        </button>
        <strong>Earlier sessions</strong>
        <span className="spacer" />
        <button type="button" className="btn btn-sm agent-stop" onClick={onNew} disabled={busy}>
          <SquarePen size={13} /> New
        </button>
      </div>
      <label className="agent-history-search">
        <Search size={13} />
        <input value={query} placeholder="Find a session…" onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.stopPropagation()} aria-label="Find a session" />
      </label>
      <div className="agent-history-list">
        {error && <p className="agent-history-note is-error">{error}</p>}
        {!list && !error && <p className="agent-history-note"><span className="spinner" /></p>}
        {list && !shown.length && <p className="agent-history-note">{list.length ? 'No session matches.' : 'Sessions you have with the agent are kept here, on this computer.'}</p>}
        {shown.map((s) => (
          <div key={s.id} className={cx('agent-history-row', s.id === currentId && 'is-current')}>
            <button type="button" className="agent-history-open" disabled={busy || s.id === currentId} onClick={() => onOpen(s)} title={s.id === currentId ? 'This is the conversation on screen' : 'Open and continue this session'}>
              <MessageSquare size={14} />
              <span className="agent-history-text">
                <span className="agent-history-title">{s.title}</span>
                <span className="agent-history-meta">
                  {ago(s.updatedAt)} · {s.turns} message{s.turns === 1 ? '' : 's'} · {s.mode === 'agent' ? 'Agent' : 'Chat'}
                  {s.where ? ` · ${s.where}` : ''}
                </span>
              </span>
            </button>
            <button
              type="button"
              className="agent-icon"
              title="Delete this session"
              aria-label={`Delete ${s.title}`}
              disabled={s.id === currentId}
              onClick={() => {
                if (!window.confirm(`Delete “${s.title}”?`)) return;
                void deleteSession(s.id).then(load, load);
              }}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Choose a file of the opened folder to attach. */
export function FilePicker({ getWorkspace, onPick, onClose }: { getWorkspace: () => AgentWorkspace; onPick: (path: string) => void; onClose: () => void }) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    const f = getWorkspace().folder;
    if (f) void folderFiles(f).then(setFiles, () => setFiles([]));
    else setFiles([]);
  }, [getWorkspace]);
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (files ?? []).filter((p) => !q || p.toLowerCase().includes(q)).slice(0, 300);
  }, [files, query]);
  return (
    <Modal title="Add a file to the message" width={520} onClose={onClose}>
      <div className="agent-picker">
        <input className="input" autoFocus placeholder="Find a file…" value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => {
          if (e.key === 'Enter' && shown[0]) onPick(shown[0]);
          e.stopPropagation();
        }} />
        <ul className="agent-picker-list">
          {!files && <li className="agent-history-note"><span className="spinner" /></li>}
          {files && !shown.length && <li className="agent-history-note">No file matches.</li>}
          {shown.map((p) => (
            <li key={p}>
              <button type="button" onClick={() => onPick(p)}>
                {/\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(p) ? <ImageIcon size={13} /> : <FileCode size={13} />}
                <span className="agent-picker-name">{p.split('/').pop()}</span>
                <span className="agent-picker-dir">{p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Modal>
  );
}
