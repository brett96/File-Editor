// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser, DOMSerializer, type Node as PMNode } from '@tiptap/pm/model';
import { EditorState } from '@tiptap/pm/state';
import { editDocument, linearize } from '../src/core/agent/doc-text';

const schema = getSchema([StarterKit]);
const docFrom = (html: string): PMNode => {
  const el = document.createElement('div');
  el.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(el);
};
const edit = (html: string, oldS: string, newS: string, all = false) => {
  const state = EditorState.create({ doc: docFrom(html) });
  const tr = state.tr;
  const res = editDocument(tr, oldS, newS, all);
  const out = document.createElement('div');
  out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(tr.doc.content));
  return { res, html: out.innerHTML, text: linearize(tr.doc).text };
};

describe('documents for the agent', () => {
  const html = '<h2>Plan</h2><p>Ship the <strong>new editor</strong> on Monday.</p><p></p><ul><li><p>tests</p></li><li><p>docs</p></li></ul><p>a<br>b</p>';

  it('reads a document as one line per paragraph, with an outline', () => {
    const lin = linearize(docFrom(html));
    expect(lin.text).toBe('Plan\nShip the new editor on Monday.\n\ntests\ndocs\na\nb');
    expect(lin.outline).toEqual([[0, 'Heading 2'], [3, 'List item'], [4, 'List item']]);
  });

  it('replaces text inside formatting and keeps it', () => {
    const r = edit(html, 'new editor', 'agent panel');
    expect(r.res).toEqual({ count: 1 });
    expect(r.html).toContain('Ship the <strong>agent panel</strong> on Monday.');
    expect(edit(html, 'Monday', 'Friday').html).toContain('</strong> on Friday.</p>');
  });

  it('adds and removes paragraphs through newlines', () => {
    const add = edit(html, 'on Monday.', 'on Monday.\nThen announce it.');
    expect(add.text).toBe('Plan\nShip the new editor on Monday.\nThen announce it.\n\ntests\ndocs\na\nb');
    expect(add.html).toContain('<p>Then announce it.</p>');
    const join = edit(html, 'Monday.\n\ntests', 'Monday. Tests');
    expect(join.text.split('\n').slice(0, 3)).toEqual(['Plan', 'Ship the new editor on Monday. Tests', 'docs']);
    const heading = edit(html, 'Plan', 'Plan\nNext steps');
    expect(heading.html.startsWith('<h2>Plan</h2><h2>Next steps</h2>')).toBe(true);
  });

  it('refuses missing or ambiguous text, and replaces every one when asked', () => {
    expect('error' in edit(html, 'nope', 'x').res).toBe(true);
    expect('error' in edit('<p>x and x</p>', 'x', 'y').res).toBe(true);
    expect(edit('<p>x and x</p><p>x</p>', 'x', 'y', true).text).toBe('y and y\ny');
  });
});

// ── the agent's tools on documents ─────────────────────────────────────────
import { memoryFolder } from '../src/platform/folders';
import { exportFlow, openDocument } from '../src/core/registry';
import { runTool, type AgentWorkspace, type EditProposal } from '../src/ui/agent/tools';
import type { CodeEditorAccess } from '../src/ui/agent/editors';

/** A document tab's editor, backed by a real ProseMirror state. */
function docEditor(name: string, html: string, extra: Partial<CodeEditorAccess> = {}) {
  let state = EditorState.create({ doc: docFrom(html) });
  const written: string[] = [];
  const ed: CodeEditorAccess & { html(): string; written: string[] } = {
    tabId: 7,
    name,
    kind: 'document',
    format: 'Word document',
    getText: () => linearize(state.doc).text,
    outline: () => linearize(state.doc).outline,
    getSelection: () => null,
    setText: () => undefined,
    insert: () => undefined,
    editText(o, n, all) {
      const tr = state.tr;
      const r = editDocument(tr, o, n, all);
      if ('count' in r) state = state.apply(tr);
      return r;
    },
    async writeMarkdown(md) {
      written.push(md);
    },
    html() {
      const out = document.createElement('div');
      out.appendChild(DOMSerializer.fromSchema(schema).serializeFragment(state.doc.content));
      return out.innerHTML;
    },
    written,
    ...extra,
  };
  return ed;
}

