/**
 * What the coding agent may do beyond reading and editing files, and whether it asks first.
 * Each capability is off, asks every time, asks once per session, or runs without asking.
 * Edits and new files keep their own review step ("Apply changes without asking").
 */

export type Capability = 'files' | 'commands' | 'web';
export type PermissionLevel = 'off' | 'ask' | 'session' | 'auto';
export type AgentPermissions = Record<Capability, PermissionLevel>;

export const DEFAULT_PERMISSIONS: AgentPermissions = { files: 'ask', commands: 'ask', web: 'ask' };

export const CAPABILITIES: { id: Capability; label: string; detail: string }[] = [
  { id: 'files', label: 'Delete and rename files', detail: 'Delete files and folders of the opened folder (to the recycle bin / Trash in the desktop app), rename and move them.' },
  { id: 'commands', label: 'Run commands and tests', detail: 'Run shell commands in the opened folder (builds, tests, linters, git…) and read their output. Commands run as you, with your access.' },
  { id: 'web', label: 'Go online and search the web', detail: 'Search the web and read web pages (public sites only; addresses on this computer or your network are refused).' },
];

export const LEVELS: { id: PermissionLevel; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'ask', label: 'Ask every time' },
  { id: 'session', label: 'Ask once per session' },
  { id: 'auto', label: 'Allowed without asking' },
];

const isLevel = (v: unknown): v is PermissionLevel => v === 'off' || v === 'ask' || v === 'session' || v === 'auto';

/** Stored settings, with defaults for anything missing or unknown. */
export function parsePermissions(raw: unknown): AgentPermissions {
  let v: unknown = raw;
  if (typeof raw === 'string') {
    try {
      v = JSON.parse(raw);
    } catch {
      v = null;
    }
  }
  const o = v && typeof v === 'object' ? (v as Record<string, unknown>) : {};
  return {
    files: isLevel(o.files) ? o.files : DEFAULT_PERMISSIONS.files,
    commands: isLevel(o.commands) ? o.commands : DEFAULT_PERMISSIONS.commands,
    web: isLevel(o.web) ? o.web : DEFAULT_PERMISSIONS.web,
  };
}

/** The capability a tool needs, or null for the tools that are always there. */
export function toolCapability(name: string): Capability | null {
  if (name === 'delete_file' || name === 'rename_file') return 'files';
  if (name === 'run_command') return 'commands';
  if (name === 'web_search' || name === 'fetch_url') return 'web';
  return null;
}

/**
 * Whether a use needs the user's OK now: 'allow' (go ahead), 'ask' (show the request), or
 * 'off' (refuse). `granted` is whether the user already allowed it for this session.
 */
export function decision(level: PermissionLevel, granted: boolean): 'allow' | 'ask' | 'off' {
  if (level === 'off') return 'off';
  if (level === 'auto') return 'allow';
  if (level === 'session' && granted) return 'allow';
  return 'ask';
}
