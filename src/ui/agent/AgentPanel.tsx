/**
 * The coding agent: a chat beside the code editor and the opened folder, answered by a model
 * the user picks from OpenUncensored's list.
 *
 * - **Agent** mode gives the model tools (tools.ts) to read, search and change the folder's
 *   files; every change is shown as a diff to apply or reject.
 * - **Chat** mode sends the file on screen (and the selection) as context; code in an answer
 *   can be inserted into the editor with one click.
 *
 * Licensed desktop copies only: requests go from the main process (electron/agent.ts) to the
 * license server, which checks the license and usage limits and holds the API key. Without a
 * license this panel only says how to get one.
 */
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import {
  AlertTriangle,
  Bot,
  Hand,
  History as HistoryIcon,
  Paperclip,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  CornerDownLeft,
  FileCode,
  FolderOpen,
  KeyRound,
  Lock,
  RefreshCw,
  Send,
  Sparkles,
  Square,
  SquarePen,
  Wrench,
  X,
} from 'lucide-react';
import { estimateTokens, fileBudget, historyBudget, limitImages, trimHistory } from '../../core/agent/context';
import { attachmentFromFile, chipsOf, composeMessage, fileAttachment, imageAttachment, type Attachment, type AttachmentChip } from './attachments';
import { loadSession, saveSession, sessionTitle, type SessionMeta } from './session-store';
import { AttachmentChips, ContextRing, FilePicker, SessionHistory } from './panel-parts';
import { clip, type Diff } from '../../core/agent/edits';
import {
  DEFAULT_AGENT_MODEL,
  formatContext,
  type AgentMessage,
  type AgentModel,
  type AgentStatus,
  type AgentToolCall,
  type AgentUsageToday,
} from '../../core/agent/protocol';
import { agentBridge } from '../../platform/host';
import { cx } from '../components';
import { AGENT_TOOLS, folderFiles, readForContext, runTool, type AgentWorkspace, type EditProposal } from './tools';
import { MenuItem, Popover } from '../components';

type Mode = 'agent' | 'chat';

type Item =
  | { kind: 'user'; id: string; text: string; note?: string; attachments?: AttachmentChip[] }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; streaming: boolean; tool?: string; meta?: string }
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'waiting' | 'done' | 'error' }
  | { kind: 'edit'; id: string; path: string; diff: Diff; isNew: boolean; status: 'pending' | 'applied' | 'rejected' | 'failed' }
  | { kind: 'notice'; id: string; text: string; error?: boolean };

const MAX_STEPS = 25;
const OUTPUT_TOKENS = 8192;
const STORE = { model: 'fe.agent.model', mode: 'fe.agent.mode', auto: 'fe.agent.autoApply', width: 'fe.agent.width' };

function load(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}
function save(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode */
  }
}

let seq = 0;
const uid = (p: string) => `${p}${Date.now().toString(36)}${(seq++).toString(36)}`;

