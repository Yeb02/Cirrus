import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { captureWhenReady } from './ipc/bench.ts';
import type { LatexSetup } from './latex/setup.ts';
import { navigationAllowed } from './navigation.ts';
import { type SyncHost, watchWindow } from './sync/host.ts';

/** What the window takes of the process (index.ts). */
interface WindowDeps {
  /** The options the interface reads at launch (the preload's `launch`). */
  launch: object;
  /** CIRRUS_BENCH and CIRRUS_CAPTURE, as the process read them. */
  bench: string | undefined;
  capture: string | undefined;
  /** Out of the user's way: captures, and the interface's checks (CIRRUS_BACKGROUND=1). */
  background: boolean;
  /** Whether the base is open: closing then waits for the interface's last snapshot. */
  baseOpen(): boolean;
  /** How long closing waits for it at most (snapshotQuitMs), read when the window closes. */
  snapshotQuitMs(): number;
  /** The synchronisation, once the base is open. */
  sync: SyncHost | null;
  /** LaTeX's state and installation (task 7), once the base is open. */
  latexSetup(): LatexSetup | null;
  /** Quits once every pdfLaTeX has exited (a capture taken). */
  exit(code: number): void;
}

/**
 * The app's window (there is one): its size and place — the laptop's own panel, full screen, for the bench; beyond the
 * screens for captures and checks —, its closing, which waits for the interface's last snapshot, and its page, which
 * it never leaves.
 */
export function createWindow(deps: WindowDeps): void {
  const { launch, bench, capture, background, sync } = deps;
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
  // Windows' « Précédent » et « Suivant » (plan 6a, D2): the browser keys, and the mouse's side buttons when the system turns
  // them into app commands. The interface acts on them like Alt+← and Alt+→.
  win.on('app-command', (_e, command) => {
    if (command === 'browser-backward' || command === 'browser-forward') win.webContents.send('cirrus:app-command', command);
  });
  // Closing: the interface sends its snapshot (if anything changed) and says so; past snapshotQuitMs, the window closes
  // anyway (the journal has every action). Bench and captures quit by app.exit, without this.
  let closing = false;
  win.on('close', (e) => {
    if (closing || !deps.baseOpen()) return;
    e.preventDefault();
    closing = true;
    const done = () => {
      clearTimeout(timer);
      ipcMain.removeListener('cirrus:quit:ready', done);
      if (!win.isDestroyed()) win.destroy();
    };
    const timer = setTimeout(done, deps.snapshotQuitMs());
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
  // A page gone (closed, reloaded, crashed): the reconciliations it held are abandoned, the sync client tries later.
  if (sync) watchWindow(win, sync);
  if (process.env.ELECTRON_RENDERER_URL) void win.loadURL(process.env.ELECTRON_RENDERER_URL);
  else void win.loadFile(page);
  // The user's LaTeX packages (latexPackages, D1), installed if missing once the window is loaded (task 7), in the
  // background. Measuring runs leave the bench's TinyTeX as it is.
  if (!bench && !capture) win.webContents.on('did-finish-load', () => { void deps.latexSetup()?.ensureAtStart(); });

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
  if (capture) captureWhenReady(win, capture, deps.exit);
}
