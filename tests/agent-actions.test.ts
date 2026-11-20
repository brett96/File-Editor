// @vitest-environment node
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PERMISSIONS, decision, parsePermissions, toolCapability } from '../src/core/agent/permissions';
import { capOutput, htmlToText, isLocalHostName, isPrivateAddress, parseDuckDuckGo, stripAnsi } from '../src/core/agent/web';
import { capabilityNote, extraTools } from '../src/ui/agent/actions';

describe('agent permissions', () => {
  it('reads stored settings with defaults', () => {
    expect(parsePermissions(null)).toEqual(DEFAULT_PERMISSIONS);
    expect(parsePermissions('{"files":"auto","commands":"nope","web":"session"}')).toEqual({ files: 'auto', commands: 'ask', web: 'session' });
    expect(parsePermissions('not json')).toEqual(DEFAULT_PERMISSIONS);
  });

  it('decides between asking, allowing and refusing', () => {
    expect(decision('off', true)).toBe('off');
    expect(decision('auto', false)).toBe('allow');
    expect(decision('ask', true)).toBe('ask');
    expect(decision('session', false)).toBe('ask');
    expect(decision('session', true)).toBe('allow');
    expect(toolCapability('run_command')).toBe('commands');
    expect(toolCapability('rename_file')).toBe('files');
    expect(toolCapability('fetch_url')).toBe('web');
    expect(toolCapability('read_file')).toBeNull();
  });

  it('offers only the tools that are on and possible, and says so', () => {
    const can = { files: true, commands: false, web: true };
    const names = extraTools({ files: 'ask', commands: 'auto', web: 'off' }, can).map((t) => t.function.name);
    expect(names).toEqual(['delete_file', 'rename_file']);
    const note = capabilityNote({ files: 'ask', commands: 'auto', web: 'off' }, can);
    expect(note).toMatch(/You can also delete and rename files/);
    expect(note).toMatch(/may be asked/);
    expect(note).toMatch(/You cannot run commands or tests, go online/);
    expect(capabilityNote({ files: 'off', commands: 'off', web: 'auto' }, { files: false, commands: false, web: true }, 'chat')).toBe('You can also search the web and read pages (web_search, fetch_url).');
  });
});

describe('agent web helpers', () => {
  it('reads DuckDuckGo results and skips ads', () => {
    const html = `
      <div class="result result--ad"><a class="result__a" href="https://duckduckgo.com/y.js?ad=1">Ad</a></div>
      <div class="result"><h2><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fvitest.dev%2Fguide%2F&amp;rut=x">Getting <b>Started</b> | Vitest</a></h2>
      <a class="result__snippet" href="x">Vitest is a <b>fast</b> test runner &amp; more.</a></div>
      <div class="result"><a class="result__a" href="https://example.org/page">Example</a></div>`;
    expect(parseDuckDuckGo(html)).toEqual([
      { title: 'Getting Started | Vitest', url: 'https://vitest.dev/guide/', snippet: 'Vitest is a fast test runner & more.' },
      { title: 'Example', url: 'https://example.org/page', snippet: '' },
    ]);
  });

  it('turns a page into text with its links', () => {
    const page = htmlToText(
      '<html><head><title>Docs &amp; more</title><style>p{}</style></head><body><script>x()</script><h1>Intro</h1><p>Hello <a href="/a">there</a>.</p><ul><li>one</li><li>two</li></ul><pre>  code\n  kept</pre></body></html>',
      'https://site.test/docs/',
    );
    expect(page.title).toBe('Docs & more');
    expect(page.text).toBe('# Intro\n\nHello there.\n\n- one\n- two\n\n  code\n  kept');
    expect(page.links).toEqual([{ text: 'there', url: 'https://site.test/a' }]);
  });

  it('knows private addresses', () => {
    for (const a of ['127.0.0.1', '10.1.2.3', '192.168.0.5', '172.20.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd00::2', '::ffff:127.0.0.1', '[::1]']) expect(isPrivateAddress(a), a).toBe(true);
    for (const a of ['8.8.8.8', '172.32.0.1', '2606:4700::1111', '93.184.216.34']) expect(isPrivateAddress(a), a).toBe(false);
    expect(isLocalHostName('localhost')).toBe(true);
    expect(isLocalHostName('printer.local')).toBe(true);
    expect(isLocalHostName('example.com')).toBe(false);
  });

  it('cuts long output keeping its end, and drops terminal codes', () => {
    const { text, cut } = capOutput('a'.repeat(500) + 'END', 100);
    expect(cut).toBe(403);
    expect(text.endsWith('END')).toBe(true);
    expect(stripAnsi('\u001b[32m✓ passed\u001b[0m\rline')).toBe('✓ passed\nline');
  });
});

