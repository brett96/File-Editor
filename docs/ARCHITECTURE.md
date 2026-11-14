# Architecture

## Goals

- One codebase that ships as **a static web app** (embeddable in a Next.js/Vercel portfolio) and
  **a signed desktop app** (Windows + macOS installers).
- Open, edit, save and convert the common document formats; edit PDFs page-by-page.
- Password-protect documents and open documents protected by Word / PDF tools (with the password).
- **Documents never leave the device.** Every parser, converter and cipher runs client-side.
  There is no backend, which is also what makes Vercel hosting free and trivial.

## Shape

```
┌──────────────────────────── UI (React) ────────────────────────────┐
│  App shell · Start screen · Dialogs (password, export, page setup) │
│  RichEditor (TipTap/ProseMirror)        PdfEditor (pdf.js canvas   │
│  — flow documents                         + object overlay)        │
└──────────────┬───────────────────────────────────┬─────────────────┘
               │ HTML fragment (contract)          │ PdfSession (pages + objects)
┌──────────────▼───────────────────────────────────▼─────────────────┐
│ core/ (no React, no Node APIs — runs in browser, Electron, tests)   │
│  registry.ts      sniff format · open · export · convert            │
│  formats/         docx · odt · rtf · doc(legacy) · md · html · txt  │
│                   pdf-export (flow → PDF) · pdf-import (PDF → flow) │
│  pdf/             apply-edits (page ops + objects → new PDF)        │
│  crypto/          office-crypto (MS-OFFCRYPTO) · pdf-crypto         │
└──────────────┬──────────────────────────────────────────────────────┘
               │ FileHost interface
┌──────────────▼──────────────┐   ┌──────────────────────────────────┐
│ platform/web                │   │ platform/electron (preload IPC)  │
│ <input type=file>, File     │   │ native dialogs, fs read/write    │
│ System Access API, download │   │ limited to user-chosen paths     │
└─────────────────────────────┘   └──────────────────────────────────┘
```

### Two document models

| Model | Formats | Editor | Why |
|---|---|---|---|
| **Flow** (`RichDocument` = HTML fragment + page setup) | DOCX, DOC, ODT, RTF, MD, HTML, TXT | TipTap | Text reflows; content is semantic. |
| **Fixed** (`PdfSession` = source PDFs + page list + overlay objects) | PDF | pdf.js canvas + overlay | Pages are fixed layouts; edits are positioned objects and page operations. |

Conversion between the two: flow → PDF renders pages (`pdf-export`), PDF → flow extracts text
and images into paragraphs (`pdf-import`, lossy by nature).

### The HTML contract

All flow importers emit, and all exporters consume, the restricted HTML documented at the top of
[`src/core/types.ts`](../src/core/types.ts). The editor schema is configured to produce exactly
that. This is what makes N formats cost N converters instead of N² and gives every pair of
formats a conversion path for free.

### PDF editing model

The original PDF bytes are never mutated in place. A session holds:

- `sources[]` — original PDF byte arrays (the opened file, plus any PDFs merged in),
- `pages[]` — ordered list of `{ source, sourcePageIndex | blank, rotation, objects[] }`,
- `objects[]` per page — text boxes, images, links, shapes, highlights, ink strokes,
  whiteouts and *text replacements* (an existing text run covered and redrawn).

Reordering, inserting, deleting and rotating pages only touches `pages[]`. On save,
`core/pdf/apply-edits.ts` builds a new PDF: copies source pages in order, applies rotation,
draws objects with pdf-lib and writes link annotations. This keeps undo simple, makes page
operations instant and keeps untouched page content byte-faithful (fonts, vectors, forms).

Editing *existing* text uses cover-and-redraw: the original run is located via pdf.js text
extraction, covered with the page background colour, and the new text is drawn on top in a
matching standard font. (True content-stream rewriting needs the original embedded font
subsets, which usually lack glyphs for new characters — this is the same trade-off most
non-Adobe editors make.) The original glyphs remain in the file underneath; it is not a
redaction tool.

### Password protection

| Format | Open protected | Save protected | Implementation |
|---|---|---|---|
| PDF | RC4-40/128, AES-128, AES-256 (user or owner password) | AES-256 (PDF 2.0, R6) | `@cantoo/pdf-lib` decrypt/encrypt; pdf.js for rendering |
| DOCX (and XLSX/PPTX containers) | Agile (Office 2010+) and Standard (2007) | Agile AES-256 / SHA-512, 100k spins | own MS-OFFCRYPTO implementation on `@noble/*` + `cfb` |
| Legacy .doc (RC4) | not yet | n/a | roadmap |

