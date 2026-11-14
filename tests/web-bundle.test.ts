// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { bundleHtml, nearestPage, type ReadFile } from '../src/core/web/bundle';

const reader = (files: Record<string, string | Uint8Array>): ReadFile => async (path) => files[path] ?? null;
const b64 = (s: string) => Buffer.from(s).toString('base64');

describe('web preview bundler', () => {
  it('inlines stylesheets with their @imports and embeds url() assets', async () => {
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    const { html, warnings, files } = await bundleHtml(
      'site/index.html',
      reader({
        'site/index.html': '<!doctype html><html><head><link rel="stylesheet" href="css/main.css" media="screen"></head><body><p style="background:url(img/dot.png)">hi</p></body></html>',
        'site/css/main.css': '@import "base.css";\n@import url(print.css) print;\nbody { background: url("../img/dot.png") }',
        'site/css/base.css': 'html { color: red }',
        'site/css/print.css': 'p { display: none }',
        'site/img/dot.png': png,
      }),
    );
    expect(warnings).toEqual([]);
    expect(html).toMatch(/^<!DOCTYPE html>/);
    expect(html).not.toContain('<link');
    expect(html).toContain('<style media="screen"');
    expect(html).toContain('html { color: red }');
    expect(html).toContain('@media print {\np { display: none }\n}');
    const data = `data:image/png;base64,${Buffer.from(png).toString('base64')}`;
    // once from the stylesheet (resolved against the CSS file), once from the inline style
    expect(html.split(data).length - 1).toBe(2);
    expect(files).toEqual(expect.arrayContaining(['site/index.html', 'site/css/main.css', 'site/css/base.css', 'site/img/dot.png']));
  });

  it('inlines classic scripts and escapes a closing script tag in them', async () => {
    const { html } = await bundleHtml(
      'index.html',
      reader({
        'index.html': '<html><body><script src="./app.js"></script></body></html>',
        'app.js': 'document.write("<script>1</script>"); window.ran = true;',
      }),
    );
    expect(html).not.toContain('<script src=');
    expect(html).toContain('data-src="./app.js"');
    expect(html).toContain('document.write("<script>1<\\/script>"); window.ran = true;');
  });

  it('collects an ES module graph, dependencies first, with placeholders for resolved imports', async () => {
    const { html, warnings } = await bundleHtml(
      'index.html',
      reader({
        'index.html': '<html><body><script type="module" src="/js/main.js"></script><script type="module">import { n } from "./js/util"; console.log(n)</script></body></html>',
        'js/main.js': "import { n } from './util';\nimport helper from './lib/index.js';\nexport * from './util.js';\nconst lazy = () => import('./lazy.js');\nimport React from 'react';",
        'js/util.js': 'export const n = 1;',
        'js/lib/index.js': "import '../util.js';\nexport default 2;",
        'js/lazy.js': 'export const later = 3;',
      }),
    );
    expect(warnings).toEqual([{ ref: 'react', from: 'js/main.js', reason: 'bare' }]);
    const boot = /var M=(\[.*?\]),E=(\[[\d,]*\]),U=\{\}/s.exec(html);
    expect(boot).not.toBeNull();
    const modules = JSON.parse(boot![1].replace(/<\\\//g, '</')) as [number, string][];
    const entries = JSON.parse(boot![2]) as number[];
    expect(modules).toHaveLength(5); // util, lib/index, lazy, main, the inline module
    expect(entries).toHaveLength(2);
    const seen = new Set<number>();
    for (const [id, code] of modules) {
      // every placeholder refers to a module listed earlier
      for (const m of code.matchAll(/__FE_MOD_(\d+)__/g)) expect(seen.has(Number(m[1]))).toBe(true);
      seen.add(id);
    }
    const main = modules.find(([, code]) => code.includes('const lazy'))![1];
    expect(main).not.toContain("'./util'");
    expect(main).toContain("from 'react'");
    expect(main.match(/__FE_MOD_\d+__/g)).toHaveLength(4);
    expect(html).not.toContain('src="/js/main.js"');
  });

  it('survives modules that import each other', async () => {
    const { warnings, html } = await bundleHtml(
      'index.html',
      reader({
        'index.html': '<script type="module" src="a.js"></script>',
        'a.js': "import './b.js'; export const a = 1;",
        'b.js': "import './a.js'; export const b = 2;",
      }),
    );
    expect(warnings).toEqual([{ ref: './a.js', from: 'b.js', reason: 'cycle' }]);
    expect(html).toContain('__FE_MOD_');
  });

  it('reports what it could not resolve and leaves it as written', async () => {
    const { html, warnings } = await bundleHtml(
      'pages/about.html',
      reader({
        'pages/about.html':
          '<html><head><link rel="stylesheet" href="https://cdn.example.com/x.css"><link rel="stylesheet" href="theme.scss"></head>' +
          '<body><img src="gone.png"><img src="../../outside.png"><img src="data:image/gif;base64,AAAA"><script src="app.ts"></script><a href="#top">top</a></body></html>',
        'pages/theme.scss': '$c: red;',
        'pages/app.ts': 'let x: number = 1;',
      }),
    );
    expect(warnings).toEqual(
      expect.arrayContaining([
        { ref: 'https://cdn.example.com/x.css', from: 'pages/about.html', reason: 'remote' },
        { ref: 'theme.scss', from: 'pages/about.html', reason: 'build' },
        { ref: 'gone.png', from: 'pages/about.html', reason: 'missing' },
        { ref: '../../outside.png', from: 'pages/about.html', reason: 'missing' },
        { ref: 'app.ts', from: 'pages/about.html', reason: 'build' },
      ]),
    );
    expect(warnings).toHaveLength(5);
    expect(html).toContain('src="gone.png"');
    expect(html).toContain('data:image/gif;base64,AAAA');
  });

  it('embeds images, srcset candidates and icons, and adds the link interceptor', async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const { html } = await bundleHtml(
      'index.html',
      reader({
        'index.html': '<html><head><link rel="icon" href="fav.svg"></head><body><img src="a.svg" srcset="a.svg 1x, b.svg 2x"><a href="about.html">About</a></body></html>',
        'a.svg': svg,
        'b.svg': svg,
        'fav.svg': svg,
      }),
    );
    const data = `data:image/svg+xml;base64,${b64(svg)}`;
    expect(html).toContain(`<link rel="icon" href="${data}">`);
    expect(html).toContain(`srcset="${data} 1x, ${data} 2x"`);
    expect(html).toContain("__fePreview:'navigate'");
    expect(html).toContain('href="about.html"');
    const plain = await bundleHtml('index.html', reader({ 'index.html': '<p>x</p>' }), { interceptLinks: false });
    expect(plain.html).not.toContain('__fePreview');
  });

  it('removes a page CSP and <base>, and bundles nested frames', async () => {
    const { html } = await bundleHtml(
      'index.html',
      reader({
        'index.html': '<html><head><base href="/x/"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'"></head><body><iframe src="inner.html"></iframe></body></html>',
        'inner.html': '<link rel="stylesheet" href="i.css"><p>inner</p>',
        'i.css': 'p{color:blue}',
      }),
    );
    expect(html).not.toContain('<base');
    expect(html).not.toContain('Content-Security-Policy');
    expect(html).toContain('srcdoc=');
    expect(html).toContain('p{color:blue}');
  });

  it('throws when the page itself is missing', async () => {
    await expect(bundleHtml('nope.html', reader({}))).rejects.toThrow(/nope\.html/);
  });

  it('finds the page a stylesheet belongs to', () => {
    const pages = ['index.html', 'docs/index.html', 'docs/guide/intro.html'];
    expect(nearestPage('docs/css/site.css', pages)).toBe('docs/index.html');
    expect(nearestPage('src/app.js', pages)).toBe('index.html');
    expect(nearestPage('a/b.css', ['pages/home.html'])).toBe('pages/home.html');
    expect(nearestPage('a/b.css', [])).toBeNull();
  });
});
