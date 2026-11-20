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
export function trimHistory(history: AgentMessage[], maxChars: number): { messages: AgentMessage[]; dropped: number } {
  const turns: AgentMessage[][] = [];
  for (const m of history) {
    if (m.role === 'user' || !turns.length) turns.push([m]);
    else turns[turns.length - 1].push(m);
  }
  let total = history.reduce((n, m) => n + size(m), 0);
  let dropped = 0;
  while (turns.length > 1 && total > maxChars) {
    const t = turns.shift()!;
    total -= t.reduce((n, m) => n + size(m), 0);
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
