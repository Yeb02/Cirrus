import { existsSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { LocalStore } from '@cirrus/store';
import { type RenderParams, withOverrides } from '@cirrus/view';
import { app, BrowserWindow, dialog, Menu, net, protocol, safeStorage, session } from 'electron';
import { dataDir, openBase, pcId } from './base.ts';
import { markNow, wireBenchMode } from './benchMode.ts';
import { Consultations } from './consultations.ts';
import { cleanCopies, FILE_SCHEME, fileResponse } from './files.ts';
import { appIdentity, applyIdentity, copiesDir } from './identity.ts';
import { wireBase } from './ipc/base.ts';
import { wireConsultations } from './ipc/consultations.ts';
import { wireFiles } from './ipc/files.ts';
import { tellLatexStatus, wireLatex } from './ipc/latex.ts';
import { wirePublications } from './ipc/publications.ts';
import { PdfCache } from './latex/cache.ts';
import { LatexService } from './latex/compiler.ts';
import { LatexSetup } from './latex/setup.ts';
import { type Deps, fetchDownload, findBinaries, Packages, provision, runFile, type TexBinaries, tinyTexRoot } from './latex/tinytex.ts';
import { lockBase } from './lock.ts';
import { refuseAllPermissions } from './permissions.ts';
import { freeBytesOf } from './pick.ts';
import { readSettings } from './settings.ts';
import { fileSecrets } from './sync/config.ts';
import { stagedDir } from './sync/firstSync.ts';
import { SyncHost } from './sync/host.ts';
import { quitsInsteadOfRelaunch, startBase } from './sync/swap.ts';
import { appWindows, tokenCipher, wireSync } from './sync/wire.ts';
import type { Updater } from './update/updater.ts';
import { wireUpdater } from './update/wire.ts';
import { createWindow } from './window.ts';

/**
 * The main process: the only one that touches the disk (spec 4). It opens the base and the settings, and answers the
 * interface over IPC; it keeps no copy of the state (plan 3c, decision 3), the interface does. It serves the nodes' files
 * by the cirrus-file: protocol, imports them and opens their copies (files.ts, plan 4a). It compiles LaTeX, the PDFs
 * served by the same protocol, and installs TinyTeX when the user asks, then the packages it misses (latex/, plan 4b).
 * It fetches a publication's metadata, and an arXiv article's PDF, when the user imports one (publications/, plan 4c).
 * With a server paired, it syncs the base with it (sync/, plan 5a): the interface reconciles, this process writes.
 * It writes the interface's consultations, in batches, to consultations.db beside the base (plan 6a, D6).
 * Paired, it looks for the official version's update, checks its signature and its installer, and installs it at the
 * app's quit (update/, plan 9, D4).
 * Closing waits, at most snapshotQuitMs, for the interface's last snapshot, and quitting for every pdfLaTeX to exit and
 * for the sync client to stop.
 * This file starts and ends the process; the interface's calls are answered by domain under ipc/ (the sync's in
 * sync/wire.ts), and the window is window.ts's. It first gives the app its identity (identity.ts, plan 9, D3), and
 * refuses the web platform's permissions (permissions.ts, D8).
 * CIRRUS_CAPTURE=<png> captures the window once the first frame is drawn, then quits (visual checks).
 * CIRRUS_BENCH=<nodes>,<connections> runs the rendering bench on the base CIRRUS_DATA names (scripts/bench.mjs), which
 * CIRRUS_BENCH_BUILD=<dir> builds beforehand; with CIRRUS_BENCH_SNAPSHOTS=<n>, the snapshot of that base is rewritten n
 * times instead, without a window, and the file's size recorded. The bench's modules are loaded in that mode only (D8).
 */
/**
 * The app's identity (plan 9, D3), before anything reads userData (the single-instance lock, Chromium's profile, the
 * base): its name, its data folder — %APPDATA%\@cirrus\app for the official app, where the user's base is, its own for
 * « Cirrus Dev » —, its AppUserModelId. A profile given by --user-data-dir (the checks, the captures) is kept; bench and
 * captures then take their own (below).
 */
const identity = appIdentity({ appData: app.getPath('appData') });
applyIdentity(app, identity, { platform: process.platform, userDataGiven: app.commandLine.hasSwitch('user-data-dir') });
let store: LocalStore | null = null;
let dir = '';
/** This PC's identifier (pc.json), once the base is open: it signs the writes. */
let pc = '';
/** The synchronisation (plan 5a), once the base is open: with no server paired, it does nothing. */
let sync: SyncHost | null = null;
/** The consultations' file (plan 6a, D6), once the base is open: created at the first batch. */
let consultations: Consultations | null = null;
/** The signed updates (plan 9, D4: update/), once the sync is made; never in bench or capture mode. */
let updater: Updater | null = null;
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
  // The app and its version (package.json, which the CI completes), said by the rubric « Serveur » (plan 9, D3).
  app: `${identity.name} ${app.getVersion()}`,
};
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
 * beside them, writable, is kept (cleanCopies). One folder per variant (plan 9, D3).
 */