// ── the main process: commands and the web ─────────────────────────────────
describe('agent actions (main process)', () => {
  const handlers = new Map<string, (...a: unknown[]) => unknown>();
  const listeners = new Map<string, (...a: unknown[]) => unknown>();
  const state = { licensed: true };
  let root = '';
  let actions: typeof import('../electron/agent-actions');
  const sender = { send: vi.fn(), isDestroyed: () => false };
  const event = { sender };
  const call = (name: string, ...args: unknown[]) => handlers.get(name)!(event, ...args) as Promise<Record<string, unknown>>;

  beforeAll(async () => {
    vi.doMock('electron', () => ({
      ipcMain: {
        handle: (n: string, f: (...a: unknown[]) => unknown) => handlers.set(n, f),
        on: (n: string, f: (...a: unknown[]) => unknown) => listeners.set(n, f),
      },
    }));
    vi.doMock('../electron/license', () => ({ licenseCredentials: async () => (state.licensed ? { token: 't', deviceId: 'd' } : null) }));
    root = await mkdtemp(join(tmpdir(), 'fe-agent-'));
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'sub', 'hello.txt'), 'hi from the file\n');
    actions = await import('../electron/agent-actions');
    actions.registerAgentActions({
      assertSender: () => undefined,
      folderRoot: (id) => {
        if (id !== 'f1') throw new Error('This folder is no longer open.');
        return root;
      },
      pathInside: async (r, rel) => {
        const parts = String(rel ?? '').split('/').filter(Boolean);
        if (parts.some((p) => p === '..')) throw new Error('That is not a path inside the folder.');
        return resolve(r, ...parts);
      },
    });
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const posix = process.platform !== 'win32';

  it.runIf(posix)('runs a command in the folder and reports its output and exit code', async () => {
    const res = await call('agent-run', 'op1', { folderId: 'f1', command: 'cat hello.txt; echo oops >&2; exit 3', cwd: 'sub' });
    expect(res).toMatchObject({ ok: true, exitCode: 3, timedOut: false, cancelled: false });
    expect(res.output).toContain('hi from the file');
    expect(res.output).toContain('oops');
    expect(sender.send).toHaveBeenCalledWith('agent-run-output', 'op1', expect.any(String));
  });

  it.runIf(posix)('stops at the time limit and on Stop', async () => {
    const slow = await call('agent-run', 'op2', { folderId: 'f1', command: 'echo start; sleep 30', timeoutSeconds: 1 });
    expect(slow).toMatchObject({ ok: true, timedOut: true });
    expect(slow.output).toContain('start');
    const running = call('agent-run', 'op3', { folderId: 'f1', command: 'sleep 30' });
    await new Promise((r) => setTimeout(r, 200));
    listeners.get('agent-run-cancel')!(event, 'op3');
    expect(await running).toMatchObject({ ok: true, cancelled: true });
  }, 15_000);

  it('refuses folders that are not open, paths outside, and unlicensed copies', async () => {
    expect(await call('agent-run', 'op4', { folderId: 'nope', command: 'echo x' })).toMatchObject({ ok: false, code: 'invalid' });
    expect(await call('agent-run', 'op5', { folderId: 'f1', command: 'echo x', cwd: '../..' })).toMatchObject({ ok: false });
    expect(await call('agent-run', 'op6', { folderId: 'f1', command: '  ' })).toMatchObject({ ok: false, code: 'invalid' });
    state.licensed = false;
    expect(await call('agent-run', 'op7', { folderId: 'f1', command: 'echo x' })).toMatchObject({ ok: false, code: 'unlicensed' });
    expect(await call('agent-web-search', 'x')).toMatchObject({ ok: false, code: 'unlicensed' });
    state.licensed = true;
  });

  it('does not open pages on this computer or the local network', async () => {
    for (const url of ['http://localhost:5173/', 'http://127.0.0.1/', 'http://[::1]/', 'http://192.168.1.1/admin', 'http://169.254.169.254/latest', 'file:///etc/passwd', 'http://user:pw@example.com/']) {
      const res = await call('agent-fetch-url', url);
      expect(res.ok, url).toBe(false);
    }
    // a name that resolves to this computer is refused on the address it resolves to
    expect(await call('agent-fetch-url', 'http://localtest.me/')).toMatchObject({ ok: false });
  });
});
