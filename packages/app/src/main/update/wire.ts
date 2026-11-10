import { app } from 'electron';
import type { RenderParams } from '@cirrus/view';
import type { SyncHost } from '../sync/host.ts';
import { devUpdatesOf, updateKeyOf } from './key.ts';
import { type FeedUpdater, Updater } from './updater.ts';

// The signed updates' wires to Electron (plan 9, D4): the app's version and variant, the key, the sync host (its
// network, its token, its chip), electron-updater — loaded the first time an update is to be downloaded, in a chunk of
// its own, never at the start — and the app's quit, at which an armed update is installed. Everything else is
// updater.ts's, which the tests run without Electron.

/**
 * The updater of this app, its sync host given: started, its periodic check running. `dev`: « Cirrus Dev » (identity.ts),
 * which never updates — but for the end-to-end check, with its test key, on a test base out of the user's way
 * (key.ts: devUpdatesOf).
 */
export function wireUpdater(o: { host: SyncHost; dev: boolean; params: () => RenderParams; env: Record<string, string | undefined>; capture: boolean }): Updater {
  const { host } = o, testing = devUpdatesOf(o.env, o.capture);
  const updater = new Updater({
    version: app.getVersion(),
    dev: o.dev && !testing,
    // The end-to-end check arms, and never installs.
    neverInstall: testing,
    publicKey: updateKeyOf(o.env, o.capture),
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
  });
  // Electron's « quit », with the exit code: the moment electron-updater itself installs at (ElectronAppAdapter.onQuit).
  app.on('quit', (_e, exitCode) => updater.quit(exitCode));
  return updater;
}
