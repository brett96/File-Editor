import { forwardRef, useEffect, useImperativeHandle, useMemo, useState } from 'react';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import {
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  Baseline,
  Bold,
  Highlighter,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Redo2,
  RemoveFormatting,
  SeparatorHorizontal,
  Settings2,
  Strikethrough,
  Subscript as SubIcon,
  Superscript as SupIcon,
  Table as TableIcon,
  Underline,
  Undo2,
} from 'lucide-react';
import { DEFAULT_PAGE_SETUP, pageDimensions, type PageSetup, type RichDocument } from '../../core/types';
import { getHost } from '../../platform/host';
import { ColorPicker, Divider, Field, IconButton, MenuItem, Modal, Popover, PromptModal, Select } from '../components';
import { IMAGE_EXTENSIONS, loadImageFile } from '../image-utils';
import { createExtensions } from './extensions';

export interface RichEditorHandle {
  getDocument(): RichDocument;
}

interface Props {
  initial: RichDocument;
  zoom: number;
  onChange: () => void;
  onStats?: (stats: { words: number; characters: number }) => void;
  onError: (message: string) => void;
}

const FONT_FAMILIES = ['Arial', 'Calibri', 'Cambria', 'Courier New', 'Garamond', 'Georgia', 'Helvetica', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Verdana'];
const FONT_SIZES = ['8', '9', '10', '11', '12', '14', '16', '18', '20', '24', '28', '36', '48', '72'];

const BLOCK_STYLES = [
  { value: 'p', label: 'Normal text' },
  { value: 'h1', label: 'Heading 1' },
  { value: 'h2', label: 'Heading 2' },
  { value: 'h3', label: 'Heading 3' },
  { value: 'h4', label: 'Heading 4' },
  { value: 'quote', label: 'Quote' },
  { value: 'code', label: 'Code block' },
];

function normalizeUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return '';
  if (/^(https?:|mailto:|tel:|#)/i.test(v)) return v;
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'mailto:' + v;
  if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return ''; // refuse other schemes (javascript:, file:, …)
  return 'https://' + v;
}

function Toolbar({ editor, onPageSetup, onError }: { editor: Editor; onPageSetup: () => void; onError: (m: string) => void }) {
  const [linkOpen, setLinkOpen] = useState(false);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const ts = e.getAttributes('textStyle') as { color?: string; fontFamily?: string; fontSize?: string };
      return {
        block: e.isActive('heading', { level: 1 }) ? 'h1'
          : e.isActive('heading', { level: 2 }) ? 'h2'
          : e.isActive('heading', { level: 3 }) ? 'h3'
          : e.isActive('heading') ? 'h4'
          : e.isActive('blockquote') ? 'quote'
          : e.isActive('codeBlock') ? 'code'
          : 'p',
        bold: e.isActive('bold'),
        italic: e.isActive('italic'),
        underline: e.isActive('underline'),
        strike: e.isActive('strike'),
        sub: e.isActive('subscript'),
        sup: e.isActive('superscript'),
        bullet: e.isActive('bulletList'),
        ordered: e.isActive('orderedList'),
        link: e.isActive('link'),
        href: (e.getAttributes('link').href as string | undefined) ?? '',
        inTable: e.isActive('table'),
        align: e.isActive({ textAlign: 'center' }) ? 'center' : e.isActive({ textAlign: 'right' }) ? 'right' : e.isActive({ textAlign: 'justify' }) ? 'justify' : 'left',
        color: ts.color ?? null,
        highlight: e.isActive('highlight') ? ((e.getAttributes('highlight').color as string | undefined) ?? '#fff59d') : null,
        fontFamily: (ts.fontFamily ?? '').split(',')[0].replace(/["']/g, '').trim(),
        fontSize: (ts.fontSize ?? '').replace(/pt$/, ''),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        canSink: e.can().sinkListItem('listItem'),
        canLift: e.can().liftListItem('listItem'),
      };
    },
  });

  const chain = () => editor.chain().focus();

  const setBlock = (v: string) => {
    const c = chain();
    switch (v) {
      case 'p': c.setParagraph().run(); break;
      case 'quote': c.setParagraph().toggleBlockquote().run(); break;
      case 'code': c.setCodeBlock().run(); break;
      default: c.setHeading({ level: Number(v.slice(1)) as 1 | 2 | 3 | 4 }).run();
    }
  };

  const insertImage = async () => {
    try {
      const [file] = await getHost().openFiles({ extensions: IMAGE_EXTENSIONS, description: 'Images' });
      if (!file) return;
      const img = await loadImageFile(file.blob, file.name, 2000);
      // fit within the text column (≈ 6.5in at 96dpi)
      const k = Math.min(1, 620 / img.width);
      chain().setImage({ src: img.dataUrl, alt: file.name.replace(/\.[^.]+$/, ''), width: Math.round(img.width * k), height: Math.round(img.height * k) }).run();
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not insert the image.');
    }
  };

  const fontFamilies = s.fontFamily && !FONT_FAMILIES.includes(s.fontFamily) ? [s.fontFamily, ...FONT_FAMILIES] : FONT_FAMILIES;
  const fontSizes = s.fontSize && !FONT_SIZES.includes(s.fontSize) ? [s.fontSize, ...FONT_SIZES] : FONT_SIZES;

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <IconButton label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()}><Undo2 size={16} /></IconButton>
      <IconButton label="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => chain().redo().run()}><Redo2 size={16} /></IconButton>
      <Divider />
      <Select label="Paragraph style" value={s.block} options={BLOCK_STYLES} onChange={setBlock} width={128} />
      <Select
        label="Font"
        value={s.fontFamily}
        width={132}
        options={[{ value: '', label: 'Default font' }, ...fontFamilies.map((f) => ({ value: f, label: f }))]}
        onChange={(v) => (v ? chain().setFontFamily(v).run() : chain().unsetFontFamily().run())}
      />
      <Select
        label="Font size"
        value={s.fontSize}
        width={64}
        options={[{ value: '', label: '11' }, ...fontSizes.map((f) => ({ value: f, label: f }))]}
        onChange={(v) => (v ? chain().setFontSize(`${v}pt`).run() : chain().unsetFontSize().run())}
      />
      <Divider />
      <IconButton label="Bold (Ctrl+B)" active={s.bold} onClick={() => chain().toggleBold().run()}><Bold size={16} /></IconButton>
      <IconButton label="Italic (Ctrl+I)" active={s.italic} onClick={() => chain().toggleItalic().run()}><Italic size={16} /></IconButton>
      <IconButton label="Underline (Ctrl+U)" active={s.underline} onClick={() => chain().toggleUnderline().run()}><Underline size={16} /></IconButton>
      <IconButton label="Strikethrough" active={s.strike} onClick={() => chain().toggleStrike().run()}><Strikethrough size={16} /></IconButton>
      <IconButton label="Subscript" active={s.sub} onClick={() => chain().unsetSuperscript().toggleSubscript().run()}><SubIcon size={16} /></IconButton>
      <IconButton label="Superscript" active={s.sup} onClick={() => chain().unsetSubscript().toggleSuperscript().run()}><SupIcon size={16} /></IconButton>
      <ColorPicker label="Text colour" icon={<Baseline size={16} />} value={s.color} onPick={(c) => chain().setColor(c).run()} onClear={() => chain().unsetColor().run()} clearLabel="Automatic" />
      <ColorPicker label="Highlight" icon={<Highlighter size={16} />} value={s.highlight} palette="highlight" onPick={(c) => chain().setHighlight({ color: c }).run()} onClear={() => chain().unsetHighlight().run()} clearLabel="None" />
      <IconButton label="Clear formatting" onClick={() => chain().unsetAllMarks().run()}><RemoveFormatting size={16} /></IconButton>
      <Divider />
      <IconButton label="Align left" active={s.align === 'left'} onClick={() => chain().setTextAlign('left').run()}><AlignLeft size={16} /></IconButton>
      <IconButton label="Align centre" active={s.align === 'center'} onClick={() => chain().setTextAlign('center').run()}><AlignCenter size={16} /></IconButton>
      <IconButton label="Align right" active={s.align === 'right'} onClick={() => chain().setTextAlign('right').run()}><AlignRight size={16} /></IconButton>
      <IconButton label="Justify" active={s.align === 'justify'} onClick={() => chain().setTextAlign('justify').run()}><AlignJustify size={16} /></IconButton>
      <Divider />
      <IconButton label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}><List size={16} /></IconButton>
      <IconButton label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={16} /></IconButton>
      <IconButton label="Decrease indent" disabled={!s.canLift} onClick={() => chain().liftListItem('listItem').run()}><IndentDecrease size={16} /></IconButton>
      <IconButton label="Increase indent" disabled={!s.canSink} onClick={() => chain().sinkListItem('listItem').run()}><IndentIncrease size={16} /></IconButton>
      <Divider />
      <IconButton label="Link (Ctrl+K)" active={s.link} onClick={() => setLinkOpen(true)}><LinkIcon size={16} /></IconButton>
      <IconButton label="Insert image" onClick={insertImage}><ImageIcon size={16} /></IconButton>
      <Popover label="Table" button={<TableIcon size={16} />}>
        {(close) => {
          const run = (fn: () => void) => () => {
            fn();
            close();
          };
          return (
            <div className="menu">
              <MenuItem onClick={run(() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}>Insert 3 × 3 table</MenuItem>
              <MenuItem onClick={run(() => chain().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run())}>Insert 2 × 2 table</MenuItem>
              <div className="menu-sep" />
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().addRowBefore().run())}>Insert row above</MenuItem>
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().addRowAfter().run())}>Insert row below</MenuItem>
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().addColumnBefore().run())}>Insert column left</MenuItem>
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().addColumnAfter().run())}>Insert column right</MenuItem>
              <div className="menu-sep" />
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().mergeOrSplit().run())}>Merge / split cells</MenuItem>
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().toggleHeaderRow().run())}>Toggle header row</MenuItem>
              <div className="menu-sep" />
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().deleteRow().run())}>Delete row</MenuItem>
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().deleteColumn().run())}>Delete column</MenuItem>
              <MenuItem disabled={!s.inTable} onClick={run(() => chain().deleteTable().run())}>Delete table</MenuItem>
            </div>
          );
        }}
      </Popover>
      <IconButton label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}><Minus size={16} /></IconButton>
      <IconButton label="Page break (Ctrl+Enter)" onClick={() => chain().insertPageBreak().run()}><SeparatorHorizontal size={16} /></IconButton>
      <Divider />
      <IconButton label="Page setup" onClick={onPageSetup}><Settings2 size={16} /></IconButton>

      {linkOpen && (
        <PromptModal
          title={s.link ? 'Edit link' : 'Insert link'}
          label="Address"
          placeholder="https://example.com"
          initial={s.href}
          confirmLabel="Apply"
          onClose={() => setLinkOpen(false)}
          extra={
            s.link ? (
              <button
                type="button"
                className="btn btn-text btn-danger"
                onClick={() => {
                  chain().extendMarkRange('link').unsetLink().run();
                  setLinkOpen(false);
                }}
              >
                Remove link
              </button>
            ) : undefined
          }
          onSubmit={(value) => {
            const href = normalizeUrl(value);
            setLinkOpen(false);
            if (!href) {
              if (value) onError('That link type is not allowed. Use a web address, e-mail address or phone number.');
              return;
            }
            const { empty } = editor.state.selection;
            if (empty && !s.link) {
              chain().insertContent({ type: 'text', text: value, marks: [{ type: 'link', attrs: { href } }] }).run();
            } else {
              chain().extendMarkRange('link').setLink({ href }).run();
            }
          }}
        />
      )}
    </div>
  );
}