"Unlocking" always means decrypting with the password the user supplies. There is no password
recovery/cracking.

### Photos, video and audio

Two more document kinds sit beside flow and fixed documents:

| Kind | Model | Editor | Engine |
|---|---|---|---|
| **Image** | RGBA pixels + vector overlays (text, shapes, ink, stickers) | `ui/image/ImageEditor` | `core/media/image-ops` (pure pixel ops, unit-tested), `image-codecs` (decode every format to pixels, encode via canvas / WASM), `image-encoders` (BMP, ICO, TIFF, GIF) |
| **Media** | Source blob + a declarative `VideoEdits` (trim, rotate/flip, crop, look, overlays, fades, volume) | `ui/video/VideoEditor` | `core/media/video-engine` (Mediabunny on WebCodecs, one conversion pass), `ffmpeg-engine` (legacy containers) |

Image edits are destructive steps on pixels with a bounded undo history (≤ 600 MB of
snapshots); overlays stay vectors until a geometric operation or a save flattens them.
Video edits are never applied to the file while editing: the preview renders each frame
through the same `renderFrameEffects` function the exporter uses, so what is shown is what is
written. Untouched streams are copied rather than re-encoded.

Format detection is by content (`media-formats.sniffMedia`), not by extension. Files the
browser cannot decode (AVI, WMV, FLV, MPEG-PS, 3GP…) are converted once to MP4/FLAC with
ffmpeg.wasm on open, edited normally, and can be written back to the legacy format on save.
Every image save re-encodes from pixels, so EXIF/GPS metadata is never copied.

### Studio, Vector Studio and Pro Photo (desktop)

**Studio** (`core/studio`, `ui/studio`) is a plain-data project (`model.ts`) drawn by one
compositor (`compose.ts`) that the preview and the exporter share. Per layer, in order: source
frame → colour grade and chroma key → stylize effect stack (`fx.ts`: curl noise, contour, glow…)
→ mask (`ClipMask`) → 2D or perspective placement (`projectQuad`, a triangle mesh spaced by the
quad's homography) → blend, blur, shadow. Optional fields on a clip (`three`, `mask`,
`expressions`, `effects.stylize`, text `reveal`) are absent in older `.fstudio` files and read
as "off".

| Piece | File | Notes |
|---|---|---|
| Animatable properties | `anim.ts` | One list (`animProps`) feeds the inspector, graph editor and command palette. `propValue` is the only way the compositor reads a property: keyframes, then the property's expression. |
| Easing | `model.ts` | Per-key easing including `bezier` (CSS cubic-bezier control points, edited in `ui/studio/GraphEditor`). |
| Expressions | `expr.ts` | A small parser/evaluator (no `eval`), so a shared project cannot run code. `data("col")` reads `Project.data` (imported CSV). |
| Motion tracking | `track.ts` | Patch matching on grey frames; the editor seeks a hidden `<video>` frame by frame and writes mask keyframes. |
| Title presets | `presets.ts` | Build ordinary text / colour clips with keyframes. |

**Vector Studio** (`core/vector`, `ui/vector`) edits drawings: SVG and Adobe Illustrator files.

- *Model* (`model.ts`): artboards over one coordinate space, layers, and objects (path, text,
  image, group). Plain immutable data: an edit shares every untouched node with the previous
  document, so undo is a list of documents and the canvas re-renders only changed objects.
  Paths hold anchors with absolute handles and no transform (moving a path rewrites its
  points); text and images carry a matrix. Paints are solid, linear / radial gradients in the
  unit square of the object's box, or a gradient mesh.
- *One serialiser* (`svg.ts`): the canvas draws each object from the same SVG markup that is
  written to disk, so the file is what was on screen. A saved .svg also embeds the document in
  `<metadata>` with a checksum of the drawing; on open it is used only while the checksum still
  matches, otherwise the drawing is parsed (`svg-import.ts`: shapes, transforms, CSS classes,
  gradients, `<use>`, clip paths, text, Illustrator / Inkscape layers).
- *Geometry* (`geom.ts`): Pathfinder, Shape Builder regions, scissors, eraser, blob brush,
  stroke outlining, offsetting and curve fitting run on Paper.js, headless and loaded on demand,
  so results keep their Bézier curves. Stroke outlines are built as the union of a box per
  segment and a wedge or disc per corner, which survives self-crossing scribbles.
- *Gradient mesh* (`mesh.ts`): rendered to pixels by Catmull-Rom interpolation of position and
  colour over the grid, then clipped to the shape (SVG has no mesh primitive).
