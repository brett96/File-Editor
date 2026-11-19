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
import { fileBudget, historyBudget, trimHistory } from '../../core/agent/context';
import { clip, type Diff } from '../../core/agent/edits';
import {
  DEFAULT_AGENT_MODEL,
  formatContext,
  type AgentMessage,
  type AgentModel,
  type AgentStatus,
  type AgentToolCall,
} from '../../core/agent/protocol';
import { agentBridge } from '../../platform/host';
import { cx } from '../components';
import { AGENT_TOOLS, runTool, type AgentWorkspace, type EditProposal } from './tools';

type Mode = 'agent' | 'chat';

type Item =
  | { kind: 'user'; id: string; text: string; note?: string }
  | { kind: 'assistant'; id: string; text: string; reasoning: string; streaming: boolean; tool?: string; meta?: string }
  | { kind: 'tool'; id: string; label: string; status: 'running' | 'done' | 'error' }
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
  return `${m.id}${ctx ? ` · ${ctx}` : ''}`;
}

function modelTitle(m: AgentModel): string {
  const bits = [m.id];
  if (m.baseModel) bits.push(`Based on ${m.baseModel}`);
  if (m.contextLength) bits.push(`Context window: ${m.contextLength.toLocaleString()} tokens`);
  if (m.promptPrice !== undefined && m.completionPrice !== undefined) bits.push(`$${m.promptPrice} in / $${m.completionPrice} out per million tokens`);
  if (m.thinking) bits.push('Reasons before it answers (slower)');
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
      {open && <pre>{text}</pre>}
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
  /** bumps on New session, so a turn still winding down can't write into the new one */
  const session = useRef(0);
  const run = useRef<{ cancelled: boolean; requestId: string | null } | null>(null);
  const approvals = useRef(new Map<string, (ok: boolean) => void>());
  const listRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
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
        if (res.ok) setModels(res.models);
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
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [items]);

  const insertCode = useCallback(
    (code: string) => {
      const ed = getWorkspace().active;
      if (ed) ed.insert(code);
    },
    [getWorkspace],
  );

  // ── one session turn: ask, run the tools it calls, ask again… ──
  const send = async () => {
    const text = draft.trim();
    if (!text || busy || !bridge || !usable || !model) return;
    const ws = getWorkspace();
    let content = text;
    let note: string | undefined;
    const sel = ws.active?.getSelection();
    if (sel && !sel.empty && sel.text.trim()) {
      const path = activePath(ws) ?? ws.active!.name;
      const { text: picked } = clip(sel.text, 40_000);
      const fence = fenceFor(picked);
      content = `Selected in ${path} (lines ${sel.fromLine}–${sel.toLine}):\n${fence}\n${picked}\n${fence}\n\n${text}`;
      note = `With the selection in ${ws.active!.name} (lines ${sel.fromLine}–${sel.toLine})`;
    }
    setDraft('');
    stick.current = true;
    const hist = history.current;
    const mine = session.current;
    // after New session, this turn only finishes quietly
    const show = (item: Item) => {
      if (session.current === mine) add(item);
    };
    show({ kind: 'user', id: uid('u'), text, note });
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
        const { messages } = trimHistory(hist, historyBudget(ctx, OUTPUT_TOKENS) - system.length);
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
        };
        const off = bridge.onDelta((id, d) => {
          if (id !== rid) return;
          if (d.content) buf.text += d.content;
          if (d.reasoning) buf.reasoning += d.reasoning;
          if (d.tool) buf.tool = d.tool;
          if (!frame) frame = requestAnimationFrame(flush);
        });
        let res;
        try {
          res = await bridge.chat(rid, { model, messages: [{ role: 'system', content: system }, ...messages], tools, maxTokens: OUTPUT_TOKENS });
        } finally {
          off();
          if (frame) cancelAnimationFrame(frame);
          me.requestId = null;
        }
        if (!res.ok) {
          setItems((list) => list.filter((i) => !(i.id === aid && i.kind === 'assistant' && !buf.text && !buf.reasoning)).map((i) => (i.id === aid ? ({ ...i, streaming: false } as Item) : i)));
          if (res.code !== 'cancelled') show({ kind: 'notice', id: uid('n'), text: res.error, error: true });
          if (res.code === 'unlicensed') void refreshStatus();
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

  const newSession = () => {
    stop();
    session.current++;
    history.current = [];
    setItems([]);
  };

  const decide = (id: string, ok: boolean) => approvals.current.get(id)?.(ok);

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
                    : 'Open a folder (Open ▸ Open folder) or a code file, then ask the agent to work on it.'
                  : 'Ask about the code on screen. Select lines first to ask about just those.'}
              </p>
            </div>
          )}
          {items.map((it) => {
            switch (it.kind) {
              case 'user':
                return (
                  <div key={it.id} className="agent-msg agent-user">
                    {it.note && <div className="agent-user-note">{it.note}</div>}
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
                    {it.status === 'running' ? <span className="spinner" /> : it.status === 'error' ? <AlertTriangle size={13} /> : <Check size={13} />}
                    <span>{it.label}</span>
                  </div>
                );
              case 'edit':
                return (
                  <div key={it.id} className={cx('agent-edit', `is-${it.status}`)}>
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
        <div className="agent-composer">
          <div className="agent-context">
            {context.folder && <span className="agent-chip" title="The agent can read and change this folder’s files"><FolderOpen size={12} /> {context.folder}</span>}
            {context.file && <span className="agent-chip" title="The file on screen"><FileCode size={12} /> {context.file}</span>}
            {!context.folder && !context.file && <span className="agent-chip is-muted">No file open</span>}
          </div>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKey}
            placeholder={mode === 'agent' ? 'Ask the agent to change something…' : 'Ask about your code…'}
            rows={3}
            aria-label="Message to the agent"
            disabled={!models}
          />
          <div className="agent-composer-row">
            <label className="agent-auto" title="Apply the agent’s changes as soon as it makes them, without a review step">
              <input
                type="checkbox"
                checked={autoApply}
                disabled={mode !== 'agent'}
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
              <button type="button" className="btn btn-primary btn-sm" onClick={() => void send()} disabled={!draft.trim() || !models}>
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
      {body}
    </aside>
  );
}
