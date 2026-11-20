/**
 * Fitting a coding session into a model's context window. Models range from 8K to 1M tokens,
 * so how much of a file is sent, and how much history is kept, follows the chosen model.
 */
import { contentImages, contentText, type AgentMessage } from './protocol';

/** What one picture in a prompt costs, roughly, in tokens (most vision models: 500–1,500). */
export const IMAGE_TOKENS = 1_000;

/** Rough characters per token for source code and prose. */
const CHARS_PER_TOKEN = 3.2;

/** How many characters of one file (or one tool result) to send to a model of this size. */
export function fileBudget(contextTokens: number): number {
  const ctx = contextTokens > 0 ? contextTokens : 32_768;
  return Math.round(Math.max(4_000, Math.min(120_000, ctx * CHARS_PER_TOKEN * 0.35)));
}

/** How many characters the whole conversation may take, leaving room for the answer. */
export function historyBudget(contextTokens: number, outputTokens: number): number {
  const ctx = contextTokens > 0 ? contextTokens : 32_768;
  return Math.round(Math.max(6_000, Math.min(2_000_000, (ctx - outputTokens) * CHARS_PER_TOKEN * 0.85)));
}

const size = (m: AgentMessage) =>
  contentText(m.content).length +
  contentImages(m.content) * IMAGE_TOKENS * CHARS_PER_TOKEN + (m.role === 'assistant' && m.tool_calls ? m.tool_calls.reduce((n, c) => n + c.function.arguments.length + 40, 0) : 0) + 16;

/**
 * Drops the oldest turns (a user message and everything after it up to the next one) until the
 * history fits `maxChars`. The latest turn is always kept whole, so a tool call is never sent
 * without its result. When even that is too big, long tool results in it are shortened.
 */
/** Messages one request may carry besides the instructions (the license server's limit, less the system message). */
export const MAX_HISTORY_MESSAGES = 1999;

export function trimHistory(history: AgentMessage[], maxChars: number, headroom = 0, maxMessages = MAX_HISTORY_MESSAGES): { messages: AgentMessage[]; dropped: number } {
  const turns: AgentMessage[][] = [];
  for (const m of history) {
    if (m.role === 'user' || !turns.length) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  let total = history.reduce((n, m) => n + size(m), 0);
  let dropped = 0;
  // once over, drop down to (1 - headroom) of the limit: the start of the conversation then stays
  // the same for the next several requests, which keeps the provider's prompt cache useful
  const goal = total > maxChars ? maxChars * (1 - headroom) : maxChars;
  // the same for the number of messages (a request may carry at most maxMessages)
  let count = history.length;
  const countGoal = count > maxMessages ? Math.floor(maxMessages * (1 - headroom)) : maxMessages;
  while (turns.length > 1 && (total > goal || count > countGoal)) {
    const t = turns.shift()!;
    total -= t.reduce((n, m) => n + size(m), 0);
    count -= t.length;
    dropped += t.length;
  }
  let messages = turns.flat();
  if (total > maxChars) {
    // shorten the oldest tool results of the remaining turn first
    messages = messages.map((m) => ({ ...m })) as AgentMessage[];
    for (const m of messages) {
      if (total <= maxChars) break;
      if (m.role !== 'tool' || m.content.length < 2_000) continue;
      const keep = Math.max(1_000, m.content.length - (total - maxChars));
      total -= m.content.length - keep;
      m.content = `${m.content.slice(0, keep)}\n[… shortened to fit the model's context window]`;
    }
  }
  return { messages, dropped };
}

/**
 * Roughly how many tokens a request of this system prompt and history takes (pictures counted
 * at IMAGE_TOKENS each). The context meter shows this against the model's context window.
 */
export function estimateTokens(system: string, history: AgentMessage[]): number {
  return Math.round((system.length + history.reduce((n, m) => n + size(m), 0)) / CHARS_PER_TOKEN);
}

/**
 * Keeps the newest `max` pictures of a conversation and replaces older ones with a short note,
 * so a long session with screenshots stays within what one request may carry.
 */
export function limitImages(history: AgentMessage[], max: number): AgentMessage[] {
  let left = max;
  const out = [...history];
  for (let i = out.length - 1; i >= 0; i--) {
    const m = out[i];
    if (m.role !== 'user' || !Array.isArray(m.content)) continue;
    const parts = [...m.content];
    for (let k = parts.length - 1; k >= 0; k--) {
      if (parts[k].type !== 'image_url') continue;
      if (left > 0) left--;
      else parts[k] = { type: 'text', text: '[a picture sent earlier in the conversation]' };
    }
    out[i] = { ...m, content: parts };
  }
  return out;
}

/** Tool results and edit arguments longer than this are shortened once their turn is over. */
const COMPACT_OVER = 800;

/**
 * Makes earlier turns cheaper to resend. Every request carries the whole conversation, so once a
 * turn is finished: what tools returned (file contents, search results) becomes a one-line note
 * (the agent reads a file again if it needs it), and the text written by edit_file / write_file
 * (already applied) is left out of their arguments. The latest turn is left whole. Pure; the
 * result is the history kept from then on, so each turn is compacted once and the start of the
 * conversation stays the same afterwards (good for prompt caching).
 */
export function compactHistory(history: AgentMessage[]): { history: AgentMessage[]; saved: number } {
  let lastUser = -1;
  for (let i = history.length - 1; i >= 0; i--) if (history[i].role === 'user') {
    lastUser = i;
    break;
  }
  let saved = 0;
  const out = history.map((m, i): AgentMessage => {
    if (i >= lastUser) return m;
    if (m.role === 'tool' && m.content.length > COMPACT_OVER && !m.content.startsWith('[earlier result')) {
      const first = m.content.split('\n', 1)[0].slice(0, 160);
      const note = `[earlier result, ${m.content.length.toLocaleString('en-US')} characters, left out to save space: ${first}. Call the tool again if you need it.]`;
      saved += m.content.length - note.length;
      return { ...m, content: note };
    }
    if (m.role === 'assistant' && m.tool_calls?.length) {
      let changed = false;
      const calls = m.tool_calls.map((c) => {
        if ((c.function.name !== 'write_file' && c.function.name !== 'edit_file') || c.function.arguments.length <= COMPACT_OVER) return c;
        try {
          const args = JSON.parse(c.function.arguments) as Record<string, unknown>;
          for (const k of ['content', 'old_string', 'new_string']) {
            if (typeof args[k] === 'string' && (args[k] as string).length > 200) args[k] = `[${(args[k] as string).length} characters, already applied]`;
          }
          const next = JSON.stringify(args);
          saved += c.function.arguments.length - next.length;
          changed = true;
          return { ...c, function: { ...c.function, arguments: next } };
        } catch {
          return c;
        }
      });
      return changed ? { ...m, tool_calls: calls } : m;
    }
    return m;
  });
  return { history: out, saved };
}