const copies = copiesDir(tmpdir(), identity);
/**
 * One instance per base (I3 of the final review): every base has its lock (lockBase, taken below). On the user's own
 * base (no CIRRUS_DATA, neither bench nor capture), Electron's lock too, which is per profile: a second launch shows the
 * first one's window and quits. Per variant, then (plan 9, D3): « Cirrus Dev » runs beside the official app.
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

/** The settings: the defaults, or on the bench CIRRUS_BENCH_SETTINGS (a JSON of overrides) to compare one setting. */
const settings = (): Record<string, unknown> => (bench ? JSON.parse(process.env.CIRRUS_BENCH_SETTINGS ?? '{}') : readSettings(dir));
/**
 * The settings LaTeX and the sync read, several times: read from the file again once the interface writes it, or the
 * server changes it (task 6).
 */
let latexParams: RenderParams | null = null;
const currentParams = (): RenderParams => (latexParams ??= withOverrides(settings()));

// The interface's calls, by domain (ipc/): read when it makes them, once the base is open; the synchronisation's are
// wired with its host, below (sync/wire.ts).
wireBase({
  store: () => store, sync: () => sync, pc: () => pc, settings, settingsWritten: () => { latexParams = null; }, bench: Boolean(bench),
});
wireFiles({ dir: () => dir, sync: () => sync, settings, copies, capture: capture !== undefined, background });
// The bench's calls, in bench mode only, their module and @cirrus/fixtures loaded then (plan 9, D8): long before the
// pass's end asks for them.
wireBenchMode(bench, exitAfterLatex, () => import('./ipc/bench.ts')).catch((e: unknown) => {
  console.error('Banc non branché :', e);
  exitAfterLatex(2);
});
wireLatex({ params: currentParams, latex: () => latex, setup: () => latexSetup });
wirePublications({ dir: () => dir, store: () => store, params: currentParams, sync: () => sync, capture: capture !== undefined });
wireConsultations({ consultations: () => consultations });

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

/**
 * A base taken from the server (plan 5a, D7) makes the app start again on it. With CIRRUS_NO_RELAUNCH=1 it only quits
 * (R27): the interface's checks (scripts/interface.mjs) start it again themselves, in their window out of the user's
 * way, so that no instance escapes them. Taken only on a test base in such a window (quitsInsteadOfRelaunch); it can
 * only turn a relaunch into a quit, and does nothing otherwise.
 */
const noRelaunch = quitsInsteadOfRelaunch(process.env, capture !== undefined);
if (process.env.CIRRUS_NO_RELAUNCH && !noRelaunch) {
  console.warn('CIRRUS_NO_RELAUNCH ignoré : seulement sur une base de test (CIRRUS_DATA), en capture ou en arrière-plan.');
}

