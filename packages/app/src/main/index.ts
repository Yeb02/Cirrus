import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Action, OpConflictError } from '@cirrus/core';
import { forceGc } from '@cirrus/fixtures';
import type { LocalStore } from '@cirrus/store';
import { withOverrides } from '@cirrus/view';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { dataDir, keepSnapshot, loadPayload, openBase, saveSnapshot } from './base.ts';
import { ensureBenchBase, loadPhases, type PassRecord, type Phase, processMemoryMb, recordRun, recordSnapshots, snapshotRewrites } from './bench.ts';
import { lockBase } from './lock.ts';
import { readSettings, writeSettings } from './settings.ts';

/**
 * The main process: the only one that touches the disk (spec 4). It opens the base and the settings, and answers the
 * interface over IPC; it keeps no copy of the state (plan 3c, decision 3), the interface does. Closing waits, at most
 * snapshotQuitMs, for the interface's last snapshot. CIRRUS_CAPTURE=<png> captures the window once the first frame is
 * drawn, then quits (visual checks).
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

function createWindow(): void {
  const [width, height] = (process.env.CIRRUS_SIZE ?? '1600,1000').split(',').map(Number);
  // The bench measures on the laptop's own panel, full screen (spec 21), like the plan 1 bench.
  const display = bench ? (screen.getAllDisplays().find((d) => d.internal) ?? screen.getPrimaryDisplay()) : null;
  const win = new BrowserWindow({
    ...(display ? { ...display.bounds, fullscreen: true } : { width, height }),
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
  win.once('ready-to-show', () => win.show());
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
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'));

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
        app.exit(code);
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
ipcMain.handle('cirrus:settings:get', () => settings());
ipcMain.handle('cirrus:settings:set', (_e, overrides: Record<string, unknown>) => { if (!bench) writeSettings(dir, overrides); });
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
  app.exit(0);
});

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
  lock = lockBase(dir);
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
  store = openBase(dir);
  markNow('baseOpened');
  createWindow();
});
app.on('window-all-closed', () => {
  store?.close();
  lock?.release();
  app.quit();
});
