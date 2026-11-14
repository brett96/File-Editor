import { forwardRef, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
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
import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { CodeFormat } from '../../core/types';
import { languageLabel } from '../../core/code/languages';
import { WARNING_TEXT, bundleHtml, nearestPage, type BundleWarning } from '../../core/web/bundle';
import { referenceKind, resolveReference } from '../../core/web/paths';
import { bufferChanged, liveBuffer, onBufferChange } from '../workspace/buffers';
import { cx } from '../components';
import { disposePreview, publishPreview, type PreviewTarget } from './preview-host';

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

/** HTML, CSS and JavaScript are part of the editor; every other grammar is loaded when a file needs it. */
function builtInLanguage(format: CodeFormat): Extension | null {
  if (format === 'html') return html();
  if (format === 'css') return css();
  if (format === 'js') return javascript();
  return null;
}

/** File names the language list does not know by themselves, mapped to a name it does. */
function grammarName(fileName: string): string {
  const leaf = fileName.replace(/^.*[\\/]/, '');
  const lower = leaf.toLowerCase();
  if (/^(dockerfile|containerfile)(\..+)?$/.test(lower)) return 'Dockerfile';
  if (/^(makefile|gnumakefile|justfile)(\..+)?$/.test(lower) || /\.(mk|mak)$/.test(lower)) return 'x.cmake';
  if (/^\.env(\..+)?$/.test(lower) || /\.(env|conf|cfg|editorconfig|npmrc|gitignore|gitattributes|dockerignore|npmignore|tf|tfvars|hcl|nix)$/.test(lower)) return 'x.properties';
  if (/\.(jsonc|json5|jsonl|webmanifest|geojson|ipynb|babelrc|eslintrc|prettierrc|map)$/.test(lower)) return 'x.json';
  if (/\.(mts|cts)$/.test(lower)) return 'x.ts';
  if (/\.cjs$/.test(lower)) return 'x.js';
  if (/\.(svelte|astro|njk|ejs|hbs|handlebars|mustache|twig|liquid)$/.test(lower)) return 'x.html';
  if (/\.(plist|csproj|vbproj|fsproj|props|targets|resx|xaml|wsdl|rss|atom|xsd|xsl|xslt)$/.test(lower)) return 'x.xml';
  if (/\.(zsh|fish|ksh)$/.test(lower)) return 'x.sh';
  if (/\.lock$/.test(lower)) return lower === 'cargo.lock' || lower === 'poetry.lock' ? 'x.toml' : lower === 'yarn.lock' ? 'x.yaml' : 'x.json';
  return leaf;
}

/** The grammar for a file, by its name; null when there is none (the file is shown as plain text). */
async function loadLanguage(fileName: string): Promise<Extension | null> {
  const [{ languages }, { LanguageDescription }] = await Promise.all([import('@codemirror/language-data'), import('@codemirror/language')]);
  const desc = LanguageDescription.matchFilename(languages, grammarName(fileName));
  return desc ? desc.load() : null;
}

function sampleSrcDoc(format: CodeFormat, text: string): string {
  if (format === 'css') {
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
${text.replace(/<\/(script)/gi, '<\\/$1')}
} catch (err) {
  document.getElementById('out').textContent = String(err);
}
</script>
</body></html>`;
}

/** Where a tab's file lives, for a preview that takes in the files around it. */
export interface PreviewSource {
  /** identifies the folder (or, for a file opened on its own, that file) */
  id: string;
  /** this file's path inside it */
  path: string;
  /** another file of the folder as it is on disk; null when it does not exist */
  read(path: string): Promise<Blob | null>;
  /** the folder's web pages, for previewing a stylesheet or script in one of them */
  pages?(): Promise<string[]>;
}

let previewSeq = 1;

export const CodeEditor = forwardRef<CodeEditorHandle, {
  initialText: string;
  format: CodeFormat;
  /** the file's name: picks the grammar and the language shown */
  fileName: string;
  /** the folder the file was opened from (or its siblings), when there is one */
  source?: PreviewSource | null;
  onChange?: () => void;
}>(function CodeEditor({ initialText, format, fileName, source = null, onChange }, ref) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const [mode, setMode] = useState<ViewMode>('edit');
  const [tick, setTick] = useState(0);
  const [refresh, setRefresh] = useState(0);
  const [target, setTarget] = useState<PreviewTarget | null>(null);
  const [warnings, setWarnings] = useState<BundleWarning[]>([]);
  const [showWarnings, setShowWarnings] = useState(false);
  const [pages, setPages] = useState<string[]>([]);
  /** the page shown in the preview: this file, or (for a stylesheet / script) a page of the folder */
  const [page, setPage] = useState<string | null>(format === 'html' ? (source?.path ?? null) : null);
  const [error, setError] = useState<string | null>(null);
  const previewId = useMemo(() => `p${Date.now().toString(36)}-${previewSeq++}`, []);
  const canPreview = format !== 'code';
  const sourceId = source?.id ?? null;
  const ownPath = source?.path ?? fileName;

  const getText = () => viewRef.current?.state.doc.toString() ?? initialText;
  useImperativeHandle(ref, () => ({ getText }));

  const language = useMemo(() => new Compartment(), []);
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
      language.of(builtInLanguage(format) ?? []),
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
          const s = sourceRef.current;
          if (s) bufferChanged(s.id, s.path);
        }
      }),
      EditorView.lineWrapping,
    ],
    [format, language],
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
  }, [extensions]);

  // every grammar but HTML / CSS / JS is its own chunk, fetched the first time a file needs it
  useEffect(() => {
    if (builtInLanguage(format)) return;
    let live = true;
    void loadLanguage(fileName).then(
      (support) => {
        if (live && support) viewRef.current?.dispatch({ effects: language.reconfigure(support) });
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
  }, [format, fileName, language, extensions]);

  // the folder's pages, for previewing a stylesheet or script where it is used
  const showPreview = canPreview && (mode === 'preview' || mode === 'split');
  useEffect(() => {
    if (!showPreview || !source?.pages) return;
    let live = true;
    void source.pages().then(
      (list) => {
        if (!live) return;
        setPages(list);
        setPage((cur) => (cur && (list.includes(cur) || cur === source.path) ? cur : format === 'html' ? source.path : nearestPage(source.path, list)));
      },
      () => undefined,
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPreview, sourceId, refresh]);

  // edits in other tabs of the same folder show up in this preview too
  useEffect(() => {
    if (!showPreview || !sourceId) return;
    return onBufferChange((id, path) => {
      if (id === sourceId && path !== sourceRef.current?.path) setTick((n) => n + 1);
    });
  }, [showPreview, sourceId]);

  // build the preview a moment after the last change
  useEffect(() => {
    if (!showPreview) return;
    let live = true;
    const id = window.setTimeout(async () => {
      const text = getText();
      const s = sourceRef.current;
      const entry = format === 'html' ? (page ?? ownPath) : page;
      try {
        let html: string;
        let found: BundleWarning[] = [];
        if (entry) {
          const read = async (path: string): Promise<Uint8Array | string | null> => {
            if (path === ownPath) return text;
            if (!s) return null;
            const open = liveBuffer(s.id, path);
            if (open !== null) return open;
            const blob = await s.read(path);
            return blob ? new Uint8Array(await blob.arrayBuffer()) : null;
          };
          ({ html, warnings: found } = await bundleHtml(entry, read));
        } else {
          html = sampleSrcDoc(format, text);
        }
        const next = await publishPreview(previewId, html);
        if (!live) return;
        setTarget(next);
        setWarnings(found);
        setError(null);
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : 'The preview could not be built.');
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showPreview, format, tick, refresh, page, ownPath, previewId]);

  useEffect(() => () => disposePreview(previewId), [previewId]);

  // a click on a link to another page of the folder shows that page
  useEffect(() => {
    if (!showPreview) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { __fePreview?: string; href?: string; from?: string } | null;
      if (!data || data.__fePreview !== 'navigate' || e.source !== frameRef.current?.contentWindow || typeof data.href !== 'string') return;
      const href = data.href;
      const s = sourceRef.current;
      const from = typeof data.from === 'string' ? data.from : ownPath;
      if (referenceKind(href) !== 'relative') {
        setError(`${href} is an online link. The preview is offline, so it was not opened.`);
        return;
      }
      const to = resolveReference(from, href);
      if (!to || !s) {
        setError(s ? `${href} is outside the folder, so it was not opened.` : `${href} was not opened: open the folder to follow links between its pages.`);
        return;
      }
      void (async () => {
        const candidates = /\.[A-Za-z0-9]+$/.test(to) ? [to] : [`${to}/index.html`, `${to}.html`];
        for (const c of candidates) {
          if (c === s.path || liveBuffer(s.id, c) !== null || (await s.read(c))) {
            if (!/\.(html?|xhtml)$/i.test(c)) return setError(`${href} is not a web page, so the preview stayed where it was.`);
            setError(null);
            return setPage(c);
          }
        }
        setError(`${href} was not found in the folder.`);
      })();
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [showPreview, ownPath]);

  const showEdit = !canPreview || mode === 'edit' || mode === 'split';
  const label = languageLabel(fileName);
  const entryPage = format === 'html' ? (page ?? ownPath) : page;
  const pageChoices = [...new Set([...(format === 'html' && source ? [source.path] : []), ...(page ? [page] : []), ...pages])];
  let note: string;
  if (!canPreview) note = '';
  else if (source?.pages) note = entryPage ? 'Preview uses the folder’s files, with unsaved changes' : 'No web page in this folder: showing a sample page';
  else if (source) note = 'Preview uses the files beside this one';
  else if (format === 'html') note = 'Preview shows this file only. Open its folder to preview it with its other files';
  else note = 'Preview uses a sample page. Open the folder to preview this file in its own page';

  return (
    <div className="code-editor">
      <div className="code-toolbar" role="toolbar" aria-label="Code view">
        {canPreview && (
          <div className="code-mode-toggle" role="tablist">
            {([
              ['edit', 'Edit'],
              ['preview', 'Preview'],
              ['split', 'Split'],
            ] as const).map(([id, text]) => (
              <button
                key={id}
                type="button"
                role="tab"
                className={cx('code-mode-btn', mode === id && 'is-active')}
                aria-selected={mode === id}
                onClick={() => setMode(id)}
              >
                {text}
              </button>
            ))}
          </div>
        )}
        <span className="code-lang-pill">{label}</span>
        {showPreview && source?.pages && pageChoices.length > 0 && (
          <label className="code-page-pick">
            <span>Page</span>
            <select value={entryPage ?? ''} onChange={(e) => setPage(e.target.value || null)} aria-label="Page to preview">
              {format !== 'html' && <option value="">Sample page</option>}
              {pageChoices.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          </label>
        )}
        {showPreview && (
          <button type="button" className="code-tool-btn" title="Rebuild the preview from the folder’s files" onClick={() => setRefresh((n) => n + 1)}>
            <RefreshCw size={14} /> Refresh
          </button>
        )}
        {showPreview && warnings.length > 0 && (
          <button
            type="button"
            className={cx('code-tool-btn', 'code-warn-btn', showWarnings && 'is-active')}
            aria-expanded={showWarnings}
            onClick={() => setShowWarnings((v) => !v)}
            title="References the preview could not load"
          >
            <AlertTriangle size={14} /> {warnings.length} not loaded
          </button>
        )}
        {note && <span className="code-preview-note">{note}</span>}
      </div>
      {showPreview && (error || (showWarnings && warnings.length > 0)) && (
        <div className="code-warnings" role="status">
          {error && <p className="code-warning-error">{error}</p>}
          {showWarnings && warnings.length > 0 && (
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>
                  <code>{w.ref.length > 80 ? `${w.ref.slice(0, 77)}…` : w.ref}</code>
                  <span>{WARNING_TEXT[w.reason]}</span>
                  <em>in {w.from}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className={cx('code-panes', canPreview && mode === 'split' && 'is-split')}>
        <div className={cx('code-pane', 'code-source', !showEdit && 'is-hidden')} ref={hostRef} />
        {showPreview && target && ('url' in target ? (
          // served with its own sandboxing policy (see preview-host.ts)
          <iframe ref={frameRef} key="url" className="code-pane code-preview" title="Preview" sandbox={window.desktop ? 'allow-scripts allow-forms allow-modals' : undefined} src={target.url} />
        ) : (
          <iframe ref={frameRef} key="srcdoc" className="code-pane code-preview" title="Preview" sandbox="allow-scripts allow-forms allow-modals" srcDoc={target.srcDoc} />
        ))}
        {showPreview && !target && <div className="code-pane code-preview code-preview-wait">Building the preview…</div>}
      </div>
    </div>
  );
});