void app.whenReady().then(() => {
  // No menu (plan 6a, fix round 1): Electron's default one, hidden by autoHideMenuBar, came back as a bar when Alt was
  // released after Alt+← or an Alt+drag. The app uses none of its shortcuts (window.ts gives back two in development).
  Menu.setApplicationMenu(null);
  // No permission of the web platform (plan 9, D8): Cirrus asks for none.
  refuseAllPermissions(session.defaultSession);
  if (!first) return;
  if (benchBuild) {
    // The bench's base (scripts/bench.mjs): built once per generator version and scale, then copied for each pass. Its
    // module, with @cirrus/fixtures, loaded in this mode only (D8).
    const [nodes, connections] = (bench ?? '50000,500000').split(',').map(Number);
    const t0 = performance.now();
    void import('./bench.ts').then(({ ensureBenchBase }) => {
      const built = ensureBenchBase(benchBuild, { seed: 1, nodes, connections });
      console.log(built ? `Base du banc écrite en ${((performance.now() - t0) / 1000).toFixed(1)} s : ${benchBuild}` : `Base du banc à jour : ${benchBuild}`);
      app.exit(0);
    }).catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      app.exit(2);
    });
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
  // A base taken from the server by the last run (plan 5a, D7, R17), staged beside this one: swapped in before the base
  // opens, while no other instance holds it (the lock just taken, then let go for the renames: the lock file is inside
  // the folder). One stat when there is none.
  // A swap that failed and left no base at its place stops the start, saying where the bases are: a new empty base is
  // never opened there (review of task 5, Important 2). One that left the old base opens it; the interface says that a
  // base waits (SyncHost.info).
  if (lock && existsSync(stagedDir(dir))) {
    lock.release();
    const start = startBase(dir);
    if (!start.open) {
      failOpen(new Error(start.message));
      return;
    }
    if (start.log) console.warn(start.log);
    try {
      lock = lockBase(dir);
    } catch (e) {
      failOpen(e);
      return;
    }
  }
  if (!lock) {
    console.error(`Base déjà ouverte par une autre instance de Cirrus (une capture, le banc ou une autre fenêtre) : ${dir}. Cette instance s’arrête.`);
    app.exit(2);
    return;
  }
  if (benchSnapshots) {
    // The base file over snapshot rewrites (plan 3c task 10, M3 of the final review), on the bench's copy of its base.
    const held = lock;
    void import('./bench.ts').then(({ recordSnapshots, snapshotRewrites }) => {
      const growth = snapshotRewrites(dir, Number(benchSnapshots));
      recordSnapshots(join(app.getAppPath(), '..', '..', 'docs', 'bancs'), growth);
      console.log(`Réécritures de l’instantané : ${growth.sizes.map((x) => `${x.step} ${x.dbMb.toFixed(1)} + ${x.walMb.toFixed(1)} Mo`).join(' ; ')}`);
      held.release();
      app.exit(0);
    }).catch((e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      app.exit(2);
    });
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
    status: tellLatexStatus,
  });
  // The synchronisation (plan 5a): its client starts once the interface holds its state (cirrus:sync:start), if a server
  // is paired; the token kept by safeStorage (DPAPI), never in clear.
  pc = pcId(dir);
  consultations = Consultations.open(dir, pc);
  sync = new SyncHost({
    fetch: (url, init) => net.fetch(String(url), init), store, dir, pc, secrets: fileSecrets(dir, tokenCipher), secretsAt: (d) => fileSecrets(d, tokenCipher),
    canEncrypt: () => safeStorage.isEncryptionAvailable(), params: currentParams, now: Date.now, machineName: hostname(),
    // A test base's free space fixed for the captures (CIRRUS_FREE_BYTES, plan 5b, task 8); the disk's otherwise.
    freeBytes: freeBytesOf(process.env, capture !== undefined),
    // Shared settings received (task 6): read again by what reads them here, and told to the interface.
    window: { ...appWindows, settings: (changes) => { latexParams = null; appWindows.settings(changes); } },
    // A base taken from the server (D7): the app quits as it does (the last snapshot, the sync stopped, the base closed),
    // then starts again, and swaps it in before it opens; only quits for the interface's checks (noRelaunch, R27). An
    // update armed is not installed at this quit: its installer would close the app starting again (plan 9, D4).
    relaunch: () => {
      updater?.disarm();
      if (!noRelaunch) app.relaunch();
      app.quit();
    },
    // What each hello says of the versions, to the updater (plan 9, D4).
    update: { hello: (version) => { void updater?.heard(version); }, refused: () => { void updater?.formatRefused(); } },
  });
  wireSync(sync);
  if (!capture && !bench) updater = wireUpdater({ host: sync, dev: identity.dev, params: currentParams, env: process.env, capture: false });
  // A blob absent from the store is asked of the server, with one paired (D6); a thumbnail's never.
  protocol.handle(FILE_SCHEME, (request) => fileResponse(dir, latexCache, request, sync?.blobFetcher() ?? null));
  createWindow({
    launch, bench, capture, background, baseOpen: () => store !== null, snapshotQuitMs: () => withOverrides(settings()).snapshotQuitMs,
    sync, latexSetup: () => latexSetup, exit: exitAfterLatex,
  });
  // The copies of earlier sessions, while the window loads; measuring runs leave the user's alone.
  if (!bench && !capture) cleanCopies(copies);
});
// The base's lock is released once every pdfLaTeX is gone, and the sync client stopped (nothing writes the base any
// more): the next instance empties the service's folders.
let latexDisposed = false;
app.on('window-all-closed', () => {
  const syncStopped = (sync?.close() ?? Promise.resolve()).catch((e: unknown) => console.error('Arrêt de la synchronisation :', e));
  void Promise.all([latex?.dispose() ?? Promise.resolve(), syncStopped]).finally(() => {
    latexDisposed = true;
    store?.close();
    consultations?.close();
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
