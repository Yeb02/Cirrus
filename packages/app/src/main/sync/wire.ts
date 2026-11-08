import { BrowserWindow, ipcMain, powerMonitor, safeStorage } from 'electron';
import type { SyncStatus } from './client.ts';
import type { TokenCipher } from './config.ts';
import type { HostWindow, ReconcileOutcome, SyncHost, SyncIncoming } from './host.ts';

// The synchronisation's wires to Electron (plan 5a, task 4): its IPC, the window it speaks to, the token's encryption
// (safeStorage, DPAPI) and sleep (powerMonitor). Everything else is SyncHost's (host.ts), which the tests run without
// Electron.

/** The token encrypted by Windows for this user (D3): serveur.json never holds it in clear. */
export const tokenCipher: TokenCipher = {
  encrypt: (text) => safeStorage.encryptString(text),
  decrypt: (data) => safeStorage.decryptString(data),
};

/** Every window open (there is one): the host's messages. Without one, `incoming` says so, and the client tries later. */
export const appWindows: HostWindow = {
  incoming: (m: SyncIncoming) => send('cirrus:sync:incoming', m),
  status: (s: SyncStatus) => { send('cirrus:sync:status', s); },
  veil: () => { send('cirrus:sync:veil'); },
};

function send(channel: string, ...args: unknown[]): boolean {
  let sent = false;
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed() || w.webContents.isDestroyed()) continue;
    w.webContents.send(channel, ...args);
    sent = true;
  }
  return sent;
}

/**
 * The interface's calls (preload: syncStart, syncRetry, syncReconciled, syncPending, syncServer, syncStatus, syncPair,
 * syncUnpair), and sleep: `suspend` sends what is pending (syncSuspendFlushMs), `resume` brings the veil and a new
 * connection. A window whose page goes away (closed, reloaded, crashed) has its reconciliations rejected (detach).
 */
export function wireSync(host: SyncHost): void {
  ipcMain.handle('cirrus:sync:start', () => host.start());
  ipcMain.on('cirrus:sync:retry', () => host.retry());
  ipcMain.handle('cirrus:sync:reconciled', (_e, id: unknown, outcome: unknown) => host.reconciled(Number(id), outcome as ReconcileOutcome));
  ipcMain.handle('cirrus:sync:pending', () => host.pending());
  ipcMain.handle('cirrus:sync:server', () => host.info());
  ipcMain.handle('cirrus:sync:status:get', () => host.status());
  ipcMain.handle('cirrus:sync:pair', (_e, url: unknown, code: unknown, name: unknown) => host.pair(url, code, name));
  ipcMain.handle('cirrus:sync:unpair', () => host.unpair());
  powerMonitor.on('suspend', () => { void host.suspend(); });
  powerMonitor.on('resume', () => { void host.resume(); });
}

/** A window's page gone or replaced: what it was reconciling is abandoned (the client tries again later). */
export function watchWindow(win: BrowserWindow, host: SyncHost): void {
  win.on('closed', () => host.detach());
  win.webContents.on('render-process-gone', () => host.detach());
  win.webContents.on('did-start-navigation', (e) => { if (e.isMainFrame && !e.isSameDocument) host.detach(); });
}
