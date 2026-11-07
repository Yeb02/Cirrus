import { mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { type Action, type CompileRequest, type FileRef, type Id, OpConflictError } from '@cirrus/core';
import { forceGc } from '@cirrus/fixtures';
import { type LocalStore, storeBytes } from '@cirrus/store';
import { type RenderParams, withOverrides } from '@cirrus/view';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, screen, shell } from 'electron';
import { dataDir, keepSnapshot, loadPayload, openBase, saveSnapshot } from './base.ts';
import { ensureBenchBase, loadPhases, type PassRecord, type Phase, processMemoryMb, recordRun, recordSnapshots, snapshotRewrites } from './bench.ts';
import { cleanCopies, FILE_SCHEME, fileResponse, historySummary, importPaths, openFailure, openTarget, storeText } from './files.ts';
import { PdfCache } from './latex/cache.ts';
import { INVALID_REQUEST, invalidRequest, LatexService } from './latex/compiler.ts';
import { LatexSetup } from './latex/setup.ts';
import { type Deps, fetchDownload, findBinaries, Packages, provision, runFile, type TexBinaries, tinyTexRoot } from './latex/tinytex.ts';
import { lockBase } from './lock.ts';
import { externalUrlAllowed, navigationAllowed } from './navigation.ts';
import { type FetchFn, importPublication, requestFetch } from './publications/fetch.ts';
import { replayDirOf, replayFetch } from './publications/replay.ts';
import { readSettings, writeSettings } from './settings.ts';

/**
 * The main process: the only one that touches the disk (spec 4). It opens the base and the settings, and answers the
 * interface over IPC; it keeps no copy of the state (plan 3c, decision 3), the interface does. It serves the nodes' files
 * by the cirrus-file: protocol, imports them and opens their copies (files.ts, plan 4a). It compiles LaTeX, the PDFs
 * served by the same protocol, and installs TinyTeX when the user asks, then the packages it misses (latex/, plan 4b).
 * It fetches a publication's metadata, and an arXiv article's PDF, when the user imports one (publications/, plan 4c).
 * Closing waits, at most snapshotQuitMs, for the interface's last snapshot, and quitting for every pdfLaTeX to exit.
 * CIRRUS_CAPTURE=<png> captures the window once the first frame is drawn, then quits (visual checks).
 * CIRRUS_BENCH=<nodes>,<connections> runs the rendering bench on the base CIRRUS_DATA names (scripts/bench.mjs), which
 * CIRRUS_BENCH_BUILD=<dir> builds beforehand; with CIRRUS_BENCH_SNAPSHOTS=<n>, the snapshot of that base is rewritten n
 * times instead, without a window, and the file's size recorded.
 */
let store: LocalStore | null = null;
let dir = '';
const capture = process.env.CIRRUS_CAPTURE;
const bench = process.env.CIRRUS_BENCH;
const benchBuild = process.env.CIRRUS_BENCH_BUILD;
const benchSnapshots = bench ? process.env.CIRRUS_BENCH_SNAPSHOTS : undefined;
const launch = {
  plan: process.env.CIRRUS_PLAN,
  view: process.env.CIRRUS_VIEW,
  hover: process.env.CIRRUS_HOVER,
  panel: process.env.CIRRUS_PANEL === '1',
  bench: bench ? (process.env.CIRRUS_BENCH_LABEL ?? 'vsync') : undefined,
  capture: capture !== undefined,
  hide: process.env.CIRRUS_BENCH_HIDE,
  keys: process.env.CIRRUS_KEYS,
  pointer: process.env.CIRRUS_POINTER,
  click: process.env.CIRRUS_CLICK,
  // "sx,sy|path": files dropped on the graph at that point; captures only, whose base is a test copy (never the user's).
  import: capture ? process.env.CIRRUS_IMPORT : undefined,
};
/** The main process's load marks, in absolute time like the interface's. */
const benchMarks: Partial<Record<Phase, number>> = {};
const markNow = (name: Phase) => { if (benchMarks[name] === undefined) benchMarks[name] = performance.timeOrigin + performance.now(); };
if (bench) {
  app.commandLine.appendSwitch('force_high_performance_gpu');
  // Memory after collections: gc() in the interface, and exact heap figures (Chromium rounds and caches them otherwise).
  app.commandLine.appendSwitch('js-flags', '--expose-gc');
  app.commandLine.appendSwitch('enable-precise-memory-info');
}
// Bench and captures keep their own profile: the tabs they open (localStorage) never replace the user's.
if (bench || capture) app.setPath('userData', join(app.getPath('temp'), 'cirrus-mesure'));
/**
 * Captures, and the interface's checks (CIRRUS_BACKGROUND=1, scripts/interface.mjs), keep out of the user's way (the
 * user, 2026-11-07): the window opens beyond the screens, without the focus nor a taskbar button. Windows would then
 * count it occluded and Chromium stop drawing it: that computation is turned off.
 */
