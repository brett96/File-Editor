/**
 * Saved agent sessions, so earlier conversations can be looked through and continued. Kept on
 * this computer only, in IndexedDB: a small summary per session for the list ("meta") and the
 * whole conversation separately ("data"), so listing stays quick even with pictures in them.
 */
import type { AgentMessage } from '../../core/agent/protocol';

export interface SessionMeta {
  id: string;
  title: string;
  /** what the session worked on (folder or file name) */
  where: string;
  model: string;
  mode: 'agent' | 'chat';
  createdAt: number;
  updatedAt: number;
  /** messages the user sent */
  turns: number;
}

export interface SessionData<Item> {
  id: string;
  items: Item[];
  history: AgentMessage[];
}

const DB = 'fe-agent';
const META = 'meta';
const DATA = 'data';
/** Older sessions beyond this are removed, so the store can't grow without end. */
export const MAX_SESSIONS = 100;

let opening: Promise<IDBDatabase> | null = null;

function db(): Promise<IDBDatabase> {
  opening ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') return reject(new Error('Sessions can’t be saved in this window.'));
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(DATA)) d.createObjectStore(DATA, { keyPath: 'id' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => {
      opening = null;
      reject(req.error ?? new Error('Sessions can’t be opened.'));
    };
  });
  return opening;
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Aborted'));
  });

const request = <T,>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

/** Every saved session, newest first. */
export async function listSessions(): Promise<SessionMeta[]> {
  const d = await db();
  const all = await request(d.transaction(META).objectStore(META).getAll() as IDBRequest<SessionMeta[]>);
  return all.sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function loadSession<Item>(id: string): Promise<SessionData<Item> | null> {
  const d = await db();
  return (await request(d.transaction(DATA).objectStore(DATA).get(id) as IDBRequest<SessionData<Item> | undefined>)) ?? null;
}

export async function saveSession<Item>(meta: SessionMeta, data: SessionData<Item>): Promise<void> {
  const d = await db();
  const tx = d.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).put(meta);
  tx.objectStore(DATA).put(data);
  await done(tx);
  // keep the newest MAX_SESSIONS
  const all = await listSessions();
  if (all.length > MAX_SESSIONS) await Promise.all(all.slice(MAX_SESSIONS).map((s) => deleteSession(s.id)));
}

export async function deleteSession(id: string): Promise<void> {
  const d = await db();
  const tx = d.transaction([META, DATA], 'readwrite');
  tx.objectStore(META).delete(id);
  tx.objectStore(DATA).delete(id);
  await done(tx);
}

/** A session's title: the start of its first message. */
export function sessionTitle(firstMessage: string): string {
  const t = firstMessage.replace(/\s+/g, ' ').trim();
  return t.length > 70 ? `${t.slice(0, 67)}…` : t || 'Untitled session';
}
