import { join } from 'node:path';

/**
 * The app's identity (plan 9, D3). Two builds of the same code: the official app, « Cirrus », and « Cirrus Dev »
 * (`npm run paquet:dev`), which has its own name, appId, data folder — so its own base, Chromium profile and
 * single-instance lock — and icon, and so can never touch the user's data. They share TinyTeX (latex/tinytex.ts).
 * This module stays out of Electron: index.ts hands it the app.
 */
export type Variant = 'official' | 'dev';

export interface AppIdentity {
  /** The app's name (app.setName), its installer's and its executable's. */
  name: 'Cirrus' | 'Cirrus Dev';
  /** Windows' AppUserModelId, electron-builder's appId: the taskbar, the shortcuts, the installation's registry key. */
  appId: string;
  /** The data folder: the base under it (base.ts), Chromium's profile, the single-instance lock. */
  userData: string;
  dev: boolean;
}

/** Defined by electron-vite at the build (electron.vite.config.ts: `--mode dev` makes « Cirrus Dev »); absent in the tests. */
declare const CIRRUS_VARIANT: string | undefined;
/** The variant this build is: the official one wherever nothing was defined. */
export const BUILT_VARIANT: Variant = typeof CIRRUS_VARIANT !== 'undefined' && CIRRUS_VARIANT === 'dev' ? 'dev' : 'official';

/**
 * The identity of a variant (by default, this build's), `appData` being Electron's (%APPDATA%). The official app keeps
 * %APPDATA%\@cirrus\app: the folder Electron gave it while it was named after its package, « @cirrus/app », where the
 * user's base already is. A name of its own would otherwise have moved it, and the base would have seemed gone.
 */
export function appIdentity(env: { appData: string; variant?: Variant }): AppIdentity {
  const dev = (env.variant ?? BUILT_VARIANT) === 'dev';
  return dev
    ? { name: 'Cirrus Dev', appId: 'io.github.yeb02.cirrus.dev', userData: join(env.appData, '@cirrus', 'app-dev'), dev }
    : { name: 'Cirrus', appId: 'io.github.yeb02.cirrus', userData: join(env.appData, '@cirrus', 'app'), dev };
}

/** What applyIdentity takes of Electron's app. */
export interface IdentityTarget {
  setName(name: string): void;
  setPath(name: 'userData', path: string): void;
  setAppUserModelId(id: string): void;
}

/**
 * Gives the app its identity: called first, before anything reads userData — the single-instance lock, Chromium's
 * profile, the base. A profile given on the command line (`userDataGiven`: --user-data-dir, which the interface's checks,
 * the captures and the package's check pass, each a temporary one) is kept: such a run never takes the user's folder.
 */
export function applyIdentity(app: IdentityTarget, id: AppIdentity, opts: { platform: NodeJS.Platform; userDataGiven: boolean }): void {
  app.setName(id.name);
  if (!opts.userDataGiven) app.setPath('userData', id.userData);
  if (opts.platform === 'win32') app.setAppUserModelId(id.appId);
}

/**
 * The folder of the read-only copies the system's applications open (files.ts, plan 4a, D5), which each start empties
 * of what is no longer open: one per variant, so that « Cirrus Dev » never empties the official app's.
 */
export function copiesDir(temp: string, id: AppIdentity): string {
  return join(temp, id.dev ? 'cirrus-dev-ouverts' : 'cirrus-ouverts');
}