const background = capture !== undefined || process.env.CIRRUS_BACKGROUND === '1';
if (background) app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
// The store's files, for fetch, <img> and pdf.js (plan 4a, D1): privileges are given before ready. Without corsEnabled,
// Chromium refuses fetch and XHR from the page (file://, or the dev server's http://) to the scheme (registry, task 1).
protocol.registerSchemesAsPrivileged([
  { scheme: FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);
/**
 * The read-only copies opened by the system's applications (plan 4a, D5), cleared at the next startup; a file saved
 * beside them, writable, is kept (cleanCopies).
 */
const copies = join(tmpdir(), 'cirrus-ouverts');
/**
 * One instance per base (I3 of the final review): every base has its lock (lockBase, taken below). On the user's own
 * base (no CIRRUS_DATA, neither bench nor capture), Electron's lock too, which is per profile: a second launch shows the
 * first one's window and quits.
 */
const ownBase = !bench && !capture && !benchBuild && !process.env.CIRRUS_DATA;
const first = !ownBase || app.requestSingleInstanceLock();
if (!first) app.quit();
app.on('second-instance', () => {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win || win.isDestroyed()) return;
  if (win.isMinimized()) win.restore();
  win.show();
  win.focus();
});
/** The base's lock, held (referenced) until the store is closed. */
let lock: { release(): void } | null = null;
/** LaTeX's compilations (plan 4b), once the base is open; and in front of them, LaTeX's state and installation (task 7). */
let latex: LatexService | null = null;
let latexSetup: LatexSetup | null = null;
let texFound: TexBinaries | null = null;
/** pdfLaTeX: looked for again while it is absent (task 7 installs it during the session). */
async function texBinaries(): Promise<TexBinaries | null> {
  if (texFound) return texFound;
  let root: string;
  try {
    root = tinyTexRoot(process.env);
  } catch {
    return null;
  }
  return (texFound = await findBinaries(root));
}
/** Quits once every pdfLaTeX has exited (no orphan, Global Constraints): the exits that skip will-quit. */
function exitAfterLatex(code: number): void {
  void (latex?.dispose() ?? Promise.resolve()).finally(() => app.exit(code));
}

function createWindow(): void {
  const [width, height] = (process.env.CIRRUS_SIZE ?? '1600,1000').split(',').map(Number);
  // The bench measures on the laptop's own panel, full screen (spec 21), like the plan 1 bench.
  const display = bench ? (screen.getAllDisplays().find((d) => d.internal) ?? screen.getPrimaryDisplay()) : null;
  const beyond = Math.max(...screen.getAllDisplays().map((d) => d.bounds.x + d.bounds.width)) + 100;
  const win = new BrowserWindow({
    ...(display ? { ...display.bounds, fullscreen: true } : { width, height }),
    ...(background && !display ? { x: beyond, y: 0, skipTaskbar: true } : {}),
    show: false, title: 'Cirrus', backgroundColor: '#0a1120', autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      // Bench and captures never depend on the window being in front (an occluded window is otherwise throttled).
      backgroundThrottling: !bench && !capture,
      additionalArguments: [`--cirrus-launch=${JSON.stringify(launch)}`],
    },
  });
  win.once('ready-to-show', () => (background ? win.showInactive() : win.show()));
  // Closing: the interface sends its snapshot (if anything changed) and says so; past snapshotQuitMs, the window closes
  // anyway (the journal has every action). Bench and captures quit by app.exit, without this.
  let closing = false;
  win.on('close', (e) => {
    if (closing || !store) return;
    e.preventDefault();
    closing = true;
    const done = () => {
      clearTimeout(timer);
      ipcMain.removeListener('cirrus:quit:ready', done);
      if (!win.isDestroyed()) win.destroy();
    };
    const timer = setTimeout(done, withOverrides(settings()).snapshotQuitMs);
    ipcMain.on('cirrus:quit:ready', done);
    win.webContents.send('cirrus:quit');
  });
  // The window shows the app's page and nothing else (Review Focus 2): a file let go outside a drop zone, a link, a
  // script's location do not take it elsewhere, and no other window opens.
  const page = join(import.meta.dirname, '..', 'renderer', 'index.html');
  const appUrl = process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(page).href;
  win.webContents.on('will-navigate', (e) => {
    if (navigationAllowed(e.url, appUrl)) return;
    e.preventDefault();
    console.warn(`Navigation refusée : ${e.url}`);
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(page);
  // The user's LaTeX packages (latexPackages, D1), installed if missing once the window is loaded (task 7), in the
  // background. Measuring runs leave the bench's TinyTeX as it is.
  if (!bench && !capture) win.webContents.on('did-finish-load', () => { void latexSetup?.ensureAtStart(); });

  if (capture || bench || process.env.CIRRUS_LOG === '1') {
    win.webContents.on('console-message', (e) => console.log(`[interface] ${e.level}: ${e.message}`));
  }
  if (bench && process.env.CIRRUS_BENCH_THROTTLE) {
    win.webContents.once('did-finish-load', () => {
      const dbg = win.webContents.debugger;
      dbg.attach('1.3');
      void dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate: Number(process.env.CIRRUS_BENCH_THROTTLE) });
    });
  }
  if (capture) {
    let done = false;
    const shoot = (code: number) => {
      if (done) return;
      done = true;
      void win.webContents.capturePage().then((img) => {
        mkdirSync(dirname(capture), { recursive: true });
        writeFileSync(capture, img.toPNG());
        console.log(`Capture écrite : ${capture}`);
        exitAfterLatex(code);
      });
    };
    ipcMain.once('cirrus:ready', () => setTimeout(() => shoot(0), 500));
    setTimeout(() => { console.error('Pas d’image après 30 s : capture de l’état actuel.'); shoot(1); }, 30_000);
  }
}

