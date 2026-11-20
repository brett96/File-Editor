/**
 * The coding agent's connection (main process only).
 *
 * - **Through the license server.** Requests go to the license server
 *   (https://license.bretttomita.com/api/agent/models and /api/agent/chat) with this computer's
 *   activation token and device id. The server checks the license, applies the limits set in
 *   Admin → Licenses (per minute, per day, at once, monthly budget), adds the OpenUncensored key
 *   and streams the answer back. **The app holds no API key.**
 * - **Licensed copies only.** This process also refuses to send anything without an active
 *   license on this computer, so an unlicensed copy never makes a request; the server's check
 *   is the one that can't be bypassed.
 * - **Network.** The app's default session blocks all network access. Agent requests go
 *   through their own in-memory session that may only reach the license server.
 * - **Bounds.** Requests are checked and capped here too (src/core/agent/protocol.ts:
 *   buildChatBody), with a local limit on running and per-minute requests, so a runaway loop
 *   stops before the server has to refuse it.
 */
import { app, session, type Session, type WebContents } from 'electron';
import {
  ChatAssembler,
  RepetitionDetector,
  SseParser,
  parseUsageToday,
  buildChatBody,
  errorFromResponse,
  parseModels,
  type AgentChatResult,
  type AgentModel,
  type AgentResponse,
  type AgentStatus,
  type AgentUsageToday,
} from '../src/core/agent/protocol';
import { apiBase, getLicenseState, licenseCredentials, refreshLicenseStatus } from './license';

const MODELS_TTL_MS = 10 * 60 * 1000;
/** No byte from the server for this long ends the request. */
const IDLE_TIMEOUT_MS = 120_000;
/** The server allows 300 s per request; give up a little after it would. */
const REQUEST_TIMEOUT_MS = 320_000;
const MAX_CONCURRENT = 3;
const MAX_PER_MINUTE = 40;
const PURCHASE_URL = 'https://license.bretttomita.com';

let agentSession: Session | null = null;

function netSession(): Session {
  if (!agentSession) {
    const origin = new URL(apiBase()).origin;
    // In-memory partition (no cookies or cache kept) that may only reach the license server.
    agentSession = session.fromPartition('file-editor-agent');
    agentSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    agentSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(`${origin}/`) }));
  }
  return agentSession;
}

const headers = (accept: string) => ({ 'Content-Type': 'application/json', Accept: accept, 'User-Agent': `FileEditor/${app.getVersion()}` });

export async function agentStatus(): Promise<AgentStatus> {
  const lic = await getLicenseState().catch(() => null);
  return { licensed: lic?.status === 'active', purchaseUrl: lic?.purchaseUrl ?? PURCHASE_URL };
}

const UNLICENSED = { ok: false as const, code: 'unlicensed' as const, error: 'The agent is part of licensed copies of File Editor. Enter your license key under Help ▸ License.' };

/** The server said the license isn't good any more: re-check it, so the app shows that. */
function onRefused(code: string) {
  if (code === 'unlicensed') void refreshLicenseStatus(true).catch(() => undefined);
}

// ── models ─────────────────────────────────────────────────────────────────
let modelsCache: { at: number; models: AgentModel[] } | null = null;

/** Today's use against this license's limits, for the usage meter. */
export async function usageToday(): Promise<AgentResponse<{ usage: AgentUsageToday }>> {
  const creds = await licenseCredentials();
  if (!creds) return UNLICENSED;
  try {
    const res = await netSession().fetch(`${apiBase()}/api/agent/usage`, { method: 'POST', headers: headers('application/json'), body: JSON.stringify(creds), signal: AbortSignal.timeout(15_000) });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const err = errorFromResponse(res.status, json);
      onRefused(err.code);
      return { ok: false, ...err };
    }
    const usage = parseUsageToday(json);
    return usage ? { ok: true, usage } : { ok: false, code: 'error', error: 'The usage answer couldn’t be read.' };
  } catch {
    return { ok: false, code: 'network', error: "Couldn't reach the license server." };
  }
}

export async function listModels(force = false): Promise<AgentResponse<{ models: AgentModel[]; usage?: AgentUsageToday }>> {
  const creds = await licenseCredentials();
  if (!creds) return UNLICENSED;
  if (!force && modelsCache && Date.now() - modelsCache.at < MODELS_TTL_MS) return { ok: true, models: modelsCache.models };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 20_000);
  try {
    const res = await netSession().fetch(`${apiBase()}/api/agent/models`, { method: 'POST', headers: headers('application/json'), body: JSON.stringify(creds), signal: ctrl.signal });
    const json = (await res.json().catch(() => null)) as unknown;
    if (!res.ok) {
      const err = errorFromResponse(res.status, json);
      onRefused(err.code);
      return { ok: false, ...err };
    }
    const models = parseModels(json);
    if (!models.length) return { ok: false, code: 'unavailable', error: 'The agent service listed no models. Try again in a moment.' };
    modelsCache = { at: Date.now(), models };
    return { ok: true, models, usage: parseUsageToday((json as { usage?: unknown })?.usage) ?? undefined };
  } catch {
    if (modelsCache) return { ok: true, models: modelsCache.models };
    return { ok: false, code: 'network', error: "Couldn't reach the license server. Check your internet connection and try again." };
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
  const creds = await licenseCredentials();
  if (!creds) return UNLICENSED;
  const built = buildChatBody(req);
  if ('error' in built) return { ok: false, code: 'invalid-request', error: built.error };
  if (running.size >= MAX_CONCURRENT) return { ok: false, code: 'rate-limited', error: 'Another request is still running. Wait for it to finish, or press Stop.' };
  if (!underRateLimit()) return { ok: false, code: 'rate-limited', error: 'That was a lot of requests in one minute. Wait a moment, then continue.' };

  // the checked request, in the shape the license server takes
  const b = built.body;
  const request = { model: b.model, messages: b.messages, tools: b.tools, temperature: b.temperature, maxTokens: b.max_tokens, frequencyPenalty: b.frequency_penalty };

  const ctrl = new AbortController();
  running.set(rid, ctrl);
  let timedOut = false;
  /** the model got stuck repeating itself: stopped here (which also stops it on the server) */
  let looped = false;
  const loops = { content: new RepetitionDetector(), reasoning: new RepetitionDetector(), args: new RepetitionDetector() };
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
    const res = await netSession().fetch(`${apiBase()}/api/agent/chat`, {
      method: 'POST',
      headers: headers('text/event-stream, application/json'),
      body: JSON.stringify({ ...creds, request }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const json = (await res.json().catch(() => null)) as unknown;
      const err = errorFromResponse(res.status, json);
      onRefused(err.code);
      return { ok: false, ...err };
    }
    const asm = new ChatAssembler();
    const send = (delta: ReturnType<ChatAssembler['push']>) => {
      if ((delta?.content && loops.content.push(delta.content)) || (delta?.reasoning && loops.reasoning.push(delta.reasoning)) || loops.args.push(asm.argsPiece)) {
        if (!looped) {
          looped = true;
          ctrl.abort();
        }
        return;
      }
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
    if (looped) return { ok: false, code: 'loop', error: 'The model got stuck repeating itself, so it was stopped.' };
    if (ctrl.signal.aborted && !timedOut) return { ok: false, code: 'cancelled', error: 'Stopped.' };
    if (timedOut) return { ok: false, code: 'timeout', error: 'The model took too long to answer. Try again, or pick a faster model.' };
    return { ok: false, code: 'network', error: "Couldn't reach the license server. Check your internet connection and try again." };
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
