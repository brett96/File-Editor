/**
 * The coding agent's wire format, shared by the renderer (src/ui/agent) and the desktop main
 * process (electron/agent.ts), which is the only place that talks to OpenUncensored.
 *
 * OpenUncensored (https://openuncensored.com/agents.md) serves an OpenAI-compatible API at
 * https://api.openuncensored.com/v1: GET /models (no key) lists the text models, and
 * POST /chat/completions takes OpenAI's `messages` / `tools` / `stream` and streams
 * `chat.completion.chunk` server-sent events ending in `data: [DONE]`.
 *
 * No React and no Node APIs here, so the stream parser is unit-tested on its own.
 */

export const OU_API_BASE = 'https://api.openuncensored.com/v1';
/** The model the service recommends as a default (agents.md). */
export const DEFAULT_AGENT_MODEL = 'deepseek-v4.1-flash-1017-uncensored';

export interface AgentModel {
  id: string;
  /** tokens; 0 when unknown */
  contextLength: number;
  /** US dollars per million tokens, when the service lists a price */
  promptPrice?: number;
  completionPrice?: number;
  /** what it is built on, e.g. "deepseek-ai/DeepSeek-V4.1-Flash-1017" */
  baseModel?: string;
  vision: boolean;
  /** the model's name says it reasons before answering (a "-thinking" variant) */
  thinking: boolean;
}

export interface AgentToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

export type AgentMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string | null; tool_calls?: AgentToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string };

