import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { useTabActive } from '../tab-active';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { TextSelection } from '@tiptap/pm/state';
import {
  AArrowDown,
  AArrowUp,
  AlignCenter,
  AlignJustify,
  AlignLeft,
  AlignRight,
  ArrowDownAZ,
  Baseline,
  Bold,
  CaseSensitive,
  Check,
  ClipboardPaste,
  Copy,
  Eraser,
  Grid2x2,
  Highlighter,
  Image as ImageIcon,
  IndentDecrease,
  IndentIncrease,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  PaintBucket,
  Paintbrush,
  PanelTop,
  Pen,
  PenLine,
  Pilcrow,
  Redo2,
  RemoveFormatting,
  Rows3,
  Scissors,
  Search,
  SeparatorHorizontal,
  Settings2,
  Strikethrough,
  Subscript as SubIcon,
  Superscript as SupIcon,
  Table as TableIcon,
  Underline,
  Undo2,
} from 'lucide-react';
import { DEFAULT_HF_DISTANCE, DEFAULT_PAGE_SETUP, pageDimensions, type PageSetup, type RichDocument } from '../../core/types';
import { toDataUrl } from '../../core/dom';
import { decodeImage, encodeImage, type DecodedImage } from '../../core/media/image-codecs';
import { getHost } from '../../platform/host';
import { ColorPicker, cx, Divider, Field, IconButton, MenuItem, Modal, Popover, PromptModal, Select } from '../components';
import { IMAGE_EXTENSIONS, loadImageFile } from '../image-utils';
import { ImageEditor, type ImageEditorHandle } from '../image/ImageEditor';
import { createExtensions } from './extensions';
import { FindBar } from '../FindBar';
import { DEFAULT_SEARCH, type SearchOptions } from '../../core/search';
import { getFind, gotoMatch, replaceAll, replaceCurrent, setSearch } from './search-extension';
import { usePinchZoom } from '../usePinchZoom';
import { DrawLayer, type DrawLayerHandle, type DrawSettings, type DrawTool } from './DrawLayer';
import type { BorderMode } from './format-extensions';
import { applyFormat, captureFormat, CASE_MODES, changeCase, LINE_SPACINGS, sortSelection, stepFontSize, type PaintFormat } from './word-tools';

export interface RichEditorHandle {
  getDocument(): RichDocument;
}