// The state as one ArrayBuffer (plan 3c, decision 5): the base's snapshot and the journal after it, or, without a
// usable snapshot (or when the interface could not use it: fromTables), the state of the tables, kept as the new
// snapshot once sent. An ArrayBuffer crosses IPC and the context bridge at the speed of memory.
ipcMain.handle('cirrus:load', (_e, fromTables: unknown) => {
  const { payload, rebuilt } = loadPayload(store!, fromTables === true);
  markNow('dataSent');
  if (rebuilt) setImmediate(() => keepSnapshot(store!, payload.data, payload.seq));
  return payload;
});
// The interface's snapshot, at rest and at closing: checked, kept if later than the stored one.
ipcMain.handle('cirrus:snapshot:save', (_e, data: unknown, seq: unknown) => { saveSnapshot(store!, data, seq); });
/** The settings: the defaults, or on the bench CIRRUS_BENCH_SETTINGS (a JSON of overrides) to compare one setting. */
const settings = (): Record<string, unknown> => (bench ? JSON.parse(process.env.CIRRUS_BENCH_SETTINGS ?? '{}') : readSettings(dir));
/** The settings LaTeX reads at each compilation, several times: read from the file again once the interface writes it. */
let latexParams: RenderParams | null = null;
const currentParams = (): RenderParams => (latexParams ??= withOverrides(settings()));
ipcMain.handle('cirrus:settings:get', () => settings());
ipcMain.handle('cirrus:settings:set', (_e, overrides: Record<string, unknown>) => {
  if (!bench) writeSettings(dir, overrides);
  latexParams = null;
});
/** The largest file an import takes, in bytes (setting maxImportMb). */
const maxImportBytes = () => withOverrides(settings()).maxImportMb * 2 ** 20;
// Files dropped on a node or chosen in the dialog, copied into the store before an action refers to them (plan 4a, D6).
// The preload passes on only the paths of files dropped in the page (I1 of the review).
ipcMain.handle('cirrus:files:import', (_e, paths: unknown) =>
  importPaths(dir, Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [], maxImportBytes()));
