/**
 * A document tab's editor as the coding agent reaches it (src/ui/agent/editors.ts): its text,
 * selection, text edits that keep formatting, and whole-document rewrites from Markdown.
 */
import type { Editor } from '@tiptap/react';
import { editDocument, lineOf, linearize } from '../../core/agent/doc-text';
import { escapeHtml, utf8Encode } from '../../core/dom';
import type { CodeEditorAccess } from '../agent/editors';

export function documentAccess(editor: Editor): Pick<CodeEditorAccess, 'getText' | 'getSelection' | 'setText' | 'insert' | 'editText' | 'writeMarkdown' | 'outline'> {
  const paragraphs = (text: string) => text.split('\n').map((l) => `<p>${escapeHtml(l)}</p>`).join('');
  return {
    getText: () => linearize(editor.state.doc).text,
    outline: () => linearize(editor.state.doc).outline,
    getSelection() {
      const { from, to, empty, head } = editor.state.selection;
      const lin = linearize(editor.state.doc);
      return { text: editor.state.doc.textBetween(from, to, '\n'), fromLine: lineOf(lin, from), toLine: lineOf(lin, to), empty, cursorLine: lineOf(lin, head) };
    },
    // a plain rewrite of the text: each line a paragraph (used only when no structured edit applies)
    setText: (text) => void editor.commands.setContent(paragraphs(text), { emitUpdate: true }),
    insert: (text) => void editor.chain().focus().insertContent(text.includes('\n') ? paragraphs(text) : escapeHtml(text)).run(),
    editText(oldString, newString, replaceAll) {
      const tr = editor.state.tr;
      const res = editDocument(tr, oldString, newString, replaceAll);
      if ('count' in res) editor.view.dispatch(tr.setMeta('inputType', 'agent'));
      return res;
    },
    async writeMarkdown(markdown) {
      const { importMarkdown } = await import('../../core/formats/markdown');
      const { html } = await importMarkdown(utf8Encode(markdown));
      editor.commands.setContent(html, { emitUpdate: true });
    },
  };
}

/**
 * The agent's text of a document that isn't open (a closed .docx in the folder), built with the
 * editor's own schema, so it matches what the agent sees once the document is opened in a tab.
 */
export async function documentText(html: string): Promise<{ text: string; outline: [number, string][] }> {
  const [{ getSchema }, { DOMParser: PMDOMParser }, { createExtensions }] = await Promise.all([
    import('@tiptap/core'),
    import('@tiptap/pm/model'),
    import('./extensions'),
  ]);
  const el = document.createElement('div');
  el.innerHTML = html;
  const doc = PMDOMParser.fromSchema(getSchema(createExtensions())).parse(el);
  const { text, outline } = linearize(doc);
  return { text, outline };
}