const call = (name: string, args: unknown) => ({ id: 'c', type: 'function' as const, function: { name, arguments: JSON.stringify(args) } });

describe('agent tools on documents', () => {
  const host = (ws: AgentWorkspace, answers: EditProposal[] = []) => ({ ws: () => ws, budget: 50_000, confirm: async (p: EditProposal) => (answers.push(p), true) });

  it('reads and edits the document on screen, keeping its formatting', async () => {
    const ed = docEditor('Report.docx', '<h1>Report</h1><p>Sales were <em>flat</em> in May.</p>');
    const ws: AgentWorkspace = { folder: null, active: ed, editorFor: () => null, openElsewhere: () => false, folderChanged: () => undefined };
    const read = await runTool(call('read_file', { path: 'Report.docx' }), host(ws));
    expect(read.result).toContain('Report\nSales were flat in May.');
    expect(read.result).toContain('line 1 Heading 1');
    expect(read.result).toContain('write it in Markdown');
    const proposals: EditProposal[] = [];
    const r = await runTool(call('edit_file', { path: 'Report.docx', old_string: 'flat in May.', new_string: 'flat in May.\nJune looks better.' }), host(ws, proposals));
    expect(r.activity.error).toBeUndefined();
    expect([proposals[0].diff.added, proposals[0].diff.removed]).toEqual([1, 0]);
    expect(ed.html()).toBe('<h1>Report</h1><p>Sales were <em>flat</em> in May.</p><p>June looks better.</p>');
    await runTool(call('write_file', { path: 'Report.docx', content: '# New\n\n- one' }), host(ws));
    expect(ed.written).toEqual(['# New\n\n- one']);
  });

  it('reads a closed Word file as text, opens it in a tab to change it, and creates new ones from Markdown', async () => {
    const bytes = await exportFlow({ html: '<h2>Minutes</h2><p>Agreed to ship.</p>' }, 'docx');
    const files = new Map<string, Blob>([['notes/minutes.docx', new Blob([bytes as BlobPart])]]);
    const folder = memoryFolder('team', files, true);
    const opened: string[] = [];
    let tab: ReturnType<typeof docEditor> | null = null;
    const ws: AgentWorkspace = {
      folder,
      active: null,
      editorFor: (p) => (tab && p === 'notes/minutes.docx' ? tab : null),
      openElsewhere: () => false,
      folderChanged: () => undefined,
      openInTab: async (p) => {
        opened.push(p);
        const doc = await openDocument('minutes.docx', new Uint8Array(await files.get(p)!.arrayBuffer()));
        tab = docEditor('minutes.docx', doc.kind === 'flow' ? doc.doc.html : '');
        return tab;
      },
    };
    const read = await runTool(call('read_file', { path: 'notes/minutes.docx' }), host(ws));
    expect(read.result).toContain('Minutes\nAgreed to ship.');
    expect(read.result).toContain('not open; changing it opens it in a tab');
    expect(read.result).toContain('line 1 Heading 2');
    expect(opened).toEqual([]);
    const edit = await runTool(call('edit_file', { path: 'notes/minutes.docx', old_string: 'Agreed to ship.', new_string: 'Agreed to ship on Friday.' }), host(ws));
    expect(edit.result).toMatch(/in its open tab/);
    expect(opened).toEqual(['notes/minutes.docx']);
    expect(tab!.getText()).toBe('Minutes\nAgreed to ship on Friday.');

    const made = await runTool(call('write_file', { path: 'out/summary.docx', content: '# Summary\n\nWe **shipped**.\n\n- on time' }), host(ws));
    expect(made.result).toMatch(/^Created out\/summary.docx/);
    const back = await openDocument('summary.docx', new Uint8Array(await files.get('out/summary.docx')!.arrayBuffer()));
    expect(back.kind === 'flow' && back.doc.html).toMatch(/<h1[^>]*>Summary<\/h1>/);
    expect(back.kind === 'flow' && back.doc.html).toContain('<strong>shipped</strong>');
  });
});
