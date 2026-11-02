import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('bench', {
  saveReport: (name: string, json: string, markdown: string): Promise<void> =>
    ipcRenderer.invoke('bench:saveReport', name, json, markdown),
  setCpuThrottle: (rate: number): Promise<void> => ipcRenderer.invoke('bench:setCpuThrottle', rate),
  quit: (): void => ipcRenderer.send('bench:quit'),
});
