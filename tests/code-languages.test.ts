// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { CODE_EXTENSIONS, isCodeFileName, languageLabel, needsBuildStep } from '../src/core/code/languages';
import { canSaveAs, ownedExtensions, saveNameProblem } from '../src/core/conversions';
import { sniffMedia } from '../src/core/media/media-formats';
import { FORMATS, formatFromExtension, openDocument, sniffFormat } from '../src/core/registry';
import { utf8Encode } from '../src/core/dom';

describe('source-code files', () => {
  it('knows languages by extension and by file name', () => {
    expect(languageLabel('src/main.ts')).toBe('TypeScript');
    expect(languageLabel('App.tsx')).toBe('TypeScript (TSX)');
    expect(languageLabel('script.py')).toBe('Python');
    expect(languageLabel('Dockerfile')).toBe('Dockerfile');
    expect(languageLabel('Dockerfile.dev')).toBe('Dockerfile');
    expect(languageLabel('Makefile')).toBe('Makefile');
    expect(languageLabel('.env.local')).toBe('INI / properties');
    expect(languageLabel('.gitignore')).toBe('Git file');
    expect(languageLabel('index.html')).toBe('HTML');
    expect(languageLabel('mystery.xyz')).toBe('Plain text');
    for (const name of ['a.json', 'b.yaml', 'c.rs', 'd.go', 'e.java', 'f.cpp', 'g.cs', 'h.php', 'i.rb', 'j.sql', 'k.sh', 'Makefile', '.editorconfig', 'x.vue']) {
      expect(isCodeFileName(name), name).toBe(true);
    }
    // these keep their own editors
    for (const name of ['notes.txt', 'README.md', 'page.html', 'site.css', 'app.js', 'photo.png', 'book.xlsx', 'LICENSE']) {
      expect(isCodeFileName(name), name).toBe(false);
    }
    expect(new Set(CODE_EXTENSIONS).size).toBe(CODE_EXTENSIONS.length);
  });

  it('knows what a browser cannot run without a build step', () => {
    expect(needsBuildStep('src/app.ts')).toBe(true);
    expect(needsBuildStep('theme.scss')).toBe(true);
    expect(needsBuildStep('app.js')).toBe(false);
    expect(needsBuildStep('site.css')).toBe(false);
  });

  it('sniffs source files as the code format and keeps unknown text as plain text', async () => {
    expect(formatFromExtension('main.py')).toBe('code');
    expect(formatFromExtension('Dockerfile')).toBe('code');
    expect(formatFromExtension('index.html')).toBe('html');
    expect((await sniffFormat('main.ts', utf8Encode('export const x: number = 1;\n'))).format).toBe('code');
    expect((await sniffFormat('notes', utf8Encode('hello'))).format).toBe('txt');
    expect((await sniffFormat('data.unknownext', utf8Encode('hello'))).format).toBe('txt');
    const binary = await sniffFormat('clip.ts', new Uint8Array([0x47, 0, 0, 0, 1, 2, 3]));
    expect(binary.format).toBeNull();
  });

  it('opens a source file as text with its language name', async () => {
    const res = await openDocument('tools/build.py', utf8Encode('print("hi")\n'));
    expect(res).toMatchObject({ kind: 'code', format: 'code', language: 'Python', text: 'print("hi")\n' });
    const web = await openDocument('index.html', utf8Encode('<p>x</p>'));
    expect(web).toMatchObject({ kind: 'code', format: 'html', language: 'HTML' });
  });

  it('does not mistake TypeScript for an MPEG transport stream', () => {
    const source = utf8Encode(`G${'x'.repeat(187)}G${'y'.repeat(300)}`);
    expect(sniffMedia('main.ts', source)).toBeNull();
    const stream = new Uint8Array(600);
    stream[0] = stream[188] = stream[376] = stream[564] = 0x47;
    expect(sniffMedia('clip.ts', stream)).toMatchObject({ kind: 'video', ext: 'ts' });
  });

  it('saves source code under its own extension only', () => {
    expect(ownedExtensions('py')).toEqual(['py']);
    expect(ownedExtensions('html')).toEqual(FORMATS.html.extensions);
    expect(canSaveAs('code', 'py')).toBe(true);
    expect(saveNameProblem('code', 'main.py', 'py', ['py'])).toBeNull();
    expect(saveNameProblem('code', 'main.rb', 'py', ['py'])).toMatch(/\.py/);
    expect(saveNameProblem('sheet', 'budget.py', 'xlsx', ['xlsx'])).not.toBeNull();
  });
});