export interface AgentToolSpec {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

export interface AgentChatRequest {
  model: string;
  messages: AgentMessage[];
  tools?: AgentToolSpec[];
  temperature?: number;
  maxTokens?: number;
}

export interface AgentUsage {
  promptTokens: number;
  completionTokens: number;
}

export interface AgentChatResult {
  message: { content: string; reasoning: string; toolCalls: AgentToolCall[] };
  finishReason: string | null;
  usage?: AgentUsage;
  /** the model that answered (the service may fall back to a sibling of the one asked for) */
  model?: string;
  costUsd?: number;
}

export type AgentErrorCode =
  | 'unlicensed'
  | 'not-configured'
  | 'network'
  | 'timeout'
  | 'cancelled'
  | 'rate-limited'
  | 'invalid-request'
  | 'auth'
  | 'quota'
  | 'model'
  | 'unavailable'
  | 'error';

export type AgentResponse<T> = ({ ok: true } & T) | { ok: false; code: AgentErrorCode; error: string };

export interface AgentStatus {
  /** this computer holds an active File Editor license */
  licensed: boolean;
  /** this build has an OpenUncensored key */
  configured: boolean;
  purchaseUrl: string;
}

/** A streamed piece of the answer, sent while a request is under way. */
export interface AgentDelta {
  content?: string;
  reasoning?: string;
  /** the name of a tool the model has started to call */
  tool?: string;
}

// ── models ─────────────────────────────────────────────────────────────────
const perMillion = (v: unknown): number | undefined => {
  const n = typeof v === 'string' || typeof v === 'number' ? Number(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 1e6 * 1000) / 1000 : undefined;
};

/** The text models in a GET /v1/models answer, sorted by id. Unavailable and non-text models are left out. */
export function parseModels(json: unknown): AgentModel[] {
  const list = (json as { data?: unknown })?.data;
  if (!Array.isArray(list)) return [];
  const out: AgentModel[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    const m = raw as Record<string, unknown>;
    const id = typeof m?.id === 'string' ? m.id.trim() : '';
    if (!isModelId(id) || seen.has(id)) continue;
    if (m.available === false) continue;
    if (typeof m.modality === 'string' && m.modality !== 'text') continue;
    seen.add(id);
    const pricing = (m.pricing ?? {}) as Record<string, unknown>;
    const tags = Array.isArray(m.tags) ? m.tags.filter((t): t is string => typeof t === 'string') : [];
    out.push({
      id,
      contextLength: Number.isFinite(Number(m.context_length)) ? Math.max(0, Math.floor(Number(m.context_length))) : 0,
      promptPrice: perMillion(pricing.prompt),
      completionPrice: perMillion(pricing.completion),
      baseModel: typeof m.base_model === 'string' && m.base_model !== 'unknown' ? m.base_model : undefined,
      vision: tags.includes('vision'),
      thinking: /(^|-)thinking($|-)|reasoning/.test(id),
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Model ids are short slugs ("glm-5.3-flash-uncensored"); anything else is refused before it is sent. */
export function isModelId(id: unknown): id is string {
  return typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/.test(id);
}

/** "1M", "262K", "8K" */
export function formatContext(tokens: number): string {
  if (!tokens) return '';
  if (tokens >= 1_000_000) return `${Math.round(tokens / 100_000) / 10}M`.replace('.0M', 'M');
  return `${Math.round(tokens / 1000)}K`;
}

// ── errors ─────────────────────────────────────────────────────────────────
/** A user-facing error for a non-2xx answer (body is the parsed JSON, when there was any). */
export function errorFromResponse(status: number, body: unknown): { code: AgentErrorCode; error: string } {
  const detail = (body as { error?: { message?: unknown; code?: unknown } | string; detail?: unknown })?.error;
  const message = typeof detail === 'string' ? detail : typeof detail?.message === 'string' ? detail.message : '';
  const code = typeof detail === 'object' && detail ? String(detail.code ?? '') : '';
  const said = message ? ` (${message.length > 300 ? `${message.slice(0, 300)}…` : message})` : '';
  if (status === 401 || code === 'invalid_api_key') return { code: 'auth', error: 'The agent service did not accept this build’s API key. Please update File Editor.' };
  if (status === 402 || code === 'insufficient_quota') return { code: 'quota', error: 'The agent service is out of credits right now. Please try again later.' };
  if (status === 404 || code === 'model_not_found') return { code: 'model', error: `That model is not available any more. Pick another one from the list.${said}` };
  if (status === 429) return { code: 'rate-limited', error: 'The agent service is busy. Wait a few seconds and try again.' };
  if (status === 400 || status === 422) return { code: 'invalid-request', error: `The model could not take this request${said}. Some models cannot use tools: switch to Chat mode or pick another model.` };
  if (status >= 500) return { code: 'unavailable', error: `No provider could answer with this model just now${said}. Try again, or pick another model.` };
  return { code: 'error', error: `The agent service answered with HTTP ${status}${said}.` };
}

// ── server-sent events ─────────────────────────────────────────────────────
/**
 * Splits a text/event-stream into the payloads of its `data:` fields. Feed it text as it
 * arrives; it returns the events that are complete so far. Comments (": keep-alive") and
 * other fields are skipped; a multi-line data field is joined with "\n".
 */
export class SseParser {
  private buf = '';
  private data: string[] = [];

  push(text: string): string[] {
    this.buf += text;
    const out: string[] = [];
    for (;;) {
      const nl = this.buf.search(/\r\n|\r|\n/);
      if (nl < 0) break;
      const line = this.buf.slice(0, nl);
      this.buf = this.buf.slice(nl + (this.buf.startsWith('\r\n', nl) ? 2 : 1));
      this.line(line, out);
    }
    return out;
  }

  /** The last event when the stream ends without a blank line. */
  end(): string[] {
    const out: string[] = [];
    if (this.buf) this.line(this.buf, out);
    this.buf = '';
    this.line('', out);
    return out;
  }

  private line(line: string, out: string[]) {
    if (line === '') {
      if (this.data.length) out.push(this.data.join('\n'));
      this.data = [];
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    if (field !== 'data') return;
    let value = colon < 0 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    this.data.push(value);
  }
}

// ── assembling a streamed answer ───────────────────────────────────────────
/**
 * Builds the final assistant message out of `chat.completion.chunk` objects (or one whole
 * `chat.completion`, when a provider ignores `stream`). Tool calls arrive in pieces keyed by
 * `index`: the id and name first, the JSON arguments a few characters at a time.
 */
export class ChatAssembler {
  private content = '';
  private reasoning = '';
  private calls: { id: string; name: string; args: string }[] = [];
  private finish: string | null = null;
  private usage?: AgentUsage;
  private model?: string;
  private cost?: number;
  /** an error the stream itself reported (some providers send one as a data event) */
  error: string | null = null;

  /** Takes one parsed chunk; returns what it added, for showing the answer as it is written. */
  push(chunk: unknown): AgentDelta | null {
    const c = chunk as Record<string, unknown> | null;
    if (!c || typeof c !== 'object') return null;
    if (c.error) {
      const e = c.error as { message?: unknown } | string;
      this.error = typeof e === 'string' ? e : typeof e?.message === 'string' ? e.message : 'The model stopped with an error.';
      return null;
    }
    if (typeof c.model === 'string') this.model = c.model;
    const ou = c.ou as { model?: unknown; cost_usd?: unknown } | undefined;
    if (ou && typeof ou.model === 'string') this.model = ou.model;
    if (ou && typeof ou.cost_usd === 'number') this.cost = ou.cost_usd;
    const u = c.usage as { prompt_tokens?: unknown; completion_tokens?: unknown } | undefined;
    if (u && typeof u === 'object') this.usage = { promptTokens: Number(u.prompt_tokens) || 0, completionTokens: Number(u.completion_tokens) || 0 };
    const choice = (Array.isArray(c.choices) ? c.choices[0] : null) as Record<string, unknown> | null;
    if (!choice) return null;
    if (typeof choice.finish_reason === 'string') this.finish = choice.finish_reason;
    // a whole completion carries `message`; a chunk carries `delta`
    const part = (choice.delta ?? choice.message) as Record<string, unknown> | undefined;
    if (!part) return null;
    const delta: AgentDelta = {};
    if (typeof part.content === 'string' && part.content) {
      this.content += part.content;
      delta.content = part.content;
    }
    const thought = typeof part.reasoning_content === 'string' ? part.reasoning_content : typeof part.reasoning === 'string' ? part.reasoning : '';
    if (thought) {
      this.reasoning += thought;
      delta.reasoning = thought;
    }
    if (Array.isArray(part.tool_calls)) {
      for (const [n, raw] of part.tool_calls.entries()) {
        const tc = raw as { index?: unknown; id?: unknown; function?: { name?: unknown; arguments?: unknown } };
        const i = Number.isInteger(tc.index) ? (tc.index as number) : n;
        if (i < 0 || i > 63) continue;
        const slot = (this.calls[i] ??= { id: '', name: '', args: '' });
        if (typeof tc.id === 'string' && tc.id) slot.id = tc.id;
        if (typeof tc.function?.name === 'string' && tc.function.name) {
          if (!slot.name) delta.tool = tc.function.name;
          // most providers send the name once; a few repeat it in every piece
          if (!slot.name.endsWith(tc.function.name)) slot.name += tc.function.name;
        }
        if (typeof tc.function?.arguments === 'string') slot.args += tc.function.arguments;
        else if (tc.function?.arguments && typeof tc.function.arguments === 'object') slot.args = JSON.stringify(tc.function.arguments);
      }
    }
    return delta.content || delta.reasoning || delta.tool ? delta : null;
  }

  result(): AgentChatResult {
    const toolCalls = this.calls
      .filter((c) => c && c.name)
      .map((c, i): AgentToolCall => ({ id: c.id || `call_${i}_${Math.random().toString(36).slice(2, 10)}`, type: 'function', function: { name: c.name, arguments: c.args || '{}' } }));
    let content = this.content;
    let reasoning = this.reasoning;
    // some reasoning models put their thinking inline, between <think> tags
    const think = /^\s*<think>([\s\S]*?)(<\/think>\s*|$)/.exec(content);
    if (think) {
      reasoning = (reasoning ? `${reasoning}\n` : '') + think[1].trim();
      content = content.slice(think[0].length);
    }
    return { message: { content, reasoning, toolCalls }, finishReason: this.finish, usage: this.usage, model: this.model, costUsd: this.cost };
  }
}

// ── checking what the renderer asks for ────────────────────────────────────
export const MAX_REQUEST_CHARS = 3_000_000;
export const MAX_OUTPUT_TOKENS = 16_384;
const ROLES = new Set(['system', 'user', 'assistant', 'tool']);

/**
 * The JSON body for POST /v1/chat/completions, or an error. The main process runs this on
 * everything the renderer sends, so only well-formed chat requests of a bounded size go out.
 */
export function buildChatBody(req: unknown): { body: Record<string, unknown> } | { error: string } {
  const r = req as Partial<AgentChatRequest> | null;
  if (!r || typeof r !== 'object') return { error: 'Empty request.' };
  if (!isModelId(r.model)) return { error: 'Pick a model first.' };
  if (!Array.isArray(r.messages) || r.messages.length === 0 || r.messages.length > 400) return { error: 'The conversation is empty or too long. Start a new session.' };
  const messages: Record<string, unknown>[] = [];
  for (const m of r.messages as unknown[]) {
    const msg = m as Record<string, unknown>;
    if (!msg || !ROLES.has(String(msg.role))) return { error: 'The conversation has a message the model cannot take.' };
    const content = msg.content === null || msg.content === undefined ? null : String(msg.content);
    if (msg.role === 'tool') {
      if (typeof msg.tool_call_id !== 'string') return { error: 'A tool result has no call id.' };
      messages.push({ role: 'tool', tool_call_id: msg.tool_call_id.slice(0, 200), content: content ?? '' });
    } else if (msg.role === 'assistant') {
      const out: Record<string, unknown> = { role: 'assistant', content };
      if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
        out.tool_calls = (msg.tool_calls as AgentToolCall[]).slice(0, 64).map((c) => ({
          id: String(c?.id ?? '').slice(0, 200),
          type: 'function',
          function: { name: String(c?.function?.name ?? '').slice(0, 100), arguments: String(c?.function?.arguments ?? '{}') },
        }));
      }
      messages.push(out);
    } else {
      messages.push({ role: msg.role, content: content ?? '' });
    }
  }
  const body: Record<string, unknown> = {
    model: r.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: Math.max(256, Math.min(MAX_OUTPUT_TOKENS, Math.floor(Number(r.maxTokens) || 8192))),
  };
  if (typeof r.temperature === 'number' && Number.isFinite(r.temperature)) body.temperature = Math.max(0, Math.min(2, r.temperature));
  if (Array.isArray(r.tools) && r.tools.length) {
    body.tools = r.tools.slice(0, 32);
    body.tool_choice = 'auto';
  }
  if (JSON.stringify(body).length > MAX_REQUEST_CHARS) return { error: 'This conversation has grown too large for one request. Start a new session.' };
  return { body };
}
