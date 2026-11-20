/**
 * What the coding agent can do outside the files, when the user allows it (see
 * src/core/agent/permissions.ts; the panel asks before each use unless told not to):
 *
 * - run a shell command in an opened folder (one the user picked: the renderer names its id
 *   and a relative directory, never a real path), with a time limit, output capped, stdin
 *   closed, and Stop killing the whole process tree;
 * - search the web (DuckDuckGo's HTML results) and read public web pages. Addresses on this
 *   computer or the local network are refused, checked on the address actually connected to
 *   (so a name that resolves to one, or a redirect to one, is refused too).
 *
 * Licensed copies only, like the rest of the agent.
 */
import { ipcMain, type IpcMainEvent, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { spawn, type ChildProcess } from 'node:child_process';
import { lookup as dnsLookup } from 'node:dns';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { capOutput, htmlToText, isLocalHostName, isPrivateAddress, parseDuckDuckGo, stripAnsi } from '../src/core/agent/web';
import { licenseCredentials } from './license';

export interface AgentActionDeps {
  assertSender(e: IpcMainInvokeEvent | IpcMainEvent): void;
  /** the real path of an opened folder, or throws */
  folderRoot(id: unknown): string;
  /** the absolute path of a relative path inside a root, or throws */
  pathInside(root: string, rel: unknown): Promise<string>;
}

type Fail = { ok: false; code: string; error: string };
const fail = (code: string, error: string): Fail => ({ ok: false, code, error });
const UNLICENSED = fail('unlicensed', 'The coding agent needs a File Editor license.');

// ── commands ───────────────────────────────────────────────────────────────
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 900;
const HEAD_CHARS = 64_000;
const TAIL_CHARS = 192_000;
const MAX_COMMAND_CHARS = 8000;

const running = new Map<string, ChildProcess>();

function killTree(child: ChildProcess) {
  if (child.exitCode !== null || child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on('error', () => undefined);
    return;
  }
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
  setTimeout(() => {
    try {
      if (child.exitCode === null && child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }, 3000).unref();
}

/** What a command and its output looks like to the model. */
export interface RunResult {
  ok: true;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  cancelled: boolean;
  output: string;
  /** characters left out of the middle */
  cut: number;
  durationMs: number;
  shell: string;
}

async function runCommand(sender: WebContents, deps: AgentActionDeps, opId: unknown, req: unknown): Promise<RunResult | Fail> {
  if (!(await licenseCredentials())) return UNLICENSED;
  const r = (req && typeof req === 'object' ? req : {}) as Record<string, unknown>;
  const id = String(opId ?? '');
  const command = typeof r.command === 'string' ? r.command.trim() : '';
  if (!id || running.has(id)) return fail('invalid', 'Bad request.');
  if (!command) return fail('invalid', 'The command is empty.');
  if (command.length > MAX_COMMAND_CHARS) return fail('invalid', 'The command is too long.');
  let cwd: string;
  try {
    const root = deps.folderRoot(r.folderId);
    cwd = await deps.pathInside(root, typeof r.cwd === 'string' ? r.cwd.replace(/^\.?\/?/, '') : '');
    if (!(await stat(cwd)).isDirectory()) return fail('invalid', `${String(r.cwd)} is not a folder.`);
  } catch (err) {
    return fail('invalid', err instanceof Error ? err.message : 'That folder can’t be used.');
  }
  const timeoutS = Math.max(1, Math.min(MAX_TIMEOUT_S, Math.floor(Number(r.timeoutSeconds) || DEFAULT_TIMEOUT_S)));
  const shell = process.platform === 'win32' ? process.env.ComSpec || 'cmd.exe' : process.env.SHELL || '/bin/sh';
  const env: NodeJS.ProcessEnv = { ...process.env, CI: process.env.CI ?? '1', NO_COLOR: '1', FORCE_COLOR: '0', GIT_TERMINAL_PROMPT: '0', GIT_PAGER: 'cat', PAGER: 'cat' };
  delete env.ELECTRON_RUN_AS_NODE;
  const started = Date.now();
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(command, { cwd, env, shell, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      done(fail('error', err instanceof Error ? err.message : 'The command couldn’t be started.'));
      return;
    }
    running.set(id, child);
    let head = '';
    let tail = '';
    let total = 0;
    let timedOut = false;
    let cancelled = false;
    const take = (buf: Buffer) => {
      const s = stripAnsi(buf.toString('utf8'));
      total += s.length;
      if (head.length < HEAD_CHARS) {
        const room = HEAD_CHARS - head.length;
        head += s.slice(0, room);
        tail += s.slice(room);
      } else tail += s;
      if (tail.length > TAIL_CHARS * 1.5) tail = tail.slice(tail.length - TAIL_CHARS);
      if (!sender.isDestroyed()) sender.send('agent-run-output', id, s);
    };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutS * 1000);
    (child as ChildProcess & { __cancel?: () => void }).__cancel = () => {
      cancelled = true;
      killTree(child);
    };
    const finish = (code: number | null, signal: NodeJS.Signals | null, error?: Error) => {
      clearTimeout(timer);
      running.delete(id);
      if (error && total === 0 && code === null) {
        done(fail('error', `The command couldn’t be started: ${error.message}`));
        return;
      }
      if (tail.length > TAIL_CHARS) tail = tail.slice(tail.length - TAIL_CHARS);
      const kept = head.length + tail.length;
      const output = total > kept ? `${head}\n\n[… ${(total - kept).toLocaleString('en-US')} characters left out …]\n\n${tail}` : head + tail;
      done({ ok: true, exitCode: code, signal, timedOut, cancelled, output, cut: total - kept, durationMs: Date.now() - started, shell });
    };
    child.on('error', (err) => finish(null, null, err));
    child.on('close', (code, signal) => finish(code, signal));
  });
}

// ── web ────────────────────────────────────────────────────────────────────
const MAX_PAGE_BYTES = 3 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 FileEditorAgent';

/** Resolves a host name, refusing private addresses (the check is on what is connected to). */
const publicLookup: LookupFunction = (hostname, options, callback) => {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, '', 0);
    const list = (addresses as unknown as { address: string; family: number }[]).filter((a) => !isPrivateAddress(a.address));
    if (!list.length) return callback(Object.assign(new Error(`${hostname} is on this computer or a private network, so it isn’t opened.`), { code: 'EPRIVATE' }), '', 0);
    if ((options as { all?: boolean }).all) return (callback as unknown as (e: null, a: typeof list) => void)(null, list);
    callback(null, list[0].address, list[0].family);
  });
};

