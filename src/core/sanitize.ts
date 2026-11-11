import { parseHtml } from './dom';

/**
 * Sanitises arbitrary HTML down to the editor's HTML contract (see types.ts).
 * Used for every untrusted source: imported .html/.md/.doc(HTML) files and clipboard-like input.
 * Scripts, styles, frames, event handlers, remote images and non-web URL schemes are dropped.
 */

const ALLOWED_TAGS = new Set([
  'p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'code', 'hr', 'br',
  'ul', 'ol', 'li', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'th', 'td', 'colgroup', 'col',
  'strong', 'b', 'em', 'i', 'u', 's', 'strike', 'del', 'sub', 'sup', 'span', 'mark', 'a', 'img', 'div',
]);

/** Dropped together with their content. */
const DROP_WITH_CONTENT = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'noscript', 'template', 'head', 'title', 'meta', 'link',
  'svg', 'math', 'form', 'input', 'button', 'select', 'textarea', 'audio', 'video', 'canvas', 'applet', 'frame', 'frameset',
]);

const ALLOWED_ATTRS: Record<string, string[]> = {
  a: ['href'],
  img: ['src', 'alt', 'width', 'height', 'data-float-x', 'data-float-y', 'data-ink', 'data-behind', 'data-drawingml'],
  td: ['colspan', 'rowspan', 'colwidth'],
  th: ['colspan', 'rowspan', 'colwidth'],
  div: ['data-page-break'],
  mark: ['data-color'],
  ol: ['start'],
};

const ALLOWED_STYLE_PROPS = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'text-align',
  // paragraphs
  'line-height', 'margin-top', 'margin-bottom', 'margin-left', 'text-indent',
  // table cells / rows
  'border-top', 'border-right', 'border-bottom', 'border-left', 'vertical-align', 'height', 'padding',
]);

const BLOCKS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const CELLS = new Set(['td', 'th']);
const LENGTH = /^-?\d+(\.\d+)?(pt|px|em|in|cm|mm)?$/i;
const BORDER = /^(none|\d+(\.\d+)?(px|pt) (solid|dashed|dotted|double) (#[0-9a-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+))$/i;

/** Where each style property may appear, and what its value must look like. */
function styleAllowed(prop: string, value: string, tag: string): boolean {
  switch (prop) {
    case 'text-align':
      return /^(left|right|center|justify)$/i.test(value);
    case 'background-color':
      return tag === 'mark' || tag === 'span' || BLOCKS.has(tag) || CELLS.has(tag);
    case 'line-height':
    case 'margin-top':
    case 'margin-bottom':
    case 'margin-left':
    case 'text-indent':
      return BLOCKS.has(tag) && LENGTH.test(value);
    case 'border-top':
    case 'border-right':
    case 'border-bottom':
    case 'border-left':
      return CELLS.has(tag) && BORDER.test(value);
    case 'vertical-align':
      return CELLS.has(tag) && /^(top|middle|bottom)$/i.test(value);
    case 'height':
      return tag === 'tr' && LENGTH.test(value);
    case 'padding':
      return CELLS.has(tag) && value.split(/\s+/).length <= 4 && value.split(/\s+/).every((v) => LENGTH.test(v));
    default:
      return true;
  }
}

const SAFE_HREF = /^(https?:|mailto:|tel:|#)/i;
const SAFE_IMG = /^data:image\/(png|jpe?g|gif|bmp|webp|svg\+xml);base64,/i;

function cleanStyle(raw: string | null, tag: string): string {
  if (!raw) return '';
  const out: string[] = [];
  for (const part of raw.split(';')) {
    const i = part.indexOf(':');
    if (i < 0) continue;
    const prop = part.slice(0, i).trim().toLowerCase();
    const value = part.slice(i + 1).trim();
    if (!ALLOWED_STYLE_PROPS.has(prop) || !value) continue;
    if (/url\s*\(|expression\s*\(|[<>\\]/i.test(value)) continue;
    if (!styleAllowed(prop, value, tag)) continue;
    out.push(`${prop}: ${value}`);
  }
  return out.join('; ');
}

function sanitizeNode(node: Node, doc: Document): void {
  for (const child of Array.from(node.childNodes)) {
    if (child.nodeType === 8 /* comment */ || child.nodeType === 7 || child.nodeType === 4) {
      child.remove();
      continue;
    }
    if (child.nodeType !== 1) continue;
    const el = child as Element;
    const tag = el.tagName.toLowerCase();

    if (DROP_WITH_CONTENT.has(tag) || tag.includes(':')) {
      el.remove();
      continue;
    }

    sanitizeNode(el, doc);

    if (!ALLOWED_TAGS.has(tag)) {
      // unwrap unknown elements, keeping their (already sanitised) children
      const blockish = /^(section|article|header|footer|main|aside|nav|figure|figcaption|address|dd|dt|dl|center|fieldset|details|summary)$/.test(tag);
      if (blockish && !el.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,div') && el.textContent?.trim()) {
        const p = doc.createElement('p');
        while (el.firstChild) p.appendChild(el.firstChild);
        el.replaceWith(p);
      } else {
        while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el);
        el.remove();
      }
      continue;
    }

    const allowed = ALLOWED_ATTRS[tag] ?? [];
    const style = cleanStyle(el.getAttribute('style'), tag);
    for (const attr of Array.from(el.attributes)) {
      if (!allowed.includes(attr.name.toLowerCase())) el.removeAttribute(attr.name);
    }
    if (style) el.setAttribute('style', style);

    if (tag === 'a') {
      const href = (el.getAttribute('href') ?? '').trim();
      if (!SAFE_HREF.test(href)) {
        el.removeAttribute('href');
      }
    } else if (tag === 'td' || tag === 'th') {
      const w = el.getAttribute('colwidth');
      if (w !== null && !/^\d+(,\d+)*$/.test(w)) el.removeAttribute('colwidth');
    } else if (tag === 'img') {
      for (const a of ['data-float-x', 'data-float-y']) {
        const v = el.getAttribute(a);
        if (v !== null && !/^-?\d+(\.\d+)?$/.test(v)) el.removeAttribute(a);
      }
      if (el.hasAttribute('data-float-x') !== el.hasAttribute('data-float-y')) {
        el.removeAttribute('data-float-x');
        el.removeAttribute('data-float-y');
      }
      const src = (el.getAttribute('src') ?? '').trim();
      if (!SAFE_IMG.test(src)) {
        // Remote / unsupported images are dropped: documents stay self-contained and nothing is fetched.
        const alt = el.getAttribute('alt');
        if (alt) el.replaceWith(doc.createTextNode(`[image: ${alt}]`));
        else el.remove();
      }
    } else if (tag === 'div') {
      if (el.getAttribute('data-page-break') !== 'true') {
        // generic <div>: unwrap, or turn into a paragraph if it only holds inline content
        const hasBlock = el.querySelector('p,h1,h2,h3,h4,h5,h6,ul,ol,table,blockquote,pre,div,hr');
        if (!hasBlock && (el.textContent?.trim() || el.querySelector('img'))) {
          const p = doc.createElement('p');
          if (style) p.setAttribute('style', style);
          while (el.firstChild) p.appendChild(el.firstChild);
          el.replaceWith(p);
        } else {
          while (el.firstChild) el.parentNode!.insertBefore(el.firstChild, el);
          el.remove();
        }
      }
    }
  }
}

export function sanitizeHtml(html: string): string {
  const body = parseHtml(html);
  sanitizeNode(body, body.ownerDocument);
  return body.innerHTML;
}
