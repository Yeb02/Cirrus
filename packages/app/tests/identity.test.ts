import { join } from 'node:path';
import { expect, test } from 'vitest';
import { dataDir } from '../src/main/base.ts';
import { type AppIdentity, appIdentity, applyIdentity, copiesDir } from '../src/main/identity.ts';

// The app's identity (plan 9, D3). The official app keeps the folder the user's base already lives in: the one Electron
// gave the app while it was named « @cirrus/app » (appData joined with that name). « Cirrus Dev » has its own, beside it.
const APPDATA = 'C:\\Users\\u\\AppData\\Roaming';

test('l’app officielle garde %APPDATA%\\@cirrus\\app, là où est la base de l’utilisateur', () => {
  const id = appIdentity({ appData: APPDATA, variant: 'official' });
  expect(id).toEqual({ name: 'Cirrus', appId: 'io.github.yeb02.cirrus', userData: join(APPDATA, '@cirrus', 'app'), dev: false });
  // Exactly the folder Electron derived from the package's name before the app had one of its own.
  expect(id.userData).toBe(join(APPDATA, '@cirrus/app'));
  if (process.platform === 'win32') expect(id.userData).toBe('C:\\Users\\u\\AppData\\Roaming\\@cirrus\\app');
});

test('« Cirrus Dev » a son nom, son appId et son dossier, à côté de celui de l’app officielle', () => {
  const id = appIdentity({ appData: APPDATA, variant: 'dev' });
  expect(id).toEqual({ name: 'Cirrus Dev', appId: 'io.github.yeb02.cirrus.dev', userData: join(APPDATA, '@cirrus', 'app-dev'), dev: true });
  if (process.platform === 'win32') expect(id.userData).toBe('C:\\Users\\u\\AppData\\Roaming\\@cirrus\\app-dev');
  expect(id.userData).not.toBe(appIdentity({ appData: APPDATA, variant: 'official' }).userData);
});

test('sans variante donnée, celle de la construction : l’officielle là où rien n’est construit (les tests)', () => {
  expect(appIdentity({ appData: APPDATA })).toEqual(appIdentity({ appData: APPDATA, variant: 'official' }));
});

/** A fake of Electron's app: the calls applyIdentity makes, in order. */
function fakeApp() {
  const calls: string[] = [];
  return {
    calls,
    setName: (name: string) => { calls.push(`name ${name}`); },
    setPath: (key: 'userData', path: string) => { calls.push(`path ${key} ${path}`); },
    setAppUserModelId: (id: string) => { calls.push(`appUserModelId ${id}`); },
  };
}

const official: AppIdentity = appIdentity({ appData: APPDATA, variant: 'official' });
const dev: AppIdentity = appIdentity({ appData: APPDATA, variant: 'dev' });

test('appliquée : le nom, le dossier de données (le profil de Chromium et le verrou d’instance unique le suivent), l’AppUserModelId sous Windows', () => {
  for (const id of [official, dev]) {
    const app = fakeApp();
    applyIdentity(app, id, { platform: 'win32', userDataGiven: false });
    expect(app.calls).toEqual([`name ${id.name}`, `path userData ${id.userData}`, `appUserModelId ${id.appId}`]);
  }
});

test('un profil donné par --user-data-dir (scénarios, captures, essai du paquet) est gardé : le dossier de l’utilisateur n’est jamais pris', () => {
  const app = fakeApp();
  applyIdentity(app, official, { platform: 'win32', userDataGiven: true });
  expect(app.calls).toEqual(['name Cirrus', 'appUserModelId io.github.yeb02.cirrus']);
});

test('hors de Windows, pas d’AppUserModelId', () => {
  const app = fakeApp();
  applyIdentity(app, official, { platform: 'linux', userDataGiven: false });
  expect(app.calls).toEqual(['name Cirrus', `path userData ${official.userData}`]);
});

test('les deux variantes sur le même PC : deux bases, donc deux verrous de base et deux fichiers de jetons', () => {
  const kept = process.env.CIRRUS_DATA;
  delete process.env.CIRRUS_DATA;
  try {
    // The base, its lock (lock.ts) and the server's token (sync/config.ts) all live in the base's folder.
    expect(dataDir(official.userData)).toBe(join(APPDATA, '@cirrus', 'app', 'base'));
    expect(dataDir(dev.userData)).toBe(join(APPDATA, '@cirrus', 'app-dev', 'base'));
  } finally {
    if (kept !== undefined) process.env.CIRRUS_DATA = kept;
  }
});

test('les copies ouvertes par les applications du système : un dossier par variante, que chacune vide à son démarrage', () => {
  expect(copiesDir('T', official)).toBe(join('T', 'cirrus-ouverts'));
  expect(copiesDir('T', dev)).toBe(join('T', 'cirrus-dev-ouverts'));
});