/** A fence longer than any run of backticks in `text`, so file content can't close it early. */
function fenceFor(text: string): string {
  let longest = 2;
  for (const m of text.matchAll(/`{3,}/g)) longest = Math.max(longest, m[0].length);
  return '`'.repeat(longest + 1);
}

function activePath(ws: AgentWorkspace): string | null {
  const a = ws.active;
  if (!a) return null;
  return a.folderId && ws.folder && a.folderId === ws.folder.id && a.path ? a.path : a.name;
}

function systemPrompt(mode: Mode, ws: AgentWorkspace, budget: number): string {
  const parts = ['You are the coding assistant built into File Editor, a desktop app for editing files and code.'];
  const path = activePath(ws);
  const canWork = !!(ws.folder || ws.active);
  if (mode === 'agent' && canWork) {
    parts.push(
      ws.folder
        ? `You are working in the project folder "${ws.folder.name}". Paths are relative to its root and use "/".`
        : `You are working on a single file, "${ws.active!.name}" (no folder is open). Use that name as its path.`,
    );
    parts.push(
      [
        'How to work:',
        '- Look before you change anything: list_files, search_files and read_file. Never guess at a file’s content.',
        '- Make focused changes with edit_file. Use write_file for new files or complete rewrites.',
        '- Keep the project’s existing style, naming and formatting.',
        '- Each change is shown to the user as a diff, and they may reject it.',
        '- You cannot run commands or tests, delete or rename files, or use the internet.',
        '- Don’t paste whole files into your reply: change them with the tools.',
        '- When you are done, reply with a short summary of what you changed and anything the user should check.',
      ].join('\n'),
    );
  } else if (mode === 'agent') {
    parts.push('No file or folder is open, so there is nothing to read or change. Answer the user directly, and suggest opening a folder (Open ▸ Open folder) to work on a project.');
  } else {
    parts.push('Answer the user’s questions about their code. Put code in fenced code blocks with the language name; the user can insert a block into the editor with one click. Be concise.');
    if (ws.folder) parts.push(`The user has the project folder "${ws.folder.name}" open.`);
  }
  if (ws.active && path) {
    const sel = ws.active.getSelection();
    parts.push(`The file on screen is ${path}${sel ? `; the cursor is on line ${sel.cursorLine}` : ''}.`);
    if (ws.active.kind === 'document') {
      parts.push(
        `${path} is a ${ws.active.format ?? 'Word-style document'} open in the document editor, not code: you see it as text, one line per paragraph. ` +
          (mode === 'agent'
            ? 'Change wording with edit_file (formatting around the change is kept; a newline starts a new paragraph). To restructure it, use write_file with the whole document in Markdown.'
            : 'When you suggest new text for it, give plain paragraphs rather than code blocks unless the user asks for code.'),
      );
    }
    if (mode === 'chat') {
      const { text, clipped } = clip(ws.active.getText(), budget);
      const fence = fenceFor(text);
      parts.push(`Its current content${clipped ? ' (the beginning; the rest was cut to fit)' : ''}:\n${fence}\n${text}\n${fence}`);
    }
  }
  return parts.join('\n\n');
}

function describeCall(call: AgentToolCall): string {
  let a: Record<string, unknown> = {};
  try {
    a = JSON.parse(call.function.arguments || '{}') as Record<string, unknown>;
  } catch {
    /* shown by name only */
  }
  const p = typeof a.path === 'string' && a.path ? a.path : '';
  switch (call.function.name) {
    case 'list_files':
      return `Listing ${p || 'the project'}…`;
    case 'read_file':
      return `Reading ${p}…`;
    case 'search_files':
      return `Searching for “${String(a.query ?? '')}”…`;
    case 'edit_file':
    case 'write_file':
      return `Preparing a change to ${p}…`;
    default:
      return `${call.function.name}…`;
  }
}

function modelLabel(m: AgentModel): string {
  const ctx = formatContext(m.contextLength);
  return `${m.id}${ctx ? ` · ${ctx}` : ''}${m.vision ? ' · sees images' : ''}`;
}

function modelTitle(m: AgentModel): string {
  const bits = [m.id];
  if (m.baseModel) bits.push(`Based on ${m.baseModel}`);
  if (m.contextLength) bits.push(`Context window: ${m.contextLength.toLocaleString()} tokens`);
  if (m.promptPrice !== undefined && m.completionPrice !== undefined) bits.push(`$${m.promptPrice} in / $${m.completionPrice} out per million tokens`);
  if (m.thinking) bits.push('Reasons before it answers (slower)');
  if (m.vision) bits.push('Can look at pictures you attach');
  return bits.join('\n');
}

// ── message text with code blocks ──────────────────────────────────────────
function inline(text: string, key: string): ReactNode[] {
  // `code` and **bold**; everything else is plain text (never HTML)
  const out: ReactNode[] = [];
  const re = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(re)) {
    if (m.index! > last) out.push(text.slice(last, m.index));
    const t = m[0];
    out.push(t.startsWith('`') ? <code key={`${key}-${n++}`}>{t.slice(1, -1)}</code> : <strong key={`${key}-${n++}`}>{t.slice(2, -2)}</strong>);
    last = m.index! + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function CodeBlock({ lang, code, onInsert }: { lang: string; code: string; onInsert: ((code: string) => void) | null }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="agent-code">
      <div className="agent-code-head">
        <span>{lang || 'code'}</span>
        <button
          type="button"
          onClick={() => {
            void navigator.clipboard?.writeText(code).then(() => {
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
          title="Copy"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? 'Copied' : 'Copy'}
        </button>
        {onInsert && (
          <button type="button" onClick={() => onInsert(code)} title="Replace the selection in the editor (or insert at the cursor)">
            <CornerDownLeft size={13} /> Insert
          </button>
        )}
      </div>
      <pre>
        <code>{code}</code>
      </pre>
    </div>
  );
}

const MessageText = memo(function MessageText({ text, onInsert }: { text: string; onInsert: ((code: string) => void) | null }) {
  const blocks: ReactNode[] = [];
  const re = /(^|\n)(`{3,})([^\n`]*)\n([\s\S]*?)(?:\n\2[ \t]*(?=\n|$)|$)/g;
  let last = 0;
  let k = 0;
  const prose = (t: string) => {
    for (const para of t.split(/\n{2,}/)) {
      if (!para.trim()) continue;
      const key = `p${k++}`;
      blocks.push(<p key={key}>{inline(para, key)}</p>);
    }
  };
  for (const m of text.matchAll(re)) {
    prose(text.slice(last, m.index! + m[1].length));
    blocks.push(<CodeBlock key={`c${k++}`} lang={m[3].trim()} code={m[4]} onInsert={onInsert} />);
    last = m.index! + m[0].length;
  }
  prose(text.slice(last));
  return <div className="agent-text">{blocks}</div>;
});

function DiffView({ diff }: { diff: Diff }) {
  const [all, setAll] = useState(false);
  const LIMIT = 400;
  const lines = all ? diff.lines : diff.lines.slice(0, LIMIT);
  return (
    <div className="agent-diff" role="region" aria-label="Proposed change">
      {lines.map((l, i) =>
        l.kind === 'gap' ? (
          <div key={i} className="agent-diff-gap">⋯</div>
        ) : (
          <div key={i} className={cx('agent-diff-line', `is-${l.kind}`)}>
            <span className="agent-diff-no">{l.kind === 'add' ? '' : l.a}</span>
            <span className="agent-diff-no">{l.kind === 'del' ? '' : l.b}</span>
            <span className="agent-diff-sign">{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
            <span className="agent-diff-text">{l.text || ' '}</span>
          </div>
        ),
      )}
      {!all && diff.lines.length > LIMIT && (
        <button type="button" className="agent-diff-more" onClick={() => setAll(true)}>
          Show all {diff.lines.length} lines
        </button>
      )}
    </div>
  );
}

function Thinking({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="agent-thinking">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />} {live ? 'Thinking…' : 'Thought process'}
      </button>
      {open && <pre>{text.length > 20_000 ? `…${text.slice(-20_000)}` : text}</pre>}
    </div>
  );
}

// ── usage meter ────────────────────────────────────────────────────────────
const fmtTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(n >= 10_000_000 ? 0 : 1)}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : String(Math.round(n)));

function untilReset(iso: string): string {
  const ms = Date.parse(iso) - Date.now();
  if (!Number.isFinite(ms) || ms <= 0) return 'soon';
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h ? `${h}h ${m}m` : `${m}m`;
}

/** Today's use against the license's daily limits; `live` adds the request streaming right now. */
function UsageMeter({ usage, live }: { usage: AgentUsageToday; live: number }) {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => tick((n) => n + 1), 30_000);
    return () => clearInterval(t);
  }, []);
  const requests = usage.requests;
  const tokens = usage.tokens + live;
  const share = Math.min(1, Math.max(requests / usage.dailyRequests, tokens / usage.dailyTokens));
  const full = share >= 1 || usage.paused;
  const level = full ? 'is-full' : share >= 0.8 ? 'is-warn' : '';
  const left = full
    ? usage.paused
      ? 'Paused by the service’s monthly limit until the 1st'
      : `Today’s limit reached · resets in ${untilReset(usage.resetsAt)}`
    : `${Math.round((1 - share) * 100)}% left today · resets in ${untilReset(usage.resetsAt)}`;
  return (
    <div
      className={cx('agent-usage', level)}
      role="meter"
      aria-label="Agent use today"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(share * 100)}
      title={`Today (UTC): ${requests.toLocaleString()} of ${usage.dailyRequests.toLocaleString()} requests and ${Math.round(tokens).toLocaleString()} of ${usage.dailyTokens.toLocaleString()} tokens${live ? ' (including the answer being written, estimated)' : ''}. Each step the agent takes is one request.`}
    >
      <div className="agent-usage-bar">
        <span style={{ width: `${Math.max(share * 100, share > 0 ? 2 : 0)}%` }} />
      </div>
      <div className="agent-usage-text">
        <span>
          {requests.toLocaleString()}/{usage.dailyRequests.toLocaleString()} requests · {fmtTokens(tokens)}/{fmtTokens(usage.dailyTokens)} tokens
        </span>
        <span className="agent-usage-left">{left}</span>
      </div>
    </div>
  );
}