ipcMain.handle('cirrus:files:pick', async (e) => {
  const chosen = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { properties: ['openFile', 'multiSelections'] });
  return chosen.canceled ? { refs: [], refused: [] } : importPaths(dir, chosen.filePaths, maxImportBytes());
});
// A .tex typed in its full screen (plan 4b, D6), stored before the action that refers to it; a name or a size refused
// rejects with its reason, in French.
ipcMain.handle('cirrus:files:store-text', (_e, name: unknown, text: unknown) => storeText(dir, name, text, maxImportBytes()));
// A file opened by the system's application, on a read-only copy; a program or a script is shown in the explorer
// instead, never run (plan 4a, D5). Failures reach the user in French, their cause in the console.
ipcMain.handle('cirrus:files:open', async (_e, ref: FileRef) => {
  const name = typeof ref?.name === 'string' ? ref.name : '';
  try {
    const { path, shown } = openTarget(dir, ref, copies);
    if (shown === 'folder') shell.showItemInFolder(path);
    else {
      const error = await shell.openPath(path);
      if (error) {
        console.error(`Ouverture de « ${name} » : ${error}`);
        return { ok: false, message: openFailure(name, error) };
      }
    }
    return { ok: true, shown };
  } catch (e) {
    console.error(`Ouverture de « ${name} » :`, e);
    return { ok: false, message: openFailure(name, e) };
  }
});
// A link clicked in a PDF (plan 4a, task 6): its address goes to the system's handler (the browser, the mail client)
// only in http:, https: or mailto: (externalUrlAllowed), checked here whatever the interface did; any other is refused.
ipcMain.handle('cirrus:open-url', async (_e, url: unknown) => {
  if (typeof url !== 'string' || !externalUrlAllowed(url)) {
    console.warn(`Lien refusé : ${String(url).slice(0, 200)}`);
    return;
  }
  try {
    await shell.openExternal(url);
  } catch (e) {
    console.error(`Ouverture du lien ${url} :`, e);
  }
});
ipcMain.handle('cirrus:history', (_e, id: Id) => historySummary(store!.historyOf(id)));
// An edit computed by the interface (spec 4: only this process writes), each "before" checked against the base. A
// conflicting record refuses it. Returns the journal number of its last line.
ipcMain.handle('cirrus:commit', (_e, action: Action) => {
  try {
    return store!.commit(action);
  } catch (e) {
    if (e instanceof OpConflictError) throw new Error('La base a changé : action refusée.');
    throw e;
  }
});
/** Every process's private memory, the collections of this one forced first (the interface forced its own). */
const processMemory = () => { forceGc(); return processMemoryMb(app.getAppMetrics()); };
ipcMain.handle('cirrus:bench:memory', () => processMemory());
// The pass is over: its load phases since this process started and every process's memory.
ipcMain.handle('cirrus:bench:done', (_e, run: Omit<PassRecord, 'phases' | 'processMb'>) => {
  const record: PassRecord = { ...run, phases: loadPhases({ ...benchMarks, ...run.marks }, performance.timeOrigin), processMb: processMemory() };
  const report = recordRun(join(app.getAppPath(), '..', '..', 'docs', 'bancs'), record, process.env.CIRRUS_BENCH_FINAL === '1', bench!);
  if (report) console.log(`Rapport écrit : ${report}`);
  exitAfterLatex(0);
});
// LaTeX (plan 4b, D2, D8): the interface sends what the source needs; the request's form is checked here whatever the
// interface did (strings, lists, a source of textViewMaxMb at most, resources of plain names present in the store).
ipcMain.handle('cirrus:latex:compile', (_e, req: unknown) => {
  const why = invalidRequest(req, dir, currentParams().textViewMaxMb * 2 ** 20);
  if (why !== null || !latexSetup) {
    console.warn(`Compilation LaTeX refusée : ${why ?? 'base non ouverte'}`);
    return INVALID_REQUEST;
  }
  return latexSetup.compile(req as CompileRequest);
});
ipcMain.on('cirrus:latex:cancel', (_e, slot: unknown) => { if (typeof slot === 'string') latexSetup?.cancel(slot); });
ipcMain.on('cirrus:latex:warm', (_e, preamble: unknown) => { if (typeof preamble === 'string') latex?.warm(preamble); });
ipcMain.handle('cirrus:latex:status:get', () => latexSetup?.state() ?? { state: 'absent' });
// TinyTeX's installation (D1, task 7): only this call, which the user's « Installer » makes, downloads it.
ipcMain.handle('cirrus:latex:install', () => latexSetup?.install());

