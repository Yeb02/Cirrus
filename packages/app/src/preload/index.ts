import { contextBridge, ipcRenderer, webUtils } from 'electron';

// The interface's only door to the system (spec 4): a few calls, no Node access.
const arg = process.argv.find((a) => a.startsWith('--cirrus-launch='));
const launch = arg ? JSON.parse(arg.slice('--cirrus-launch='.length)) : {};
// The paths of the files dropped in this page, which pathForFile gave: the only ones importFiles hands on (I1 of the
// review). Scripts of the page cannot reach this closure (contextIsolation), and getPathForFile gives '' for any File
// they make; so a script cannot have the main process read a file the user did not drop.
const dropped = new Set<string>();
// Captures (CIRRUS_IMPORT="sx,sy|path"): the paths the main process gives at launch are as trusted as a drop's; the
// page drops them by its own drop function, through this gate.
if (typeof launch.import === 'string') for (const p of launch.import.split('|').slice(1)) if (p) dropped.add(p);
const nameOf = (p: unknown) => String(p).slice(Math.max(String(p).lastIndexOf('\\'), String(p).lastIndexOf('/')) + 1);

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
    let path = '';
    try {
      path = webUtils.getPathForFile(file);
    } catch {
      // not a File
    }
    if (path) dropped.add(path);
    return path;
  },
  importFiles: async (paths: string[]) => {
    const given: unknown[] = Array.isArray(paths) ? paths : [];
    const r = await ipcRenderer.invoke('cirrus:files:import', given.filter((p) => dropped.has(p as string)));
    const others = given.filter((p) => !dropped.has(p as string)).map((p) => ({ name: nameOf(p), reason: 'non déposé' }));
    return { refs: r.refs, refused: [...r.refused, ...others] };
  },
  pickFiles: () => ipcRenderer.invoke('cirrus:files:pick'),
  storeText: (name: string, text: string) => ipcRenderer.invoke('cirrus:files:store-text', name, text),
  openFile: (ref: unknown) => ipcRenderer.invoke('cirrus:files:open', ref),
  openUrl: (url: string) => ipcRenderer.invoke('cirrus:open-url', url),
  historyOf: (id: string) => ipcRenderer.invoke('cirrus:history', id),
  latexCompile: (req: unknown) => ipcRenderer.invoke('cirrus:latex:compile', req),
  latexCancel: (slot: string) => ipcRenderer.send('cirrus:latex:cancel', slot),
  latexWarm: (preamble: string) => ipcRenderer.send('cirrus:latex:warm', preamble),
  latexStatus: () => ipcRenderer.invoke('cirrus:latex:status:get'),
  latexInstall: () => ipcRenderer.invoke('cirrus:latex:install'),
  publicationFetch: (text: string, options?: { pdf?: boolean }) => ipcRenderer.invoke('cirrus:publications:fetch', text, options),
  onLatexStatus: (fn: (s: unknown) => void) => {
    const listener = (_e: unknown, s: unknown) => fn(s);
    ipcRenderer.on('cirrus:latex:status', listener);
    return () => { ipcRenderer.removeListener('cirrus:latex:status', listener); };
  },
  launch,
});
