# File Editor

Create, edit, convert and password-protect documents, spreadsheets, photos, video and audio, in the browser or as an installed desktop
app for Windows and macOS. Everything runs on the user's device: no file is ever uploaded, and
there is no server to run.

| | |
|---|---|
| **Open & edit** | Word (.docx, .doc), PDF, OpenDocument (.odt), Rich Text (.rtf), Markdown, HTML, plain text |
| **Word-style editing** | Headings, fonts, sizes, colours, highlight, alignment, lists, tables (merge/split), images, links, page breaks, page size/orientation/margins |
| **Spreadsheets** | Open Excel (.xlsx, .xlsm, .xltx), CSV and TSV; new blank workbooks. Excel / Google Sheets-style editor: formula bar with 400+ functions, multiple sheets, cell formatting (fonts, colours, borders, alignment, wrap, rotation), number formats (currency, percent, dates…), merge, freeze panes, insert/delete/hide rows and columns, sort, filter, find & replace, fill handle, copy/paste, undo |
| **PDF editing** | Edit existing text, add text, images, links, shapes, lines, freehand drawing/signature, highlights, white-out; insert blank pages or pages from another document at any position; delete, duplicate, reorder (drag) and rotate pages |
| **Photos** | Open JPEG, PNG, WebP, AVIF, HEIC/HEIF (iPhone), JPEG XL, GIF, TIFF, BMP, ICO and SVG. Crop (with aspect presets), rotate, flip, straighten, resize; exposure, contrast, highlights/shadows, saturation, warmth, hue, vignette, sharpen, blur; one-click filters; text, arrows, shapes, freehand drawing, stickers; redact faces, plates or text (pixelate / blur / black box) |
| **Video & audio** | Open MP4, MOV, WebM, MKV, TS, MP3, M4A, WAV, FLAC, OGG/Opus, AAC, plus legacy AVI, WMV, FLV, MPEG, 3GP, OGV, WMA, AIFF, AMR. Trim, crop, rotate, flip, resize, change frame rate; colour look and filters; text overlays with timing; fade in/out; volume or mute; save a frame as a picture or edit it in the photo editor |
| **Convert** | Documents ↔ documents (incl. PDF ↔ DOCX); spreadsheets ↔ .xlsx, CSV, TSV; photos ↔ any photo format or PDF; video ↔ MP4 (H.264/HEVC/AV1/VP9), WebM, MOV, MKV, TS, animated GIF, AVI, WMV, FLV, MPEG, 3GP, OGV; video or audio → MP3, M4A, WAV, FLAC, OGG, Opus, AAC |
| **Passwords** | Open Word, Excel and PDF files protected by Office, Acrobat or other tools (with the password); save password-protected DOCX and XLSX (Office AES-256) and PDF (AES-256, with optional permission restrictions) |

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design.

## Development

Requires Node 20+.

```bash
npm install
```

```bash
npm run dev
```

The app opens at http://localhost:5173. Other scripts:

| Script | What it does |
|---|---|
| `npm test` | Runs the converter, PDF and encryption test suites (vitest) |
| `npm run typecheck` | Type-checks everything |
| `npm run build:web` | Builds the static web app into `dist/` |
| `npm run electron:dev` | Runs the desktop app against the dev server |
| `npm run dist:win` / `npm run dist:mac` | Builds the signed installers into `release/` |

`npm install` runs `scripts/copy-runtime-assets.mjs`, which copies the pdf.js assets and the
ffmpeg.wasm core into `public/` so they are served by the app itself and never fetched from a
CDN.

## Adding it to the portfolio site (Next.js on Vercel)

The web build is a plain static bundle, so it doesn't need to live inside the Next.js app.

### Option A (recommended): separate Vercel project plus a rewrite

1. Push this repository to GitHub and import it into Vercel as a new project. `vercel.json`
   already sets the build command and output folder.