interface Props {
  initial: RichDocument;
  zoom: number;
  /** Pinch / Ctrl+wheel zoom requests. */
  onZoom?: (zoom: number) => void;
  onChange: () => void;
  onStats?: (stats: { words: number; characters: number }) => void;
  /** Approximate page count for the status bar (headers repeat visually per page). */
  onPageCount?: (n: number) => void;
  onError: (message: string, kind?: 'error' | 'info') => void;
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

interface ToolbarProps {
  editor: Editor;
  onPageSetup: () => void;
  onFind: () => void;
  onError: (message: string, kind?: 'error' | 'info') => void;
  drawing: boolean;
  onToggleDraw: () => void;
  showMarks: boolean;
  onToggleMarks: () => void;
  painting: boolean;
  onPaint: () => void;
  /** Which header / footer is being edited (the toolbar then formats it). */
  headerFooter: 'header' | 'footer' | null;
  onHeaderFooter: () => void;
}

const BORDER_MODES: { mode: BorderMode; label: string }[] = [
  { mode: 'all', label: 'All borders' },
  { mode: 'outside', label: 'Outside borders' },
  { mode: 'inside', label: 'Inside borders' },
  { mode: 'top', label: 'Top border' },
  { mode: 'bottom', label: 'Bottom border' },
  { mode: 'left', label: 'Left border' },
  { mode: 'right', label: 'Right border' },
  { mode: 'none', label: 'No border' },
];

function Toolbar({ editor, onPageSetup, onFind, onError, drawing, onToggleDraw, showMarks, onToggleMarks, painting, onPaint, headerFooter, onHeaderFooter }: ToolbarProps) {
  const [linkOpen, setLinkOpen] = useState(false);
  const s = useEditorState({
    editor,
    selector: ({ editor: e }) => {
      const ts = e.getAttributes('textStyle') as { color?: string; fontFamily?: string; fontSize?: string };
      const block = e.isActive('heading') ? e.getAttributes('heading') : e.getAttributes('paragraph');
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
        canAddRowBefore: e.can().addRowBefore(),
        canAddRowAfter: e.can().addRowAfter(),
        canAddColBefore: e.can().addColumnBefore(),
        canAddColAfter: e.can().addColumnAfter(),
        canMergeSplit: e.can().mergeOrSplit(),
        canToggleHeader: e.can().toggleHeaderRow(),
        canDeleteRow: e.can().deleteRow(),
        canDeleteCol: e.can().deleteColumn(),
        canDeleteTable: e.can().deleteTable(),
        align: e.isActive({ textAlign: 'center' }) ? 'center' : e.isActive({ textAlign: 'right' }) ? 'right' : e.isActive({ textAlign: 'justify' }) ? 'justify' : 'left',
        color: ts.color ?? null,
        highlight: e.isActive('highlight') ? ((e.getAttributes('highlight').color as string | undefined) ?? '#fff59d') : null,
        fontFamily: (ts.fontFamily ?? '').split(',')[0].replace(/["']/g, '').trim(),
        fontSize: (ts.fontSize ?? '').replace(/pt$/, ''),
        canUndo: e.can().undo(),
        canRedo: e.can().redo(),
        canSink: e.can().sinkListItem('listItem'),
        canLift: e.can().liftListItem('listItem'),
        inList: e.isActive('bulletList') || e.isActive('orderedList'),
        lineHeight: (block.lineHeight as string | null) ?? null,
        spaceBefore: (block.spaceBefore as string | null) ?? null,
        spaceAfter: (block.spaceAfter as string | null) ?? null,
        indent: (block.indent as string | null) ?? null,
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

  const clip = (command: 'cut' | 'copy') => {
    editor.commands.focus();
    let ok = false;
    try {
      ok = document.execCommand(command);
    } catch {
      ok = false;
    }
    if (!ok) onError(`Your browser blocked the clipboard. Press ${command === 'cut' ? 'Ctrl+X' : 'Ctrl+C'} instead.`, 'info');
  };

  const paste = async () => {
    editor.commands.focus();
    try {
      const items = await navigator.clipboard.read();
      for (const item of items) {
        if (item.types.includes('text/html')) {
          editor.view.pasteHTML(await (await item.getType('text/html')).text());
          return;
        }
        const image = item.types.find((t) => t.startsWith('image/'));
        if (image) {
          const img = await loadImageFile(await item.getType(image), 'Pasted image', 2000);
          const k = Math.min(1, 620 / img.width);
          chain().setImage({ src: img.dataUrl, width: Math.round(img.width * k), height: Math.round(img.height * k) }).run();
          return;
        }
        if (item.types.includes('text/plain')) {
          editor.view.pasteText(await (await item.getType('text/plain')).text());
          return;
        }
      }
    } catch {
      onError('Your browser blocked the clipboard. Press Ctrl+V to paste.', 'info');
    }
  };

  const indent = (direction: 1 | -1) => {
    if (s.inList) {
      if (direction > 0) chain().sinkListItem('listItem').run();
      else chain().liftListItem('listItem').run();
    } else {
      chain().shiftIndent(direction).run();
    }
  };

  // Word shades the selected table cells, or the paragraph outside tables
  const shade = (color: string | null) => {
    if (s.inTable) chain().setCellBackground(color).run();
    else chain().setParagraphShading(color).run();
  };

  const fontFamilies = s.fontFamily && !FONT_FAMILIES.includes(s.fontFamily) ? [s.fontFamily, ...FONT_FAMILIES] : FONT_FAMILIES;
  const fontSizes = s.fontSize && !FONT_SIZES.includes(s.fontSize) ? [s.fontSize, ...FONT_SIZES] : FONT_SIZES;

  return (
    <div className="toolbar" role="toolbar" aria-label="Formatting">
      <IconButton label="Undo (Ctrl+Z)" disabled={!s.canUndo} onClick={() => chain().undo().run()}><Undo2 size={16} /></IconButton>
      <IconButton label="Redo (Ctrl+Y)" disabled={!s.canRedo} onClick={() => chain().redo().run()}><Redo2 size={16} /></IconButton>
      <Divider />
      <IconButton label="Cut (Ctrl+X)" onClick={() => clip('cut')}><Scissors size={16} /></IconButton>
      <IconButton label="Copy (Ctrl+C)" onClick={() => clip('copy')}><Copy size={16} /></IconButton>
      <IconButton label="Paste (Ctrl+V)" onClick={() => void paste()}><ClipboardPaste size={16} /></IconButton>
      <IconButton label="Format painter: copies the formatting here; then select text to apply it" active={painting} onClick={onPaint}><Paintbrush size={16} /></IconButton>
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
      <IconButton label="Grow font (Ctrl+])" onClick={() => stepFontSize(editor, 1)}><AArrowUp size={16} /></IconButton>
      <IconButton label="Shrink font (Ctrl+[)" onClick={() => stepFontSize(editor, -1)}><AArrowDown size={16} /></IconButton>
      <Popover label="Change case" button={<CaseSensitive size={17} />}>
        {(close) => (
          <div className="menu">
            {CASE_MODES.map(({ mode, label }) => (
              <MenuItem
                key={mode}
                onClick={() => {
                  close();
                  if (!changeCase(editor, mode)) onError('Select the text to change, or put the cursor in a word.', 'info');
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        )}
      </Popover>
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
      <IconButton label="Bulleted list" active={s.bullet} onClick={() => chain().toggleBulletList().run()}><List size={16} /></IconButton>
      <IconButton label="Numbered list" active={s.ordered} onClick={() => chain().toggleOrderedList().run()}><ListOrdered size={16} /></IconButton>
      <IconButton label="Decrease indent" disabled={s.inList ? !s.canLift : !s.indent} onClick={() => indent(-1)}><IndentDecrease size={16} /></IconButton>
      <IconButton label="Increase indent" disabled={s.inList && !s.canSink} onClick={() => indent(1)}><IndentIncrease size={16} /></IconButton>
      <Popover label="Sort" button={<ArrowDownAZ size={16} />}>
        {(close) => {
          const run = (desc: boolean) => () => {
            close();
            if (!sortSelection(editor, desc)) onError('Select two or more paragraphs (or put the cursor in a list) to sort.', 'info');
          };
          return (
            <div className="menu">
              <MenuItem onClick={run(false)}>Sort A → Z</MenuItem>
              <MenuItem onClick={run(true)}>Sort Z → A</MenuItem>
            </div>
          );
        }}
      </Popover>
      <IconButton label="Show formatting marks (Ctrl+Shift+8)" active={showMarks} onClick={onToggleMarks}><Pilcrow size={16} /></IconButton>
      <Divider />
      <IconButton label="Align left" active={s.align === 'left'} onClick={() => chain().setTextAlign('left').run()}><AlignLeft size={16} /></IconButton>
      <IconButton label="Align centre" active={s.align === 'center'} onClick={() => chain().setTextAlign('center').run()}><AlignCenter size={16} /></IconButton>
      <IconButton label="Align right" active={s.align === 'right'} onClick={() => chain().setTextAlign('right').run()}><AlignRight size={16} /></IconButton>
      <IconButton label="Justify" active={s.align === 'justify'} onClick={() => chain().setTextAlign('justify').run()}><AlignJustify size={16} /></IconButton>
      <Popover label="Line and paragraph spacing" button={<Rows3 size={16} />}>
        {(close) => {
          const run = (fn: () => void) => () => {
            fn();
            close();
          };
          return (
            <div className="menu">
              {LINE_SPACINGS.map((l) => (
                <MenuItem key={l.word} onClick={run(() => chain().setLineHeight(l.css).run())}>
                  <span className="menu-check">{s.lineHeight === l.css ? <Check size={14} /> : null}</span>
                  {String(l.word)}
                </MenuItem>
              ))}
              <MenuItem onClick={run(() => chain().setLineHeight(null).run())}>
                <span className="menu-check">{!s.lineHeight ? <Check size={14} /> : null}</span>
                Default (1.08)
              </MenuItem>
              <div className="menu-sep" />
              {s.spaceBefore && s.spaceBefore !== '0pt' ? (
                <MenuItem onClick={run(() => chain().setParagraphSpacing({ before: null }).run())}>Remove space before paragraph</MenuItem>
              ) : (
                <MenuItem onClick={run(() => chain().setParagraphSpacing({ before: 12 }).run())}>Add space before paragraph</MenuItem>
              )}
              {s.spaceAfter === '0pt' ? (
                <MenuItem onClick={run(() => chain().setParagraphSpacing({ after: null }).run())}>Add space after paragraph</MenuItem>
              ) : (
                <MenuItem onClick={run(() => chain().setParagraphSpacing({ after: 0 }).run())}>Remove space after paragraph</MenuItem>
              )}
            </div>
          );
        }}
      </Popover>
      <ColorPicker label={s.inTable ? 'Cell shading' : 'Paragraph shading'} icon={<PaintBucket size={16} />} value={null} onPick={(c) => shade(c)} onClear={() => shade(null)} clearLabel="No colour" />
      <Popover label={s.inTable ? 'Borders' : 'Borders (put the cursor in a table)'} button={<Grid2x2 size={16} />} disabled={!s.inTable}>
        {(close) => (
          <div className="menu">
            {BORDER_MODES.map(({ mode, label }) => (
              <MenuItem
                key={mode}
                onClick={() => {
                  close();
                  chain().setCellBorders(mode).run();
                }}
              >
                {label}
              </MenuItem>
            ))}
          </div>
        )}
      </Popover>
      <Divider />
      <IconButton label="Link (Ctrl+K)" active={s.link} onClick={() => setLinkOpen(true)}><LinkIcon size={16} /></IconButton>
      <IconButton label="Insert image" onClick={insertImage}><ImageIcon size={16} /></IconButton>
      <Popover label="Table" button={<TableIcon size={16} />}>
        {(close) => {
          const run = (fn: () => boolean | void) => () => {
            fn();
            close();
          };
          return (
            <div className="menu">
              <MenuItem onClick={run(() => chain().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run())}>Insert 3 × 3 table</MenuItem>
              <MenuItem onClick={run(() => chain().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run())}>Insert 2 × 2 table</MenuItem>
              <div className="menu-sep" />
              <MenuItem disabled={!s.canAddRowBefore} onClick={run(() => chain().addRowBefore().run())}>Insert row above</MenuItem>
              <MenuItem disabled={!s.canAddRowAfter} onClick={run(() => chain().addRowAfter().run())}>Insert row below</MenuItem>
              <MenuItem disabled={!s.canAddColBefore} onClick={run(() => chain().addColumnBefore().run())}>Insert column left</MenuItem>
              <MenuItem disabled={!s.canAddColAfter} onClick={run(() => chain().addColumnAfter().run())}>Insert column right</MenuItem>
              <div className="menu-sep" />
              <MenuItem disabled={!s.canMergeSplit} onClick={run(() => chain().mergeOrSplit().run())}>Merge / split cells</MenuItem>
              <MenuItem disabled={!s.canToggleHeader} onClick={run(() => chain().toggleHeaderRow().run())}>Toggle header row</MenuItem>
              <div className="menu-sep" />
              <MenuItem disabled={!s.canDeleteRow} onClick={run(() => chain().deleteRow().run())}>Delete row</MenuItem>
              <MenuItem disabled={!s.canDeleteCol} onClick={run(() => chain().deleteColumn().run())}>Delete column</MenuItem>
              <MenuItem disabled={!s.canDeleteTable} onClick={run(() => chain().deleteTable().run())}>Delete table</MenuItem>
            </div>
          );
        }}
      </Popover>
      <IconButton label="Horizontal line" onClick={() => chain().setHorizontalRule().run()}><Minus size={16} /></IconButton>
      <IconButton label="Page break (Ctrl+Enter)" onClick={() => chain().insertPageBreak().run()}><SeparatorHorizontal size={16} /></IconButton>
      <Divider />
      <IconButton label={headerFooter ? 'Close header and footer' : 'Header & footer (or double-click the top or bottom margin)'} active={!!headerFooter} onClick={onHeaderFooter}><PanelTop size={16} /></IconButton>
      <IconButton label="Page setup" onClick={onPageSetup}><Settings2 size={16} /></IconButton>
      <IconButton label="Find & replace (Ctrl+F)" onClick={onFind}><Search size={16} /></IconButton>
      <IconButton label="Draw" active={drawing} onClick={onToggleDraw}><PenLine size={16} /></IconButton>

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

const INK_COLORS = ['#1b1b1f', '#d62828', '#1a56db', '#138a36', '#7b2cbf', '#f77f00'];
const HIGHLIGHTER_COLORS = ['#ffd400', '#7cf27c', '#5ee2ff', '#ff8ad8', '#ffa94d'];
const PEN_WIDTHS = [
  { value: '1.5', label: 'Fine' },
  { value: '3', label: 'Medium' },
  { value: '6', label: 'Thick' },
  { value: '10', label: 'Marker' },
];

function TableContextMenu({ editor, x, y, onClose }: { editor: Editor; x: number; y: number; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const run = (fn: () => boolean) => () => {
    fn();
    onClose();
  };
  const vw = typeof window !== 'undefined' ? window.innerWidth : x + 220;
  const vh = typeof window !== 'undefined' ? window.innerHeight : y + 320;
  const left = Math.max(8, Math.min(x, vw - 220));
  const top = Math.max(8, Math.min(y, vh - 280));

  return (
    <div ref={ref} className="popover table-context-menu" role="menu" style={{ position: 'fixed', top, left, zIndex: 80 }} onContextMenu={(e) => e.preventDefault()}>
      <div className="menu">
        <MenuItem disabled={!editor.can().addRowBefore()} onClick={run(() => editor.chain().focus().addRowBefore().run())}>Insert row above</MenuItem>
        <MenuItem disabled={!editor.can().addRowAfter()} onClick={run(() => editor.chain().focus().addRowAfter().run())}>Insert row below</MenuItem>
        <MenuItem disabled={!editor.can().addColumnBefore()} onClick={run(() => editor.chain().focus().addColumnBefore().run())}>Insert column left</MenuItem>
        <MenuItem disabled={!editor.can().addColumnAfter()} onClick={run(() => editor.chain().focus().addColumnAfter().run())}>Insert column right</MenuItem>
        <div className="menu-sep" />
        <MenuItem disabled={!editor.can().mergeOrSplit()} onClick={run(() => editor.chain().focus().mergeOrSplit().run())}>Merge / split cells</MenuItem>
        <MenuItem disabled={!editor.can().toggleHeaderRow()} onClick={run(() => editor.chain().focus().toggleHeaderRow().run())}>Toggle header row</MenuItem>
        <div className="menu-sep" />
        <MenuItem disabled={!editor.can().deleteRow()} onClick={run(() => editor.chain().focus().deleteRow().run())}>Delete row</MenuItem>
        <MenuItem disabled={!editor.can().deleteColumn()} onClick={run(() => editor.chain().focus().deleteColumn().run())}>Delete column</MenuItem>
        <MenuItem disabled={!editor.can().deleteTable()} onClick={run(() => editor.chain().focus().deleteTable().run())}>Delete table</MenuItem>
      </div>
    </div>
  );
}

function DrawToolbar({ settings, onChange, onDone }: { settings: DrawSettings; onChange: (s: DrawSettings) => void; onDone: () => void }) {
  const [penColor, setPenColor] = useState(settings.tool === 'highlighter' ? INK_COLORS[0] : settings.color);
  const [hlColor, setHlColor] = useState(HIGHLIGHTER_COLORS[0]);
  const pick = (tool: DrawTool) => onChange({ ...settings, tool, color: tool === 'highlighter' ? hlColor : penColor });
  const colors = settings.tool === 'highlighter' ? HIGHLIGHTER_COLORS : INK_COLORS;
  return (
    <div className="toolbar draw-toolbar" role="toolbar" aria-label="Drawing tools">
      <IconButton label="Pen" active={settings.tool === 'pen'} onClick={() => pick('pen')}><Pen size={16} /></IconButton>
      <IconButton label="Highlighter pen" active={settings.tool === 'highlighter'} onClick={() => pick('highlighter')}><Highlighter size={16} /></IconButton>
      <IconButton label="Eraser: drag over a drawing to remove it" active={settings.tool === 'eraser'} onClick={() => pick('eraser')}><Eraser size={16} /></IconButton>
      <Divider />
      {settings.tool !== 'eraser' && (
        <>
          {colors.map((c) => (
            <button
              key={c}
              type="button"
              className={cx('swatch ink-swatch', settings.color === c && 'is-active')}
              style={{ background: c }}
              title={c}
              aria-label={`Colour ${c}`}
              onClick={() => {
                if (settings.tool === 'highlighter') setHlColor(c);
                else setPenColor(c);
                onChange({ ...settings, color: c });
              }}
            />
          ))}
          {settings.tool === 'pen' && (
            <>
              <Divider />
              <Select label="Thickness" value={String(settings.width)} options={PEN_WIDTHS} width={92} onChange={(v) => onChange({ ...settings, width: parseFloat(v) })} />
            </>
          )}
        </>
      )}
      <span className="draw-hint">{settings.tool === 'eraser' ? 'Drag over a drawing to erase it.' : 'Draw on the page. Drawings stay with the text they are drawn over.'}</span>
      <button type="button" className="btn btn-primary draw-done" onClick={onDone}>Done</button>
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
        <label className="check-row">
          <input type="checkbox" checked={!!draft.differentFirstPage} onChange={(e) => setDraft({ ...draft, differentFirstPage: e.target.checked })} />
          Different first page header/footer
        </label>
        <label className="check-row">
          <input type="checkbox" checked={!!draft.differentOddEven} onChange={(e) => setDraft({ ...draft, differentOddEven: e.target.checked })} />
          Different odd and even headers/footers
        </label>
      </div>
    </Modal>
  );
}

/** True when an editor holds any text or picture. */
function hasContent(ed: Editor | null): boolean {
  return !!ed && (ed.getText().trim().length > 0 || /<img\b/i.test(ed.getHTML()));
}

/** A small editor for the page header or footer (same schema as the body). */
function useSideEditor(content: string | undefined, placeholder: string, onChange: () => void): Editor | null {
  const changed = useRef(onChange);
  changed.current = onChange;
  const extensions = useMemo(() => createExtensions(placeholder), [placeholder]);
  return useEditor({
    extensions,
    content: content ?? '',
    shouldRerenderOnTransaction: false,
    editorProps: { attributes: { class: 'doc-content', spellcheck: 'true', 'aria-label': placeholder } },
    onUpdate: () => changed.current(),
  });
}

export const RichEditor = forwardRef<RichEditorHandle, Props>(function RichEditor({ initial, zoom, onZoom, onChange, onStats, onPageCount, onError }, ref) {
  const [pageSetup, setPageSetup] = useState<PageSetup>(initial.pageSetup ?? DEFAULT_PAGE_SETUP);
  const [setupOpen, setSetupOpen] = useState(false);
  const [find, setFind] = useState<{ replace: boolean; token: number } | null>(null);
  const [query, setQuery] = useState('');
  const [searchOpts, setSearchOpts] = useState<SearchOptions>(DEFAULT_SEARCH);
  const [findInfo, setFindInfo] = useState({ total: 0, current: -1 });
  const [scrollEl, setScrollEl] = useState<HTMLDivElement | null>(null);
  const [drawing, setDrawing] = useState(false);
  const [drawSettings, setDrawSettings] = useState<DrawSettings>({ tool: 'pen', color: INK_COLORS[0], width: 3 });
  const drawRef = useRef<DrawLayerHandle>(null);
  const [showMarks, setShowMarks] = useState(false);
  const [painter, setPainter] = useState<PaintFormat | null>(null);
  const [hfEdit, setHfEdit] = useState<'header' | 'footer' | null>(null);
  const headerEditor = useSideEditor(initial.header, 'Header', onChange);
  const footerEditor = useSideEditor(initial.footer, 'Footer', onChange);
  const [sheetEl, setSheetEl] = useState<HTMLDivElement | null>(null);
  const [pageCount, setPageCount] = useState(1);
  const [hfSnap, setHfSnap] = useState({ header: initial.header ?? '', footer: initial.footer ?? '' });
  const [imgEdit, setImgEdit] = useState<{ pos: number; decoded: DecodedImage } | null>(null);
  const [tableMenu, setTableMenu] = useState<{ x: number; y: number } | null>(null);
  const imgEditRef = useRef<ImageEditorHandle>(null);
  usePinchZoom(scrollEl, sheetEl, zoom, onZoom, { min: 0.25, max: 4 });
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
      getDocument: () => {
        drawRef.current?.flush(); // strokes still being grouped become part of the document
        return {
          html: editor?.getHTML() ?? initial.html,
          title: initial.title,
          pageSetup,
          header: hasContent(headerEditor) ? headerEditor!.getHTML() : undefined,
          footer: hasContent(footerEditor) ? footerEditor!.getHTML() : undefined,
          // first / even variants are not edited in the UI yet — keep what was imported
          headerFirst: initial.headerFirst,
          footerFirst: initial.footerFirst,
          headerEven: initial.headerEven,
          footerEven: initial.footerEven,
        };
      },
    }),
    [editor, initial, pageSetup, headerEditor, footerEditor],
  );

  // keep the find bar's "n of m" in step with the editor (typing can add or remove matches)
  useEffect(() => {
    if (!editor) return;
    const sync = () => {
      const f = getFind(editor.view);
      setFindInfo((cur) => (cur.total === f.matches.length && cur.current === f.current ? cur : { total: f.matches.length, current: f.current }));
    };
    editor.on('transaction', sync);
    return () => {
      editor.off('transaction', sync);
    };
  }, [editor]);

  const openFind = useCallback(
    (replace: boolean) => {
      // start from the selected text, like Word and browsers do
      const sel = editor ? editor.state.doc.textBetween(editor.state.selection.from, editor.state.selection.to, ' ') : '';
      if (sel && sel.length < 200 && !sel.includes('\n')) setQuery(sel);
      setFind((f) => ({ replace: replace || !!f?.replace, token: (f?.token ?? 0) + 1 }));
    },
    [editor],
  );

  const closeFind = () => {
    setFind(null);
    if (editor) {
      setSearch(editor.view, '', searchOpts);
      editor.commands.focus();
    }
  };

  // search as you type
  useEffect(() => {
    if (!editor || !find) return;
    setSearch(editor.view, query, searchOpts);
  }, [editor, find, query, searchOpts]);

  // Snapshot header/footer HTML so later pages can mirror the live editors
  useEffect(() => {
    if (!headerEditor || !footerEditor) return;
    const sync = () => setHfSnap({ header: headerEditor.getHTML(), footer: footerEditor.getHTML() });
    sync();
    headerEditor.on('update', sync);
    footerEditor.on('update', sync);
    return () => {
      headerEditor.off('update', sync);
      footerEditor.off('update', sync);
    };
  }, [headerEditor, footerEditor]);

  // Double-click an image in the document to open the photo editor
  useEffect(() => {
    const editors = [editor, headerEditor, footerEditor].filter(Boolean) as Editor[];
    const onEdit = (e: Event) => {
      const detail = (e as CustomEvent<{ src: string; pos: number }>).detail;
      if (!detail?.src?.startsWith('data:image/')) return;
      void (async () => {
        try {
          const res = await fetch(detail.src);
          const blob = await res.blob();
          const decoded = await decodeImage(blob, 'image.png');
          setImgEdit({ pos: detail.pos, decoded });
        } catch (err) {
          onError(err instanceof Error ? err.message : 'Could not open the image for editing.');
        }
      })();
    };
    for (const ed of editors) ed.view.dom.addEventListener('edit-doc-image', onEdit);
    return () => {
      for (const ed of editors) ed.view.dom.removeEventListener('edit-doc-image', onEdit);
    };
  }, [editor, headerEditor, footerEditor, onError]);

  // Right-click inside a table to insert / delete rows and columns
  useEffect(() => {
    if (!editor) return;
    const onContext = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      if (!t?.closest?.('td, th, table')) {
        setTableMenu(null);
        return;
      }
      // Put the caret in the clicked cell so table commands apply there
      const coords = editor.view.posAtCoords({ left: e.clientX, top: e.clientY });
      if (coords) {
        editor.view.dispatch(editor.view.state.tr.setSelection(TextSelection.near(editor.view.state.doc.resolve(coords.pos))));
      }
      if (!editor.isActive('table')) {
        setTableMenu(null);
        return;
      }
      e.preventDefault();
      setTableMenu({ x: e.clientX, y: e.clientY });
    };
    const onClose = () => setTableMenu(null);
    editor.view.dom.addEventListener('contextmenu', onContext);
    window.addEventListener('scroll', onClose, true);
    window.addEventListener('resize', onClose);
    return () => {
      editor.view.dom.removeEventListener('contextmenu', onContext);
      window.removeEventListener('scroll', onClose, true);
      window.removeEventListener('resize', onClose);
    };
  }, [editor]);


  // How many page-tall slices the body needs (measure the body only — not the padded minHeight)
  useEffect(() => {
    if (!sheetEl) return;
    const pageH = (pageDimensions(pageSetup).height * 96) / 72;
    const topPad = (pageSetup.margins.top * 96) / 72;
    const bottomPad = (pageSetup.margins.bottom * 96) / 72;
    const measure = () => {
      const body = sheetEl.querySelector('.body-layer') as HTMLElement | null;
      const bodyH = body ? body.scrollHeight : 0;
      const total = topPad + bodyH + bottomPad;
      const n = Math.max(1, Math.ceil(total / pageH - 0.001));
      setPageCount((cur) => (cur === n ? cur : n));
      onPageCount?.(n);
    };
    measure();
    const ro = new ResizeObserver(measure);
    const body = sheetEl.querySelector('.body-layer');
    if (body) ro.observe(body);
    else ro.observe(sheetEl);
    editor?.on('update', measure);
    return () => {
      ro.disconnect();
      editor?.off('update', measure);
    };
  }, [sheetEl, pageSetup, editor, onPageCount]);

  // the editor being worked on: the body, or the header / footer while editing it
  const active = (hfEdit === 'header' ? headerEditor : hfEdit === 'footer' ? footerEditor : editor) ?? editor;

  const applyImgEdit = async () => {
    if (!imgEdit || !editor) return;
    try {
      const pixels = imgEditRef.current?.getPixels() ?? imgEdit.decoded.pixels;
      const bytes = await encodeImage(pixels, 'png');
      const src = toDataUrl('image/png', bytes);
      const target = active ?? editor;
      const node = target.state.doc.nodeAt(imgEdit.pos);
      if (node && (node.type.name === 'image' || node.type.name === 'floatingImage')) {
        const w = node.attrs.width || pixels.width;
        const h = Math.round((w * pixels.height) / Math.max(1, pixels.width));
        target.view.dispatch(
          target.state.tr.setNodeMarkup(imgEdit.pos, undefined, {
            ...node.attrs,
            src,
            width: w,
            height: h,
            drawingml: null,
          }),
        );
        onChange();
      }
      setImgEdit(null);
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Could not save the edited image.');
    }
  };

  // entering header / footer editing puts the cursor there; Esc leaves
  const tabActive0 = useTabActive();
  useEffect(() => {
    if (!hfEdit) return;
    (hfEdit === 'header' ? headerEditor : footerEditor)?.commands.focus('end');
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive0.current) return;
      if (e.key === 'Escape') {
        setHfEdit(null);
        editor?.commands.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hfEdit, headerEditor, footerEditor, editor]);

  // format painter: the next selection made with the mouse (or a click in a word) takes the format
  const tabActive1 = useTabActive();
  useEffect(() => {
    if (!active || !painter) return;
    const editor = active;
    const dom = editor.view.dom;
    const onUp = () => {
      // let ProseMirror settle the selection from this mouse-up first
      setTimeout(() => {
        applyFormat(editor, painter);
        setPainter(null);
      }, 0);
    };
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive1.current) return;
      if (e.key === 'Escape') setPainter(null);
    };
    dom.addEventListener('mouseup', onUp);
    window.addEventListener('keydown', onKey);
    return () => {
      dom.removeEventListener('mouseup', onUp);
      window.removeEventListener('keydown', onKey);
    };
  }, [active, painter]);

  // Ctrl/Cmd+K opens the link dialog; Ctrl/Cmd+F find; Ctrl/Cmd+H find & replace;
  // Ctrl+Shift+8 shows formatting marks and Ctrl+] / Ctrl+[ grow / shrink the font, as in Word.
  // Runs in the capture phase so these win over the editor's own bindings (Ctrl+Shift+8 = bullets).
  const tabActive2 = useTabActive();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!tabActive2.current) return;
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const k = e.key.toLowerCase();
      if (e.shiftKey && (e.code === 'Digit8' || k === '*')) {
        e.preventDefault();
        e.stopPropagation();
        setShowMarks((v) => !v);
        return;
      }
      if (editor && !e.shiftKey && (e.code === 'BracketRight' || e.code === 'BracketLeft')) {
        e.preventDefault();
        e.stopPropagation();
        stepFontSize(active ?? editor, e.code === 'BracketRight' ? 1 : -1);
        return;
      }
      if (k === 'k') {
        e.preventDefault();
        document.querySelector<HTMLButtonElement>('button[aria-label="Link (Ctrl+K)"]')?.click();
      } else if (k === 'f' || k === 'h') {
        e.preventDefault();
        openFind(k === 'h');
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [openFind, editor, active]);

  if (!editor || !active) return null;

  const dims = pageDimensions(pageSetup);
  const px = (pt: number) => `${(pt * 96) / 72}px`;

  /** Double-click in the top / bottom margin edits the header / footer; in the body, leaves it. */
  const onSheetDoubleClick = (e: React.MouseEvent) => {
    if (!sheetEl || drawing) return;
    const r = sheetEl.getBoundingClientRect();
    const k = r.width / Math.max(1, sheetEl.offsetWidth) || 1;
    const y = (e.clientY - r.top) / k;
    const top = (pageSetup.margins.top * 96) / 72;
    const bottom = sheetEl.offsetHeight - (pageSetup.margins.bottom * 96) / 72;
    if (!hfEdit) {
      if (y < top) setHfEdit('header');
      else if (y > bottom) setHfEdit('footer');
    } else if (y > top && y < bottom) {
      setHfEdit(null);
      editor.commands.focus();
    }
  };

  return (
    <div className="editor-root">
      <Toolbar
        key={hfEdit ?? 'body'}
        editor={active}
        onPageSetup={() => setSetupOpen(true)}
        onFind={() => openFind(false)}
        onError={onError}
        drawing={drawing}
        onToggleDraw={() => setDrawing((d) => !d)}
        showMarks={showMarks}
        onToggleMarks={() => setShowMarks((v) => !v)}
        painting={!!painter}
        onPaint={() => {
          if (painter) {
            setPainter(null);
            return;
          }
          setPainter(captureFormat(active.state));
          onError('Format copied. Select the text to apply it to (Esc cancels).', 'info');
        }}
        headerFooter={hfEdit}
        onHeaderFooter={() => {
          if (hfEdit) {
            setHfEdit(null);
            editor.commands.focus();
          } else {
            setHfEdit('header');
          }
        }}
      />
      {drawing && <DrawToolbar settings={drawSettings} onChange={setDrawSettings} onDone={() => setDrawing(false)} />}
      {find && (
        <FindBar
          replaceOpen={find.replace}
          onToggleReplace={() => setFind((f) => f && { ...f, replace: !f.replace })}
          query={query}
          onQuery={setQuery}
          options={searchOpts}
          onOptions={setSearchOpts}
          total={findInfo.total}
          current={findInfo.current}
          focusToken={find.token}
          onNext={() => gotoMatch(editor.view, findInfo.current + 1)}
          onPrev={() => gotoMatch(editor.view, findInfo.current - 1)}
          onReplace={(r) => replaceCurrent(editor.view, r)}
          onReplaceAll={(r) => {
            const n = replaceAll(editor.view, r);
            if (n) onError(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}. Undo (Ctrl+Z) puts them all back.`, 'info');
          }}
          onClose={closeFind}
        />
      )}
      <div
        className={cx('workspace zoom-scroll', showMarks && 'show-marks', painter && 'is-painting')}
        ref={setScrollEl}
        onMouseDown={(e) => e.target === e.currentTarget && editor.commands.focus('end')}
      >
        <div
          ref={setSheetEl}
          className={cx('page-sheet', hfEdit && `hf-editing hf-editing-${hfEdit}`)}
          onDoubleClick={onSheetDoubleClick}
          style={{
            width: px(dims.width),
            minHeight: px(dims.height * pageCount),
            padding: `${px(pageSetup.margins.top)} ${px(pageSetup.margins.right)} ${px(pageSetup.margins.bottom)} ${px(pageSetup.margins.left)}`,
            zoom,
            // Visual page breaks between stacked page regions
            backgroundImage:
              pageCount > 1
                ? `repeating-linear-gradient(to bottom, #fff 0, #fff calc(${px(dims.height)} - 10px), #d8dbe3 calc(${px(dims.height)} - 10px), #d8dbe3 ${px(dims.height)})`
                : undefined,
          }}
        >
          {Array.from({ length: pageCount }, (_, pageIndex) => {
            const oneBased = pageIndex + 1;
            const pick = (part: 'header' | 'footer'): string => {
              if (pageSetup.differentFirstPage && oneBased === 1) {
                const v = part === 'header' ? initial.headerFirst : initial.footerFirst;
                if (v) return v;
              }
              if (pageSetup.differentOddEven && oneBased % 2 === 0) {
                const v = part === 'header' ? initial.headerEven : initial.footerEven;
                if (v) return v;
              }
              return part === 'header' ? hfSnap.header : hfSnap.footer;
            };
            return (['header', 'footer'] as const).map((part) => {
              const ed = part === 'header' ? headerEditor : footerEditor;
              if (!ed) return null;
              const distance = px((part === 'header' ? pageSetup.headerDistance : pageSetup.footerDistance) ?? DEFAULT_HF_DISTANCE);
              const editable = pageIndex === 0;
              const html = pick(part);
              return (
                <div
                  key={`${pageIndex}-${part}`}
                  className={cx('hf-page', `hf-${part}`, !editable && 'hf-mirror')}
                  style={{
                    height: px(dims.height),
                    top: px(dims.height * pageIndex),
                    bottom: 'auto',
                  }}
                >
                  <div
                    className="hf-content"
                    style={{
                      marginLeft: px(pageSetup.margins.left),
                      marginRight: px(pageSetup.margins.right),
                      ...(part === 'header' ? { paddingTop: distance } : { paddingBottom: distance }),
                    }}
                  >
                    {editable ? (
                      <>
                        {part === 'header' && <EditorContent editor={ed} />}
                        {hfEdit === part && (
                          <div className="hf-label">
                            <span>{part === 'header' ? 'Header' : 'Footer'}</span>
                            <button type="button" className="hf-switch" onClick={() => setHfEdit(part === 'header' ? 'footer' : 'header')}>
                              Go to {part === 'header' ? 'footer' : 'header'}
                            </button>
                            <button
                              type="button"
                              className="hf-close"
                              onClick={() => {
                                setHfEdit(null);
                                editor.commands.focus();
                              }}
                            >
                              Close
                            </button>
                          </div>
                        )}
                        {part === 'footer' && <EditorContent editor={ed} />}
                      </>
                    ) : (
                      html.trim() ? <div className="doc-content" dangerouslySetInnerHTML={{ __html: html }} /> : null
                    )}
                  </div>
                </div>
              );
            });
          })}
          <div className="body-layer">
            <EditorContent editor={editor} />
          </div>
          {drawing && sheetEl && <DrawLayer ref={drawRef} editor={editor} sheet={sheetEl} settings={drawSettings} />}
        </div>
      </div>
      {tableMenu && editor && (
        <TableContextMenu
          editor={editor}
          x={tableMenu.x}
          y={tableMenu.y}
          onClose={() => setTableMenu(null)}
        />
      )}
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
      {imgEdit && (
        <div className="doc-image-edit" role="dialog" aria-label="Edit image">
          <div className="doc-image-edit-bar">
            <strong>Edit image</strong>
            <span className="spacer" />
            <button type="button" className="btn" onClick={() => setImgEdit(null)}>
              Cancel
            </button>
            <button type="button" className="btn primary" onClick={() => void applyImgEdit()}>
              Done
            </button>
          </div>
          <ImageEditor ref={imgEditRef} initial={imgEdit.decoded} onChange={() => {}} onError={onError} />
        </div>
      )}
    </div>
  );
});
