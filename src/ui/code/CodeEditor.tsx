import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import {
  EditorView,
  keymap,
  lineNumbers,
  highlightActiveLine,
  highlightActiveLineGutter,
  drawSelection,
  dropCursor,
  rectangularSelection,
  crosshairCursor,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
  HighlightStyle,
} from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { tags as t } from '@lezer/highlight';
import type { CodeLanguage } from '../../core/types';
import { cx } from '../components';

export interface CodeEditorHandle {
  getText(): string;
}

type ViewMode = 'edit' | 'preview' | 'split';

/** Soft dark theme — easier on the eyes than defaultHighlightStyle's hot reds/purples. */
const codeHighlight = HighlightStyle.define([
  { tag: t.comment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.lineComment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.blockComment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.docComment, color: '#6a9955', fontStyle: 'italic' },
  { tag: t.keyword, color: '#c586c0' },
  { tag: t.controlKeyword, color: '#c586c0' },
  { tag: t.operatorKeyword, color: '#c586c0' },
  { tag: t.moduleKeyword, color: '#c586c0' },
  { tag: t.definitionKeyword, color: '#569cd6' },
  { tag: t.string, color: '#ce9178' },
  { tag: t.special(t.string), color: '#ce9178' },
  { tag: t.character, color: '#ce9178' },
  { tag: t.number, color: '#b5cea8' },
  { tag: t.bool, color: '#569cd6' },
  { tag: t.null, color: '#569cd6' },
  { tag: t.regexp, color: '#d16969' },
  { tag: t.escape, color: '#d7ba7d' },
  { tag: t.variableName, color: '#9cdcfe' },
  { tag: t.definition(t.variableName), color: '#9cdcfe' },
  { tag: t.local(t.variableName), color: '#9cdcfe' },
  { tag: t.function(t.variableName), color: '#dcdcaa' },
  { tag: t.definition(t.function(t.variableName)), color: '#dcdcaa' },
  { tag: t.propertyName, color: '#9cdcfe' },
  { tag: t.definition(t.propertyName), color: '#9cdcfe' },
  { tag: t.attributeName, color: '#9cdcfe' },
  { tag: t.className, color: '#4ec9b0' },
  { tag: t.typeName, color: '#4ec9b0' },
  { tag: t.namespace, color: '#4ec9b0' },
  { tag: t.tagName, color: '#569cd6' },
  { tag: t.angleBracket, color: '#808080' },
  { tag: t.operator, color: '#d4d4d4' },
  { tag: t.punctuation, color: '#d4d4d4' },
  { tag: t.bracket, color: '#ffd700' },
  { tag: t.paren, color: '#ffd700' },
  { tag: t.brace, color: '#ffd700' },
  { tag: t.squareBracket, color: '#ffd700' },
  { tag: t.meta, color: '#9b9b9b' },
  { tag: t.invalid, color: '#f44747' },
  { tag: t.heading, color: '#569cd6', fontWeight: 'bold' },
  { tag: t.link, color: '#4ec9b0', textDecoration: 'underline' },
  { tag: t.url, color: '#4ec9b0' },
  { tag: t.literal, color: '#b5cea8' },
  { tag: t.unit, color: '#b5cea8' },
  { tag: t.color, color: '#ce9178' },
  { tag: t.self, color: '#569cd6' },
  { tag: t.labelName, color: '#c8c8c8' },
]);

const codeTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      fontSize: '13.5px',
      backgroundColor: '#1e1e1e',
      color: '#d4d4d4',
    },
    '.cm-scroller': {
      overflow: 'auto',
      fontFamily: 'Consolas, "Cascadia Code", "JetBrains Mono", "Segoe UI Mono", ui-monospace, monospace',
      lineHeight: '1.55',
    },
    '.cm-content': {
      padding: '14px 0',
      caretColor: '#aeafad',
    },
    '.cm-cursor, .cm-dropCursor': {
      borderLeftColor: '#aeafad',
    },
    '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
      backgroundColor: '#264f78',
    },
    '.cm-activeLine': {
      backgroundColor: '#2a2a2a',
    },
    '.cm-gutters': {
      backgroundColor: '#1e1e1e',
      color: '#858585',
      border: 'none',
      borderRight: '1px solid #2b2b2b',
      minWidth: '48px',
    },
    '.cm-activeLineGutter': {
      backgroundColor: '#2a2a2a',
      color: '#c6c6c6',
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 12px 0 8px',
      minWidth: '36px',
    },
    '.cm-foldGutter .cm-gutterElement': {
      padding: '0 4px',
      color: '#6e6e6e',
    },
    '.cm-matchingBracket, .cm-nonmatchingBracket': {
      backgroundColor: '#515c6a',
      outline: '1px solid #888',
    },
    '.cm-searchMatch': {
      backgroundColor: '#613214',
      outline: '1px solid #e2b068',
    },
    '.cm-searchMatch.cm-searchMatch-selected': {
      backgroundColor: '#515c6a',
    },
    '.cm-selectionMatch': {
      backgroundColor: '#3a3d41',
    },
    '.cm-tooltip': {
      backgroundColor: '#252526',
      border: '1px solid #454545',
      color: '#cccccc',
    },
    '.cm-tooltip-autocomplete ul li[aria-selected]': {
      backgroundColor: '#094771',
      color: '#ffffff',
    },
    '.cm-panels': {
      backgroundColor: '#252526',
      color: '#cccccc',
    },
    '.cm-panels.cm-panels-top': {
      borderBottom: '1px solid #2b2b2b',
    },
  },
  { dark: true },
);

