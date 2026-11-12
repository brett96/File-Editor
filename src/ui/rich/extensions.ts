import { Node, mergeAttributes, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { Color, FontFamily, FontSize, TextStyle } from '@tiptap/extension-text-style';
import Highlight from '@tiptap/extension-highlight';
import TextAlign from '@tiptap/extension-text-align';
import { TableKit } from '@tiptap/extension-table';
import Image from '@tiptap/extension-image';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import { Plugin } from '@tiptap/pm/state';
import { FindReplace } from './search-extension';
import { CharacterCount, Placeholder } from '@tiptap/extensions';
import { CellFormat, FloatingImage, ParagraphFormat } from './format-extensions';

/** Double-click an inline image to request editing (App may listen for `edit-doc-image`). */
const DocImage = Image.extend({
  addProseMirrorPlugins() {
    return [
      ...(this.parent?.() ?? []),
      new Plugin({
        props: {
          handleDOMEvents: {
            dblclick(view, event) {
              const t = event.target;
              if (!(t instanceof HTMLImageElement)) return false;
              if (t.classList.contains('float-img') || t.closest('.float-img-wrap')) return false;
              let pos: number | null = null;
              try {
                pos = view.posAtDOM(t, 0);
              } catch {
                return false;
              }
              if (pos == null) return false;
              const node = view.state.doc.nodeAt(pos);
              if (!node || node.type.name !== 'image') return false;
              view.dom.dispatchEvent(
                new CustomEvent('edit-doc-image', {
                  bubbles: true,
                  detail: {
                    src: node.attrs.src as string,
                    width: node.attrs.width as number | undefined,
                    height: node.attrs.height as number | undefined,
                    pos,
                  },
                }),
              );
              return true;
            },
          },
        },
      }),
    ];
  },
});

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    pageBreak: {
      insertPageBreak: () => ReturnType;
    };
  }
}

/** Hard page break — serialised as <div data-page-break="true"> (see core/types.ts). */
export const PageBreak = Node.create({
  name: 'pageBreak',
  group: 'block',
  atom: true,
  selectable: true,
  parseHTML() {
    return [{ tag: 'div[data-page-break]' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-page-break': 'true' })];
  },
  addCommands() {
    return {
      insertPageBreak:
        () =>
        ({ chain }) =>
          chain().insertContent([{ type: this.name }, { type: 'paragraph' }]).run(),
    };
  },
  addKeyboardShortcuts() {
    return { 'Mod-Enter': () => this.editor.commands.insertPageBreak() };
  },
});

/** The editor schema. It is deliberately the same vocabulary as the HTML contract. */
export function createExtensions(placeholder = 'Start typing…'): Extensions {
  return [
    StarterKit.configure({
      heading: { levels: [1, 2, 3, 4, 5, 6] },
      link: {
        openOnClick: false,
        autolink: true,
        protocols: ['http', 'https', 'mailto', 'tel'],
        HTMLAttributes: { rel: 'noopener noreferrer nofollow', target: null },
      },
    }),
    TextStyle,
    Color,
    FontFamily,
    FontSize,
    Highlight.configure({ multicolor: true }),
    TextAlign.configure({ types: ['heading', 'paragraph'] }),
    // imported layouts use narrow spacer columns; keep them at their real width
    TableKit.configure({ table: { resizable: false, cellMinWidth: 1, HTMLAttributes: {} } }),
    DocImage.configure({
      inline: true,
      allowBase64: true,
      resize: { enabled: true, minWidth: 24, minHeight: 24, alwaysPreserveAspectRatio: true },
    }),
    FloatingImage,
    Subscript,
    Superscript,
    ParagraphFormat,
    CellFormat,
    PageBreak,
    FindReplace,
    CharacterCount,
    Placeholder.configure({ placeholder }),
  ];
}
