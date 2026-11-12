import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * The app's identity (plan 9, D3). Two packagings of the same build: the official app, « Cirrus », and « Cirrus Dev »
 * (`npm run paquet:dev`), which has its own name, appId, data folder — so its own base, Chromium profile and
 * single-instance lock — and icon, and so can never touch the user's data. They share TinyTeX (latex/tinytex.ts).
 * This module stays out of Electron: index.ts hands it the app.
 */
export type Variant = 'official' | 'dev';

/**
 * The package name that makes « Cirrus Dev »: electron-builder.dev.yml writes it into the archive's package.json
 * (`extraMetadata.name`). The variant is read there at each start (packageVariant), and nowhere else: the build is the
 * same for both, so a build cannot disagree with its packaging (fix round 1 of task 3, I3).
 */
export const DEV_PACKAGE = '@cirrus/app-dev';

/** The variant a package name makes: « Cirrus Dev » for DEV_PACKAGE alone, the official app for any other. */
export function variantOf(packageName: unknown): Variant {
  return packageName === DEV_PACKAGE ? 'dev' : 'official';
}

/**
 * The variant of the app at `appPath` (app.getAppPath(): the archive when packaged, packages/app otherwise, whose name,
 * « @cirrus/app », makes `npm run dev` and every check the official app). Throws if its package.json cannot be read:
 * the caller stops rather than guess, since guessing « official » would give a « Cirrus Dev » the user's base.
 */
export function packageVariant(appPath: string): Variant {
  return variantOf(JSON.parse(readFileSync(join(appPath, 'package.json'), 'utf8')).name);
}

/**
 * The variant this run takes: its package's when packaged (the installed app, « Cirrus » or « Cirrus Dev »); « Cirrus
 * Dev » for any run from the repository (npm run dev, npm run start, the checks), whatever packages/app's name says, so
 * that code being worked on never opens the user's base, nor talks to the server it is paired with (2026-11-12: the user
 * tries his changes with npm run dev). Its data folder is %APPDATA%@cirrusapp-dev, the installed « Cirrus Dev »'s.
 */
export function runVariant(pkg: Variant, packaged: boolean): Variant {
  return packaged ? pkg : 'dev';
}

export interface AppIdentity {
  /** The app's name (app.setName), its installer's and its executable's. */
  name: 'Cirrus' | 'Cirrus Dev';
  /** Windows' AppUserModelId, electron-builder's appId: the taskbar, the shortcuts, the installation's registry key. */
  appId: string;
  /** The data folder: the base under it (base.ts), Chromium's profile, the single-instance lock. */
  userData: string;
  dev: boolean;
}

/**
 * The identity of a variant, `appData` being Electron's (%APPDATA%). The official app keeps %APPDATA%\@cirrus\app: the
 * folder Electron gave it while it was named after its package, « @cirrus/app », where the user's base already is. A
 * name of its own would otherwise have moved it, and the base would have seemed gone.
 */
export function appIdentity(env: { appData: string; variant: Variant }): AppIdentity {
  return env.variant === 'dev'
    ? { name: 'Cirrus Dev', appId: 'io.github.yeb02.cirrus.dev', userData: join(env.appData, '@cirrus', 'app-dev'), dev: true }
    : { name: 'Cirrus', appId: 'io.github.yeb02.cirrus', userData: join(env.appData, '@cirrus', 'app'), dev: false };
}

/** What applyIdentity takes of Electron's app. */
export interface IdentityTarget {
  setName(name: string): void;
  setPath(name: 'userData', path: string): void;
  setAppUserModelId(id: string): void;
}

/**
 * Gives the app its identity: called first, before anything reads userData — the single-instance lock, Chromium's
 * profile, the base. The data folder first, then the name, so that nothing derives a folder from the name in between.
 * A profile given on the command line (`userDataGiven`: --user-data-dir, which the interface's checks, the captures and
 * the package's check pass, each a temporary one) is kept: such a run never takes the user's folder.
 */
export function applyIdentity(app: IdentityTarget, id: AppIdentity, opts: { platform: NodeJS.Platform; userDataGiven: boolean }): void {
  if (!opts.userDataGiven) app.setPath('userData', id.userData);
  app.setName(id.name);
  if (opts.platform === 'win32') app.setAppUserModelId(id.appId);
}

/**
 * The folder of the read-only copies the system's applications open (files.ts, plan 4a, D5), which each start empties
 * of what is no longer open: one per variant, so that « Cirrus Dev » never empties the official app's.
 */
export function copiesDir(temp: string, id: AppIdentity): string {
  return join(temp, id.dev ? 'cirrus-dev-ouverts' : 'cirrus-ouverts');
}
