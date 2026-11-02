import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { toSnapshot } from '@cirrus/core';
import type { LocalStore } from '@cirrus/store';
import { app, BrowserWindow, ipcMain } from 'electron';
import { dataDir, openBase } from './base.ts';
import { readSettings, writeSettings } from './settings.ts';

/**
 * The main process: the only one that touches the disk (spec 4). It opens the base and the settings, and answers the
 * interface over IPC. CIRRUS_CAPTURE=<png> captures the window once the first frame is drawn, then quits (visual checks).
 */
let store: LocalStore | null = null;
let dir = '';
const capture = process.env.CIRRUS_CAPTURE;
const launch = {
  plan: process.env.CIRRUS_PLAN,
  view: process.env.CIRRUS_VIEW,
  hover: process.env.CIRRUS_HOVER,
  panel: process.env.CIRRUS_PANEL === '1',
};

function createWindow(): void {
  const [width, height] = (process.env.CIRRUS_SIZE ?? '1600,1000').split(',').map(Number);
  const win = new BrowserWindow({
    width, height, show: false, title: 'Cirrus', backgroundColor: '#0a1120', autoHideMenuBar: true,
    webPreferences: {
      preload: join(import.meta.dirname, '..', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      additionalArguments: [`--cirrus-launch=${JSON.stringify(launch)}`],
    },
  });
  win.once('ready-to-show', () => win.show());
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(join(import.meta.dirname, '..', 'renderer', 'index.html'));

  if (capture || process.env.CIRRUS_LOG === '1') {
    win.webContents.on('console-message', (e) => console.log(`[interface] ${e.level}: ${e.message}`));
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

ipcMain.handle('cirrus:snapshot', () => toSnapshot(store!.state));
ipcMain.handle('cirrus:settings:get', () => readSettings(dir));
ipcMain.handle('cirrus:settings:set', (_e, overrides: Record<string, unknown>) => writeSettings(dir, overrides));

void app.whenReady().then(() => {
  dir = dataDir(app.getPath('userData'));
  store = openBase(dir);
  createWindow();
});
app.on('window-all-closed', () => {
  store?.close();
  app.quit();
});