- *Illustrator files* (`ai-import.ts`): a PDF-compatible .ai file is a PDF, so pdf.js parses it
  and its operator list is replayed into objects instead of onto a canvas (paths, shadings as
  gradients, text runs, images; one artboard per page). Illustrator's private data is not read,
  and an opened .ai file is never written back: Save produces an SVG.
- *Export* (`browser.ts`): SVG; PDF and .ai through pdfmake's vector SVG renderer, one page per
  artboard, with text converted to outlines (glyph outlines via opentype.js when the installed
  font can be read, otherwise traced from the browser's rendering with `trace.ts`); PNG / JPEG /
  WebP by rasterising an artboard.

**Pro Photo** (`core/pro-image`, `ui/pro-image`) keeps immutable layers. Adjustment layers run
through `applyAdjust`; per-pixel ones live in `adjust.ts`, neighbourhood and table ones
(Clarity, Dehaze, Grain, LUT / `.cube`) in `tone.ts`. `inpaint.ts` holds the Remove tool
(coarse-to-fine PatchMatch fill, plus a heuristic that extends the mask over an attached
shadow) and the Patch tool (copy with a harmonic colour correction). Adjustments Photoshop
has no layer for are baked to pixel layers on `.psd` export (`ops.bakeForPsd`).

### Presentations

A deck (`core/slides/model.ts`) is plain data: slides of elements (text/shape, picture, table,
line) in slide pixels, text as paragraphs of runs. `pptx-read.ts` resolves what PowerPoint
leaves implicit down the slide → layout → master → theme chain (placeholder positions, font
sizes, colours, bullets) and copies master/layout artwork onto each slide, locked;
`pptx-write.ts` builds a complete package (theme, master, four layouts, notes, media) in
which every shape states its own geometry and formatting. `render.ts` draws a slide as
self-contained HTML (inline styles and SVG, all text escaped); the editor stage, thumbnails,
slide show and the PNG / PDF export (`ui/slides/export.ts`, via an SVG `foreignObject`) all
use it. Text is edited in a `contentEditable` seeded from that HTML and read back by
`ui/slides/text-edit.ts`, which keeps only text and the formatting the model knows.

### Spreadsheets, databases and large files

Spreadsheets are edited as a Univer snapshot (`core/sheet/workbook.ts`); databases as a SQLite
file in sql.js (`core/db/sqlite.ts`), read a page of rows at a time.

The grid keeps every filled cell as a JavaScript object, and the JavaScript heap is capped (4 GB
in Chromium, less on small machines), so large files are handled by never holding more than
one representation at once:

- **Reading** — `.xlsx` packages are inflated and scanned as a stream (`sheet/xlsx-stream.ts`),
  CSV/TSV are decoded and parsed about 4 MB at a time (`sheet/csv.ts`). Cells are built with
  exactly their own fields, and strings are detached from the decode buffer and pooled
  (`core/memory.ts`), which is what keeps a sheet's XML from staying alive behind its cells.
- **Limit** — `sheetCellBudget()` derives the most cells the grid may be given from the heap
  limit and the RAM the device reports, instead of one fixed number.
- **Past the limit** — the same readers run in row mode (`readXlsxRows`, `readDelimitedRows`)
  and feed `db/import-rows.ts`, which writes each row straight into a SQLite table. sql.js keeps
  its pages in WebAssembly memory, outside the JavaScript heap, and the grid only ever asks for
  200 rows.
- **Saving** — a large workbook is written from the snapshot the editor holds
  (`getLiveWorkbook`), not from a deep copy of it.

Work that blocks the page (filtering or sorting a large sheet, counting or measuring a large
table) is started one frame late behind a spinner whose animation runs on the compositor
(`BusyPill` / `useBusy` in `ui/components.tsx`), so it keeps turning while the page is busy.

`core/conversions.ts` is the one table of which kinds of document can be saved as which
families of format; the save path refuses a file name whose extension the chosen format does
not own, in the browser (`platform/host.ts`) and in the desktop main process.

### Folders, source code and the web preview

A folder is opened through `OpenedFolder` (`platform/folders.ts`): a `FileSystemDirectoryHandle`
in Chrome / Edge, a root granted by the desktop main process, or a read-only in-memory list of
files where the browser only offers `<input webkitdirectory>`. Paths are always relative to the
folder root and '/'-separated (`core/web/paths.ts`); directories are listed one level at a time,
so a large repository opens at once. A file opened from the tree is an ordinary `OpenedFile`
that also carries `folder: { folder, path }`; the shell uses that to focus an existing tab
rather than open a file twice.

Source files other than HTML / CSS / JS share one format, `code` (`core/code/languages.ts`): the
file keeps its own extension and is written back as UTF-8 text. Grammars come from
`@codemirror/language-data`, each in its own lazily loaded chunk.

The preview of a web page is built by `core/web/bundle.ts`, a pure function from an entry path
and a `readFile` callback to one self-contained HTML document: stylesheets are inlined with
their `@import`s, `url(…)` and asset attributes become `data:` URLs, classic scripts are
inlined, and ES modules are collected into a graph that a small bootstrap turns into `blob:`
URLs inside the frame, dependencies first. The reader given to it answers from the open tabs'
live text first (`ui/workspace/buffers.ts`), then from the folder, so unsaved edits are previewed.
What cannot be resolved is reported, never fetched: the preview is offline.

A frame filled through `srcdoc` inherits the app's CSP, under which inline scripts do not run.
So the bundled page is served from a URL that carries its own policy (`ui/code/preview-host.ts`):
`fe-preview://` in the desktop app, and in the web build a service worker scoped to
`__preview__/` that answers from Cache Storage. Both send
`Content-Security-Policy: sandbox allow-scripts allow-forms allow-modals; default-src data: blob: 'unsafe-inline' 'unsafe-eval'`,
which gives the page an opaque origin (no access to the app or its storage) and no network.
The development server has no CSP and uses a sandboxed `srcdoc` frame.

## Technology choices

| Concern | Choice | Reason |
|---|---|---|
| UI | React 19 + Vite | Same component tree for web and desktop; static output. |
| Rich text | TipTap 3 (ProseMirror) | Schema-driven, tables/images/marks, MIT. |
| Video/audio | Mediabunny + WebCodecs | Hardware-accelerated, streams from disk (no full read), MPL-2.0; ffmpeg.wasm only as a lazy fallback for legacy formats (GPL, 31 MB). |
| Photo codecs | Canvas, @jsquash (AVIF/JXL), heic-to, utif2, gifenc | Every common format without a server; WASM loaded only when that format is used. |
| PDF render | pdf.js | Reference renderer, handles encrypted files, runs in a worker. |
| PDF write | `@cantoo/pdf-lib` | Maintained pdf-lib fork with encryption + decryption. |
| Flow → PDF | pdfmake | Real vector/text PDFs client-side (not screenshots). |
| DOCX write / read | `docx` / own OOXML parser | Full control of fidelity; no server. |
| Desktop | Electron + electron-builder | Identical Chromium rendering everywhere, NSIS + DMG, code signing, auto-update. Tauri was considered (smaller binaries) but needs a Rust toolchain and renders through the OS webview, which makes PDF/layout behaviour differ per OS version. |

## Desktop security model

- `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`; the renderer is plain web code.
- The preload exposes a five-function API (`openFile`, `saveFile`, `saveFileAs`, `onOpenFile`,
  `appInfo`). The main process only reads/writes paths that came from a native dialog, an OS
  file-open event or the command line — the renderer cannot name arbitrary paths.
- An opened folder is one more grant. The main process keeps its real path; the renderer names a
  folder id and a relative path, which is rejected unless it is clean (no absolute path, drive
  letter, backslash or `..`) and its real path, following symlinks, is still inside the root.
  Deleting moves to the recycle bin / Trash; creating never overwrites. The preview of a page
  opened on its own may read, read-only, files in that page's own directory.
- The web preview is served from `fe-preview://` to a sub-frame only, sandboxed and without any
  network source in its policy; the request filter still cancels every non-app request.
- App content is served from a custom `app://` protocol with path-traversal checks; navigation
  and `window.open` to anything else are blocked (external links open in the system browser).
- Strict Content-Security-Policy (no remote scripts, no `eval`), Electron fuses flipped at
  package time (no `ELECTRON_RUN_AS_NODE`, no `--inspect`, ASAR integrity on).
- Installers are code-signed (Authenticode / Developer ID + notarization) in CI;
  `electron-updater` verifies signatures before applying updates.

## Web deployment (Next.js portfolio on Vercel)

The web build is a static bundle. Recommended: deploy this repo as its own Vercel project and
add a rewrite in the portfolio's `next.config.js` so it appears at `/editor`. See the README.

## Roadmap (not in v1)

- Legacy `.doc` RC4 decryption and formatting recovery; XLSX/PPTX editing.
- Headers/footers, footnotes, comments and tracked changes in the flow editor.
- PDF form filling, annotations round-trip, OCR for scanned PDFs, digital signatures.
- Optional LibreOffice bridge on desktop for highest-fidelity conversions.
- Real pagination in the flow editor (currently a continuous page-width sheet with page breaks).
