# Document Editor

Create, edit, convert and password-protect documents, in the browser or as an installed desktop
app for Windows and macOS. Everything runs on the user's device: no file is ever uploaded, and
there is no server to run.

| | |
|---|---|
| **Open & edit** | Word (.docx, .doc), PDF, OpenDocument (.odt), Rich Text (.rtf), Markdown, HTML, plain text |
| **Word-style editing** | Headings, fonts, sizes, colours, highlight, alignment, lists, tables (merge/split), images, links, page breaks, page size/orientation/margins |
| **PDF editing** | Edit existing text, add text, images, links, shapes, lines, freehand drawing/signature, highlights, white-out; insert blank pages or pages from another document at any position; delete, duplicate, reorder (drag) and rotate pages |
| **Convert** | Save any open document in any supported format (including PDF to DOCX and DOCX to PDF) |
| **Passwords** | Open Word and PDF files protected by Word, Acrobat or other tools (with the password); save password-protected DOCX (Office AES-256) and PDF (AES-256, with optional permission restrictions) |

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
  away or open new windows, and is blocked from making any network request.

Publish `SHA256SUMS` next to the downloads so users can verify them:

```bash
cd release && sha256sum *.exe *.dmg > SHA256SUMS
```

The app icon is `build/icon.png` (1024×1024); electron-builder generates the `.ico`/`.icns` from it.

## Format support and limitations

- **DOCX** is the highest-fidelity editable format. Headers, footers, footnotes, comments and
  tracked-change history are not imported yet.
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
