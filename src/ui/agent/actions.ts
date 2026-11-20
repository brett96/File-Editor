/**
 * The agent's tools beyond reading and editing: deleting and renaming files, running commands,
 * and the web. Each needs its capability turned on in the panel's permissions, and asks the
 * user first unless they said not to (src/core/agent/permissions.ts). Commands and the web are
 * the desktop app's (electron/agent-actions.ts).
 */
import { clip } from '../../core/agent/edits';
import { type AgentPermissions, type Capability } from '../../core/agent/permissions';
import type { AgentToolSpec } from '../../core/agent/protocol';
import { capOutput } from '../../core/agent/web';
import { dirOf, isSafeName, leafOf, safeSegments } from '../../core/web/paths';
import type { DesktopBridge } from '../../platform/host';
import type { AgentWorkspace, ToolActivity } from './tools';

export interface PermissionRequest {
  capability: Capability;
  /** what is about to happen, e.g. "Delete src/old.ts" */
  title: string;
  /** a command or an address, shown in monospace */
  code?: string;
  detail?: string;
}

/** The desktop bridge's commands and web access. */
export type AgentActions = Pick<NonNullable<DesktopBridge['agent']>, 'run' | 'cancelRun' | 'onRunOutput' | 'webSearch' | 'fetchUrl'>;

export interface ActionHost {
  permit(req: PermissionRequest): Promise<boolean>;
  actions?: AgentActions | null;
  /** a running command's output as it arrives */
  onOutput?(chunk: string): void;
  /** called with a function that stops the running command (Stop in the panel) */
  onCancel?(stop: (() => void) | null): void;
  /** characters of a result the model can take */
  budget: number;
  platform?: string;
}

const FILE_TOOLS: AgentToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or folder of the project (a folder with everything in it). In the desktop app it goes to the recycle bin / Trash. The user may be asked first.',
      parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path relative to the project root.' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'rename_file',
      description: 'Rename or move a file, or rename a folder in place. new_path is the full new path relative to the project root; missing folders are created. The user may be asked first.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Current path.' }, new_path: { type: 'string', description: 'New path.' } },
        required: ['path', 'new_path'],
      },
    },
  },
];

function commandTool(platform?: string): AgentToolSpec {
  const shell = platform === 'win32' ? 'cmd.exe (Windows)' : platform === 'darwin' ? 'the user’s shell (macOS)' : 'the user’s shell (Linux)';
  return {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        `Run a shell command in the project folder, in ${shell}, and get its output and exit code. Use it to build, run tests, lint or inspect the project. ` +
        'It is not interactive (no input; CI=1 is set): pass flags that avoid prompts and watch modes. Long output is cut in the middle. The user may be asked first, and may refuse.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'The command line.' },
          cwd: { type: 'string', description: 'Folder to run it in, relative to the project root. Default: the root.' },
          timeout_seconds: { type: 'integer', description: 'Stop it after this long (1–900). Default 120.' },
        },
        required: ['command'],
      },
    },
  };
}

const WEB_TOOLS: AgentToolSpec[] = [
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web. Returns titles, addresses and snippets of the top results; read one with fetch_url.',
      parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'fetch_url',
      description: 'Read a public web page (or a text / JSON file on the web) as text. Long pages can be read on with start_char.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string', description: 'An http or https address.' }, start_char: { type: 'integer', description: 'Where to start reading (from a previous answer).' } },
        required: ['url'],
      },
    },
  },
];

/** What can be offered right now: the capability is on and this copy / folder can do it. */
export function availableCapabilities(ws: AgentWorkspace, actions: AgentActions | null | undefined, mode: 'agent' | 'chat'): Record<Capability, boolean> {
  return {
    files: mode === 'agent' && !!ws.folder?.canWrite,
    commands: mode === 'agent' && !!ws.folder?.desktopId && !!actions?.run,
    web: !!actions?.webSearch && !!actions.fetchUrl,
  };
}

/** The extra tools to send with a request. */
export function extraTools(perms: AgentPermissions, can: Record<Capability, boolean>, platform?: string): AgentToolSpec[] {
  const out: AgentToolSpec[] = [];
  if (can.files && perms.files !== 'off') out.push(...FILE_TOOLS);
  if (can.commands && perms.commands !== 'off') out.push(commandTool(platform));
  if (can.web && perms.web !== 'off') out.push(...WEB_TOOLS);
  return out;
}

/** A line for the system prompt on what the agent may do beyond files (and what it can't). */
export function capabilityNote(perms: AgentPermissions, can: Record<Capability, boolean>, mode: 'agent' | 'chat' = 'agent'): string {
  const yes: string[] = [];
  const no: string[] = [];
  const say = (c: Capability, on: string, off: string) => {
    if (can[c] && perms[c] !== 'off') yes.push(on);
    else if (mode === 'agent' || c === 'web') no.push(off);
  };
  say('files', 'delete and rename files (delete_file, rename_file)', 'delete or rename files');
  say('commands', 'run commands and tests (run_command)', 'run commands or tests');
  say('web', 'search the web and read pages (web_search, fetch_url)', 'go online');
  const asks = (['files', 'commands', 'web'] as const).some((c) => can[c] && (perms[c] === 'ask' || perms[c] === 'session'));
  return [
    yes.length ? `You can also ${yes.join('; ')}.${asks ? ' The user may be asked to allow these first; if they refuse, don’t try again the same way: continue without it or ask them.' : ''}` : '',
    no.length ? `You cannot ${no.join(', ')} (the user can turn these on in the agent’s permissions).` : '',
  ]
    .filter(Boolean)
    .join(' ');
}

