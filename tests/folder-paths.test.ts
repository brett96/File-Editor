import { describe, expect, it } from 'vitest';
import { dirOf, isSafeName, joinPath, leafOf, referenceKind, resolveReference, safeSegments } from '../src/core/web/paths';
import { folderFromFileList, memoryFolder } from '../src/platform/folders';

describe('folder-relative paths', () => {
  it('accepts clean relative paths only', () => {
    expect(safeSegments('')).toEqual([]);
    expect(safeSegments('src/app/main.ts')).toEqual(['src', 'app', 'main.ts']);
    for (const bad of ['/etc/passwd', '../secret', 'a/../../b', 'a//b', 'a/./b', 'C:/Windows', 'a\\b', 'a/b/', 'x\u0000y', 'a/..', 42, null, undefined, 'a'.repeat(5000)]) {
      expect(safeSegments(bad), String(bad).slice(0, 20)).toBeNull();
    }
  });

  it('accepts single file names only', () => {
    for (const ok of ['index.html', '.gitignore', 'my file (1).txt', 'Dockerfile']) expect(isSafeName(ok), ok).toBe(true);
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'a:b', 'what?', 'trailing.', 'trailing ', 'x'.repeat(300)]) expect(isSafeName(bad), bad).toBe(false);
  });

  it('joins and splits', () => {
    expect(joinPath('', 'a.txt')).toBe('a.txt');
    expect(joinPath('src', 'a.txt')).toBe('src/a.txt');
    expect(dirOf('src/ui/a.txt')).toBe('src/ui');
    expect(dirOf('a.txt')).toBe('');
    expect(leafOf('src/ui/a.txt')).toBe('a.txt');
  });

  it('resolves references the way a browser would, but never out of the folder', () => {
    expect(resolveReference('pages/about.html', 'style.css')).toBe('pages/style.css');
    expect(resolveReference('pages/about.html', './img/a%20b.png?v=3#x')).toBe('pages/img/a b.png');
    expect(resolveReference('pages/about.html', '../css/site.css')).toBe('css/site.css');
    expect(resolveReference('pages/about.html', '/css/site.css')).toBe('css/site.css');
    expect(resolveReference('index.html', '../outside.css')).toBeNull();
    expect(resolveReference('pages/about.html', '../../outside.css')).toBeNull();
    expect(resolveReference('index.html', '#top')).toBeNull();
    expect(resolveReference('index.html', '')).toBeNull();
  });

  it('tells relative, remote and inline references apart', () => {
    expect(referenceKind('img/a.png')).toBe('relative');
    expect(referenceKind('/img/a.png')).toBe('relative');
    expect(referenceKind('https://example.com/a.png')).toBe('remote');
    expect(referenceKind('//cdn.example.com/a.js')).toBe('remote');
    expect(referenceKind('data:image/png;base64,AA')).toBe('inline');
    expect(referenceKind('#section')).toBe('inline');
    expect(referenceKind('mailto:a@example.com')).toBe('inline');
  });
});

describe('in-memory folders', () => {
  const make = (canWrite = true) =>
    memoryFolder(
      'site',
      new Map([
        ['index.html', new Blob(['<p>hi</p>'])],
        ['css/main.css', new Blob(['body{}'])],
        ['node_modules/pkg/index.js', new Blob([''])],
      ]),
      canWrite,
    );

  it('lists one level at a time, folders first, and marks dependency folders', async () => {
    const f = make();
    expect(await f.list('')).toEqual([
      { name: 'css', path: 'css', kind: 'dir' },
      { name: 'node_modules', path: 'node_modules', kind: 'dir', ignored: true },
      { name: 'index.html', path: 'index.html', kind: 'file' },
    ]);
    expect((await f.list('css')).map((e) => e.path)).toEqual(['css/main.css']);
    await expect(f.list('../x')).rejects.toThrow();
  });

  it('opens, reads, creates, renames and removes', async () => {
    const f = make();
    const opened = await f.open('css/main.css');
    expect(opened.name).toBe('main.css');
    expect(opened.folder).toEqual({ folder: f, path: 'css/main.css' });
    expect(await f.read('missing.txt')).toBeNull();
    await f.createFile('css/extra.css', new TextEncoder().encode('p{}'));
    expect(await (await f.read('css/extra.css'))!.text()).toBe('p{}');
    await expect(f.createFile('css/extra.css')).rejects.toThrow(/already exists/);
    await f.createDir('img');
    expect((await f.list('')).map((e) => e.name)).toContain('img');
    expect(await f.rename('css', 'styles')).toBe('styles');
    expect((await f.list('styles')).map((e) => e.path).sort()).toEqual(['styles/extra.css', 'styles/main.css']);
    await f.remove('styles');
    expect((await f.list('')).map((e) => e.name)).not.toContain('styles');
    await expect(f.createFile('bad:name.txt')).rejects.toThrow();
  });

  it('refuses changes to a read-only folder', async () => {
    const f = make(false);
    await expect(f.createFile('x.txt')).rejects.toThrow(/read-only/);
    await expect(f.remove('index.html')).rejects.toThrow(/read-only/);
    expect(await f.read('index.html')).not.toBeNull();
  });

  it('builds a folder from a directory input, dropping the picked folder’s own name', async () => {
    const file = (rel: string) => Object.assign(new Blob(['x']), { name: rel.split('/').pop()!, webkitRelativePath: rel }) as unknown as File;
    const f = folderFromFileList([file('proj/index.html'), file('proj/src/a.js')])!;
    expect(f.name).toBe('proj');
    expect(f.canWrite).toBe(false);
    expect((await f.list('')).map((e) => e.path)).toEqual(['src', 'index.html']);
    expect(folderFromFileList([])).toBeNull();
  });
});
