import { app, BrowserWindow, ipcMain, screen } from 'electron';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// BENCH_UNCAPPED=1: no vsync and no frame cap, so frame intervals expose the real GPU time.
if (process.env.BENCH_UNCAPPED === '1') {
  app.commandLine.appendSwitch('disable-gpu-vsync');
  app.commandLine.appendSwitch('disable-frame-rate-limit');
}
app.commandLine.appendSwitch('force_high_performance_gpu');

const reportsDir = () => join(app.getAppPath(), '..', '..', 'docs', 'bancs');
let win: BrowserWindow | null = null;

function createWindow(): void {
  // Measure on the laptop's own panel (2560x1600, 165 Hz, spec 21), not on an external primary monitor.
  const display = screen.getAllDisplays().find((d) => d.internal) ?? screen.getPrimaryDisplay();
  win = new BrowserWindow({
    ...display.bounds,
    fullscreen: true,
    backgroundColor: '#0a1120',
    show: false,
    webPreferences: {
      preload: join(app.getAppPath(), 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.once('ready-to-show', () => win?.show());
  const query = process.env.BENCH_QUERY ?? '';
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(`${process.env.ELECTRON_RENDERER_URL}?${query}`);
  else void win.loadFile(join(app.getAppPath(), 'out', 'renderer', 'index.html'), { search: query });

  if (process.env.BENCH_LOG === '1') {
    win.webContents.on('console-message', (e) => console.log(`[renderer] ${e.message}`));
    for (const d of screen.getAllDisplays()) {
      console.log(`[display] ${d.id} ${d.size.width}x${d.size.height} scale ${d.scaleFactor} ${d.displayFrequency} Hz internal=${d.internal} primary=${d.id === screen.getPrimaryDisplay().id}`);
    }
  }
  // BENCH_CAPTURE=<name>: capture after BENCH_CAPTURE_MS (default 8 s) and quit — for unattended visual checks.
  if (process.env.BENCH_CAPTURE) {
    const name = process.env.BENCH_CAPTURE;
    setTimeout(() => {
      void win!.webContents.capturePage().then((img) => {
        mkdirSync(reportsDir(), { recursive: true });
        writeFileSync(join(reportsDir(), `${name}.png`), img.toPNG());
        app.quit();
      });
    }, Number(process.env.BENCH_CAPTURE_MS ?? 8000));
  }
  // F12: capture the window for the visual check.
  win.webContents.on('before-input-event', (_e, input) => {
    if (input.type === 'keyDown' && input.key === 'F12' && win) {
      void win.webContents.capturePage().then((img) => {
        mkdirSync(reportsDir(), { recursive: true });
        writeFileSync(join(reportsDir(), 'rendu-capture.png'), img.toPNG());
      });
    }
  });
}

ipcMain.handle('bench:saveReport', (_e, name: string, json: string, markdown: string) => {
  mkdirSync(reportsDir(), { recursive: true });
  writeFileSync(join(reportsDir(), `${name}.json`), json, 'utf8');
  writeFileSync(join(reportsDir(), `${name}.md`), markdown, 'utf8');
});

ipcMain.handle('bench:setCpuThrottle', async (_e, rate: number) => {
  const dbg = win!.webContents.debugger;
  if (!dbg.isAttached()) dbg.attach('1.3');
  await dbg.sendCommand('Emulation.setCPUThrottlingRate', { rate });
});

ipcMain.on('bench:quit', () => app.quit());

void app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
