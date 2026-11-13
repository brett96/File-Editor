/**
 * Desktop license activation (main process only). Nothing in the app is locked behind a
 * license; this only records that this computer holds one.
 *
 * - Activation: the key the user enters is sent, with a device id, to
 *   https://license.bretttomita.com/api/license/activate (Portfolio-Website). The server binds
 *   the license to this device (one device per license, for life) and returns a token signed
 *   with its Ed25519 key.
 * - The token is checked offline against LICENSE_PUBLIC_KEY below: the signature proves the
 *   server issued it and the device id inside must match this computer, so copying the license
 *   file to another machine doesn't carry the license with it.
 * - Device id: SHA-256 of the OS machine id (Windows MachineGuid, macOS IOPlatformUUID, Linux
 *   /etc/machine-id). The raw machine id never leaves the computer.
 * - An activated copy checks in (/api/license/status) whenever the app checks for updates
 *   (launch, every few hours, and Help → Check for Updates), so a refund or revoke is picked
 *   up on that same cadence. Offline or failing check-ins change nothing.
 *
 * Network: the app's default session blocks all network access. License requests go through
 * a separate in-memory session that may only reach the license server.
 */
import { app, session, type Session } from 'electron';
import { execFile } from 'node:child_process';
import { createHash, createPublicKey, randomUUID, verify } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Base64 SPKI DER of the server's Ed25519 public key (Admin → Licenses shows the server's). */
export const LICENSE_PUBLIC_KEY = 'MCowBQYDK2VwAyEAup+QSSXf7sveuyvbJCoTzkggXxsKEXggI27sgJkG01c=';
const DEFAULT_API = 'https://license.bretttomita.com';
const PURCHASE_URL = 'https://license.bretttomita.com';
const TOKEN_VERSION = 'FE1';
const TOKEN_TYPE = 'file-editor-license';
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 20_000;
const KEY_ALPHABET = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';

export type LicenseStatus = 'unlicensed' | 'active' | 'revoked';

export interface LicenseState {
  status: LicenseStatus;
  email?: string;
  keyHint?: string;
  activatedAt?: string;
  /** Why a license stopped being valid (shown when status is "revoked"). */
  message?: string;
  purchaseUrl: string;
}

export type ActivateResult = { ok: true; state: LicenseState } | { ok: false; error: string; code: string };

interface StoredLicense {
  token: string;
  status: 'active' | 'revoked';
  activatedAt?: string;
  revokedMessage?: string;
  checkedAt: number;
}

interface TokenPayload {
  typ: string;
  lid: string;
  hint: string;
  email: string;
  dev: string;
  iat: number;
}

/** The dev build may point at a local server (FILE_EDITOR_LICENSE_API); packaged builds never do. */
function apiBase(): string {
  const override = process.env.FILE_EDITOR_LICENSE_API;
  return !app.isPackaged && override ? override.replace(/\/+$/, '') : DEFAULT_API;
}

const licenseFile = () => join(app.getPath('userData'), 'license.json');
const fallbackIdFile = () => join(app.getPath('userData'), 'device-fallback-id');

// ── device id ──────────────────────────────────────────────────────────────
function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 5000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))));
  });
}

async function osMachineId(): Promise<string | null> {
  try {
    if (process.platform === 'win32') {
      const reg = join(process.env.windir ?? 'C:\\Windows', 'System32', 'reg.exe');
      const out = await run(reg, ['query', 'HKLM\\SOFTWARE\\Microsoft\\Cryptography', '/v', 'MachineGuid', '/reg:64']);
      return /MachineGuid\s+REG_SZ\s+([0-9a-f-]{36})/i.exec(out)?.[1] ?? null;
    }
    if (process.platform === 'darwin') {
      const out = await run('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice']);
      return /"IOPlatformUUID"\s*=\s*"([0-9A-F-]{36})"/i.exec(out)?.[1] ?? null;
    }
    for (const p of ['/etc/machine-id', '/var/lib/dbus/machine-id']) {
      const id = (await readFile(p, 'utf8').catch(() => '')).trim();
      if (/^[0-9a-f]{32}$/i.test(id)) return id;
    }
  } catch {
    /* fall through */
  }
  return null;
}

let deviceIdPromise: Promise<string> | null = null;

/** SHA-256 hex identifying this computer. Not persisted (a copied profile mustn't carry it), except the random fallback. */
export function deviceId(): Promise<string> {
  if (!deviceIdPromise) {
    deviceIdPromise = (async () => {
      let raw = await osMachineId();
      if (!raw) {
        raw = (await readFile(fallbackIdFile(), 'utf8').catch(() => '')).trim();
        if (!raw) {
          raw = `fallback-${randomUUID()}`;
          await mkdir(dirname(fallbackIdFile()), { recursive: true });
          await writeFile(fallbackIdFile(), raw, { mode: 0o600 });
        }
      }
      return createHash('sha256').update(`file-editor-device:${raw.trim().toLowerCase()}`).digest('hex');
    })();
  }
  return deviceIdPromise;
}

// ── token ──────────────────────────────────────────────────────────────────
const publicKey = createPublicKey({ key: Buffer.from(LICENSE_PUBLIC_KEY, 'base64'), format: 'der', type: 'spki' });

/** The payload of a genuine token for this device, or null. */
export function verifyToken(token: unknown, device: string): TokenPayload | null {
  if (typeof token !== 'string' || token.length > 2000) return null;
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== TOKEN_VERSION) return null;
  try {
    if (!verify(null, Buffer.from(`${parts[0]}.${parts[1]}`), publicKey, Buffer.from(parts[2], 'base64url'))) return null;
    const p = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) as TokenPayload;
    if (p?.typ !== TOKEN_TYPE || p.dev !== device || typeof p.lid !== 'string') return null;
    return p;
  } catch {
    return null;
  }
}