2. In that project's **Settings → Environment Variables**, set `VITE_BASE` to `/editor/`, then redeploy.
3. In the portfolio's `next.config.js`, proxy `/editor` to it:

   ```js
   /** @type {import('next').NextConfig} */
   module.exports = {
     async rewrites() {
       return [
         { source: '/editor', destination: 'https://YOUR-EDITOR-PROJECT.vercel.app/editor/' },
         { source: '/editor/:path*', destination: 'https://YOUR-EDITOR-PROJECT.vercel.app/editor/:path*' },
       ];
     },
   };
   ```

   The editor now appears at `https://your-portfolio.com/editor`, and each project deploys on its own.

### Option B: copy the build into the portfolio's `public/` folder

```bash
npx cross-env VITE_BASE=/editor/ npm run build:web
```

Copy `dist/*` into `<portfolio>/public/editor/`, then add
`{ source: '/editor', destination: '/editor/index.html' }` to the portfolio's rewrites.

Link to it from a project card, or embed it in a page with
`<iframe src="/editor/" style={{ width: '100%', height: '80vh', border: 0 }} />`.

**Saving on the web:** Chrome and Edge use the File System Access API, so **Save** writes back to
the opened file. Firefox and Safari download a copy instead.

## Desktop installers

`npm run dist:win` builds an NSIS installer (x64 + arm64). `npm run dist:mac` builds a universal DMG
plus a ZIP (the ZIP is used for auto-updates). macOS builds must run on a Mac.

### Making the installers trusted ("secure downloadable installer")

Unsigned installers trigger SmartScreen and Gatekeeper warnings. Signing is configured; supply
credentials through environment variables (CI secrets), never in the repo:

| Platform | What you need | Environment variables |
|---|---|---|
| Windows | An OV/EV code-signing certificate (.pfx), **or** Azure Trusted Signing | `CSC_LINK` (path or base64 of the .pfx), `CSC_KEY_PASSWORD`, or the `AZURE_*` variables for Trusted Signing |
| macOS | Apple Developer ID Application certificate + notarization | `CSC_LINK`, `CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID` |

What the build does to harden the app:

- Installers and app binaries are signed with SHA-256 and timestamped. The macOS app uses the
  hardened runtime and is notarized by Apple.
- Electron fuses are flipped at package time: no `ELECTRON_RUN_AS_NODE`, no `--inspect`, no
  `NODE_OPTIONS`, ASAR integrity validation on, and the app loads only from its ASAR.
- Auto-updates come from GitHub Releases over HTTPS. `electron-updater` checks the update's
  signature before installing it. Set `build.publish` in `package.json` to your repository.
- At runtime the renderer is sandboxed, can only reach files the user picked, cannot navigate
  away or open new windows, and is blocked from making any network request. The only network
  traffic besides updates is license activation (below), made by the main process.

### Licenses (desktop only)

The desktop app can be activated with a lifetime license bought at
`license.bretttomita.com` (one license, one device, for life). **Nothing is locked without a
license**; activation only records that the computer holds one. The web version never asks.

- **Help → Enter License Key…** opens the license dialog (`src/ui/license/LicenseDialog.tsx`).
- `electron/license.ts` (main process) sends the key and a device id to
  `https://license.bretttomita.com/api/license/activate`, verifies the Ed25519-signed token it
  gets back against `LICENSE_PUBLIC_KEY`, and stores it in `license.json` in the app's user-data
  folder. The device id is a SHA-256 of the OS machine id; the raw id never leaves the computer.
  The token only verifies on the device it was issued for.
- Once a day an activated app checks `/api/license/status` to learn about a refund or revoke.
  Offline, nothing changes.
- License requests use their own in-memory Electron session that can reach only the license
  server; the app's main session still blocks all network access.
- `LICENSE_PUBLIC_KEY` must match the server's `LICENSE_SIGNING_PRIVATE_KEY` (Admin → Licenses
  on the portfolio site shows the server's public key). If you rotate the server key, update
  the constant and ship a new build; licenses activated under the old key then need
  re-activating (same key, same device works).
- For local testing, `FILE_EDITOR_LICENSE_API=http://localhost:3000` points an unpackaged dev
  build at a local portfolio server (packaged builds ignore it). The server side is documented
  in the portfolio repo's `docs/license.md`.

Publish `SHA256SUMS` next to the downloads so users can verify them:

```bash
cd release && sha256sum *.exe *.dmg > SHA256SUMS
```

