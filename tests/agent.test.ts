import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_HISTORY_MESSAGES, compactHistory, trimHistory } from '../src/core/agent/context';
import { applyEdit, lineDiff, minimalChange } from '../src/core/agent/edits';
import { MAX_MESSAGES, ChatAssembler, RepetitionDetector, SseParser, buildChatBody, errorFromResponse, formatContext, parseModels, parseUsageToday, type AgentMessage } from '../src/core/agent/protocol';
import { memoryFolder } from '../src/platform/folders';
import type { CodeEditorAccess } from '../src/ui/agent/editors';
import { READ_TOOLS, folderOverview, runTool, type AgentWorkspace, type EditProposal } from '../src/ui/agent/tools';

describe('agent stream parsing', () => {
  it('splits server-sent events across chunk boundaries and skips comments', () => {
    const p = new SseParser();
    expect(p.push(': keep-alive\n\ndata: {"a"')).toEqual([]);
    expect(p.push(':1}\n\ndata: [DO')).toEqual(['{"a":1}']);
    expect(p.push('NE]\r\n\r\n')).toEqual(['[DONE]']);
    expect(p.push('data: tail')).toEqual([]);
    expect(p.end()).toEqual(['tail']);
  });

  it('assembles streamed content, reasoning and tool calls', () => {
    const a = new ChatAssembler();
    a.push({ model: 'm', choices: [{ delta: { role: 'assistant', content: 'Hel' } }] });
    a.push({ choices: [{ delta: { content: 'lo', reasoning_content: 'hmm' } }] });
    const first = a.push({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'read_file', arguments: '{"pa' } }] } }] });
    expect(first?.tool).toBe('read_file');
    a.push({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } }] });
    a.push({ choices: [{ delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 }, ou: { model: 'm2', cost_usd: 0.001 } });
    const r = a.result();
    expect(r.message.content).toBe('Hello');
    expect(r.message.reasoning).toBe('hmm');
    expect(r.message.toolCalls).toEqual([{ id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }]);
    expect(r.finishReason).toBe('tool_calls');
    expect(r.usage).toEqual({ promptTokens: 10, completionTokens: 5 });
    expect(r.model).toBe('m2');
    expect(r.costUsd).toBe(0.001);
    const b = new ChatAssembler();
    b.push({ choices: [{ delta: { content: 'x' }, finish_reason: 'stop' }], usage: { prompt_tokens: 900, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 800 } } });
    expect(b.result().usage).toEqual({ promptTokens: 900, completionTokens: 5, cachedTokens: 800 });
  });

  it('reads a whole (non-streamed) completion and inline <think> blocks', () => {
    const a = new ChatAssembler();
    a.push({ choices: [{ message: { role: 'assistant', content: '<think>plan</think>\nAnswer' }, finish_reason: 'stop' }] });
    expect(a.result().message).toEqual({ content: 'Answer', reasoning: 'plan', toolCalls: [] });
  });

  it('records an error sent inside the stream', () => {
    const a = new ChatAssembler();
    a.push({ error: { message: 'provider failed' } });
    expect(a.error).toBe('provider failed');
  });
});

