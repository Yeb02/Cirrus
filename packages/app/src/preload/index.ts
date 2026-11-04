import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The interface's only door to the system (spec 4): a few calls, no Node access.
const arg = process.argv.find((a) => a.startsWith('--cirrus-launch='));
const launch = arg ? JSON.parse(arg.slice('--cirrus-launch='.length)) : {};

contextBridge.exposeInMainWorld('cirrus', {
  load: (fromTables: boolean) => ipcRenderer.invoke('cirrus:load', fromTables === true),
  saveSnapshot: (data: ArrayBuffer, seq: number) => ipcRenderer.invoke('cirrus:snapshot:save', data, seq),
  getSettings: () => ipcRenderer.invoke('cirrus:settings:get'),
  setSettings: (overrides: Record<string, unknown>) => ipcRenderer.invoke('cirrus:settings:set', overrides),
  ready: () => ipcRenderer.send('cirrus:ready'),
  benchMemory: () => ipcRenderer.invoke('cirrus:bench:memory'),
  benchDone: (run: unknown) => ipcRenderer.invoke('cirrus:bench:done', run),
  commit: (action: unknown) => ipcRenderer.invoke('cirrus:commit', action),
  onQuit: (fn: () => void) => {
    const listener = () => fn();
    ipcRenderer.on('cirrus:quit', listener);
    return () => { ipcRenderer.removeListener('cirrus:quit', listener); };
  },
  quitReady: () => ipcRenderer.send('cirrus:quit:ready'),
  // A dropped file's path (File.path is gone): '' for a file not on the disk, and for anything that is not a File.
  pathForFile: (file: File) => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  importFiles: (paths: string[]) => ipcRenderer.invoke('cirrus:files:import', paths),
  pickFiles: () => ipcRenderer.invoke('cirrus:files:pick'),
  openFile: (ref: unknown) => ipcRenderer.invoke('cirrus:files:open', ref),
  historyOf: (id: string) => ipcRenderer.invoke('cirrus:history', id),
  launch,
});
