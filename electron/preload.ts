/**
 * Preload bridge. Runs in the sandboxed renderer with access to a minimal Electron API and
 * exposes exactly the DesktopBridge interface (src/platform/host.ts) — nothing else.
 */
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from 'electron';

type FilePayload = { name: string; bytes: Uint8Array; token: string };
type UpdateStatusPayload = { state: string; version?: string; percent?: number; speed?: number; message?: string; manual?: boolean };

const bridge = {
  platform: process.platform,
  version: process.versions.electron,
  openFiles: (options: { extensions: string[]; multiple: boolean; description: string }): Promise<FilePayload[]> =>
    ipcRenderer.invoke('open-files', options),
  saveFile: (token: string, bytes: Uint8Array): Promise<{ name: string; token: string }> => ipcRenderer.invoke('save-file', token, bytes),
  saveFileAs: (options: { suggestedName: string; ext: string; extensions?: string[]; description: string }, bytes: Uint8Array): Promise<{ name: string; token: string } | null> =>
    ipcRenderer.invoke('save-file-as', options, bytes),
  onOpenFile: (callback: (file: FilePayload) => void) => {
    const listener = (_e: IpcRendererEvent, file: FilePayload) => callback(file);
    ipcRenderer.on('open-file', listener);
    return () => ipcRenderer.removeListener('open-file', listener);
  },
  onMenuCommand: (callback: (command: string) => void) => {
    const listener = (_e: IpcRendererEvent, command: string) => callback(command);
    ipcRenderer.on('menu', listener);
    return () => ipcRenderer.removeListener('menu', listener);
  },
  onUpdateStatus: (callback: (status: UpdateStatusPayload) => void) => {
    let live = false;
    const listener = (_e: IpcRendererEvent, status: UpdateStatusPayload) => {
      live = true;
      callback(status);
    };
    ipcRenderer.on('update-status', listener);
    // the update may have been found (or downloaded) before this window subscribed
    void ipcRenderer.invoke('update-status-get').then(
      (status: UpdateStatusPayload | null) => {
        if (status && !live) callback({ ...status, manual: false });
      },
      () => undefined,
    );
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  checkForUpdates: () => ipcRenderer.send('update-check'),
  installUpdate: () => ipcRenderer.send('install-update'),
  recent: {
    list: (): Promise<{ id: string; name: string; folder: string }[]> => ipcRenderer.invoke('recent-list'),
    open: (id: string): Promise<FilePayload> => ipcRenderer.invoke('recent-open', id),
    clear: (): Promise<void> => ipcRenderer.invoke('recent-clear'),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('recent-remove', id),
    onChange: (callback: () => void) => {
      const listener = () => callback();
      ipcRenderer.on('recent-changed', listener);
      return () => ipcRenderer.removeListener('recent-changed', listener);
    },
  },
  setAutoSave: (on: boolean) => ipcRenderer.send('set-autosave', on),
  backupFile: (token: string): Promise<string | null> => ipcRenderer.invoke('backup-file', token),
  // Only a real dropped File has a path; one constructed by page script resolves to null.
  openDropped: async (file: File): Promise<FilePayload | null> => {
    const path = webUtils.getPathForFile(file);
    return path ? ipcRenderer.invoke('open-dropped', path) : null;
  },
  folder: {
    pick: (): Promise<{ id: string; name: string } | null> => ipcRenderer.invoke('folder-pick'),
    list: (id: string, path: string): Promise<{ name: string; kind: 'file' | 'dir' }[]> => ipcRenderer.invoke('folder-list', id, path),
    open: (id: string, path: string): Promise<FilePayload> => ipcRenderer.invoke('folder-open', id, path),
    read: (id: string, path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('folder-read', id, path),
    createFile: (id: string, path: string, bytes: Uint8Array): Promise<void> => ipcRenderer.invoke('folder-create-file', id, path, bytes),
    createDir: (id: string, path: string): Promise<void> => ipcRenderer.invoke('folder-create-dir', id, path),
    rename: (id: string, path: string, newName: string): Promise<string> => ipcRenderer.invoke('folder-rename', id, path, newName),
    remove: (id: string, path: string): Promise<void> => ipcRenderer.invoke('folder-remove', id, path),
  },
  readSibling: (token: string, path: string): Promise<Uint8Array | null> => ipcRenderer.invoke('sibling-read', token, path),
  preview: {
    set: (id: string, html: string): Promise<string> => ipcRenderer.invoke('preview-set', id, html),
    clear: (id: string) => ipcRenderer.send('preview-clear', id),
  },
  license: {
    get: () => ipcRenderer.invoke('license-get'),
    activate: (key: string) => ipcRenderer.invoke('license-activate', key),
    onChange: (callback: (state: { status: string; message?: string; purchaseUrl: string }) => void) => {
      const listener = (_e: IpcRendererEvent, state: { status: string; message?: string; purchaseUrl: string }) => callback(state);
      ipcRenderer.on('license-changed', listener);
      return () => ipcRenderer.removeListener('license-changed', listener);
    },
  },
  setDirty: (dirty: boolean) => ipcRenderer.send('set-dirty', dirty),
  setTitle: (title: string) => ipcRenderer.send('set-title', title),
};

contextBridge.exposeInMainWorld('desktop', bridge);