describe('stuck models', () => {
  const feed = (text: string, chunk = 37) => {
    const d = new RepetitionDetector();
    for (let i = 0; i < text.length; i += chunk) if (d.push(text.slice(i, i + chunk))) return true;
    return false;
  };
  const code = Array.from({ length: 300 }, (_, i) => `const value${i} = compute(${i}, "item-${i * 7}");`).join('\n');

  it('spots a run of one character and a line repeated over and over', () => {
    expect(feed(`Let me think. ${'!'.repeat(1500)}`)).toBe(true);
    expect(feed(`intro\n${"- '    if ($m.SID -and $m.SID.Value -eq $user.SID.Value) { continue }'\n".repeat(40)}`)).toBe(true);
    expect(feed('ok '.repeat(500))).toBe(true);
  });

  it('leaves normal answers, code, separators and blank space alone', () => {
    expect(feed(code)).toBe(false);
    expect(feed(`Python:\n${'-'.repeat(40)}\n\n${code}`)).toBe(false);
    expect(feed(`a${' '.repeat(3000)}b${'\n'.repeat(2000)}`)).toBe(false);
    expect(feed('The quick brown fox jumps over the lazy dog. '.repeat(3))).toBe(false);
  });

  it('reads today’s usage and passes a repetition penalty on', () => {
    expect(parseUsageToday({ requests: 3, tokens: 1200, dailyRequests: 300, dailyTokens: 2e6, resetsAt: '2026-11-21T00:00:00.000Z', paused: false })).toMatchObject({ requests: 3, dailyRequests: 300 });
    expect(parseUsageToday({ requests: 1 })).toBeNull();
    expect(parseUsageToday({ requests: 0, tokens: 0, dailyRequests: 1, dailyTokens: 1, resetsAt: 'x', maxOutputTokens: 32768 })?.maxOutputTokens).toBe(32768);
    const a = new ChatAssembler();
    a.push({ choices: [{ delta: { content: 'x' } }] });
    a.push({ fe_usage: { requests: 4, tokens: 10, dailyRequests: 300, dailyTokens: 1000, resetsAt: '', paused: false } });
    expect(a.result().today?.requests).toBe(4);
    const b = buildChatBody({ model: 'm', messages: [{ role: 'user', content: 'x' }], frequencyPenalty: 9 });
    expect('body' in b && b.body.frequency_penalty).toBe(1.5);
  });
});

describe('agent models and requests', () => {
  it('lists available text models with prices per million tokens', () => {
    const models = parseModels({
      data: [
        { id: 'zeta', context_length: 1048576, pricing: { prompt: '0.000001', completion: '0.000002' }, tags: ['vision'], available: true, modality: 'text', base_model: 'x/Y' },
        { id: 'alpha-thinking', context_length: 8192, available: true },
        { id: 'gone', available: false },
        { id: 'pic', modality: 'image' },
        { id: 'bad id with spaces' },
      ],
    });
    expect(models.map((m) => m.id)).toEqual(['alpha-thinking', 'zeta']);
    expect(models[1]).toMatchObject({ contextLength: 1048576, promptPrice: 1, completionPrice: 2, vision: true, baseModel: 'x/Y', thinking: false });
    expect(models[0].thinking).toBe(true);
    expect(formatContext(1048576)).toBe('1M');
    expect(formatContext(262144)).toBe('262K');
  });

  it('checks and caps what is sent', () => {
    expect('error' in buildChatBody({ model: 'x y', messages: [{ role: 'user', content: 'hi' }] })).toBe(true);
    expect('error' in buildChatBody({ model: 'm', messages: [] })).toBe(true);
    expect('error' in buildChatBody({ model: 'm', messages: [{ role: 'admin', content: 'hi' }] })).toBe(true);
    const ok = buildChatBody({ model: 'm', messages: [{ role: 'user', content: 'hi', extra: 'dropped' }], maxTokens: 999999, tools: [{ type: 'function', function: { name: 'f', description: '', parameters: {} } }] });
    if ('error' in ok) throw new Error(ok.error);
    expect(ok.body).toMatchObject({ model: 'm', stream: true, max_tokens: 131072, tool_choice: 'auto', messages: [{ role: 'user', content: 'hi' }] });
    expect((ok.body.messages as object[])[0]).not.toHaveProperty('extra');
  });

  it('turns service errors into messages', () => {
    expect(errorFromResponse(402, { error: { message: 'x', code: 'insufficient_quota' } }).code).toBe('quota');
    expect(errorFromResponse(404, {}).code).toBe('model');
    expect(errorFromResponse(400, { error: { message: 'tools unsupported' } }).error).toContain('tools unsupported');
    expect(errorFromResponse(503, null).code).toBe('unavailable');
  });
});

