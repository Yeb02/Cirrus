import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { dataDir } from '../src/main/base.ts';
import { type AppIdentity, appIdentity, applyIdentity, copiesDir, packageVariant, runVariant, variantOf } from '../src/main/identity.ts';

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

test('la variante vient du nom du paquet, et de lui seul : « @cirrus/app-dev » fait « Cirrus Dev », tout autre l’app officielle', () => {
  expect(variantOf('@cirrus/app-dev')).toBe('dev');
  for (const name of ['@cirrus/app', 'cirrus', '@cirrus/app-dev ', '@CIRRUS/APP-DEV', '', undefined, null, 42]) expect(variantOf(name)).toBe('official');
});

test('une app non empaquetée (npm run dev, npm run start) est toujours « Cirrus Dev » : jamais la base de l’utilisateur ; empaquetée, la variante de son paquet', () => {
  expect(runVariant('official', false)).toBe('dev');
  expect(runVariant('dev', false)).toBe('dev');
  expect(runVariant('official', true)).toBe('official');
  expect(runVariant('dev', true)).toBe('dev');
});

test('le nom lu dans le package.json de l’app (l’archive empaquetée, ou packages/app) ; illisible, une erreur plutôt qu’une variante devinée', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-identite-'));
  try {
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: '@cirrus/app-dev', version: '0.1.0' }));
    expect(packageVariant(dir)).toBe('dev');
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'cirrus', version: '0.1.0' }));
    expect(packageVariant(dir)).toBe('official');
    writeFileSync(join(dir, 'package.json'), '{ abîmé');
    expect(() => packageVariant(dir)).toThrow();
    rmSync(join(dir, 'package.json'));
    expect(() => packageVariant(dir)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  // `npm run dev`, the checks and the captures run packages/app: the official app, on the user's base as before.
  expect(packageVariant(join(dirname(fileURLToPath(import.meta.url)), '..'))).toBe('official');
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

test('appliquée : le dossier de données d’abord (le profil de Chromium et le verrou d’instance unique le suivent), puis le nom, puis l’AppUserModelId sous Windows', () => {
  for (const id of [official, dev]) {
    const app = fakeApp();
    applyIdentity(app, id, { platform: 'win32', userDataGiven: false });
    expect(app.calls).toEqual([`path userData ${id.userData}`, `name ${id.name}`, `appUserModelId ${id.appId}`]);
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
  expect(app.calls).toEqual([`path userData ${official.userData}`, 'name Cirrus']);
});

test('dans index.ts, l’identité est donnée avant le verrou d’instance unique et avant toute lecture de userData ; aucun autre module du principal ne lit userData', () => {
  const main = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main');
  const index = readFileSync(join(main, 'index.ts'), 'utf8');
  const at = (s: string) => index.indexOf(s);
  const applied = at('applyIdentity(app');
  expect(applied).toBeGreaterThan(0);
  // The variant is read before it is applied; the lock and every read or override of userData come after.
  expect(at('packageVariant(app.getAppPath())')).toBeGreaterThan(0);
  expect(at('packageVariant(app.getAppPath())')).toBeLessThan(applied);
  expect(at('requestSingleInstanceLock(')).toBeGreaterThan(applied);
  const userData = [...index.matchAll(/getPath\('userData'\)|setPath\('userData'/g)].map((m) => m.index);
  expect(userData.length).toBeGreaterThan(0);
  for (const i of userData) expect(i).toBeGreaterThan(applied);
  const others = readdirSync(main, { recursive: true, encoding: 'utf8' })
    .filter((f) => /\.tsx?$/.test(f) && f !== 'index.ts' && f !== 'identity.ts')
    .filter((f) => /getPath\(\s*'userData'|setPath\(\s*'userData'/.test(readFileSync(join(main, f), 'utf8')));
  expect(others).toEqual([]);
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