// ── the panel ──────────────────────────────────────────────────────────────
export interface AgentPanelProps {
  hidden: boolean;
  onClose: () => void;
  /** the folder and the file on screen, read when a message is sent */
  getWorkspace: () => AgentWorkspace;
  /** what the panel shows as its context (changes re-render the chips) */
  context: { file: string | null; folder: string | null; code: boolean };
  /** bumps when the license may have changed (activated, revoked) */
  licenseVersion: number;
  onOpenLicense: () => void;
}

export function AgentPanel({ hidden, onClose, getWorkspace, context, licenseVersion, onOpenLicense }: AgentPanelProps) {
  const bridge = agentBridge();
  const [status, setStatus] = useState<AgentStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [models, setModels] = useState<AgentModel[] | null>(null);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [model, setModel] = useState<string>(() => load(STORE.model) ?? DEFAULT_AGENT_MODEL);
  const [mode, setMode] = useState<Mode>(() => (load(STORE.mode) === 'chat' ? 'chat' : 'agent'));
  const [autoApply, setAutoApply] = useState(() => load(STORE.auto) === '1');
  const [width, setWidth] = useState(() => Math.max(300, Math.min(900, Number(load(STORE.width)) || 400)));
  const [items, setItems] = useState<Item[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const history = useRef<AgentMessage[]>([]);
  /** files and pictures waiting to go with the next message */
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  /** this conversation in the saved sessions */
  const sessionMeta = useRef<{ id: string; createdAt: number }>({ id: uid('s'), createdAt: Date.now() });
  const [view, setView] = useState<'chat' | 'history'>('chat');
  const [picking, setPicking] = useState(false);
  /** the last answer's real prompt size against our estimate of it, to correct the context meter */
  const calibration = useRef(1);
  /** bumps on New session, so a turn still winding down can't write into the new one */
  const session = useRef(0);
  const run = useRef<{ cancelled: boolean; requestId: string | null } | null>(null);
  const approvals = useRef(new Map<string, (ok: boolean) => void>());
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  /** an item to scroll into view after the next render (a change waiting for approval) */
  const revealRef = useRef<string | null>(null);
  const [usage, setUsage] = useState<AgentUsageToday | null>(null);
  /** this moment's request, estimated while it streams */
  const [liveTokens, setLiveTokens] = useState(0);
  const autoApplyRef = useRef(autoApply);
  autoApplyRef.current = autoApply;

  const usable = !!status?.licensed;

  // ── license / service status, then the model list ──
  const refreshStatus = useCallback(async () => {
    if (!bridge) return;
    try {
      setStatus(await bridge.status());
      setStatusError(null);
    } catch {
      setStatusError('Could not check this computer’s license.');
    }
  }, [bridge]);

  useEffect(() => {
    if (!hidden) void refreshStatus();
  }, [hidden, licenseVersion, refreshStatus]);

  const loadModels = useCallback(
    async (force = false) => {
      if (!bridge) return;
      setModelsError(null);
      try {
        const res = await bridge.models(force);
        if (res.ok) {
          setModels(res.models);
          if (res.usage) setUsage(res.usage);
        }
        else {
          setModelsError(res.error);
          if (res.code === 'unlicensed') void refreshStatus();
        }
      } catch {
        setModelsError('Could not load the list of models.');
      }
    },
    [bridge, refreshStatus],
  );

  useEffect(() => {
    if (usable && !models) void loadModels();
  }, [usable, models, loadModels]);

  // the saved model may have gone from the list
  useEffect(() => {
    if (!models?.length || models.some((m) => m.id === model)) return;
    setModel(models.find((m) => m.id === DEFAULT_AGENT_MODEL)?.id ?? models[0].id);
  }, [models, model]);

  // a license that goes away stops a running session
  useEffect(() => {
    if (status && !status.licensed) stop();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  const chosen = models?.find((m) => m.id === model) ?? null;

  // ── items ──
  const add = (item: Item) => setItems((list) => [...list, item]);
  const patch = (id: string, change: Partial<Item>) => setItems((list) => list.map((i) => (i.id === id ? ({ ...i, ...change } as Item) : i)));

  useLayoutEffect(() => {
    const el = listRef.current;
    const reveal = revealRef.current;
    if (el && reveal) {
      const target = el.querySelector(`[data-item="${reveal}"]`);
      if (target) {
        revealRef.current = null;
        target.scrollIntoView({ block: 'nearest' });
        stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        return;
      }
    }
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  // ── usage meter: today's use against this license's limits ──
  const refreshUsage = useCallback(async () => {
    if (!bridge) return;
    const res = await bridge.usage().catch(() => null);
    if (res?.ok) setUsage(res.usage);
  }, [bridge]);
  useEffect(() => {
    if (hidden || !usable) return;
    void refreshUsage();
    const timer = window.setInterval(() => !run.current && void refreshUsage(), 60_000);
    return () => clearInterval(timer);
  }, [hidden, usable, refreshUsage]);

  const insertCode = useCallback(
    (code: string) => {
      const ed = getWorkspace().active;
      if (ed) ed.insert(code);
    },
    [getWorkspace],
  );

  // ── one session turn: ask, run the tools it calls, ask again… ──
  const send = async () => {
    const typed = draft.trim();
    if ((!typed && !attachments.length) || busy || !bridge || !usable || !model) return;
    const pictures = attachments.filter((a) => a.kind === 'image').length;
    if (pictures && chosen && !chosen.vision) {
      add({ kind: 'notice', id: uid('n'), text: `${chosen.id} can’t look at pictures. Pick a model marked “sees images”, or remove the pictures.`, error: true });
      return;
    }
    const text = typed || (pictures ? 'Look at the attached pictures.' : 'Look at the attached files.');
    const ws = getWorkspace();
    let content: AgentMessage['content'] = text;
    let note: string | undefined;
    const sel = ws.active?.getSelection();
    if (sel && !sel.empty && sel.text.trim()) {
      const path = activePath(ws) ?? ws.active!.name;
      const { text: picked } = clip(sel.text, 40_000);
      const fence = fenceFor(picked);
      content = `Selected in ${path} (lines ${sel.fromLine}–${sel.toLine}):\n${fence}\n${picked}\n${fence}\n\n${text}`;
      note = `With the selection in ${ws.active!.name} (lines ${sel.fromLine}–${sel.toLine})`;
    }
    const sent = attachments;
    // attached files go before the words (cut to what the model can take), pictures after them
    content = composeMessage(typeof content === 'string' ? content : text, sent, fileBudget(chosen?.contextLength ?? 0));
    setDraft('');
    setAttachments([]);
    stick.current = true;
    const hist = history.current;
    const mine = session.current;
    // after New session, this turn only finishes quietly
    const show = (item: Item) => {
      if (session.current === mine) add(item);
    };
    show({ kind: 'user', id: uid('u'), text, note, attachments: sent.length ? chipsOf(sent) : undefined });
    hist.push({ role: 'user', content });
    const me = { cancelled: false, requestId: null as string | null };
    run.current = me;
    setBusy(true);
    const ctx = chosen?.contextLength ?? 0;
    const budget = fileBudget(ctx);
    try {
      for (let step = 0; step < MAX_STEPS && !me.cancelled; step++) {
        const now = getWorkspace();
        const system = systemPrompt(mode, now, budget);
        const tools = mode === 'agent' && (now.folder || now.active) ? AGENT_TOOLS : undefined;
        // older pictures become a note: a request carries a few at most
        const { messages } = trimHistory(limitImages(hist, 4), historyBudget(ctx, OUTPUT_TOKENS) - system.length);
        const chatMessages: AgentMessage[] = [{ role: 'system', content: system }, ...messages];
        const promptTokens = Math.round(JSON.stringify(chatMessages).length / 4);
        /** One request, its answer streamed into a new assistant item. */
        const ask = async (extra: { frequencyPenalty?: number; temperature?: number } = {}) => {
          const aid = uid('a');
          show({ kind: 'assistant', id: aid, text: '', reasoning: '', streaming: true });
          const rid = uid('r');
          me.requestId = rid;
          // pieces of the answer as they arrive, shown once per frame
          const buf = { text: '', reasoning: '', tool: undefined as string | undefined };
          let frame = 0;
          const flush = () => {
            frame = 0;
            patch(aid, { text: buf.text, reasoning: buf.reasoning, tool: buf.tool } as Partial<Item>);
            // the usage meter counts this request as it goes (an estimate until the server's figure arrives)
            setLiveTokens(promptTokens + Math.round((buf.text.length + buf.reasoning.length) / 4));
          };
          const off = bridge.onDelta((id, d) => {
            if (id !== rid) return;
            if (d.content) buf.text += d.content;
            if (d.reasoning) buf.reasoning += d.reasoning;
            if (d.tool) buf.tool = d.tool;
            if (!frame) frame = requestAnimationFrame(flush);
          });
          setLiveTokens(promptTokens);
          try {
            const res = await bridge.chat(rid, { model, messages: chatMessages, tools, maxTokens: OUTPUT_TOKENS, ...extra });
            if (res.ok && res.today) setUsage(res.today);
            // how far off the context estimate was, so the meter shows real sizes
            if (res.ok && res.usage?.promptTokens) {
              const est = estimateTokens(system, messages);
              if (est > 0) calibration.current = Math.max(0.3, Math.min(3, res.usage.promptTokens / est));
            }
            else if (!res.ok) void refreshUsage();
            return { res, aid, buf };
          } finally {
            off();
            if (frame) cancelAnimationFrame(frame);
            me.requestId = null;
            setLiveTokens(0);
          }
        };
        let { res, aid, buf } = await ask();
        if (!res.ok && res.code === 'loop' && !me.cancelled) {
          // the model degenerated ("!!!!…" or the same line over and over): it was stopped at once;
          // try once more, discouraging repetition
          setItems((list) => list.filter((i) => i.id !== aid));
          show({ kind: 'notice', id: uid('n'), text: 'The model got stuck repeating itself, so it was stopped. Trying again…' });
          ({ res, aid, buf } = await ask({ frequencyPenalty: 0.6, temperature: 0.6 }));
          if (!res.ok && res.code === 'loop') {
            res = { ...res, error: 'The model got stuck repeating itself again. Pick another model (“thinking” variants loop more often), or rephrase the request.' };
          }
        }
        if (!res.ok) {
          setItems((list) => list.filter((i) => !(i.id === aid && i.kind === 'assistant' && !buf.text && !buf.reasoning)).map((i) => (i.id === aid ? ({ ...i, streaming: false } as Item) : i)));
          if (res.code !== 'cancelled') show({ kind: 'notice', id: uid('n'), text: res.error, error: true });
          if (res.code === 'unlicensed') void refreshStatus();
          if (res.code === 'loop') setItems((list) => list.filter((i) => i.id !== aid));
          break;
        }
        const { content: answer, reasoning, toolCalls } = res.message;
        const meta = [res.model && res.model !== model ? `answered by ${res.model}` : '', res.usage ? `${res.usage.promptTokens.toLocaleString()} → ${res.usage.completionTokens.toLocaleString()} tokens` : '']
          .filter(Boolean)
          .join(' · ');
        if (!answer.trim() && !reasoning && !toolCalls.length) {
          show({ kind: 'notice', id: uid('n'), text: res.finishReason === 'length' ? 'The answer was cut off (too long). Ask the model to continue, or to make smaller changes.' : 'The model sent an empty answer. Try again or pick another model.', error: true });
          setItems((list) => list.filter((i) => i.id !== aid));
          break;
        }
        patch(aid, { text: answer, reasoning, streaming: false, tool: undefined, meta } as Partial<Item>);
        if (!answer.trim() && !reasoning) setItems((list) => list.filter((i) => i.id !== aid));
        hist.push({ role: 'assistant', content: answer || null, ...(toolCalls.length ? { tool_calls: toolCalls } : {}) });
        if (!toolCalls.length) {
          if (res.finishReason === 'length') show({ kind: 'notice', id: uid('n'), text: 'The answer was cut off because it got too long. Send “continue” for the rest.' });
          break;
        }

        for (const call of toolCalls) {
          if (me.cancelled) {
            hist.push({ role: 'tool', tool_call_id: call.id, content: 'Stopped by the user before this ran.' });
            continue;
          }
          const tid = uid('t');
          show({ kind: 'tool', id: tid, label: describeCall(call), status: 'running' });
          let editId: string | null = null;
          let accepted = false;
          const { result, activity } = await runTool(call, {
            ws: getWorkspace,
            budget,
            confirm: (p: EditProposal) => {
              editId = uid('e');
              const auto = autoApplyRef.current;
              show({ kind: 'edit', id: editId, path: p.path, diff: p.diff, isNew: p.isNew, status: auto ? 'applied' : 'pending' });
              if (!auto && !me.cancelled) {
                // the turn waits for the user here: say so, and bring the change into view
                patch(tid, { label: `Waiting for you to apply or reject the ${p.isNew ? 'new file' : 'change to'} ${p.path}`, status: 'waiting' } as Partial<Item>);
                revealRef.current = editId;
              }
              if (auto || me.cancelled) {
                accepted = auto && !me.cancelled;
                return Promise.resolve(accepted);
              }
              const id = editId;
              return new Promise<boolean>((resolve) => {
                approvals.current.set(id, (ok) => {
                  approvals.current.delete(id);
                  accepted = ok;
                  resolve(ok);
                });
              });
            },
          });
          if (editId) patch(editId, { status: activity.error ? 'failed' : accepted ? 'applied' : 'rejected' } as Partial<Item>);
          patch(tid, { label: activity.label, status: activity.error ? 'error' : 'done' } as Partial<Item>);
          hist.push({ role: 'tool', tool_call_id: call.id, content: result });
        }
        if (step === MAX_STEPS - 1 && !me.cancelled) {
          show({ kind: 'notice', id: uid('n'), text: `Paused after ${MAX_STEPS} steps. Send “continue” to let the agent keep going.` });
        }
      }
    } catch (err) {
      show({ kind: 'notice', id: uid('n'), text: err instanceof Error ? err.message : 'Something went wrong.', error: true });
    } finally {
      if (run.current === me) run.current = null;
      setBusy(false);
      if (session.current === mine) void persist();
      setItems((list) => list.map((i) => (i.kind === 'assistant' && i.streaming ? { ...i, streaming: false } : i)));
    }
  };

  function stop() {
    const r = run.current;
    if (r) {
      r.cancelled = true;
      if (r.requestId) bridge?.cancel(r.requestId);
    }
    for (const resolve of [...approvals.current.values()]) resolve(false);
  }

  // ── saved sessions ──
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const persist = useCallback(async () => {
    const list = itemsRef.current;
    const first = list.find((i) => i.kind === 'user');
    if (!first || first.kind !== 'user') return;
    const meta: SessionMeta = {
      id: sessionMeta.current.id,
      title: sessionTitle(first.text),
      where: context.folder ?? context.file ?? '',
      model,
      mode,
      createdAt: sessionMeta.current.createdAt,
      updatedAt: Date.now(),
      turns: list.filter((i) => i.kind === 'user').length,
    };
    // a change still waiting for approval can't be applied after reopening
    const items = list.map((i) => (i.kind === 'edit' && i.status === 'pending' ? { ...i, status: 'rejected' as const } : i.kind === 'assistant' ? { ...i, streaming: false } : i));
    await saveSession(meta, { id: meta.id, items, history: history.current }).catch(() => undefined);
  }, [context.folder, context.file, model, mode]);

  const newSession = () => {
    stop();
    void persist();
    session.current++;
    sessionMeta.current = { id: uid('s'), createdAt: Date.now() };
    history.current = [];
    calibration.current = 1;
    setItems([]);
    setAttachments([]);
    setView('chat');
  };

  const openSession = async (meta: SessionMeta) => {
    if (busy) return;
    const data = await loadSession<Item>(meta.id).catch(() => null);
    if (!data) return add({ kind: 'notice', id: uid('n'), text: 'That session couldn’t be opened.', error: true });
    void persist();
    session.current++;
    sessionMeta.current = { id: meta.id, createdAt: meta.createdAt };
    history.current = data.history;
    calibration.current = 1;
    setItems([...data.items, { kind: 'notice', id: uid('n'), text: `Reopened “${meta.title}”. The agent continues with the files open now${meta.where ? ` (it worked on ${meta.where})` : ''}.` }]);
    setAttachments([]);
    if (models?.some((m) => m.id === meta.model)) setModel(meta.model);
    setMode(meta.mode);
    stick.current = true;
    setView('chat');
  };

  const decide = (id: string, ok: boolean) => approvals.current.get(id)?.(ok);

  // ── attachments ──
  const attachFailed = (err: unknown) => add({ kind: 'notice', id: uid('n'), text: err instanceof Error ? err.message : 'That couldn’t be added.', error: true });
  const addFiles = async (files: File[]) => {
    for (const f of files.slice(0, 10)) {
      try {
        const a = await attachmentFromFile(f);
        setAttachments((list) => [...list, a]);
      } catch (err) {
        attachFailed(err);
      }
    }
  };
  const attachScreenFile = () => {
    const ws = getWorkspace();
    if (!ws.active) return;
    const path = activePath(ws) ?? ws.active.name;
    setAttachments((list) => [...list.filter((a) => a.where !== path), fileAttachment(ws.active!.name, ws.active!.getText(), path)]);
  };
  const attachFolderFile = async (path: string) => {
    const got = await readForContext(getWorkspace(), path);
    if ('error' in got) return attachFailed(new Error(got.error));
    const leaf = got.path.split('/').pop() ?? got.path;
    try {
      const a = 'image' in got ? await imageAttachment(got.image, leaf, got.path) : fileAttachment(leaf, got.text, got.path);
      setAttachments((list) => [...list.filter((x) => x.where !== got.path), a]);
    } catch (err) {
      attachFailed(err);
    }
  };
  const fileInput = useRef<HTMLInputElement>(null);

  // ── context window: how much of the model's context this conversation takes ──
  const contextInfo = useMemo(() => {
    const total = chosen?.contextLength ?? 0;
    if (!total || !usable) return null;
    const budget = fileBudget(total);
    const system = systemPrompt(mode, getWorkspace(), budget);
    const next: AgentMessage[] = attachments.length ? [{ role: 'user', content: composeMessage('', attachments, budget) }] : [];
    const { messages, dropped } = trimHistory(limitImages([...history.current, ...next], 4), historyBudget(total, OUTPUT_TOKENS) - system.length);
    return { used: Math.round(estimateTokens(system, messages) * calibration.current), total, dropped: dropped > 0 };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, attachments, chosen, mode, context, usable, busy]);

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void send();
    }
    // keep app shortcuts (Ctrl+O, Ctrl+W…) from firing while typing here
    e.stopPropagation();
  };

  // ── resizing from the left edge ──
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    const startX = e.clientX;
    const startW = width;
    let w = startW;
    const move = (ev: PointerEvent) => {
      w = Math.max(300, Math.min(Math.min(900, window.innerWidth - 320), startW + (startX - ev.clientX)));
      setWidth(w);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      save(STORE.width, String(Math.round(w)));
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const modelOptions = useMemo(() => {
    if (!models) return null;
    const rec = models.find((m) => m.id === DEFAULT_AGENT_MODEL);
    const rest = models.filter((m) => m !== rec);
    return (
      <>
        {rec && (
          <optgroup label="Recommended">
            <option value={rec.id} title={modelTitle(rec)}>{modelLabel(rec)}</option>
          </optgroup>
        )}
        <optgroup label="All models">
          {rest.map((m) => (
            <option key={m.id} value={m.id} title={modelTitle(m)}>
              {modelLabel(m)}
            </option>
          ))}
        </optgroup>
      </>
    );
  }, [models]);

  const hasWork = !!(context.folder || context.code);
  const pendingEdits = items.filter((i): i is Extract<Item, { kind: 'edit' }> => i.kind === 'edit' && i.status === 'pending');
  const pending = pendingEdits[0] ?? null;
  const pendingCount = pendingEdits.length;

  // ── what is shown ──
  let body: ReactNode;
  if (!bridge) {
    body = (
      <div className="agent-gate">
        <Lock size={28} />
        <h3>Desktop app only</h3>
        <p>The coding agent is part of licensed copies of the File Editor desktop app.</p>
      </div>
    );
  } else if (!status) {
    body = (
      <div className="agent-gate">
        {statusError ? (
          <>
            <AlertTriangle size={28} />
            <p>{statusError}</p>
            <button type="button" className="btn btn-primary btn-sm" onClick={() => void refreshStatus()}>Try again</button>
          </>
        ) : (
          <p><span className="spinner" /> Checking your license…</p>
        )}
      </div>
    );
  } else if (!status.licensed) {
    body = (
      <div className="agent-gate">
        <Lock size={28} />
        <h3>A license unlocks the coding agent</h3>
        <p>
          With a File Editor license, an AI agent works alongside you in the code editor and in opened folders: it reads your project, answers
          questions and proposes changes you can apply with one click. Pick the model you like from more than 60.
        </p>
        <div className="agent-gate-actions">
          <button type="button" className="btn btn-primary btn-sm" onClick={onOpenLicense}>
            <KeyRound size={14} /> Enter license key…
          </button>
          <a className="btn btn-sm" href={status.purchaseUrl} target="_blank" rel="noopener noreferrer">Purchase a license</a>
        </div>
      </div>
    );
  } else {
    body = (
      <>
        <div className="agent-messages" ref={listRef} onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}>
          {items.length === 0 && (
            <div className="agent-empty">
              <Sparkles size={26} />
              <p>
                {mode === 'agent'
                  ? hasWork
                    ? `Ask the agent to explain, fix or change ${context.folder ? `the files in ${context.folder}` : context.file}. It reads what it needs and shows each change for you to apply.`
                    : 'Open a folder (Open ▸ Open folder), a code file or a document, then ask the agent to work on it.'
                  : 'Ask about the file on screen. Select text first to ask about just that.'}
              </p>
            </div>
          )}
          {items.map((it) => {
            switch (it.kind) {
              case 'user':
                return (
                  <div key={it.id} className="agent-msg agent-user">
                    {it.note && <div className="agent-user-note">{it.note}</div>}
                    {it.attachments && <AttachmentChips chips={it.attachments} />}
                    <div className="agent-user-text">{it.text}</div>
                  </div>
                );
              case 'assistant':
                return (
                  <div key={it.id} className="agent-msg agent-assistant">
                    {it.reasoning && <Thinking text={it.reasoning} live={it.streaming && !it.text} />}
                    {it.text ? <MessageText text={it.text} onInsert={context.code ? insertCode : null} /> : it.streaming && !it.reasoning && <div className="agent-typing"><span /><span /><span /></div>}
                    {it.streaming && it.tool && <div className="agent-tool-hint"><Wrench size={12} /> {it.tool.replace(/_/g, ' ')}…</div>}
                    {it.meta && <div className="agent-meta">{it.meta}</div>}
                  </div>
                );
              case 'tool':
                return (
                  <div key={it.id} className={cx('agent-tool', `is-${it.status}`)}>
                    {it.status === 'running' ? <span className="spinner" /> : it.status === 'waiting' ? <Hand size={13} /> : it.status === 'error' ? <AlertTriangle size={13} /> : <Check size={13} />}
                    <span>{it.label}</span>
                  </div>
                );
              case 'edit':
                return (
                  <div key={it.id} data-item={it.id} className={cx('agent-edit', `is-${it.status}`)}>
                    <div className="agent-edit-head">
                      <FileCode size={14} />
                      <span className="agent-edit-path" title={it.path}>{it.path}</span>
                      <span className="agent-edit-stat">
                        {it.isNew ? 'new file · ' : ''}
                        <span className="is-add">+{it.diff.added}</span> <span className="is-del">−{it.diff.removed}</span>
                      </span>
                    </div>
                    <DiffView diff={it.diff} />
                    <div className="agent-edit-foot">
                      {it.status === 'pending' ? (
                        <>
                          <button type="button" className="btn btn-primary btn-sm" onClick={() => decide(it.id, true)}><Check size={14} /> Apply</button>
                          <button type="button" className="btn btn-sm" onClick={() => decide(it.id, false)}><X size={14} /> Reject</button>
                        </>
                      ) : (
                        <span className="agent-edit-status">
                          {it.status === 'applied' ? 'Applied' : it.status === 'rejected' ? 'Rejected' : 'Could not be applied'}
                        </span>
                      )}
                    </div>
                  </div>
                );
              case 'notice':
                return (
                  <div key={it.id} className={cx('agent-notice', it.error && 'is-error')} role={it.error ? 'alert' : 'status'}>
                    {it.error && <AlertTriangle size={14} />}
                    <span>{it.text}</span>
                  </div>
                );
            }
          })}
        </div>
        <div
          className="agent-composer"
          onDragOver={(e) => {
            if (e.dataTransfer.types.includes('Files')) {
              e.preventDefault();
              e.stopPropagation();
            }
          }}
          onDrop={(e) => {
            if (!e.dataTransfer.files.length) return;
            // files dropped here go to the agent, not open in a tab
            e.preventDefault();
            e.stopPropagation();
            void addFiles(Array.from(e.dataTransfer.files));
          }}
        >
          {pending && (
            <div className="agent-pending" role="alert">
              <Hand size={14} />
              <span>
                {pendingCount > 1 ? `${pendingCount} changes are` : 'A change is'} waiting for you: <strong>{pending.path}</strong>
              </span>
              <button type="button" className="btn btn-text btn-sm" onClick={() => listRef.current?.querySelector(`[data-item="${pending.id}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })}>
                Show
              </button>
              <button type="button" className="btn btn-primary btn-sm" onClick={() => decide(pending.id, true)}>
                Apply
              </button>
              <button type="button" className="btn btn-sm agent-stop" onClick={() => decide(pending.id, false)}>
                Reject
              </button>
            </div>
          )}
          <div className="agent-context">
            {context.folder && <span className="agent-chip" title="The agent can read and change this folder’s files"><FolderOpen size={12} /> {context.folder}</span>}
            {context.file && <span className="agent-chip" title="The file on screen"><FileCode size={12} /> {context.file}</span>}
            {!context.folder && !context.file && <span className="agent-chip is-muted">No file open</span>}
          </div>
          {attachments.length > 0 && (
            <div className="agent-attachments">
              {attachments.map((a) => (
                <span key={a.id} className={cx('agent-attachment', a.kind === 'image' && 'is-image')} title={a.where ?? a.name}>
                  {a.thumb ? <img src={a.thumb} alt="" /> : <FileCode size={12} />}
                  <span className="agent-attachment-name">{a.kind === 'file' && a.where && a.where !== 'from this computer' ? a.where : a.name}</span>
                  <button type="button" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((list) => list.filter((x) => x.id !== a.id))}>
                    <X size={11} />
                  </button>
                </span>
              ))}
              {attachments.some((a) => a.kind === 'image') && chosen && !chosen.vision && (
                <span className="agent-attachment-warn"><AlertTriangle size={12} /> {chosen.id} can’t see pictures: pick a model marked “sees images”.</span>
              )}
            </div>
          )}
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            onPaste={(e) => {
              // pasted screenshots and copied files become attachments
              const files = Array.from(e.clipboardData.files);
              if (!files.length) return;
              e.preventDefault();
              void addFiles(files);
            }}
            placeholder={mode === 'agent' ? 'Ask the agent to change something…' : 'Ask about your code…'}
            rows={3}
            aria-label="Message to the agent"
            disabled={!models}
          />
          <div className="agent-composer-row">
            <Popover label="Add files or pictures" align="left" button={<Paperclip size={15} />} disabled={busy}>
              {(close) => (
                <div className="format-menu" role="menu" aria-label="Add to the message">
                  <MenuItem disabled={!context.file} hint={context.file ?? undefined} onClick={() => (close(), attachScreenFile())}>
                    The file on screen
                  </MenuItem>
                  <MenuItem disabled={!context.folder} onClick={() => (close(), setPicking(true))}>
                    A file from {context.folder ?? 'the folder'}…
                  </MenuItem>
                  <MenuItem onClick={() => (close(), fileInput.current?.click())}>From this computer… (files, photos, screenshots)</MenuItem>
                  <div className="menu-empty">Paste a screenshot (Ctrl+V) or drop files here too.</div>
                </div>
              )}
            </Popover>
            <input
              ref={fileInput}
              type="file"
              multiple
              hidden
              onChange={(e) => {
                void addFiles(Array.from(e.target.files ?? []));
                e.target.value = '';
              }}
            />
            <label className="agent-auto" title="Agent mode: apply the agent’s changes as soon as it makes them, without a review step">
              <input
                type="checkbox"
                checked={autoApply}
                onChange={(e) => {
                  setAutoApply(e.target.checked);
                  save(STORE.auto, e.target.checked ? '1' : '0');
                }}
              />
              Apply changes without asking
            </label>
            {busy ? (
              <button type="button" className="btn btn-sm agent-stop" onClick={stop}><Square size={13} /> Stop</button>
            ) : (
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void send()} disabled={(!draft.trim() && !attachments.length) || !models}>
                <Send size={14} /> Send
              </button>
            )}
          </div>
          <p className="agent-privacy">Your messages, and the files the agent reads, go through File Editor’s license server to OpenUncensored to be answered. They aren’t stored.</p>
        </div>
      </>
    );
  }

  return (
    <aside className="agent-panel" hidden={hidden} aria-label="Coding agent" style={{ width }}>
      <div className="agent-resize" onPointerDown={startResize} aria-hidden="true" />
      <div className="agent-head">
        <Bot size={16} />
        <span className="agent-title">Agent</span>
        {usable && (
          <div className="agent-mode" role="radiogroup" aria-label="Mode">
            {(['agent', 'chat'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="radio"
                aria-checked={mode === m}
                className={cx(mode === m && 'is-active')}
                title={m === 'agent' ? 'The agent reads your files and proposes changes' : 'Ask about the code on screen'}
                onClick={() => {
                  setMode(m);
                  save(STORE.mode, m);
                }}
                disabled={busy}
              >
                {m === 'agent' ? 'Agent' : 'Chat'}
              </button>
            ))}
          </div>
        )}
        <span className="spacer" />
        {usable && (
          <button type="button" className={cx('agent-icon', view === 'history' && 'is-on')} title="Earlier sessions" aria-label="Earlier sessions" aria-pressed={view === 'history'} onClick={() => setView((v) => (v === 'history' ? 'chat' : 'history'))}>
            <HistoryIcon size={15} />
          </button>
        )}
        {usable && (
          <button type="button" className="agent-icon" title="New session" aria-label="New session" onClick={newSession}><SquarePen size={15} /></button>
        )}
        <button type="button" className="agent-icon" title="Close the agent (the session is kept)" aria-label="Close the agent" onClick={onClose}><X size={15} /></button>
      </div>
      {usable && (
        <div className="agent-model">
          {models ? (
            <select
              value={model}
              onChange={(e) => {
                setModel(e.target.value);
                save(STORE.model, e.target.value);
              }}
              aria-label="Model"
              title={chosen ? modelTitle(chosen) : 'Model'}
              disabled={busy}
            >
              {modelOptions}
            </select>
          ) : modelsError ? (
            <span className="agent-model-error"><AlertTriangle size={13} /> {modelsError}</span>
          ) : (
            <span className="agent-model-wait"><span className="spinner" /> Loading models…</span>
          )}
          <button type="button" className="agent-icon" title="Reload the list of models" aria-label="Reload the list of models" onClick={() => void loadModels(true)} disabled={busy}>
            <RefreshCw size={14} />
          </button>
        </div>
      )}
      {usable && (usage || contextInfo) && (
        <div className="agent-meters">
          {usage ? <UsageMeter usage={usage} live={liveTokens} /> : <span className="spacer" />}
          {contextInfo && <ContextRing used={contextInfo.used + (busy ? 0 : Math.round(draft.length / 3.2))} total={contextInfo.total} dropped={contextInfo.dropped} />}
        </div>
      )}
      {usable && view === 'history' ? (
        <SessionHistory currentId={sessionMeta.current.id} busy={busy} onOpen={(m) => void openSession(m)} onNew={newSession} onBack={() => setView('chat')} />
      ) : (
        body
      )}
      {picking && (
        <FilePicker
          getWorkspace={getWorkspace}
          onPick={(path) => {
            setPicking(false);
            void attachFolderFile(path);
          }}
          onClose={() => setPicking(false)}
        />
      )}
    </aside>
  );
}
