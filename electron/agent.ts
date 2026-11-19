/**
 * The coding agent's connection to OpenUncensored (main process only).
 *
 * - **Licensed copies only.** Every request checks this computer's license first
 *   (getLicenseState, the same offline-verified token the Help menu shows). Without an active
 *   license nothing is sent, whatever the renderer asks for.
 * - **The API key stays here.** It is compiled into the main-process bundle at build time
 *   (OPENUNCENSORED_API_KEY, see scripts/build-electron.mjs) and only ever placed in the
 *   Authorization header of a request this process makes. The renderer never sees it.
 *   A development build may also read OPENUNCENSORED_API_KEY from the environment.
 * - **Network.** The app's default session blocks all network access. Agent requests go
 *   through their own in-memory session that may only reach https://api.openuncensored.com.
 * - **Bounds.** Requests are checked and capped (src/core/agent/protocol.ts: buildChatBody), a
 *   few may run at once, and there is a per-minute limit, so a runaway loop can't drain the
 *   account behind the key.
 */
import { app, session, type Session, type WebContents } from 'electron';
import {
  ChatAssembler,
  OU_API_BASE,
  SseParser,
  buildChatBody,
  errorFromResponse,
  parseModels,
  type AgentChatResult,
  type AgentModel,
  type AgentResponse,
  type AgentStatus,
} from '../src/core/agent/protocol';
import { getLicenseState } from './license';

/** Replaced by esbuild with the key from the build environment ('' when none was set). */
declare const __OU_API_KEY__: string | undefined;

const MODELS_TTL_MS = 10 * 60 * 1000;
/** No byte from the service for this long ends the request. */
const IDLE_TIMEOUT_MS = 120_000;
/** A whole answer may take this long (long tool-writing turns on slow models). */
const REQUEST_TIMEOUT_MS = 6 * 60 * 1000;
const MAX_CONCURRENT = 3;
const MAX_PER_MINUTE = 40;
const PURCHASE_URL = 'https://license.bretttomita.com';

function apiKey(): string {
  const built = typeof __OU_API_KEY__ === 'string' ? __OU_API_KEY__ : '';
  const dev = !app.isPackaged ? (process.env.OPENUNCENSORED_API_KEY ?? '') : '';
  return (dev || built).trim();
}

let agentSession: Session | null = null;

function netSession(): Session {
  if (!agentSession) {
    const origin = new URL(OU_API_BASE).origin;
    // In-memory partition (no cookies or cache kept) that may only reach the API host.
    agentSession = session.fromPartition('file-editor-agent');
    agentSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    agentSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(`${origin}/`) }));
  }
  return agentSession;
}

const userAgent = () => `FileEditor/${app.getVersion()}`;

export async function agentStatus(): Promise<AgentStatus> {
  const lic = await getLicenseState().catch(() => null);
  return { licensed: lic?.status === 'active', configured: !!apiKey(), purchaseUrl: lic?.purchaseUrl ?? PURCHASE_URL };
}

/** null when the agent may be used; otherwise why not. */
async function gate(): Promise<{ ok: false; code: 'unlicensed' | 'not-configured'; error: string } | null> {
  const s = await agentStatus();
  if (!s.licensed) return { ok: false, code: 'unlicensed', error: 'The agent is part of licensed copies of File Editor. Enter your license key under Help ▸ License.' };
  if (!s.configured) return { ok: false, code: 'not-configured', error: 'This build of File Editor was made without access to the agent service.' };
  return null;
}

// ── models ─────────────────────────────────────────────────────────────────
let modelsCache: { at: number; models: AgentModel[] } | null = null;

