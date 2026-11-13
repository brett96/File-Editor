/**
 * Latest desktop installers from the public GitHub Releases feed (see package.json build.publish).
 * Used only by the web home screen — the Electron app updates itself.
 */

const RELEASES_API = 'https://api.github.com/repos/brett96/File-Editor/releases/latest';
export const LICENSE_PURCHASE_URL = 'https://license.bretttomita.com';

export type DesktopOs = 'windows' | 'mac' | 'other';

export interface InstallerOption {
  id: string;
  /** Short button label, e.g. "Windows (x64)". */
  label: string;
  /** Longer description shown under the label. */
  hint: string;
  url: string;
  arch: string;
  os: 'windows' | 'mac';
}

export interface LatestInstallers {
  version: string;
  tag: string;
  options: InstallerOption[];
}

let cache: { at: number; data: LatestInstallers } | null = null;
const CACHE_MS = 5 * 60 * 1000;

export function detectDesktopOs(): DesktopOs {
  const uaData = (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform?.toLowerCase() ?? '';
  if (uaData.includes('mac')) return 'mac';
  if (uaData.includes('win')) return 'windows';
  const ua = navigator.userAgent;
  const platform = navigator.platform || '';
  if (/Mac|iPhone|iPad|iPod/i.test(ua) || /^Mac/i.test(platform)) return 'mac';
  if (/Win/i.test(ua) || /^Win/i.test(platform)) return 'windows';
  return 'other';
}

function archFromName(name: string): string {
  const m = /-(x64|arm64|universal|ia32)(?:\.|$)/i.exec(name);
  return m ? m[1].toLowerCase() : 'default';
}

function describe(os: 'windows' | 'mac', arch: string): { label: string; hint: string } {
  if (os === 'mac') {
    if (arch === 'universal') return { label: 'macOS (Universal)', hint: 'Works on Apple Silicon and Intel Macs · .dmg' };
    if (arch === 'arm64') return { label: 'macOS (Apple Silicon)', hint: 'M1 / M2 / M3 Macs · .dmg' };
    if (arch === 'x64') return { label: 'macOS (Intel)', hint: 'Intel Macs · .dmg' };
    return { label: 'macOS', hint: 'Disk image installer · .dmg' };
  }
  if (arch === 'x64') return { label: 'Windows (x64)', hint: 'Most PCs with Intel or AMD processors · .exe' };
  if (arch === 'arm64') return { label: 'Windows (ARM)', hint: 'Snapdragon and other ARM PCs · .exe' };
  return { label: 'Windows', hint: 'Installer · .exe' };
}

interface GhAsset {
  name: string;
  browser_download_url: string;
}

interface GhRelease {
  tag_name: string;
  name?: string;
  assets: GhAsset[];
}

function parseRelease(release: GhRelease): LatestInstallers {
  const win: InstallerOption[] = [];
  const mac: InstallerOption[] = [];
  for (const asset of release.assets) {
    const name = asset.name;
    if (/\.(blockmap|yml|yaml)$/i.test(name)) continue;
    if (/^latest/i.test(name)) continue;
    const url = asset.browser_download_url;
    if (/Setup.*\.exe$/i.test(name) || (/File-Editor.*\.exe$/i.test(name) && !/blockmap/i.test(name))) {
      const arch = archFromName(name);
      const { label, hint } = describe('windows', arch);
      win.push({ id: `win-${arch}-${name}`, label, hint, url, arch, os: 'windows' });
    } else if (/\.dmg$/i.test(name)) {
      const arch = archFromName(name);
      const { label, hint } = describe('mac', arch);
      mac.push({ id: `mac-${arch}-${name}`, label, hint, url, arch, os: 'mac' });
    }
  }

  // Prefer arch-tagged Windows builds when both tagged and untagged exist
  const winTagged = win.filter((o) => o.arch !== 'default');
  const winOptions = winTagged.length ? winTagged : win;
  const macOptions = mac;

  const order = (a: InstallerOption, b: InstallerOption) => {
    const rank = (x: string) => (x === 'x64' ? 0 : x === 'universal' ? 0 : x === 'arm64' ? 1 : 2);
    return rank(a.arch) - rank(b.arch) || a.label.localeCompare(b.label);
  };

  const version = (release.tag_name || '').replace(/^v/i, '') || release.name || 'latest';
  return {
    version,
    tag: release.tag_name,
    options: [...winOptions.sort(order), ...macOptions.sort(order)],
  };
}

/** Fetches (and briefly caches) installer assets from the latest published GitHub release. */
export async function fetchLatestInstallers(): Promise<LatestInstallers> {
  if (cache && Date.now() - cache.at < CACHE_MS) return cache.data;
  const res = await fetch(RELEASES_API, {
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) throw new Error(res.status === 404 ? 'No desktop release has been published yet.' : `Could not reach GitHub Releases (${res.status}).`);
  const data = parseRelease((await res.json()) as GhRelease);
  if (!data.options.length) throw new Error('The latest release has no installers yet.');
  cache = { at: Date.now(), data };
  return data;
}

/** Installers for the visitor's OS; falls back to every platform when the OS is unknown. */
export function installersForOs(all: LatestInstallers, os: DesktopOs): InstallerOption[] {
  if (os === 'windows') return all.options.filter((o) => o.os === 'windows');
  if (os === 'mac') return all.options.filter((o) => o.os === 'mac');
  return all.options;
}

export function startInstallerDownload(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.rel = 'noopener noreferrer';
  // GitHub serves Content-Disposition: attachment; a plain navigation also works
  a.download = '';
  document.body.appendChild(a);
  a.click();
  a.remove();
}
