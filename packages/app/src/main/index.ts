import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { type Action, OpConflictError, type State, toSnapshot } from '@cirrus/core';
import { buildLargeState } from '@cirrus/fixtures';
import type { LocalStore } from '@cirrus/store';
import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { dataDir, openBase } from './base.ts';
import { recordRun } from './bench.ts';
import { readSettings, writeSettings } from './settings.ts';

/**
 * The main process: the only one that touches the disk (spec 4). It opens the base and the settings, and answers the
 * interface over IPC. CIRRUS_CAPTURE=<png> captures the window once the first frame is drawn, then quits (visual checks).
 * CIRRUS_BENCH=<nodes>,<connections> serves a synthetic base instead and runs the rendering bench (scripts/bench.mjs).
 */
let store: LocalStore | null = null;
let benchState: State | null = null;
let dir = '';
const capture = process.env.CIRRUS_CAPTURE;
const bench = process.env.CIRRUS_BENCH;
const launch = {
  plan: process.env.CIRRUS_PLAN,
  view: process.env.CIRRUS_VIEW,
  hover: process.env.CIRRUS_HOVER,
  panel: process.env.CIRRUS_PANEL === '1',
  bench: bench ? (process.env.CIRRUS_BENCH_LABEL ?? 'vsync') : undefined,
  hide: process.env.CIRRUS_BENCH_HIDE,
  keys: process.env.CIRRUS_KEYS,
};
if (bench) app.commandLine.appendSwitch('force_high_performance_gpu');

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
      backgroundThrottling: !bench,
      additionalArguments: [`--cirrus-launch=${JSON.stringify(launch)}`],
    },
  });
  win.once('ready-to-show', () => win.show());
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

// As JSON text: a string crosses IPC and the context bridge in one copy; a large object graph took minutes
// (403 s for 50 000 nodes and 500 000 connections, against 1.3 s for a tenth of that).
ipcMain.handle('cirrus:snapshot', () => JSON.stringify(toSnapshot(benchState ?? store!.state)));
// The bench runs on the defaults, or on CIRRUS_BENCH_SETTINGS (a JSON of overrides) to compare one setting.
ipcMain.handle('cirrus:settings:get', () => (bench ? JSON.parse(process.env.CIRRUS_BENCH_SETTINGS ?? '{}') : readSettings(dir)));
ipcMain.handle('cirrus:settings:set', (_e, overrides: Record<string, unknown>) => { if (!bench) writeSettings(dir, overrides); });
// An edit computed by the interface (spec 4: only this process writes). A conflicting record refuses it.
ipcMain.handle('cirrus:commit', (_e, action: Action) => {
  if (!store) throw new Error('Pas de base ouverte (mode banc).');
  try {
    store.commit(action);
  } catch (e) {
    if (e instanceof OpConflictError) throw new Error('La base a changé : action refusée.');
    throw e;
  }
});
ipcMain.handle('cirrus:bench:done', (_e, run) => {
  const report = recordRun(join(app.getAppPath(), '..', '..', 'docs', 'bancs'), run, process.env.CIRRUS_BENCH_FINAL === '1', bench!);
  if (report) console.log(`Rapport écrit : ${report}`);
  app.exit(0);
});

void app.whenReady().then(() => {
  if (bench) {
    const [nodes, connections] = bench.split(',').map(Number);
    benchState = buildLargeState({ seed: 1, nodes, connections }).state;
  } else {
    dir = dataDir(app.getPath('userData'));
    store = openBase(dir);
  }
  createWindow();
});
app.on('window-all-closed', () => {
  store?.close();
  app.quit();
});
