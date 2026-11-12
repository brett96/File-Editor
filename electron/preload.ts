/**
 * Preload bridge. Runs in the sandboxed renderer with access to a minimal Electron API and
 * exposes exactly the DesktopBridge interface (src/platform/host.ts) — nothing else.
 */
import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';

type FilePayload = { name: string; bytes: Uint8Array; token: string };

const bridge = {
  platform: process.platform,
  version: process.versions.electron,
  openFiles: (options: { extensions: string[]; multiple: boolean; description: string }): Promise<FilePayload[]> =>
    ipcRenderer.invoke('open-files', options),
  saveFile: (token: string, bytes: Uint8Array): Promise<{ name: string; token: string }> => ipcRenderer.invoke('save-file', token, bytes),
  saveFileAs: (options: { suggestedName: string; ext: string; description: string }, bytes: Uint8Array): Promise<{ name: string; token: string } | null> =>
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
  onUpdateStatus: (callback: (status: { state: string; version?: string; percent?: number }) => void) => {
    const listener = (_e: IpcRendererEvent, status: { state: string; version?: string; percent?: number }) => callback(status);
    ipcRenderer.on('update-status', listener);
    return () => ipcRenderer.removeListener('update-status', listener);
  },
  installUpdate: () => ipcRenderer.send('install-update'),
  setDirty: (dirty: boolean) => ipcRenderer.send('set-dirty', dirty),
  setTitle: (title: string) => ipcRenderer.send('set-title', title),
};

contextBridge.exposeInMainWorld('desktop', bridge);
