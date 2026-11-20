/**
 * The editors of open tabs, for the coding agent: it reads a file from the tab it is open in
 * (unsaved changes included) and applies its edits there, as one undoable change. Code tabs
 * (CodeMirror) and Word-style document tabs (txt, docx, odt, rtf, md… in the rich editor) both
 * register; a document's text is one line per paragraph (src/core/agent/doc-text.ts).
 */

export interface CodeSelection {
  text: string;
  /** 1-based lines the selection starts and ends on */
  fromLine: number;
  toLine: number;
}

export interface CodeEditorAccess {
  tabId: number;
  /** 'document': a Word-style document; edits keep its formatting, a rewrite takes Markdown */
  kind?: 'code' | 'document';
  /** the document's format, e.g. "Word document" (documents only) */
  format?: string;
  /** the file name shown on the tab */
  name: string;
  /** set (by the app shell) when the tab's file belongs to the opened folder */
  folderId?: string;
  path?: string;
  getText(): string;
  /** the selection, or null when nothing is selected; `cursorLine` is where the cursor is */
  getSelection(): (CodeSelection & { empty: boolean; cursorLine: number }) | null;
  /** Replaces the whole text (applied as the smallest change, so undo and the cursor behave). */
  setText(text: string): void;
  /** Replaces the selection (or inserts at the cursor). */
  insert(text: string): void;
  /** Documents: replaces text inside the document, keeping its formatting (one undo step). */
  editText?(oldString: string, newString: string, replaceAll: boolean): { count: number } | { error: string };
  /** Documents: replaces the whole document with Markdown (headings, lists, bold, tables…). */
  writeMarkdown?(markdown: string): Promise<void>;
  /** Documents: paragraph styles by line, for the agent's outline */
  outline?(): [number, string][];
}

const editors = new Map<number, CodeEditorAccess>();
const listeners = new Set<() => void>();

export function registerCodeEditor(access: CodeEditorAccess): () => void {
  editors.set(access.tabId, access);
  listeners.forEach((l) => l());
  return () => {
    if (editors.get(access.tabId) === access) editors.delete(access.tabId);
    listeners.forEach((l) => l());
  };
}

export function codeEditorForTab(tabId: number | null): CodeEditorAccess | null {
  return tabId === null ? null : (editors.get(tabId) ?? null);
}

export function onCodeEditorsChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
