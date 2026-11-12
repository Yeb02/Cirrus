import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import type { RenderParams } from '@cirrus/view';
import type { SyncHost } from '../sync/host.ts';
import { updateModeOf } from './key.ts';
import { type FeedUpdater, type TriedStore, Updater } from './updater.ts';

/** The file of the app's folder (userData) that keeps the version whose install was started (updater.ts: TriedStore). */
const TRIED_FILE = 'mise-a-jour-tentee.txt';

/** The version whose install was started, in `dir` (the app's userData; a temporary profile in the scripts' runs). */
function triedIn(dir: string): TriedStore {
  const file = join(dir, TRIED_FILE);
  return {
    read: () => {
      try {
        return readFileSync(file, 'utf8');
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw e;
      }
    },
    write: (version) => writeFileSync(file, version, 'utf8'),
    clear: () => rmSync(file, { force: true }),
  };
}

// The signed updates' wires to Electron (plan 9, D4): the app's version and variant, the key, the sync host (its
// network, its token, its chip), electron-updater — loaded the first time an update is to be downloaded, in a chunk of
// its own, never at the start — the window's closing once an update is armed (the forced update), the app's quit, at
// which an armed update is installed, and the file of the app's folder that keeps the version whose install started. Everything else is updater.ts's and key.ts's, which the tests run without
// Electron.

/**
 * The updater of this app, its sync host given: started, its periodic check running. Its mode is key.ts's
 * (updateModeOf): « Cirrus Dev » (`dev`, identity.ts) never updates but for the end-to-end check, and a test key, on
 * any variant, never installs.
 */
export function wireUpdater(o: {
  host: SyncHost; dev: boolean; params: () => RenderParams; env: Record<string, string | undefined>; capture: boolean;
  /** The app's folder (userData, read by index.ts once its identity is given), where the version tried is kept. */
  appDir: string;
}): Updater {
  const { host } = o, mode = updateModeOf(o.env, o.capture, o.dev);
  const updater = new Updater({
    version: app.getVersion(),
    dev: mode.dev,
    // npm run dev never updates (review of the forced update, I3).
    packaged: app.isPackaged,
    tried: triedIn(o.appDir),
    neverInstall: mode.neverInstall,
    publicKey: mode.publicKey,
    fetchFile: (name) => host.versionFile(name),
    server: () => host.updateServer(),
    connected: () => host.connected(),
    params: o.params,
    // Windows' (NSIS): the only installer Cirrus builds (electron-builder.yml).
    updater: async (): Promise<FeedUpdater> => {
      const { autoUpdater, NsisUpdater } = await import('electron-updater');
      if (!(autoUpdater instanceof NsisUpdater)) throw new Error('les mises à jour ne se font que sous Windows (NSIS)');
      return autoUpdater;
    },
    tell: (word) => host.updateWord(word),
    // The forced update armed: the window closed as the user would close it (window.ts: cirrus:quit, the interface's
    // last saves), then the app quits (index.ts: window-all-closed) and its « quit » runs the installer.
    restart: () => {
      const windows = BrowserWindow.getAllWindows();
      if (windows.length === 0) app.quit();
      for (const w of windows) w.close();
    },
  });
  // Electron's « quit », with the exit code: the moment electron-updater itself installs at (ElectronAppAdapter.onQuit).
  app.on('quit', (_e, exitCode) => updater.quit(exitCode));
  return updater;
}