function languageSupport(language: CodeLanguage) {
  if (language === 'html') return html();
  if (language === 'css') return css();
  return javascript();
}

function previewSrcDoc(language: CodeLanguage, text: string): string {
  if (language === 'html') return text;
  if (language === 'css') {
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${text}</style></head><body>
<main style="font-family:system-ui,sans-serif;padding:24px;max-width:40rem;margin:0 auto">
  <h1>Heading</h1>
  <p>Sample paragraph for your stylesheet. <a href="#">A link</a> and <code>code</code>.</p>
  <button type="button">Button</button>
  <ul><li>List item</li><li>Another</li></ul>
</main>
</body></html>`;
  }
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Preview</title></head><body>
<pre id="out" style="font:14px/1.4 ui-monospace,monospace;padding:16px;white-space:pre-wrap"></pre>
<script>
try {
${text}
} catch (err) {
  document.getElementById('out').textContent = String(err);
}
</script>
</body></html>`;
}

const LANG_LABEL: Record<CodeLanguage, string> = {
  html: 'HTML',
  css: 'CSS',
  js: 'JavaScript',
};

export const CodeEditor = forwardRef<CodeEditorHandle, {
  initialText: string;
  language: CodeLanguage;
  onChange?: () => void;
}>(function CodeEditor({ initialText, language, onChange }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const [mode, setMode] = useState<ViewMode>('edit');
  const [tick, setTick] = useState(0);
  const [previewHtml, setPreviewHtml] = useState(() => previewSrcDoc(language, initialText));

  useImperativeHandle(ref, () => ({
    getText: () => viewRef.current?.state.doc.toString() ?? initialText,
  }));

  const extensions = useMemo(
    () => [
      lineNumbers(),
      highlightActiveLine(),
      highlightActiveLineGutter(),
      drawSelection(),
      dropCursor(),
      rectangularSelection(),
      crosshairCursor(),
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      codeTheme,
      syntaxHighlighting(codeHighlight, { fallback: true }),
      languageSupport(language),
      keymap.of([
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...foldKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.();
          setTick((n) => n + 1);
        }
      }),
      EditorView.lineWrapping,
    ],
    [language],
  );

  useEffect(() => {
    if (!hostRef.current) return;
    const state = EditorState.create({ doc: initialText, extensions });
    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Parent remounts this component via key when the document changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [language, extensions]);

  useEffect(() => {
    if (mode === 'edit') return;
    const id = window.setTimeout(() => {
      const text = viewRef.current?.state.doc.toString() ?? initialText;
      setPreviewHtml(previewSrcDoc(language, text));
    }, 300);
    return () => clearTimeout(id);
  }, [mode, language, tick, initialText]);

  const showEdit = mode === 'edit' || mode === 'split';
  const showPreview = mode === 'preview' || mode === 'split';

  return (
    <div className="code-editor">
      <div className="code-toolbar" role="toolbar" aria-label="Code view">
        <div className="code-mode-toggle" role="tablist">
          {([
            ['edit', 'Edit'],
            ['preview', 'Preview'],
            ['split', 'Split'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              className={cx('code-mode-btn', mode === id && 'is-active')}
              aria-selected={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="code-lang-pill">{LANG_LABEL[language]}</span>
        <span className="code-preview-note">Preview uses this file’s current contents</span>
      </div>
      <div className={cx('code-panes', mode === 'split' && 'is-split')}>
        <div className={cx('code-pane', 'code-source', !showEdit && 'is-hidden')} ref={hostRef} />
        {showPreview && (
          <iframe
            className="code-pane code-preview"
            title="Preview"
            sandbox="allow-scripts"
            srcDoc={previewHtml}
          />
        )}
      </div>
    </div>
  );
});