describe('agent edits', () => {
  it('replaces a unique string, and refuses missing or ambiguous ones', () => {
    expect(applyEdit('a b a', 'b', 'c')).toEqual({ text: 'a c a', count: 1 });
    expect('error' in applyEdit('a b a', 'a', 'c')).toBe(true);
    expect(applyEdit('a b a', 'a', 'c', true)).toEqual({ text: 'c b c', count: 2 });
    expect('error' in applyEdit('abc', 'x', 'y')).toBe(true);
    // "$&" in the replacement is literal text, not a pattern
    expect(applyEdit('x', 'x', '$&$&')).toEqual({ text: '$&$&', count: 1 });
  });

  it('matches a file with Windows line endings', () => {
    expect(applyEdit('one\r\ntwo\r\n', 'one\ntwo', 'uno\ndos')).toEqual({ text: 'uno\r\ndos\r\n', count: 1 });
  });

  it('finds the smallest change', () => {
    expect(minimalChange('hello world', 'hello there world')).toEqual({ from: 6, to: 6, insert: 'there ' });
    expect(minimalChange('same', 'same')).toBeNull();
  });

  it('diffs lines with context and gaps', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');
    const after = before.replace('line 10', 'line ten');
    const d = lineDiff(before, after, 2);
    expect(d.added).toBe(1);
    expect(d.removed).toBe(1);
    expect(d.lines[0].kind).toBe('gap');
    expect(d.lines.filter((l) => l.kind !== 'gap').map((l) => `${l.kind}:${l.text}`)).toEqual([
      'same:line 8',
      'same:line 9',
      'del:line 10',
      'add:line ten',
      'same:line 11',
      'same:line 12',
    ]);
    expect(lineDiff('', 'a\nb\n').added).toBe(2);
    expect(lineDiff('x', 'x').lines).toEqual([]);
  });
});