function PageSetupModal({ value, onApply, onClose }: { value: PageSetup; onApply: (v: PageSetup) => void; onClose: () => void }) {
  const [draft, setDraft] = useState(value);
  const inches = (pt: number) => String(Math.round((pt / 72) * 100) / 100);
  const setMargin = (side: keyof PageSetup['margins'], v: string) => {
    const n = Math.max(0, Math.min(4, parseFloat(v) || 0));
    setDraft((d) => ({ ...d, margins: { ...d.margins, [side]: n * 72 } }));
  };
  return (
    <Modal
      title="Page setup"
      onClose={onClose}
      footer={
        <>
          <span className="spacer" />
          <button type="button" className="btn btn-text" onClick={onClose}>Cancel</button>
          <button type="button" className="btn btn-primary" onClick={() => onApply(draft)}>Apply</button>
        </>
      }
    >
      <div className="grid-2">
        <Field label="Paper size">
          <select className="input" value={draft.size} onChange={(e) => setDraft({ ...draft, size: e.target.value as PageSetup['size'] })}>
            <option value="letter">Letter (8.5 × 11 in)</option>
            <option value="a4">A4 (210 × 297 mm)</option>
            <option value="legal">Legal (8.5 × 14 in)</option>
          </select>
        </Field>
        <Field label="Orientation">
          <select className="input" value={draft.orientation} onChange={(e) => setDraft({ ...draft, orientation: e.target.value as PageSetup['orientation'] })}>
            <option value="portrait">Portrait</option>
            <option value="landscape">Landscape</option>
          </select>
        </Field>
        {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
          <Field key={side} label={`${side[0].toUpperCase()}${side.slice(1)} margin (in)`}>
            <input className="input" type="number" min={0} max={4} step={0.05} value={inches(draft.margins[side])} onChange={(e) => setMargin(side, e.target.value)} />
          </Field>
        ))}
      </div>
    </Modal>
  );
}

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ initial, zoom, onChange, onStats, onError }, ref) {
  const [pageSetup, setPageSetup] = useState<PageSetup>(initial.pageSetup ?? DEFAULT_PAGE_SETUP);
  const [setupOpen, setSetupOpen] = useState(false);
  const extensions = useMemo(() => createExtensions(), []);

  const editor = useEditor({
    extensions,
    content: initial.html,
    autofocus: 'start',
    shouldRerenderOnTransaction: false,
    editorProps: {
      attributes: { class: 'doc-content', spellcheck: 'true', 'aria-label': 'Document' },
      // pasted / dropped image files become embedded images
      handlePaste(view, event) {
        const file = Array.from(event.clipboardData?.files ?? []).find((f) => f.type.startsWith('image/'));
        if (!file) return false;
        event.preventDefault();
        void loadImageFile(file, file.name, 2000).then((img) => {
          const k = Math.min(1, 620 / img.width);
          const node = view.state.schema.nodes.image.create({ src: img.dataUrl, width: Math.round(img.width * k), height: Math.round(img.height * k) });
          view.dispatch(view.state.tr.replaceSelectionWith(node));
        });
        return true;
      },
      // dropped image files are embedded at the drop position; other files are ignored here
      handleDrop(view, event, _slice, moved) {
        if (moved) return false;
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (!files.length) return false;
        event.preventDefault();
        const images = files.filter((f) => f.type.startsWith('image/'));
        if (!images.length) {
          onError('To open a document, drop it outside the page or use Open.');
          return true;
        }
        const pos = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos ?? view.state.selection.from;
        void (async () => {
          for (const file of images.reverse()) {
            try {
              const img = await loadImageFile(file, file.name, 2000);
              const k = Math.min(1, 620 / img.width);
              const node = view.state.schema.nodes.image.create({ src: img.dataUrl, alt: file.name.replace(/\.[^.]+$/, ''), width: Math.round(img.width * k), height: Math.round(img.height * k) });
              view.dispatch(view.state.tr.insert(Math.min(pos, view.state.doc.content.size), node));
            } catch (err) {
              onError(err instanceof Error ? err.message : 'Could not insert the image.');
            }
          }
        })();
        return true;
      },
    },
    onUpdate({ editor: e }) {
      onChange();
      onStats?.({ words: e.storage.characterCount.words(), characters: e.storage.characterCount.characters() });
    },
    onCreate({ editor: e }) {
      onStats?.({ words: e.storage.characterCount.words(), characters: e.storage.characterCount.characters() });
    },
  });

  useImperativeHandle(
    ref,
    () => ({
      getDocument: () => ({ html: editor?.getHTML() ?? initial.html, title: initial.title, pageSetup }),
    }),
    [editor, initial, pageSetup],
  );

  // Ctrl/Cmd+K opens the link dialog through the toolbar button
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('button[aria-label="Link (Ctrl+K)"]')?.click();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!editor) return null;

  const dims = pageDimensions(pageSetup);
  const px = (pt: number) => `${(pt * 96) / 72}px`;

  return (
    <div className="editor-root">
      <Toolbar editor={editor} onPageSetup={() => setSetupOpen(true)} onError={onError} />
      <div className="workspace" onMouseDown={(e) => e.target === e.currentTarget && editor.commands.focus('end')}>
        <div
          className="page-sheet"
          style={{
            width: px(dims.width),
            minHeight: px(dims.height),
            padding: `${px(pageSetup.margins.top)} ${px(pageSetup.margins.right)} ${px(pageSetup.margins.bottom)} ${px(pageSetup.margins.left)}`,
            zoom,
          }}
        >
          <EditorContent editor={editor} />
        </div>
      </div>
      {setupOpen && (
        <PageSetupModal
          value={pageSetup}
          onClose={() => setSetupOpen(false)}
          onApply={(v) => {
            setPageSetup(v);
            setSetupOpen(false);
            onChange();
          }}
        />
      )}
    </div>
  );
});