/**
 * A publication's network (plan 4c, D5, D6): Electron's stack (its proxy, its certificates), by net.request, whose
 * redirects fetch.ts follows by hand. On a test base out of the user's way (CIRRUS_DATA, in capture mode or with
 * CIRRUS_BACKGROUND=1), CIRRUS_PUBLICATIONS_REPLAY names recorded answers instead (replay.ts): the interface's scenarios
 * and the captures import without the network. Never on the user's own base, where the variable is ignored.
 */
const publicationsReplay = replayDirOf(process.env, capture !== undefined);
if (process.env.CIRRUS_PUBLICATIONS_REPLAY && !publicationsReplay) {
  console.warn('CIRRUS_PUBLICATIONS_REPLAY ignoré : seulement sur une base de test (CIRRUS_DATA), en capture ou en arrière-plan.');
}
const publicationsFetch: FetchFn = publicationsReplay ? replayFetch(publicationsReplay) : requestFetch((options) => net.request(options));
// A publication's import (plan 4c, task 4), which the user's import makes (task 5): the only call that reaches the
// network for it, never at startup nor in the background. The text is checked here whatever the interface did (a
// string parseIdentifier reads); the answers within publicationMaxKb and publicationTimeoutMs, the PDF within
// maxImportMb, stored before any action refers to it; `{ pdf: false }` leaves it out (a PDF dropped in the dialog, task 5).
ipcMain.handle('cirrus:publications:fetch', (_e, text: unknown, options: unknown) => {
  if (!store) return { ok: false, message: 'La base n’est pas ouverte.' };
  const p = currentParams();
  return importPublication(text, {
    fetch: publicationsFetch, store: (name, bytes) => storeBytes(dir, name, bytes),
    maxKb: p.publicationMaxKb, maxPdfBytes: p.maxImportMb * 2 ** 20, timeoutMs: p.publicationTimeoutMs,
    log: (m) => console.warn(m),
  }, options);
});

/**
 * A base that cannot be opened (damaged, disk full, folder not writable): said, and the app quits rather than staying
 * without a window, holding the locks that would drop the next launches. Measuring runs have no one to click the box.
 */
function failOpen(e: unknown): void {
  const message = `La base de Cirrus ne peut pas être ouverte : ${dir}\n\n${e instanceof Error ? e.message : String(e)}`;
  if (bench || capture) console.error(message);
  else dialog.showErrorBox('Cirrus', message);
  lock?.release();
  app.exit(2);
}

