import { BrowserWindow, ipcMain, powerMonitor, safeStorage } from 'electron';
import type { TokenCipher } from './config.ts';
import type { HostWindow, SyncHost } from './host.ts';
import type { ReconcileOutcome, ServerInfo, SyncIncoming, SyncStatus } from './protocol.ts';

// The synchronisation's wires to Electron (plan 5a, task 4): its IPC, the window it speaks to, the token's encryption
// (safeStorage, DPAPI) and sleep (powerMonitor). Everything else is SyncHost's (host.ts, watchWindow too), which the
// tests run without Electron.

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
  settings: (changes: Record<string, unknown>) => { send('cirrus:settings:changed', changes); },
  server: (info: ServerInfo) => { send('cirrus:sync:server', info); },
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
 * The interface's calls (preload: syncStart, syncRetry, syncReconciled, syncPending, syncServer, syncPair, syncFirst,
 * syncUnpair), and sleep: `suspend` sends what is pending (syncSuspendFlushMs), `resume` brings the veil and a new
 * connection. A window whose page goes away (closed, reloaded, crashed) has its reconciliations rejected (detach).
 */
export function wireSync(host: SyncHost): void {
  ipcMain.handle('cirrus:sync:start', () => host.start());
  ipcMain.on('cirrus:sync:retry', () => host.retry());
  ipcMain.handle('cirrus:sync:reconciled', (_e, id: unknown, outcome: unknown) => host.reconciled(Number(id), outcome as ReconcileOutcome));
  ipcMain.handle('cirrus:sync:pending', () => host.pending());
  // Asked (:get), as cirrus:latex:status:get; cirrus:sync:server is the main process's message (appWindows.server).
  ipcMain.handle('cirrus:sync:server:get', () => host.info());
  ipcMain.handle('cirrus:sync:pair', (_e, url: unknown, code: unknown, name: unknown) => host.pair(url, code, name));
  ipcMain.handle('cirrus:sync:first', (_e, choice: unknown) => host.first(choice));
  ipcMain.handle('cirrus:sync:unpair', () => host.unpair());
  powerMonitor.on('suspend', () => { void host.suspend(); });
  powerMonitor.on('resume', () => { void host.resume(); });
}