const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
const clean = (raw: unknown) => str(raw).trim().replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '').replace(/\/+$/, '');
const refused = (label: string, what: string) => ({ result: `The user did not allow this (${what}). Don’t try it again the same way: continue without it, or ask the user.`, activity: { label: `Not allowed: ${label}`, error: true } });
const failed = (label: string, msg: string) => ({ result: `Error: ${msg}`, activity: { label, error: true } });

async function entryKind(ws: AgentWorkspace, path: string): Promise<'file' | 'dir' | null> {
  const list = await ws.folder!.list(dirOf(path)).catch(() => []);
  return list.find((e) => e.path === path)?.kind ?? null;
}

async function deleteFile(ws: AgentWorkspace, host: ActionHost, raw: unknown) {
  const path = clean(raw);
  const label = `Delete ${path || 'file'}`;
  const folder = ws.folder;
  if (!folder) return failed(label, 'No folder is open.');
  if (!path || !safeSegments(path)) return failed(label, `"${str(raw)}" is not a path inside the project.`);
  const kind = await entryKind(ws, path);
  if (!kind) return failed(label, `${path} does not exist.`);
  const what = kind === 'dir' ? `the folder ${path} and everything in it` : path;
  const ok = await host.permit({ capability: 'files', title: kind === 'dir' ? `Delete the folder ${path} and everything in it` : `Delete ${path}`, detail: folder.removesToTrash ? 'It goes to the recycle bin / Trash.' : 'This can’t be undone.' });
  if (!ok) return refused(label, `deleting ${what}`);
  await folder.remove(path);
  ws.folderChanged(dirOf(path));
  const open = ws.editorFor(path) || ws.openElsewhere(path);
  return { result: `Deleted ${what}${folder.removesToTrash ? ' (moved to the recycle bin / Trash)' : ''}.${open ? ' It is still open in a tab, unsaved.' : ''}`, activity: { label: `Deleted ${path}` } };
}

async function renameFile(ws: AgentWorkspace, host: ActionHost, rawFrom: unknown, rawTo: unknown) {
  const from = clean(rawFrom);
  const to = clean(rawTo);
  const label = `Rename ${from || 'file'}`;
  const folder = ws.folder;
  if (!folder) return failed(label, 'No folder is open.');
  if (!from || !safeSegments(from) || !to || !safeSegments(to)) return failed(label, 'Give both paths relative to the project root.');
  if (from === to) return failed(label, 'The new path is the same as the old one.');
  if (!isSafeName(leafOf(to))) return failed(label, `"${leafOf(to)}" can’t be used as a name.`);
  const kind = await entryKind(ws, from);
  if (!kind) return failed(label, `${from} does not exist.`);
  if (await entryKind(ws, to)) return failed(label, `${to} already exists.`);
  const move = dirOf(from) !== dirOf(to);
  if (move && kind === 'dir') return failed(label, 'Folders can only be renamed in place (same parent folder). Move the files one by one instead.');
  if (move && (to + '/').startsWith(from + '/')) return failed(label, 'A folder can’t be moved into itself.');
  const ok = await host.permit({ capability: 'files', title: move ? `Move ${from} to ${to}` : `Rename ${from} to ${leafOf(to)}` });
  if (!ok) return refused(label, `renaming ${from}`);
  if (!move) {
    await folder.rename(from, leafOf(to));
  } else {
    const blob = await folder.read(from);
    if (!blob) return failed(label, `${from} couldn’t be read.`);
    const dirs: string[] = [];
    for (let d = dirOf(to); d; d = dirOf(d)) dirs.unshift(d);
    for (const d of dirs) await folder.createDir(d).catch(() => undefined);
    await folder.createFile(to, new Uint8Array(await blob.arrayBuffer()));
    await folder.remove(from);
  }
  ws.renamed?.(from, to);
  ws.folderChanged(dirOf(from));
  if (move) ws.folderChanged(dirOf(to));
  return { result: `${move ? 'Moved' : 'Renamed'} ${from} to ${to}.`, activity: { label: `${move ? 'Moved' : 'Renamed'} ${from} → ${to}` } };
}