/** Canonical "FE-XXXXX-XXXXX-XXXXX-XXXXX", or null (same rules as the server). */
export function normalizeKey(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 100) return null;
  let s = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.startsWith('FE') && s.length === 22) s = s.slice(2);
  if (s.length !== 20 || [...s].some((c) => !KEY_ALPHABET.includes(c))) return null;
  return ['FE', s.slice(0, 5), s.slice(5, 10), s.slice(10, 15), s.slice(15)].join('-');
}

// ── storage ────────────────────────────────────────────────────────────────
async function readStored(): Promise<StoredLicense | null> {
  try {
    const s = JSON.parse(await readFile(licenseFile(), 'utf8')) as StoredLicense;
    return typeof s?.token === 'string' ? s : null;
  } catch {
    return null;
  }
}

async function writeStored(s: StoredLicense | null): Promise<void> {
  const file = licenseFile();
  await mkdir(dirname(file), { recursive: true });
  if (!s) {
    await writeFile(file, '{}', { mode: 0o600 });
    return;
  }
  const tmp = `${file}.tmp`;
  await writeFile(tmp, JSON.stringify(s), { mode: 0o600 });
  await rename(tmp, file);
}

export async function getLicenseState(): Promise<LicenseState> {
  const stored = await readStored();
  if (!stored) return { status: 'unlicensed', purchaseUrl: PURCHASE_URL };
  // Clear leftover revoked records (and anything whose token no longer verifies).
  if (stored.status === 'revoked') {
    await writeStored(null);
    return {
      status: 'unlicensed',
      purchaseUrl: PURCHASE_URL,
      message: stored.revokedMessage ?? 'This license was revoked (for example after a refund).',
    };
  }
  const payload = verifyToken(stored.token, await deviceId());
  if (!payload) {
    await writeStored(null);
    return { status: 'unlicensed', purchaseUrl: PURCHASE_URL };
  }
  return {
    status: 'active',
    email: payload.email,
    keyHint: payload.hint,
    activatedAt: stored.activatedAt ?? new Date(payload.iat * 1000).toISOString(),
    purchaseUrl: PURCHASE_URL,
  };
}

// ── network ────────────────────────────────────────────────────────────────
let licenseSession: Session | null = null;

function netSession(): Session {
  if (!licenseSession) {
    const origin = new URL(apiBase()).origin;
    // In-memory partition: no cookies or cache are kept, and it may only talk to the license server.
    licenseSession = session.fromPartition('file-editor-license');
    licenseSession.setPermissionRequestHandler((_wc, _p, cb) => cb(false));
    licenseSession.webRequest.onBeforeRequest((details, cb) => cb({ cancel: !details.url.startsWith(`${origin}/`) }));
  }
  return licenseSession;
}

async function post(path: string, body: unknown): Promise<{ status: number; data: Record<string, unknown> }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await netSession().fetch(`${apiBase()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': `FileEditor/${app.getVersion()}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

export async function activateLicense(rawKey: unknown): Promise<ActivateResult> {
  const key = normalizeKey(rawKey);
  if (!key) return { ok: false, code: 'invalid-key', error: "That doesn't look like a license key. It should look like FE-XXXXX-XXXXX-XXXXX-XXXXX." };
  const device = await deviceId();
  let res: { status: number; data: Record<string, unknown> };
  try {
    res = await post('/api/license/activate', { key, deviceId: device, platform: process.platform, arch: process.arch, appVersion: app.getVersion() });
  } catch {
    return { ok: false, code: 'network', error: "Couldn't reach the license server. Check your internet connection and try again." };
  }
  const { status, data } = res;
  if (status !== 200 || typeof data.token !== 'string') {
    return { ok: false, code: String(data.code ?? 'error'), error: String(data.error ?? `Activation failed (HTTP ${status}). Please try again.`) };
  }
  const payload = verifyToken(data.token, device);
  if (!payload) return { ok: false, code: 'bad-token', error: 'The license server sent an activation this app could not verify. Please update File Editor and try again.' };
  const lic = (data.license ?? {}) as { activatedAt?: string };
  await writeStored({ token: data.token, status: 'active', activatedAt: lic.activatedAt, checkedAt: Date.now() });
  return { ok: true, state: await getLicenseState() };
}

/**
 * Check-in for a stored license against the license server.
 * `force` skips the local throttle (used on every update check and when the license dialog opens).
 * Quietly does nothing when offline.
 */
export async function refreshLicenseStatus(force = false): Promise<void> {
  const stored = await readStored();
  if (!stored) return;
  // A license already marked revoked locally should not linger on disk.
  if (stored.status === 'revoked') {
    await writeStored(null);
    return;
  }
  if (!force && Date.now() - (stored.checkedAt ?? 0) < CHECK_INTERVAL_MS) return;
  const device = await deviceId();
  if (!verifyToken(stored.token, device)) {
    // Token no longer verifies for this device — drop it.
    await writeStored(null);
    return;
  }
  try {
    const { status, data } = await post('/api/license/status', { token: stored.token, deviceId: device });
    if (status !== 200) return;
    if (data.status === 'revoked' || data.status === 'inactive') {
      // Refund / revoke / moved to another device: this computer no longer holds the license.
      await writeStored(null);
    } else if (data.status === 'active') {
      await writeStored({ token: stored.token, status: 'active', activatedAt: stored.activatedAt, checkedAt: Date.now() });
    }
  } catch {
    /* offline: try again next start */
  }
}
