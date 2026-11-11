import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { bracketMatching, foldGutter, indentOnInput, syntaxHighlighting, defaultHighlightStyle } from '@codemirror/language';
import { html } from '@codemirror/lang-html';
import { css } from '@codemirror/lang-css';
import { javascript } from '@codemirror/lang-javascript';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import type { CodeLanguage } from '../../core/types';
import { cx } from '../components';

export interface CodeEditorHandle {
  getText(): string;
}

type ViewMode = 'edit' | 'preview' | 'split';

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
      history(),
      foldGutter(),
      indentOnInput(),
      bracketMatching(),
      closeBrackets(),
      autocompletion(),
      highlightSelectionMatches(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      languageSupport(language),
      keymap.of([
        indentWithTab,
        ...closeBracketsKeymap,
        ...defaultKeymap,
        ...searchKeymap,
        ...historyKeymap,
        ...completionKeymap,
        ...lintKeymap,
      ]),
      EditorView.updateListener.of((update) => {
        if (update.docChanged) {
          onChangeRef.current?.();
          setTick((n) => n + 1);
        }
      }),
      EditorView.theme({
        '&': { height: '100%', fontSize: '13px' },
        '.cm-scroller': { overflow: 'auto', fontFamily: 'Consolas, "Cascadia Code", "Segoe UI Mono", ui-monospace, monospace' },
        '.cm-content': { padding: '12px 0' },
        '.cm-gutters': { background: 'transparent', border: 'none' },
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
        <div className="code-mode-toggle">
          {([
            ['edit', 'Edit'],
            ['preview', 'Preview'],
            ['split', 'Split'],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={cx('btn', 'btn-text', 'btn-sm', mode === id && 'is-active')}
              aria-pressed={mode === id}
              onClick={() => setMode(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="code-preview-note">Preview of this file</span>
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
