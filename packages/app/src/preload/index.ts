import { contextBridge, ipcRenderer, webUtils } from 'electron';
import { benchCalls } from './bench.ts';

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

/** A message of the main process passed to `fn`, its argument only; returns the unsubscription. */
const on = (channel: string, fn: (x: unknown) => void) => {
  const listener = (_e: unknown, x: unknown) => fn(x);
  ipcRenderer.on(channel, listener);
  return () => { ipcRenderer.removeListener(channel, listener); };
};

contextBridge.exposeInMainWorld('cirrus', {
  load: (fromTables: boolean) => ipcRenderer.invoke('cirrus:load', fromTables === true),
  saveSnapshot: (data: ArrayBuffer, seq: number) => ipcRenderer.invoke('cirrus:snapshot:save', data, seq),
  getSettings: () => ipcRenderer.invoke('cirrus:settings:get'),
  setSettings: (changes: Record<string, unknown>) => ipcRenderer.invoke('cirrus:settings:set', changes),
  // The shared settings received from the server (plan 5a, task 6), one batch per message.
  onSettingsChanged: (fn: (changes: unknown) => void) => on('cirrus:settings:changed', fn),
  ready: () => ipcRenderer.send('cirrus:ready'),
  // The bench's calls, in bench mode only (plan 9, D8).
  ...benchCalls(launch, (channel, ...args) => ipcRenderer.invoke(channel, ...args)),
  commit: (action: unknown, unit: string) => ipcRenderer.invoke('cirrus:commit', action, unit),
  // The consultations (plan 6a, D6): sent, never awaited, on the channel the closing's « ready » is sent on, so that they
  // arrive before it.
  recordConsultations: (events: unknown) => ipcRenderer.send('cirrus:consultations', events),
  // The Windows app commands « Précédent » et « Suivant » (plan 6a, D2: the mouse's side buttons, the browser keys).
  onAppCommand: (fn: (command: string) => void) => on('cirrus:app-command', (c) => { if (c === 'browser-backward' || c === 'browser-forward') fn(c); }),
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
  storeTexts: (items: unknown) => ipcRenderer.invoke('cirrus:files:store-texts', items),
  // A .bib dropped on the graph's background (plan 4c, task 6): read only if its path is a drop's, as importFiles.
  readBib: (path: unknown) => (typeof path === 'string' && dropped.has(path)
    ? ipcRenderer.invoke('cirrus:bib:read', path)
    : Promise.resolve({ refused: `« ${nameOf(path).slice(0, 80)} » n’a pas été déposé : il n’est pas lu.` })),
  pickBib: () => ipcRenderer.invoke('cirrus:bib:pick'),
  // « Choisir un PDF… » (plan 5b, D5): the path the system's dialog gave (the main process opened it, no script of the
  // page chose it), which importFiles then takes as it takes a dropped file's; null when none is chosen.
  pickPdf: async () => {
    const path: unknown = await ipcRenderer.invoke('cirrus:pdf:pick');
    if (typeof path !== 'string' || path === '') return null;
    dropped.add(path);
    return path;
  },
  openFile: (ref: unknown) => ipcRenderer.invoke('cirrus:files:open', ref),
  openUrl: (url: string) => ipcRenderer.invoke('cirrus:open-url', url),
  historyOf: (id: string) => ipcRenderer.invoke('cirrus:history', id),
  latexCompile: (req: unknown) => ipcRenderer.invoke('cirrus:latex:compile', req),
  latexCancel: (slot: string) => ipcRenderer.send('cirrus:latex:cancel', slot),
  latexBackground: (reqs: unknown) => ipcRenderer.send('cirrus:latex:background', reqs),
  latexWarm: (preamble: string) => ipcRenderer.send('cirrus:latex:warm', preamble),
  latexStatus: () => ipcRenderer.invoke('cirrus:latex:status:get'),
  latexInstall: () => ipcRenderer.invoke('cirrus:latex:install'),
  publicationFetch: (text: string, options?: { pdf?: boolean }) => ipcRenderer.invoke('cirrus:publications:fetch', text, options),
  onLatexStatus: (fn: (s: unknown) => void) => on('cirrus:latex:status', fn),
  // The synchronisation (plan 5a, task 4).
  syncStart: () => ipcRenderer.invoke('cirrus:sync:start'),
  syncRetry: () => ipcRenderer.send('cirrus:sync:retry'),
  syncReconciled: (id: number, outcome: unknown) => ipcRenderer.invoke('cirrus:sync:reconciled', id, outcome),
  syncPending: () => ipcRenderer.invoke('cirrus:sync:pending'),
  syncServer: () => ipcRenderer.invoke('cirrus:sync:server:get'),
  syncPair: (url: string, code: string, name: string) => ipcRenderer.invoke('cirrus:sync:pair', url, code, name),
  syncFirst: (choice: string) => ipcRenderer.invoke('cirrus:sync:first', choice),
  syncUnpair: () => ipcRenderer.invoke('cirrus:sync:unpair'),
  onSyncIncoming: (fn: (m: unknown) => void) => on('cirrus:sync:incoming', fn),
  onSyncStatus: (fn: (s: unknown) => void) => on('cirrus:sync:status', fn),
  onSyncVeil: (fn: () => void) => on('cirrus:sync:veil', () => fn()),
  // Each change of the pairing (short review after plan 5a, B2).
  onSyncServer: (fn: (info: unknown) => void) => on('cirrus:sync:server', fn),
  // « .tex ouvert ailleurs » (plan 5b, D6).
  texOpened: (node: string, name: string) => ipcRenderer.invoke('cirrus:sync:tex:opened', node, name),
  texClosed: (node: string, name: string) => ipcRenderer.send('cirrus:sync:tex:closed', node, name),
  // The server's state and « Tout télécharger » (plan 5b, D8).
  serverStatus: () => ipcRenderer.invoke('cirrus:sync:server:status'),
  downloadAllPlan: (refs: unknown) => ipcRenderer.invoke('cirrus:sync:download-all:plan', refs),
  downloadAllStart: (refs: unknown) => ipcRenderer.invoke('cirrus:sync:download-all:start', refs),
  downloadAllStop: () => ipcRenderer.send('cirrus:sync:download-all:stop'),
  onDownloadAll: (fn: (p: unknown) => void) => on('cirrus:sync:download-all', fn),
  launch,
});