const seconds = (ms: number) => (ms < 10_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 1000)} s`);

async function runCommand(ws: AgentWorkspace, host: ActionHost, rawCommand: unknown, rawCwd: unknown, rawTimeout: unknown) {
  const command = str(rawCommand).trim();
  const short = command.length > 60 ? `${command.slice(0, 57)}…` : command;
  const label = `Run ${short || 'command'}`;
  const folder = ws.folder;
  if (!folder?.desktopId || !host.actions?.run) return failed(label, 'Commands can only be run in a folder opened in the desktop app.');
  if (!command) return failed(label, 'The command is empty.');
  const cwd = clean(rawCwd);
  if (cwd && !safeSegments(cwd)) return failed(label, `"${str(rawCwd)}" is not a folder inside the project.`);
  const ok = await host.permit({ capability: 'commands', title: `Run a command in ${cwd ? `${folder.name}/${cwd}` : folder.name}`, code: command });
  if (!ok) return refused(label, `running “${short}”`);
  const opId = `run${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  const off = host.actions.onRunOutput?.((id, chunk) => {
    if (id === opId) host.onOutput?.(chunk);
  });
  host.onCancel?.(() => host.actions?.cancelRun?.(opId));
  try {
    const timeout = Number(rawTimeout);
    const res = await host.actions.run(opId, { folderId: folder.desktopId, command, cwd, ...(Number.isFinite(timeout) && timeout > 0 ? { timeoutSeconds: timeout } : {}) });
    if (!res.ok) return failed(label, res.error);
    // what the agent may have changed shows up in the file list
    ws.folderChanged(cwd);
    const how = res.cancelled
      ? 'stopped by the user'
      : res.timedOut
        ? `stopped after the time limit (${seconds(res.durationMs)})`
        : res.exitCode === null
          ? `ended by signal ${res.signal ?? '?'}`
          : `exit code ${res.exitCode}`;
    const { text } = capOutput(res.output.trimEnd(), Math.min(host.budget, 60_000));
    const result = `$ ${command}\n(${how}, ${seconds(res.durationMs)})\n\n${text || '(no output)'}`;
    const failedRun = res.cancelled || res.timedOut || res.exitCode !== 0;
    return { result, activity: { label: `Ran ${short} — ${how}`, error: failedRun } };
  } finally {
    off?.();
    host.onCancel?.(null);
  }
}

async function webSearch(host: ActionHost, rawQuery: unknown) {
  const query = str(rawQuery).trim();
  const label = `Searched the web for “${query.length > 40 ? `${query.slice(0, 37)}…` : query}”`;
  if (!host.actions?.webSearch) return failed(label, 'Web search is only in the desktop app.');
  if (!query) return failed(label, 'The search is empty.');
  const ok = await host.permit({ capability: 'web', title: 'Search the web', code: query });
  if (!ok) return refused(label, 'searching the web');
  const res = await host.actions.webSearch(query);
  if (!res.ok) return failed(label, res.error);
  if (!res.results.length) return { result: `No results for “${query}”.`, activity: { label } };
  const list = res.results.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}${r.snippet ? `\n   ${r.snippet}` : ''}`).join('\n');
  return { result: `Results for “${query}”:\n${list}`, activity: { label: `${label} (${res.results.length} results)` } };
}

async function fetchUrl(host: ActionHost, rawUrl: unknown, rawStart: unknown) {
  const url = str(rawUrl).trim();
  let host_ = url;
  try {
    host_ = new URL(url).host;
  } catch {
    /* shown as typed */
  }
  const label = `Read ${host_ || 'web page'}`;
  if (!host.actions?.fetchUrl) return failed(label, 'Reading web pages is only in the desktop app.');
  if (!url) return failed(label, 'No address given.');
  const ok = await host.permit({ capability: 'web', title: 'Open a web page', code: url });
  if (!ok) return refused(label, `opening ${url}`);
  const res = await host.actions.fetchUrl(url);
  if (!res.ok) return failed(label, res.error);
  const start = Math.max(0, Math.floor(Number(rawStart) || 0));
  const { text, clipped } = clip(res.text.slice(start), Math.min(host.budget, 80_000));
  const end = start + text.length;
  const head = `${res.title ? `${res.title}\n` : ''}${res.url}${res.status !== 200 ? ` (HTTP ${res.status})` : ''}${start ? ` — from character ${start}` : ''}`;
  const more = clipped ? `\n\n[… ${(res.text.length - end).toLocaleString('en-US')} more characters: read on with start_char=${end}]` : '';
  const links = !start && res.links.length ? `\n\nLinks:\n${res.links.slice(0, 30).map((l) => `- ${l.text}: ${l.url}`).join('\n')}` : '';
  return { result: `${head}\n\n${text || '(no text on the page)'}${more}${links}`, activity: { label: `Read ${res.title ? `“${res.title.slice(0, 50)}”` : host_}` } };
}

/** Runs one of these tools; null when `name` isn't one of them. */
export async function runAction(name: string, args: Record<string, unknown>, ws: AgentWorkspace, host: ActionHost): Promise<{ result: string; activity: ToolActivity } | null> {
  switch (name) {
    case 'delete_file':
      return deleteFile(ws, host, args.path);
    case 'rename_file':
      return renameFile(ws, host, args.path, args.new_path);
    case 'run_command':
      return runCommand(ws, host, args.command, args.cwd, args.timeout_seconds);
    case 'web_search':
      return webSearch(host, args.query);
    case 'fetch_url':
      return fetchUrl(host, args.url, args.start_char);
    default:
      return null;
  }
}