describe('agent panel layout', () => {
  it('never squashes the items of the conversation (a waiting request collapsed to its border, so Show showed nothing)', async () => {
    const { readFileSync } = await import('node:fs');
    const css = readFileSync('src/styles.css', 'utf8');
    expect(css).toMatch(/\.agent-messages > \*\s*\{\s*flex-shrink: 0;/);
  });
});

describe('agent context', () => {
  it('drops the oldest turns first and keeps tool calls with their results', () => {
    const big = 'x'.repeat(1000);
    const history: AgentMessage[] = [
      { role: 'user', content: big },
      { role: 'assistant', content: big },
      { role: 'user', content: 'q' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c', content: 'ok' },
    ];
    const { messages, dropped } = trimHistory(history, 500);
    expect(dropped).toBe(2);
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('frees a margin when it trims, so the start stays the same for a while', () => {
    const turn = (n: number): AgentMessage[] => [
      { role: 'user', content: `q${n}` + 'x'.repeat(95) },
      { role: 'assistant', content: 'y'.repeat(100) },
    ];
    const history = [1, 2, 3, 4, 5].flatMap(turn); // ~1000 characters
    const plain = trimHistory(history, 900);
    const roomy = trimHistory(history, 900, 0.25);
    expect(plain.dropped).toBeGreaterThan(0);
    expect(roomy.dropped).toBeGreaterThan(plain.dropped);
    expect(JSON.stringify(roomy.messages).length).toBeLessThan(JSON.stringify(plain.messages).length * 0.85);
    expect(roomy.messages[0].role).toBe('user');
    expect(trimHistory(history, 2000, 0.25).dropped).toBe(0); // under the limit: untouched
    // and by number of messages: oldest turns go, whole
    const many = trimHistory(history, 1e9, 0, 7);
    expect(many.messages.length).toBeLessThanOrEqual(7);
    expect(many.messages[0].role).toBe('user');
    expect(MAX_HISTORY_MESSAGES + 1).toBe(MAX_MESSAGES);
  });

  it('compacts finished turns: tool results and applied edit text become notes', () => {
    const file = 'line\n'.repeat(400);
    const edit = JSON.stringify({ path: 'a.ts', old_string: 'o'.repeat(500), new_string: 'n'.repeat(500) });
    const history: AgentMessage[] = [
      { role: 'user', content: 'fix it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'r', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'r', content: `a.ts: 400 lines\n\n${file}` },
      { role: 'assistant', content: null, tool_calls: [{ id: 'e', type: 'function', function: { name: 'edit_file', arguments: edit } }] },
      { role: 'tool', tool_call_id: 'e', content: 'Applied.' },
      { role: 'assistant', content: 'Done.' },
      { role: 'user', content: 'now this' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'r2', type: 'function', function: { name: 'read_file', arguments: '{"path":"a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'r2', content: file },
    ];
    const { history: out, saved } = compactHistory(history);
    expect(saved).toBeGreaterThan(2500);
    expect(out[2].content).toMatch(/^\[earlier result, 2,\d{3} characters, left out.*a\.ts: 400 lines/);
    const args = JSON.parse((out[3] as Extract<AgentMessage, { role: 'assistant' }>).tool_calls![0].function.arguments) as Record<string, string>;
    expect(args).toEqual({ path: 'a.ts', old_string: '[500 characters, already applied]', new_string: '[500 characters, already applied]' });
    expect(out[4].content).toBe('Applied.');
    expect(out[8].content).toBe(file); // the current turn is whole
    // compacting again changes nothing (the start of the conversation stays the same)
    expect(compactHistory(out).saved).toBe(0);
  });
});

// ── tools against an in-memory folder and a fake code tab ──────────────────
function fakeEditor(name: string, text: string, extra: Partial<CodeEditorAccess> = {}): CodeEditorAccess & { text: string } {
  const ed: CodeEditorAccess & { text: string } = {
    tabId: 1,
    name,
    text,
    getText: (): string => ed.text,
    getSelection: () => null,
    setText: (t: string) => {
      ed.text = t;
    },
    insert: () => undefined,
    ...extra,
  };
  return ed;
}

const call = (name: string, args: unknown) => ({ id: 'c1', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('agent tools', () => {
  let files: Map<string, Blob>;
  let ws: AgentWorkspace;
  let open: (CodeEditorAccess & { text: string }) | null;
  let approved: EditProposal[];
  let answer: boolean;
  const host = () => ({
    ws: () => ws,
    budget: 50_000,
    confirm: async (p: EditProposal) => {
      approved.push(p);
      return answer;
    },
  });
  const text = async (path: string) => (await files.get(path)?.text()) ?? null;

  beforeEach(() => {
    files = new Map([
      ['src/a.ts', new Blob(['export const a = 1;\n'])],
      ['src/b.ts', new Blob(['import { a } from "./a";\nconsole.log(a);\n'])],
      ['node_modules/x/index.js', new Blob(['const a = 1;'])],
      ['logo.png', new Blob([new Uint8Array([0x89, 0x50, 0, 0])])],
    ]);
    const folder = memoryFolder('proj', files, true);
    open = fakeEditor('b.ts', 'import { a } from "./a";\nconsole.log(a); // unsaved\n', { folderId: folder.id, path: 'src/b.ts' });
    approved = [];
    answer = true;
    ws = {
      folder,
      active: open,
      editorFor: (p) => (p === 'src/b.ts' ? open : null),
      openElsewhere: () => false,
      folderChanged: () => undefined,
    };
  });

  it('answers a repeated, unchanged read of the same turn with a short note', async () => {
    const h = { ...host(), readCache: new Map<string, string>() };
    const first = await runTool(call('read_file', { path: 'src/a.ts' }), h);
    expect(first.result).toContain('export const a = 1;');
    expect((await runTool(call('read_file', { path: 'src/a.ts' }), h)).result).toMatch(/unchanged since you read it/);
    files.set('src/a.ts', new Blob(['export const a = 2;\n']));
    expect((await runTool(call('read_file', { path: 'src/a.ts' }), h)).result).toContain('export const a = 2;');
  });

  it('deletes, renames and moves files only with permission', async () => {
    const asked: string[] = [];
    let allow = false;
    const renamed: [string, string][] = [];
    ws.renamed = (a, b) => renamed.push([a, b]);
    const h = { ...host(), actions: { budget: 50_000, permit: async (r: { title: string }) => (asked.push(r.title), allow) } };
    const denied = await runTool(call('delete_file', { path: 'src/a.ts' }), h);
    expect(denied.result).toMatch(/did not allow/);
    expect(files.has('src/a.ts')).toBe(true);
    allow = true;
    expect((await runTool(call('delete_file', { path: 'src/a.ts' }), h)).result).toMatch(/^Deleted src\/a\.ts/);
    expect(files.has('src/a.ts')).toBe(false);
    expect((await runTool(call('rename_file', { path: 'src/b.ts', new_path: 'src/main.ts' }), h)).result).toBe('Renamed src/b.ts to src/main.ts.');
    expect((await runTool(call('rename_file', { path: 'src/main.ts', new_path: 'lib/deep/main.ts' }), h)).result).toBe('Moved src/main.ts to lib/deep/main.ts.');
    expect(await text('lib/deep/main.ts')).toContain('console.log(a);');
    expect(files.has('src/main.ts')).toBe(false);
    expect(renamed).toEqual([['src/b.ts', 'src/main.ts'], ['src/main.ts', 'lib/deep/main.ts']]);
    expect(asked).toEqual(['Delete src/a.ts', 'Delete src/a.ts', 'Rename src/b.ts to main.ts', 'Move src/main.ts to lib/deep/main.ts']);
    expect((await runTool(call('delete_file', { path: 'nope.ts' }), h)).result).toMatch(/does not exist/);
    // Chat mode, or permissions turned off
    expect((await runTool(call('delete_file', { path: 'logo.png' }), { ...h, readOnly: true })).result).toMatch(/Chat mode/);
    const off = { ...host(), actions: { budget: 1000, permit: () => Promise.reject(new Error('“Delete and rename files” is turned off')) } };
    expect((await runTool(call('delete_file', { path: 'logo.png' }), off)).result).toMatch(/turned off/);
    expect((await runTool(call('delete_file', { path: 'logo.png' }), host())).result).toMatch(/isn't available/);
  });

  it('runs commands and reads the web through the desktop bridge', async () => {
    (ws.folder as { desktopId?: string }).desktopId = 'f1';
    const runs: unknown[] = [];
    const out: string[] = [];
    const actions = {
      run: async (_id: string, req: unknown) => (runs.push(req), { ok: true as const, exitCode: 1, signal: null, timedOut: false, cancelled: false, output: '1 failed\n', cut: 0, durationMs: 1234, shell: 'sh' }),
      onRunOutput: (cb: (id: string, c: string) => void) => (cb('other', 'x'), () => undefined),
      webSearch: async () => ({ ok: true as const, results: [{ title: 'Vitest', url: 'https://vitest.dev', snippet: 'fast' }] }),
      fetchUrl: async () => ({ ok: true as const, url: 'https://vitest.dev/', status: 200, contentType: 'text/html', title: 'Vitest', text: 'x'.repeat(3000), links: [{ text: 'Guide', url: 'https://vitest.dev/guide' }], truncated: false }),
    };
    const h = { ...host(), actions: { budget: 1000, actions, onOutput: (c: string) => out.push(c), permit: async () => true } };
    const ran = await runTool(call('run_command', { command: 'npm test', cwd: './src/', timeout_seconds: 30 }), h);
    expect(runs).toEqual([{ folderId: 'f1', command: 'npm test', cwd: 'src', timeoutSeconds: 30 }]);
    expect(ran.result).toBe('$ npm test\n(exit code 1, 1.2 s)\n\n1 failed');
    expect(ran.activity).toMatchObject({ label: 'Ran npm test — exit code 1', error: true });
    expect(out).toEqual([]); // output of another command isn't shown here
    expect((await runTool(call('web_search', { query: 'vitest' }), h)).result).toBe('Results for “vitest”:\n1. Vitest\n   https://vitest.dev\n   fast');
    const page = await runTool(call('fetch_url', { url: 'https://vitest.dev/' }), h);
    expect(page.result).toMatch(/^Vitest\nhttps:\/\/vitest\.dev\/\n\nx+/);
    expect(page.result).toMatch(/read on with start_char=\d+/);
    expect(page.result).toContain('- Guide: https://vitest.dev/guide');
  });

  it('lists the folder without entering dependency folders', async () => {
    const { result } = await runTool(call('list_files', {}), host());
    expect(result).toContain('node_modules/ (not listed)');
    expect(result).toContain('  a.ts');
    expect(result).not.toContain('index.js');
  });

  it('reads files from disk, or from the open tab with unsaved changes', async () => {
    expect((await runTool(call('read_file', { path: 'src/a.ts' }), host())).result).toContain('export const a = 1;');
    expect((await runTool(call('read_file', { path: './src/b.ts' }), host())).result).toContain('// unsaved');
    expect((await runTool(call('read_file', { path: 'logo.png' }), host())).result).toMatch(/not a text file/);
    expect((await runTool(call('read_file', { path: '../etc/passwd' }), host())).result).toMatch(/^Error/);
  });

  it('searches text files, skipping dependencies', async () => {
    const { result } = await runTool(call('search_files', { query: 'const a' }), host());
    expect(result).toBe('src/a.ts:1: export const a = 1;');
  });

  it('edits a file on disk only once the user approves', async () => {
    answer = false;
    const rejected = await runTool(call('edit_file', { path: 'src/a.ts', old_string: '= 1', new_string: '= 2' }), host());
    expect(rejected.result).toMatch(/rejected/);
    expect(await text('src/a.ts')).toBe('export const a = 1;\n');
    answer = true;
    const ok = await runTool(call('edit_file', { path: 'src/a.ts', old_string: '= 1', new_string: '= 2' }), host());
    expect(ok.activity.error).toBeUndefined();
    expect(approved[1].diff.added).toBe(1);
    expect(await text('src/a.ts')).toBe('export const a = 2;\n');
  });

  it('edits an open file in its tab, not on disk', async () => {
    await runTool(call('edit_file', { path: 'src/b.ts', old_string: '// unsaved', new_string: '// edited' }), host());
    expect(open!.text).toContain('// edited');
    expect(await text('src/b.ts')).not.toContain('edited');
  });

  it('creates new files and their folders', async () => {
    const r = await runTool(call('write_file', { path: 'src/util/new.ts', content: 'export {};\n' }), host());
    expect(r.result).toMatch(/^Created src\/util\/new.ts/);
    expect(approved[0].isNew).toBe(true);
    expect(await text('src/util/new.ts')).toBe('export {};\n');
  });

  it('reports a bad edit to the model instead of applying it', async () => {
    const r = await runTool(call('edit_file', { path: 'src/a.ts', old_string: 'nope', new_string: 'x' }), host());
    expect(r.result).toMatch(/not found/);
    expect(approved).toHaveLength(0);
  });

  it('in Chat mode reads files but does not change them, and maps the folder', async () => {
    expect(READ_TOOLS.map((t) => t.function.name)).toEqual(['list_files', 'read_file', 'search_files']);
    const chat = { ...host(), readOnly: true };
    expect((await runTool(call('read_file', { path: 'src/a.ts' }), chat)).result).toContain('export const a = 1;');
    const refused = await runTool(call('edit_file', { path: 'src/a.ts', old_string: '= 1', new_string: '= 2' }), chat);
    expect(refused.result).toMatch(/Chat mode.*Agent mode/s);
    expect(approved).toHaveLength(0);
    expect(await text('src/a.ts')).toBe('export const a = 1;\n');
    const map = await folderOverview(ws.folder!);
    expect(map).toContain('src/\n  a.ts');
    expect(map).toContain('node_modules/ (dependencies; not listed)');
    expect(map).not.toContain('index.js');
  });

  it('works on the one open file when no folder is open', async () => {
    const solo = fakeEditor('notes.py', 'print(1)\n');
    ws = { folder: null, active: solo, editorFor: () => null, openElsewhere: () => false, folderChanged: () => undefined };
    await runTool(call('edit_file', { path: 'notes.py', old_string: '1', new_string: '2' }), host());
    expect(solo.text).toBe('print(2)\n');
    expect((await runTool(call('read_file', { path: 'other.py' }), host())).result).toMatch(/Only the open file/);
  });
});

// ── the main process: licensed copies only, through the license server ──────
describe('agent requests (main process)', () => {
  it('sends nothing without a license, then goes to the license server with the token', async () => {
    vi.resetModules();
    const fetch = vi.fn();
    vi.doMock('electron', () => ({
      app: { isPackaged: false, getVersion: () => '0.0.0' },
      session: { fromPartition: () => ({ fetch, setPermissionRequestHandler: () => undefined, webRequest: { onBeforeRequest: () => undefined } }) },
    }));
    const state = { active: false };
    const refresh = vi.fn(async () => undefined);
    vi.doMock('../electron/license', () => ({
      apiBase: () => 'https://license.example.test',
      getLicenseState: async () => ({ status: state.active ? 'active' : 'unlicensed', purchaseUrl: 'https://license.example.test' }),
      licenseCredentials: async () => (state.active ? { token: 'FE1.tok.sig', deviceId: 'd'.repeat(64) } : null),
      refreshLicenseStatus: refresh,
    }));
    const agent = await import('../electron/agent');
    const sender = { send: vi.fn(), isDestroyed: () => false } as never;
    const req = { model: 'm', messages: [{ role: 'user', content: 'hi' }], maxTokens: 999999 };

    expect(await agent.agentStatus()).toEqual({ licensed: false, purchaseUrl: 'https://license.example.test' });
    expect(await agent.chat(sender, 'r1', req)).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(await agent.listModels()).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(await agent.makeImage('i0', { mode: 'generate', model: 'z', prompt: 'x' })).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(await agent.imageModels()).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(fetch).not.toHaveBeenCalled();

    state.active = true;
    const sse = 'data: {"choices":[{"delta":{"content":"Hi"}}]}\n\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n';
    fetch.mockResolvedValueOnce(new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } }));
    const res = await agent.chat(sender, 'r2', req);
    expect(res).toMatchObject({ ok: true, message: { content: 'Hi' }, finishReason: 'stop' });
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit & { headers: Record<string, string> }];
    expect(url).toBe('https://license.example.test/api/agent/chat');
    expect(init.headers).not.toHaveProperty('Authorization');
    const sent = JSON.parse(String(init.body));
    expect(sent).toMatchObject({ token: 'FE1.tok.sig', deviceId: 'd'.repeat(64), request: { model: 'm', maxTokens: 131072 } });
    expect((sender as unknown as { send: ReturnType<typeof vi.fn> }).send).toHaveBeenCalledWith('agent-delta', 'r2', { content: 'Hi' });

    // the server's refusals are shown as it words them; a lost license is re-checked
    fetch.mockResolvedValueOnce(Response.json({ error: "You've reached today's limit.", code: 'daily-limit' }, { status: 429 }));
    expect(await agent.chat(sender, 'r3', req)).toEqual({ ok: false, code: 'quota', error: "You've reached today's limit." });
    fetch.mockResolvedValueOnce(Response.json({ error: 'This license was revoked.', code: 'revoked' }, { status: 403 }));
    expect(await agent.chat(sender, 'r4', req)).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(refresh).toHaveBeenCalledWith(true);

    // a model stuck repeating itself is stopped mid-stream (aborting the request) and reported
    let aborted = false;
    fetch.mockImplementationOnce(async (_url: string, init: RequestInit) => {
      init.signal?.addEventListener('abort', () => (aborted = true));
      const piece = `data: ${JSON.stringify({ choices: [{ delta: { reasoning_content: '!'.repeat(100) } }] })}\n\n`;
      let n = 0;
      const body = new ReadableStream({
        pull(c) {
          if (aborted) return c.error(new Error('aborted'));
          if (n++ > 200) return c.close();
          c.enqueue(new TextEncoder().encode(piece));
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });
    expect(await agent.chat(sender, 'r5', req)).toMatchObject({ ok: false, code: 'loop' });
    expect(aborted).toBe(true);

    // AI pictures: sent to the license server, answered as image bytes with usage in a header
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2]);
    fetch.mockResolvedValueOnce(
      new Response(png, { status: 200, headers: { 'content-type': 'image/png', 'x-fe-model': 'qwen-image-3-edit', 'x-fe-cost': '0.03', 'x-fe-usage': JSON.stringify({ requests: 1, tokens: 5, dailyRequests: 300, dailyTokens: 1000, images: 4, dailyImages: 20, resetsAt: '', paused: false }) } }),
    );
    const pic = await agent.makeImage('i1', { mode: 'edit', model: 'qwen-image-3-edit', prompt: 'purple sky', image: 'data:image/png;base64,AAAA' });
    expect(pic).toMatchObject({ ok: true, mime: 'image/png', model: 'qwen-image-3-edit', costUsd: 0.03, today: { images: 4, dailyImages: 20 } });
    expect(pic.ok && Array.from(pic.bytes)).toEqual(Array.from(png));
    const [picUrl, picInit] = fetch.mock.calls[fetch.mock.calls.length - 1] as [string, RequestInit];
    expect(picUrl).toBe('https://license.example.test/api/agent/image');
    expect(JSON.parse(String(picInit.body))).toMatchObject({ token: 'FE1.tok.sig', request: { mode: 'edit', model: 'qwen-image-3-edit', prompt: 'purple sky', image: 'data:image/png;base64,AAAA' } });
    fetch.mockResolvedValueOnce(Response.json({ error: "You've reached today's limit of 20 AI images.", code: 'daily-limit' }, { status: 429 }));
    expect(await agent.makeImage('i2', { mode: 'generate', model: 'z', prompt: 'x' })).toMatchObject({ ok: false, code: 'quota', error: "You've reached today's limit of 20 AI images." });
  });
});

describe('attachments and pictures', async () => {
  const { composeMessage, fileAttachment } = await import('../src/ui/agent/attachments');
  const { estimateTokens, limitImages, IMAGE_TOKENS } = await import('../src/core/agent/context');
  const pic = 'data:image/png;base64,iVBORw0KGgo=';

  it('puts attached files before the words, and pictures after them', () => {
    expect(composeMessage('fix it', [fileAttachment('a.ts', 'let x = 1;', 'src/a.ts')], 1000)).toBe('Attached file src/a.ts:\n```\nlet x = 1;\n```\n\nfix it');
    const withPic = composeMessage('what is this?', [{ id: 'i', kind: 'image', name: 'shot.png', dataUrl: pic }], 1000);
    expect(withPic).toEqual([{ type: 'text', text: 'what is this?' }, { type: 'image_url', image_url: { url: pic } }]);
    const long = composeMessage('x', [fileAttachment('big.txt', 'line\n'.repeat(1000))], 200);
    expect(typeof long === 'string' && long).toContain('the rest was cut to fit');
  });

  it('sends well-formed pictures and refuses others', () => {
    const ok = buildChatBody({ model: 'm', messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: pic } }] }] });
    expect('body' in ok && (ok.body.messages as { content: unknown }[])[0].content).toEqual([{ type: 'text', text: 'hi' }, { type: 'image_url', image_url: { url: pic } }]);
    expect('error' in buildChatBody({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://x.test/a.png' } }] }] })).toBe(true);
    expect('error' in buildChatBody({ model: 'm', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:text/html;base64,PGI+' } }] }] })).toBe(true);
    const nine = Array.from({ length: 9 }, () => ({ type: 'image_url', image_url: { url: pic } }));
    expect('error' in buildChatBody({ model: 'm', messages: [{ role: 'user', content: nine }] })).toBe(true);
  });

  it('keeps only the newest pictures, and counts pictures in the context estimate', () => {
    const msg = (n: number): AgentMessage => ({ role: 'user', content: [{ type: 'text', text: `turn ${n}` }, { type: 'image_url', image_url: { url: pic } }] });
    const limited = limitImages([msg(1), msg(2), msg(3)], 2);
    expect(limited.map((m) => (m.content as { type: string }[]).map((p) => p.type).join(','))).toEqual(['text,text', 'text,image_url', 'text,image_url']);
    const textOnly = estimateTokens('', [{ role: 'user', content: 'turn 1' }]);
    expect(estimateTokens('', [msg(1)]) - textOnly).toBeGreaterThanOrEqual(IMAGE_TOKENS - 10);
  });
});