interface Page {
  url: string;
  status: number;
  contentType: string;
  body: Buffer;
  truncated: boolean;
}

function checkUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error(`“${raw}” is not a web address.`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('Only http and https addresses can be opened.');
  if (u.username || u.password) throw new Error('Addresses with a user name or password aren’t opened.');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (isLocalHostName(host) || (isIP(host) && isPrivateAddress(host))) throw new Error(`${u.hostname} is on this computer or a private network, so it isn’t opened.`);
  return u;
}

function getOnce(u: URL, signal: AbortSignal, accept: string): Promise<Page & { location?: string }> {
  return new Promise((resolve, reject) => {
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request(
      u,
      { method: 'GET', lookup: publicLookup, signal, headers: { 'User-Agent': UA, Accept: accept, 'Accept-Language': 'en-US,en;q=0.8', 'Accept-Encoding': 'gzip, deflate, br' } },
      (res) => {
        const status = res.statusCode ?? 0;
        const location = res.headers.location;
        if (status >= 300 && status < 400 && location) {
          res.resume();
          return resolve({ url: u.href, status, contentType: '', body: Buffer.alloc(0), truncated: false, location });
        }
        const enc = String(res.headers['content-encoding'] ?? '').toLowerCase();
        const stream = enc === 'gzip' ? res.pipe(zlib.createGunzip()) : enc === 'deflate' ? res.pipe(zlib.createInflate()) : enc === 'br' ? res.pipe(zlib.createBrotliDecompress()) : res;
        const chunks: Buffer[] = [];
        let size = 0;
        let ended = false;
        const finish = (truncated: boolean) => {
          if (ended) return;
          ended = true;
          resolve({ url: u.href, status, contentType: String(res.headers['content-type'] ?? ''), body: Buffer.concat(chunks), truncated });
        };
        stream.on('data', (c: Buffer) => {
          if (ended) return;
          size += c.length;
          if (size > MAX_PAGE_BYTES) {
            chunks.push(c.subarray(0, c.length - (size - MAX_PAGE_BYTES)));
            finish(true);
            res.destroy();
            return;
          }
          chunks.push(c);
        });
        stream.on('end', () => finish(false));
        stream.on('error', (err) => {
          if (!ended) {
            ended = true;
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

async function getPage(raw: string, accept: string): Promise<Page> {
  let u = checkUrl(raw);
  const signal = AbortSignal.timeout(20_000);
  for (let hop = 0; ; hop++) {
    const page = await getOnce(u, signal, accept);
    if (!page.location) return page;
    if (hop >= MAX_REDIRECTS) throw new Error('Too many redirects.');
    u = checkUrl(new URL(page.location, u).href);
  }
}

function decodeBody(page: Page): string {
  const charset = /charset=([^;]+)/i.exec(page.contentType)?.[1]?.trim().replace(/^"|"$/g, '') || /<meta[^>]+charset=["']?([\w-]+)/i.exec(page.body.subarray(0, 4096).toString('latin1'))?.[1] || 'utf-8';
  try {
    return new TextDecoder(charset).decode(page.body);
  } catch {
    return new TextDecoder('utf-8').decode(page.body);
  }
}

const netError = (err: unknown) => {
  const e = err as { name?: string; code?: string; message?: string };
  if (e?.name === 'TimeoutError' || e?.name === 'AbortError') return 'The site took too long to answer.';
  if (e?.code === 'EPRIVATE') return e.message ?? 'That address is private.';
  if (e?.code === 'ENOTFOUND') return 'That site wasn’t found (no such address, or you’re offline).';
  return e?.message || 'The page couldn’t be loaded.';
};

async function webSearch(query: unknown) {
  if (!(await licenseCredentials())) return UNLICENSED;
  const q = typeof query === 'string' ? query.trim().slice(0, 400) : '';
  if (!q) return fail('invalid', 'The search is empty.');
  try {
    const page = await getPage(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}&kl=wt-wt`, 'text/html');
    if (page.status !== 200) return fail('error', `The search service answered ${page.status}. Try again in a moment.`);
    const results = parseDuckDuckGo(decodeBody(page));
    return { ok: true as const, results };
  } catch (err) {
    return fail('network', netError(err));
  }
}

async function fetchUrl(url: unknown) {
  if (!(await licenseCredentials())) return UNLICENSED;
  if (typeof url !== 'string' || !url.trim()) return fail('invalid', 'No address given.');
  try {
    const page = await getPage(url.trim(), 'text/html,application/xhtml+xml,text/plain,application/json,text/markdown;q=0.9,*/*;q=0.5');
    const type = page.contentType.split(';')[0].trim().toLowerCase();
    const texty = !type || type.startsWith('text/') || /json|xml|javascript|yaml|toml|markdown/.test(type);
    if (!texty) return fail('invalid', `That address is a ${type} file, not a page that can be read as text.`);
    const raw = decodeBody(page);
    const isHtml = type.includes('html') || (!type && /<html|<body/i.test(raw.slice(0, 2000)));
    const read = isHtml ? htmlToText(raw, page.url) : { title: '', text: raw, links: [] };
    return { ok: true as const, url: page.url, status: page.status, contentType: type, title: read.title, text: capOutput(read.text, 400_000).text, links: read.links, truncated: page.truncated };
  } catch (err) {
    return fail('network', netError(err));
  }
}

export function registerAgentActions(deps: AgentActionDeps) {
  ipcMain.handle('agent-run', (e, opId: unknown, req: unknown) => {
    deps.assertSender(e);
    return runCommand(e.sender, deps, opId, req);
  });
  ipcMain.on('agent-run-cancel', (e, opId: unknown) => {
    try {
      deps.assertSender(e);
      (running.get(String(opId)) as (ChildProcess & { __cancel?: () => void }) | undefined)?.__cancel?.();
    } catch {
      /* not ours */
    }
  });
  ipcMain.handle('agent-web-search', (e, query: unknown) => {
    deps.assertSender(e);
    return webSearch(query);
  });
  ipcMain.handle('agent-fetch-url', (e, url: unknown) => {
    deps.assertSender(e);
    return fetchUrl(url);
  });
}

/** Stops every command the agent started (the app is quitting). */
export function stopAllCommands() {
  for (const child of running.values()) killTree(child);
  running.clear();
}
