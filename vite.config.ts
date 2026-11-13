import { defineConfig, type Plugin } from 'vitest/config';
import react from '@vitejs/plugin-react';

// ELECTRON=1  -> relative asset paths so the bundle loads from the app:// protocol
// VITE_BASE   -> sub-path when hosted under a portfolio site, e.g. /editor/
const base = process.env.ELECTRON ? './' : process.env.VITE_BASE || '/';

/**
 * Strict Content-Security-Policy for production builds. Not applied to the dev server,
 * because Vite's HMR client relies on inline scripts. Everything the app needs is bundled:
 * no remote scripts, styles or fonts. The only outbound connect is GitHub Releases, so the
 * home-screen "Download for Windows/Mac" button can look up the latest installer.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "worker-src 'self' blob:",
  "connect-src 'self' blob: data: https://api.github.com",
  "media-src 'self' blob: data:",
  "frame-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

function cspPlugin(): Plugin {
  return {
    name: 'inject-csp',
    apply: 'build',
    transformIndexHtml() {
      return [{ tag: 'meta', attrs: { 'http-equiv': 'Content-Security-Policy', content: CSP }, injectTo: 'head-prepend' }];
    },
  };
}

export default defineConfig({
  base,
  plugins: [react(), cspPlugin()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 2500,
  },
  server: { port: 5173, strictPort: true },
  // these load their own WASM / workers relative to import.meta.url; pre-bundling breaks that
  optimizeDeps: { exclude: ['@ffmpeg/ffmpeg', '@ffmpeg/util', '@jsquash/avif', '@jsquash/jxl', 'heic-to'] },
  worker: { format: 'es' },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 60000,
  },
});
