// Copies runtime assets into public/ so they are served next to the app and never fetched
// from a CDN (the CSP forbids it, and documents must not trigger third-party requests):
//  - pdf.js character maps, standard fonts, WASM decoders and ICC profiles  → public/pdfjs/
//  - the ffmpeg.wasm core (loaded only when a legacy video format is used)   → public/ffmpeg/
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const nm = join(root, 'node_modules');

function copyDirs(srcRoot, dest, dirs) {
  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  for (const dir of dirs) {
    const from = join(srcRoot, dir);
    if (existsSync(from)) cpSync(from, join(dest, dir), { recursive: true });
  }
}

copyDirs(join(nm, 'pdfjs-dist'), join(root, 'public', 'pdfjs'), ['cmaps', 'standard_fonts', 'wasm', 'iccs']);

const ffmpegDest = join(root, 'public', 'ffmpeg');
rmSync(ffmpegDest, { recursive: true, force: true });
mkdirSync(ffmpegDest, { recursive: true });
const core = join(nm, '@ffmpeg', 'core', 'dist', 'esm');
for (const f of ['ffmpeg-core.js', 'ffmpeg-core.wasm']) {
  if (existsSync(join(core, f))) cpSync(join(core, f), join(ffmpegDest, f));
}

// The ffmpeg core is GPL-2.0-or-later. Ship a notice with it so every copy of the web build
// and the installer says what it is and where its source lives.
const coreVersion = JSON.parse(readFileSync(join(nm, '@ffmpeg', 'core', 'package.json'), 'utf8')).version;
writeFileSync(
  join(ffmpegDest, 'NOTICE.txt'),
  [
    `ffmpeg-core.js / ffmpeg-core.wasm — @ffmpeg/core ${coreVersion}`,
    '',
    'FFmpeg compiled to WebAssembly by the ffmpeg.wasm project, including libx264 and other',
    'GPL-licensed libraries. Licensed under the GNU General Public License, version 2 or later.',
    '',
    `Source: https://github.com/ffmpegwasm/ffmpeg.wasm (tag v${coreVersion}, packages/core)`,
    'FFmpeg: https://ffmpeg.org/   Licence text: https://www.gnu.org/licenses/old-licenses/gpl-2.0.txt',
    '',
    'File Editor loads this component only to read or write legacy video/audio formats',
    '(AVI, WMV, FLV, MPEG, 3GP, OGV, WMA, AIFF, AMR). The source code of File Editor is',
    'available from its publisher on request or from its public repository.',
    '',
  ].join('\n'),
);

console.log('runtime assets copied to public/pdfjs and public/ffmpeg');
