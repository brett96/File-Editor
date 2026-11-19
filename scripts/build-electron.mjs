// Bundles the Electron main process and preload script into dist-electron/ (CommonJS).
import { build } from 'esbuild';

const common = {
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  sourcemap: false,
  minify: true,
  external: ['electron', 'electron-updater'],
  logLevel: 'info',
};

// The coding agent's OpenUncensored key goes into the main process only (electron/agent.ts),
// never into the preload script or the renderer. Set it in the build environment, e.g. the
// OPENUNCENSORED_API_KEY repository secret in CI; without it the agent says it isn't available.
const agentKey = (process.env.OPENUNCENSORED_API_KEY ?? '').trim();
if (!agentKey) console.warn('OPENUNCENSORED_API_KEY is not set: this build has no coding agent.');

await Promise.all([
  build({ ...common, entryPoints: ['electron/main.ts'], outfile: 'dist-electron/main.cjs', define: { __OU_API_KEY__: JSON.stringify(agentKey) } }),
  build({ ...common, entryPoints: ['electron/preload.ts'], outfile: 'dist-electron/preload.cjs' }),
]);
