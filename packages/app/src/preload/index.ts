import { contextBridge, ipcRenderer } from 'electron';

// The interface's only door to the system (spec 4): a few calls, no Node access.
const arg = process.argv.find((a) => a.startsWith('--cirrus-launch='));
const launch = arg ? JSON.parse(arg.slice('--cirrus-launch='.length)) : {};

contextBridge.exposeInMainWorld('cirrus', {
  snapshot: () => ipcRenderer.invoke('cirrus:snapshot'),
  getSettings: () => ipcRenderer.invoke('cirrus:settings:get'),
  setSettings: (overrides: Record<string, unknown>) => ipcRenderer.invoke('cirrus:settings:set', overrides),
  ready: () => ipcRenderer.send('cirrus:ready'),
  benchDone: (run: unknown) => ipcRenderer.invoke('cirrus:bench:done', run),
  commit: (action: unknown) => ipcRenderer.invoke('cirrus:commit', action),
  launch,
});