void app.whenReady().then(() => {
  if (!first) return;
  if (benchBuild) {
    // The bench's base (scripts/bench.mjs): built once per generator version and scale, then copied for each pass.
    const [nodes, connections] = (bench ?? '50000,500000').split(',').map(Number);
    const t0 = performance.now();
    try {
      const built = ensureBenchBase(benchBuild, { seed: 1, nodes, connections });
      console.log(built ? `Base du banc écrite en ${((performance.now() - t0) / 1000).toFixed(1)} s : ${benchBuild}` : `Base du banc à jour : ${benchBuild}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      app.exit(2);
      return;
    }
    app.exit(0);
    return;
  }
  try {
    dir = dataDir(app.getPath('userData'), bench !== undefined || capture !== undefined);
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    app.exit(2);
    return;
  }
  try {
    lock = lockBase(dir);
  } catch (e) {
    failOpen(e);
    return;
  }
  if (!lock) {
    console.error(`Base déjà ouverte par une autre instance de Cirrus (une capture, le banc ou une autre fenêtre) : ${dir}. Cette instance s’arrête.`);
    app.exit(2);
    return;
  }
  if (benchSnapshots) {
    // The base file over snapshot rewrites (plan 3c task 10, M3 of the final review), on the bench's copy of its base.
    try {
      const growth = snapshotRewrites(dir, Number(benchSnapshots));
      recordSnapshots(join(app.getAppPath(), '..', '..', 'docs', 'bancs'), growth);
      console.log(`Réécritures de l’instantané : ${growth.sizes.map((x) => `${x.step} ${x.dbMb.toFixed(1)} + ${x.walMb.toFixed(1)} Mo`).join(' ; ')}`);
    } catch (e) {
      console.error(e instanceof Error ? e.message : String(e));
      app.exit(2);
      return;
    }
    lock.release();
    app.exit(0);
    return;
  }
  try {
    store = openBase(dir);
  } catch (e) {
    failOpen(e);
    return;
  }
  markNow('baseOpened');
  const latexRoot = join(dir, 'latex'), latexCache = join(latexRoot, 'cache');
  const cacheBytes = () => currentParams().latexCacheMb * 2 ** 20;
  const cache = new PdfCache(latexCache, cacheBytes, () => (cacheBytes() * currentParams().latexCacheTrimPercent) / 100);
  // The cache's folder listed in the background, while the window loads (final review, I3).
  void cache.load().catch((e: unknown) => console.warn('Cache LaTeX non listé :', e));
  latex = new LatexService({ binaries: texBinaries, root: latexRoot, store: dir, params: currentParams, cache });
  // tlmgr, TinyTeX's installer and pdflatex --version under latexTlmgrTimeoutMs: a network that hangs never holds the
  // packages' queue (task 7). The download goes through Electron's network stack (its proxy, its certificates).
  const toolRun: Deps['run'] = (file, args) => runFile(file, args, currentParams().latexTlmgrTimeoutMs);
  latexSetup = new LatexSetup({
    service: latex, binaries: texBinaries, params: currentParams,
    provision: async (onProgress) => provision(tinyTexRoot(process.env), {
      download: fetchDownload((url, init) => net.fetch(url, init), () => currentParams().latexDownloadStallMs), run: toolRun,
    }, onProgress),
    packages: (bins) => new Packages(bins, toolRun),
    status: (s) => { for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cirrus:latex:status', s); },
  });
  protocol.handle(FILE_SCHEME, (request) => fileResponse(dir, latexCache, request));
  createWindow();
  // The copies of earlier sessions, while the window loads; measuring runs leave the user's alone.
  if (!bench && !capture) cleanCopies(copies);
});
// The base's lock is released once every pdfLaTeX is gone: the next instance empties the service's folders.
let latexDisposed = false;
app.on('window-all-closed', () => {
  void (latex?.dispose() ?? Promise.resolve()).finally(() => {
    latexDisposed = true;
    store?.close();
    lock?.release();
    app.quit();
  });
});
// No pdfLaTeX outlives the app, however it quits: will-quit waits for every one to be killed and gone.
app.on('will-quit', (e) => {
  if (!latex || latexDisposed) return;
  e.preventDefault();
  void latex.dispose().finally(() => {
    latexDisposed = true;
    app.quit();
  });
});