The app icon is `build/icon.png` (1024×1024); electron-builder generates the `.ico`/`.icns` from it.

## Desktop updates

Installed copies update themselves from this repository's **GitHub Releases**
(`build.publish` in `package.json` → `brett96/File-Editor`).

The app downloads updates without signing in, so the releases must be public. GitHub gives a
private repository private releases, so either make this repository public or point
`build.publish` at a separate public repository used only for releases. In the second case,
give the workflow a personal access token secret with write access to that repository and use
it as `GH_TOKEN`; the built-in `GITHUB_TOKEN` can't publish to another repository.

**Shipping an update**

1. Bump `"version"` in `package.json` (e.g. `0.1.0` → `0.2.0`), commit and push.
2. Tag that commit and push the tag (a normal push doesn't send tags):
   `git tag v0.2.0` then `git push origin v0.2.0`.
3. `.github/workflows/release.yml` creates a draft release, runs the tests, builds the Windows
   and macOS installers, signs them (if the secrets below are set) and uploads them with
   `latest.yml` / `latest-mac.yml` — the files the app reads to learn about new versions.
   The draft is published only when both platforms succeed. If a build fails, fix it and
   re-run the workflow; it reuses the draft. A version that is already published can't be
   rebuilt, so bump the version instead.

Without a Mac signing certificate the macOS app is only ad-hoc signed. It runs, but users must
right-click → Open the first time, and macOS can't auto-update it. Auto-update on macOS needs a
Developer ID certificate.

**What happens on users' machines** (`electron/main.ts` → `startAutoUpdates`)

- At launch and every 4 hours the app asks GitHub for `latest.yml`. If its version is newer,
  the update downloads in the background (Windows: a differential download using the
  `.blockmap`, so usually only the changed parts).
- The download is checked against the SHA-512 in `latest.yml`; on Windows the new installer's
  code signature must also match the publisher of the installed app, otherwise it is refused.
- When it is ready, a banner offers **Restart now** (asks first if there are unsaved changes).
  **Later** installs it silently the next time the app is closed.

**Requirements**

- The repository (or at least its releases) must be **public**; a private repo would need a
  token embedded in the app, which is not safe to ship.
- **macOS only installs updates for signed and notarized apps.** Without the Apple secrets the
  Mac build is published but cannot auto-update.
- Unsigned Windows builds still update, but SmartScreen warns on the first install.
- Repository secrets for signing: `WIN_CSC_LINK` (base64 `.pfx`), `WIN_CSC_KEY_PASSWORD`,
  `MAC_CSC_LINK` (base64 `.p12`), `MAC_CSC_KEY_PASSWORD`, `APPLE_ID`,
  `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`.

## Format support and limitations

- **Spreadsheets** (`src/core/sheet/`, editor `src/ui/sheet/`): the editor is
  [Univer](https://github.com/dream-num/univer) (Apache-2.0), loaded only when a spreadsheet is
  opened (≈6 MB); `.xlsx` is read and written with ExcelJS (MIT) and CSV/TSV with Papa Parse
  (MIT). Kept in `.xlsx`: all sheets (order, names, hidden, tab colour), values, formulas with
  their results, fonts, fills, borders, alignment/wrap/rotation, number formats, merged cells,
  column widths, row heights, hidden rows/columns, frozen panes, zoom and gridlines. Not kept
  (the app lists what a file uses when it opens): charts, pictures, comments, conditional
  formatting, data validation, pivot tables, named ranges, mixed formatting inside one cell and
  macros (`.xlsm` is saved as `.xlsx`). Legacy `.xls` and `.ods` are not supported yet.
  CSV/TSV keep one sheet's values as displayed (UTF-8 with BOM, so Excel shows accents);
  reading one detects the encoding and delimiter, turns plain numbers into numbers and keeps
  codes such as `00501` and values starting with `=` as text. Printing a spreadsheet prints
  the active sheet as a simple table.
- **DOCX** is the highest-fidelity editable format. Layout tables keep their column widths,
  cell borders, shading and row heights, and paragraphs keep their spacing, line height and
  indents. Footnotes, comments and tracked-change history are not imported yet.
- **Headers and footers** (DOCX): the default header and footer are imported, edited (double-click
  the top or bottom margin, or the Header & footer button) and saved back to DOCX, HTML/print and
  PDF. Pictures and shape groups placed in them (background bands, logos, panels) keep their place
  on the page; shape groups are turned into a single picture when the file is opened, so they
  can be moved but not reshaped. Custom-drawn shapes (freeform icons) are not drawn. The editor
  shows the page as one continuous sheet, so the header appears once at the top and the footer
  once at the bottom; printing and PDF repeat them on every page. Different first-page and
  odd/even headers are not supported (the default one is used). ODT and RTF exports leave
  headers and footers out.
- **Drawing (Draw button):** pen, highlighter and eraser. Each group of strokes becomes a floating
  picture anchored to the paragraph it was drawn over, so it moves with that text; drag it to
  reposition it. DOCX keeps drawings floating. ODT, RTF and PDF exports place them inline at the
  start of their paragraph.
- **Legacy .doc** (Word 97–2003): text, paragraphs, tables and links are imported; most character
  formatting is not. Saving as `.doc` writes Word-compatible RTF content, which Word opens normally.
  Password-protected `.doc` files are not supported yet (re-save them as .docx in Word).
- **PDF editing** works on top of the page: edited existing text is covered and retyped in a
  standard font (Helvetica, Times or Courier) that closely matches the original. The original
  glyphs stay in the file underneath, so **white-out and text editing are not redaction**.
  Standard PDF fonts cover Western European characters only.
- **PDF to DOCX/ODT/…** rebuilds paragraphs from the page text; images and complex layouts are
  not carried over. **DOCX to PDF** typesets with the embedded Roboto font.
- **Passwords:** "unlocking" always means decrypting with the correct password. There is no
  password removal or recovery for files whose password you don't know.
- Spreadsheets and presentations (.xlsx, .pptx) are not supported.
- **Photos:** HEIC can be opened but not written (there is no royalty-free HEIC encoder); save
  as JPEG, WebP or AVIF instead. Animated GIF/WebP/APNG open as their first frame in the photo
  editor. Multi-page TIFFs open their largest page. Camera RAW files (CR2, NEF, ARW, DNG) are not
  supported yet. Saved copies never carry camera metadata such as GPS location.
- **Video:** editing and conversion use the browser's own hardware encoders (WebCodecs), so the
  codec list in Save as depends on the browser — Chrome, Edge and the desktop app offer H.264,
  HEVC (where the OS has it), VP9, AV1 and AAC; Firefox and Safari offer fewer. Legacy formats
  (AVI, WMV, FLV, MPEG, 3GP, OGV) go through ffmpeg.wasm, which is slower and limited to files
  of about 1.5 GB in the browser. Colour changes and text overlays re-encode every frame;
  trims and container changes without visual edits are copied without re-encoding where
  possible. There is no multi-clip timeline, speed change or audio mixing yet.

### Third-party codecs and licences

| Component | Used for | Licence |
|---|---|---|
| Mediabunny (+ MP3/AAC/FLAC encoder add-ons) | Video/audio demux, edit, encode via WebCodecs | MPL-2.0 |
| ffmpeg.wasm core | Legacy video/audio formats only, loaded on first use | **GPL-2.0-or-later** (includes x264) |
| @jsquash/avif, @jsquash/jxl | AVIF and JPEG XL encode/decode | Apache-2.0 |
| heic-to (libheif) | HEIC/HEIF decode | LGPL-3.0 (loaded as a separate module) |
| utif2, gifenc | TIFF and GIF | MIT |

Distributing the desktop installer or a public site that serves `ffmpeg-core.wasm` means
distributing GPL software: publish this repository's source (or the ffmpeg core's corresponding
source) alongside it. The build ships `ffmpeg/NOTICE.txt` next to the core (generated by
`scripts/copy-runtime-assets.mjs`) naming the licence and the source location; once the
repository is public, put its URL in that notice. If that is not acceptable, delete `public/ffmpeg/` and the
`copy-runtime-assets` step — the app keeps working, and only the legacy formats above become
unavailable (the Save as dialog reports it).
