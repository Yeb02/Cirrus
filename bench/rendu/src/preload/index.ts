import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bench', {
  saveReport: (name: string, json: string, markdown: string): Promise<void> =>
    ipcRenderer.invoke('bench:saveReport', name, json, markdown),
  setCpuThrottle: (rate: number): Promise<void> => ipcRenderer.invoke('bench:setCpuThrottle', rate),
  displayInfo: (): Promise<string> => ipcRenderer.invoke('bench:displayInfo'),
  appendRun: (json: string): Promise<void> => ipcRenderer.invoke('bench:appendRun', json),
  loadRuns: (): Promise<string> => ipcRenderer.invoke('bench:loadRuns'),
  quit: (): void => ipcRenderer.send('bench:quit'),
});