export async function listModels(force = false): Promise<AgentResponse<{ models: AgentModel[] }>> {
  const blocked = await gate();
  if (blocked) return blocked;
  if (!force && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return { ok: true, models: modelsCache.models };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await netSession().fetch(`${OU_API_BASE}/models`, { headers: { Accept: 'application/json', 'User-Agent': userAgent() }, signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) return { ok: false, ...errorFromResponse(res.status, json) };
    const models = parseModels(json);
    if (!models.length) return { ok: false, code: 'unavailable', error: 'The agent service listed no models. Try again in a moment.' };
    modelsCache = { at: Date.now(), models };
    return { ok: true, models };
  } catch {
    if (modelsCache) return { ok: true, models: modelsCache.models };
    return { ok: false, code: 'network', error: "Couldn't reach the agent service. Check your internet connection and try again." };
  } finally {
    clearTimeout(timer);
  }
}

// ── chat ───────────────────────────────────────────────────────────────────
const running = new Map<string, AbortController>();
const recent: number[] = [];

function underRateLimit(): boolean {
  const now = Date.now();
  while (recent.length && now - recent[0] > 60_000) recent.shift();
  if (recent.length >= MAX_PER_MINUTE) return false;
  recent.push(now);
  return true;
}

export function cancelChat(id: unknown) {
  running.get(String(id))?.abort();
}

/**
 * Sends one chat request and streams the answer: each piece goes to `target` as an
 * 'agent-delta' event for request `id`, and the whole answer is the result.
 */
export async function chat(target: WebContents, id: unknown, req: unknown): Promise<AgentResponse<AgentChatResult>> {
  const rid = String(id ?? '');
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(rid)) return { ok: false, code: 'invalid-request', error: 'Bad request id.' };
  const blocked = await gate();
  if (blocked) return blocked;
  const built = buildChatBody(req);
  if ('error' in built) return { ok: false, code: 'invalid-request', error: built.error };
  if (running.size >= MAX_CONCURRENT) return { ok: false, code: 'rate-limited', error: 'Another request is still running. Wait for it to finish, or press Stop.' };
  if (!underRateLimit()) return { ok: false, code: 'rate-limited', error: 'That was a lot of requests in one minute. Wait a moment, then continue.' };

  const ctrl = new AbortController();
  running.set(rid, ctrl);
  let timedOut = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      timedOut = true;
      ctrl.abort();
    }, IDLE_TIMEOUT_MS);
  };
  const whole = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, REQUEST_TIMEOUT_MS);
  kick();
  try {
    const res = await netSession().fetch(`${OU_API_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
        Authorization: `Bearer ${apiKey()}`,
        'User-Agent': userAgent(),
      },
      body: JSON.stringify(built.body),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as unknown;
      return { ok: false, ...errorFromResponse(res.status, json) };
    }
    const asm = new ChatAssembler();
    const send = (delta: ReturnType<ChatAssembler['push']>) => {
      if (delta && !target.isDestroyed()) target.send('agent-delta', rid, delta);
    };
    const handle = (payload: string) => {
      if (payload === '[DONE]') return;
      try {
        send(asm.push(JSON.parse(payload)));
      } catch {
        /* a malformed event: skip it */
      }
    };
    const type = res.headers.get('content-type') ?? '';
    if (!type.includes('text/event-stream') || !res.body) {
      // the provider answered in one piece
      kick();
      send(asm.push(await res.json()));
    } else {
      const parser = new SseParser();
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        kick();
        for (const p of parser.push(decoder.decode(value, { stream: true }))) handle(p);
      }
      for (const p of [...parser.push(decoder.decode()), ...parser.end()]) handle(p);
    }
    if (asm.error) return { ok: false, code: 'unavailable', error: `The model stopped with an error: ${asm.error}` };
    return { ok: true, ...asm.result() };
  } catch {
    if (ctrl.signal.aborted && !timedOut) return { ok: false, code: 'cancelled', error: 'Stopped.' };
    if (timedOut) return { ok: false, code: 'timeout', error: 'The model took too long to answer. Try again, or pick a faster model.' };
    return { ok: false, code: 'network', error: "Couldn't reach the agent service. Check your internet connection and try again." };
  } finally {
    clearTimeout(idle);
    clearTimeout(whole);
    running.delete(rid);
  }
}

/** Ends every running request (the window is going away). */
export function cancelAllChats() {
  for (const c of running.values()) c.abort();
}
