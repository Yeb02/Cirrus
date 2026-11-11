import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign, verify } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeAll, expect, test, vi } from 'vitest';
import { devUpdatesOf, KEY_PLACEHOLDER, UPDATE_PUBLIC_KEY, updateKeyOf, updateModeOf } from '../src/main/update/key.ts';
import { checkInstaller, compareVersions, type Manifest, usableKey, verifyManifest } from '../src/main/update/manifest.ts';
import { type FeedUpdater, type LatestInfo, NOT_SERVED, REFUSED, Updater, type UpdaterDeps } from '../src/main/update/updater.ts';
import type { UpdateFlow, UpdateWord } from '../src/main/sync/protocol.ts';
import { chipOf } from '../src/renderer/sync/syncSession.ts';
import { passesKey, updateScreenOf } from '../src/renderer/sync/updateScreen.ts';
import { AppPc } from './support/appPc.ts';
import { Lab, until } from './support/virtualPc.ts';

// The signed updates (plan 9, task 4, D4; Review Focus 2): the manifest of the official version, version.json, signed
// by the CI (ed25519) with the key kept in GitHub's secrets, checked with the public key the app carries; the installer
// electron-updater downloads, checked against the manifest's sha512; the install armed only then. Forced (2026-11-11):
// from the manifest checked on, a screen blocks the app; the installer armed, the window closes by its normal path and
// the installer runs at the quit, the app started again after it. Never a downgrade, never « Cirrus Dev », never with the placeholder key. A test key is made here, never in the
// repository.

const run = promisify(execFile);
const ROOT = join(import.meta.dirname, '..', '..', '..');

/** A key pair of the test: the public key as key.ts holds one (SPKI DER, base64), the private one to sign. */
function keyPair(): { pub: string; priv: KeyObject } {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return { pub: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'), priv: privateKey };
}
const signed = (bytes: string, priv: KeyObject): string => sign(null, Buffer.from(bytes, 'utf8'), priv).toString('base64');

let key: { pub: string; priv: KeyObject };
let dir: string;
/** The installer of 0.1.2, its bytes in `dir`. */
let installer: { path: string; bytes: Buffer; sha512: string };
beforeAll(() => {
  key = keyPair();
});

function setUp(): void {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-maj-'));
  const bytes = randomBytes(256 * 1024), path = join(dir, 'Cirrus Setup 0.1.2.exe');
  writeFileSync(path, bytes);
  installer = { path, bytes, sha512: createHash('sha512').update(bytes).digest('base64') };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** version.json as the CI writes it (signer-version.mjs), `fields` over the installer of 0.1.2. */
function manifestText(fields: Record<string, unknown> = {}): string {
  return `${JSON.stringify({ version: '0.1.2', file: 'Cirrus Setup 0.1.2.exe', sha512: installer.sha512, size: installer.bytes.length, date: '2026-11-10T09:00:00.000Z', ...fields }, null, 2)}\n`;
}

test('verifyManifest : une bonne signature rend le manifeste, ses seuls champs', () => {
  setUp();
  const text = manifestText({ extra: 'ignoré' });
  expect(verifyManifest(text, signed(text, key.priv), key.pub)).toEqual({
    version: '0.1.2', file: 'Cirrus Setup 0.1.2.exe', sha512: installer.sha512, size: installer.bytes.length, date: '2026-11-10T09:00:00.000Z',
  });
  // The signature file may end with a newline.
  expect(verifyManifest(text, `${signed(text, key.priv)}\n`, key.pub)?.version).toBe('0.1.2');
});

test('verifyManifest (Review Focus 2) : une signature fausse — une autre clé, d’autres octets, le manifeste modifié après signature, une signature abîmée — rend null', () => {
  setUp();
  const text = manifestText(), sig = signed(text, key.priv);
  const other = keyPair();
  expect(verifyManifest(text, signed(text, other.priv), key.pub)).toBeNull();
  expect(verifyManifest(text, sig, other.pub)).toBeNull();
  // A signature of other bytes: another manifest, the same one re-indented.
  expect(verifyManifest(text, signed(manifestText({ version: '0.1.3' }), key.priv), key.pub)).toBeNull();
  expect(verifyManifest(text, signed(JSON.stringify(JSON.parse(text)), key.priv), key.pub)).toBeNull();
  // The manifest changed after it was signed: a newer version, another hash, another file, one space more.
  for (const changed of [manifestText({ version: '0.1.9' }), manifestText({ sha512: createHash('sha512').update('x').digest('base64') }), manifestText({ file: 'Autre.exe' }), `${text} `, text.replace('0.1.2', '0.1.20')]) {
    expect(verifyManifest(changed, sig, key.pub), changed).toBeNull();
  }
  // A signature broken: cut, a byte changed, not base64, empty, two of them.
  const raw = Buffer.from(sig, 'base64');
  raw[10] ^= 1;
  for (const bad of [sig.slice(0, -4), raw.toString('base64'), '!'.repeat(88), '', `${sig}${sig}`, Buffer.alloc(64).toString('base64')]) {
    expect(verifyManifest(text, bad, key.pub), bad).toBeNull();
  }
});

test('verifyManifest : la clé provisoire, une clé illisible ou d’un autre type refusent tout ; la clé de key.ts est utilisable', () => {
  setUp();
  const text = manifestText(), sig = signed(text, key.priv);
  // The key the user made (2ca1817): a real ed25519 key, never the placeholder again.
  expect(UPDATE_PUBLIC_KEY).not.toBe(KEY_PLACEHOLDER);
  expect(usableKey(UPDATE_PUBLIC_KEY)).toBe(true);
  expect(verifyManifest(text, sig, KEY_PLACEHOLDER)).toBeNull();
  expect(verifyManifest(text, sig, '')).toBeNull();
  expect(verifyManifest(text, sig, 'AAAA')).toBeNull();
  const rsa = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  expect(verifyManifest(text, sig, rsa)).toBeNull();
});

test('verifyManifest : un manifeste signé mais mal formé rend null (version, nom, empreinte, taille, date)', () => {
  setUp();
  const broken: Record<string, unknown>[] = [
    { version: '0.1' }, { version: '0.1.2-beta' }, { version: 'v0.1.2' }, { version: '01.1.2' }, { version: 12 }, { version: `0.1.${'9'.repeat(12)}` },
    { file: '../Cirrus Setup.exe' }, { file: 'dossier/x.exe' }, { file: 'dossier\\x.exe' }, { file: 'C:x.exe' }, { file: '' }, { file: 7 }, { file: 'x.exe.' },
    { sha512: 'abc' }, { sha512: installer.sha512.slice(0, -4) }, { sha512: Buffer.alloc(32).toString('base64') }, { sha512: null },
    { size: 0 }, { size: -1 }, { size: 1.5 }, { size: '262144' }, { date: 5 }, { date: 'x'.repeat(200) },
  ];
  for (const fields of broken) {
    const text = manifestText(fields);
    expect(verifyManifest(text, signed(text, key.priv), key.pub), JSON.stringify(fields)).toBeNull();
  }
  for (const text of ['[]', 'null', '"0.1.2"', '{', '']) expect(verifyManifest(text, signed(text, key.priv), key.pub), text).toBeNull();
});

test('checkInstaller (Review Focus 2) : l’installateur dont l’empreinte et la taille sont celles du manifeste ; un octet changé, une taille autre, un absent : non', async () => {
  setUp();
  const m: Manifest = { version: '0.1.2', file: 'Cirrus Setup 0.1.2.exe', sha512: installer.sha512, size: installer.bytes.length, date: 'x' };
  expect(await checkInstaller(installer.path, m)).toBe(true);
  const altered = Buffer.from(installer.bytes);
  altered[altered.length - 1] ^= 1;
  writeFileSync(join(dir, 'altéré.exe'), altered);
  expect(await checkInstaller(join(dir, 'altéré.exe'), m)).toBe(false);
  writeFileSync(join(dir, 'plus.exe'), Buffer.concat([installer.bytes, Buffer.from([0])]));
  expect(await checkInstaller(join(dir, 'plus.exe'), m)).toBe(false);
  expect(await checkInstaller(installer.path, { ...m, size: m.size + 1 })).toBe(false);
  expect(await checkInstaller(join(dir, 'absent.exe'), m)).toBe(false);
  expect(await checkInstaller(dir, m)).toBe(false);
});

test('compareVersions : par nombres, non par lettres', () => {
  expect(compareVersions('0.1.2', '0.1.1')).toBeGreaterThan(0);
  expect(compareVersions('0.1.1', '0.1.2')).toBeLessThan(0);
  expect(compareVersions('0.1.2', '0.1.2')).toBe(0);
  expect(compareVersions('0.1.10', '0.1.9')).toBeGreaterThan(0);
  expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0);
  expect(compareVersions('0.2.0', '0.1.99')).toBeGreaterThan(0);
});

test('updateKeyOf : la clé de test (CIRRUS_UPDATE_PUBLIC_KEY) seulement sur une base de test, en arrière-plan ou en capture ; sinon celle de key.ts', () => {
  const env = { CIRRUS_UPDATE_PUBLIC_KEY: key.pub };
  expect(updateKeyOf(env, false)).toBe(UPDATE_PUBLIC_KEY);
  expect(updateKeyOf({ ...env, CIRRUS_DATA: 'C:\\essai' }, false)).toBe(UPDATE_PUBLIC_KEY);
  expect(updateKeyOf({ ...env, CIRRUS_BACKGROUND: '1' }, false)).toBe(UPDATE_PUBLIC_KEY);
  expect(updateKeyOf({ ...env, CIRRUS_DATA: 'C:\\essai', CIRRUS_BACKGROUND: '1' }, false)).toBe(key.pub);
  expect(updateKeyOf({ ...env, CIRRUS_DATA: 'C:\\essai' }, true)).toBe(key.pub);
  expect(updateKeyOf({}, true)).toBe(UPDATE_PUBLIC_KEY);
  // « Cirrus Dev » updates for the end-to-end check only: CIRRUS_UPDATE_DEV=1 with the test key, on a test base, out of
  // the user's way; never otherwise.
  const test = { CIRRUS_DATA: 'C:\\essai', CIRRUS_BACKGROUND: '1' };
  expect(devUpdatesOf({ ...test, ...env, CIRRUS_UPDATE_DEV: '1' }, false)).toBe(true);
  expect(devUpdatesOf({ ...test, CIRRUS_UPDATE_DEV: '1' }, false)).toBe(false);
  expect(devUpdatesOf({ ...env, CIRRUS_UPDATE_DEV: '1' }, false)).toBe(false);
  expect(devUpdatesOf({ ...env, CIRRUS_DATA: 'C:\\essai', CIRRUS_UPDATE_DEV: '1' }, false)).toBe(false);
  expect(devUpdatesOf({ ...test, ...env }, false)).toBe(false);
  expect(devUpdatesOf({ ...test, ...env, CIRRUS_UPDATE_DEV: 'oui' }, false)).toBe(false);
});

// ——— The updater ———

/** latest.yml as electron-builder writes it for the installer of 0.1.2 (as electron-updater reads it), `fields` over it. */
function latestYml(fields: Record<string, unknown> = {}): Record<string, unknown> {
  const file = { url: 'Cirrus Setup 0.1.2.exe', sha512: installer.sha512, size: installer.bytes.length };
  return { version: '0.1.2', files: [file], path: file.url, sha512: file.sha512, releaseDate: '2026-11-10T09:00:00.000Z', ...fields };
}

/**
 * electron-updater's autoUpdater as the updater drives it: what it was set to, its checks, its downloads, its installs.
 * A check reads `latest` (latest.yml; null: the updater inactive, an app run unpackaged), and downloads at once when
 * autoDownload is set, as electron-updater does. A download gives `download` (the version latest.yml says, the file it
 * kept) and says so ('update-downloaded'), then, as BaseUpdater does at once after, looks whether it would install at the
 * app's quit by itself (`armedByItself`).
 */
class FakeFeed extends EventEmitter implements FeedUpdater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  disableDifferentialDownload = false;
  disableWebInstaller = false;
  allowDowngrade = true;
  requestHeaders: Record<string, string> | null = null;
  readonly feeds: unknown[] = [];
  /** At each check: autoInstallOnAppQuit then, and its settings. */
  readonly checks: { autoInstallOnAppQuit: boolean; autoDownload: boolean; differential: boolean; webInstaller: boolean; downgrade: boolean; headers: unknown }[] = [];
  downloads = 0;
  readonly installs: [boolean | undefined, boolean | undefined][] = [];
  /** Whether electron-updater, right after its 'update-downloaded', would have added its own quit handler (BaseUpdater.addQuitHandler). */
  readonly armedByItself: boolean[] = [];
  latest: Record<string, unknown> | null = null;
  download: { version: string; file: string } | null = null;
  fails: Error | null = null;
  /** A download that fails (electron-updater's own sha512 check of latest.yml: ERR_CHECKSUM_MISMATCH). */
  downloadFails: Error | null = null;
  /** The percentages a download says ('download-progress'), before it ends. */
  progress: number[] = [];

  setFeedURL(options: unknown): void {
    this.feeds.push(options);
  }

  async checkForUpdates() {
    this.checks.push({
      autoInstallOnAppQuit: this.autoInstallOnAppQuit, autoDownload: this.autoDownload, differential: !this.disableDifferentialDownload, webInstaller: !this.disableWebInstaller,
      downgrade: this.allowDowngrade, headers: this.requestHeaders,
    });
    if (this.fails) throw this.fails;
    if (!this.latest) return null;
    const updateInfo = this.latest as unknown as LatestInfo;
    if (this.autoDownload) void this.downloadUpdate();
    return { isUpdateAvailable: compareVersions(String(updateInfo.version), '0.1.1') > 0, updateInfo };
  }

  async downloadUpdate(): Promise<string[]> {
    this.downloads++;
    if (this.downloadFails) throw this.downloadFails;
    const d = this.download;
    if (!d) return [];
    await new Promise((r) => setTimeout(r, 1));
    for (const percent of this.progress) this.emit('download-progress', { percent });
    this.emit('update-downloaded', { version: d.version, downloadedFile: d.file });
    this.armedByItself.push(this.autoInstallOnAppQuit);
    return [d.file];
  }

  install(isSilent?: boolean, isForceRunAfter?: boolean): boolean {
    this.installs.push([isSilent, isForceRunAfter]);
    return true;
  }
}

const SERVER = { url: 'https://cirrus.exemple.fr', token: 'J'.repeat(43) };

/** An updater as the app makes it, at version `version`, its server answering `files` (a text, a status, or 404). */
function updater(o: Partial<UpdaterDeps> & { files?: Record<string, string | number | Error> } = {}) {
  const feed = new FakeFeed();
  const told: UpdateWord[] = [], warned: string[] = [], asked: string[] = [];
  /** The files asked of the server when each word was told: the screen never before the manifest's signature. */
  const toldAfter: number[] = [];
  let made = 0, restarts = 0;
  const files = o.files ?? {};
  const u = new Updater({
    version: '0.1.1', dev: false, publicKey: key.pub, connected: () => true, params: () => ({ updateCheckMs: 3_600_000, syncRetryMaxMs: 30_000 }), server: () => SERVER,
    fetchFile: async (name) => {
      asked.push(name);
      const f = files[name];
      if (f instanceof Error) throw f;
      return typeof f === 'string' ? new Response(f) : new Response('{"error":"absent"}', { status: typeof f === 'number' ? f : 404 });
    },
    updater: () => { made++; return feed; },
    tell: (w) => { told.push(w); toldAfter.push(asked.length); },
    warn: (t) => warned.push(t),
    restart: () => { restarts++; },
    ...o,
  });
  feed.latest = latestYml();
  return { u, feed, told, toldAfter, warned, asked, made: () => made, restarts: () => restarts };
}

/** The steps of the screen the words said, in order (null: a word without one). */
const stepsOf = (told: UpdateWord[]) => told.map((w) => w.updateFlow?.step ?? null);
/** The screen's word for 0.1.2 at `step` (its `attempt`: the first by default). */
const flow = (step: UpdateFlow['step'], more: Record<string, unknown> = {}): UpdateFlow => ({ version: '0.1.2', attempt: 1, step, ...more }) as UpdateFlow;

/** The server's versions/ for a manifest of 0.1.2 signed with the test key (or `sig`). */
function published(o: { text?: string; sig?: string } = {}): Record<string, string> {
  const text = o.text ?? manifestText();
  return { 'version.json': text, 'version.json.sig': o.sig ?? signed(text, key.priv) };
}

test('Updater (D4, mise à jour forcée) : un /hello qui annonce une version plus récente ; le manifeste vérifié, l’écran le dit, electron-updater téléchargé avec le jeton, sa progression dite, l’installateur vérifié et armé ; puis la fenêtre fermée par son chemin normal, et l’installateur lancé à la fermeture, avec relance', async () => {
  setUp();
  const { u, feed, told, toldAfter, asked, restarts } = updater({ files: published() });
  feed.download = { version: '0.1.2', file: installer.path };
  // Each whole percent said once; a fraction more says nothing new.
  feed.progress = [12.5, 12.9, 57.3, 100];
  await u.heard('0.1.2');
  expect(asked).toEqual(['version.json', 'version.json.sig']);
  // electron-updater: the server's versions/, the token in a header; a full download, never differential nor a web
  // installer; never a downgrade; never installed at the quit by itself.
  expect(feed.feeds).toEqual([{ provider: 'generic', url: `${SERVER.url}/versions/` }]);
  // latest.yml read first, nothing downloaded with it (M2); then, latest.yml being the signed manifest's, one download.
  expect(feed.checks).toEqual([{ autoInstallOnAppQuit: false, autoDownload: false, differential: false, webInstaller: false, downgrade: false, headers: { Authorization: `Bearer ${SERVER.token}` } }]);
  expect(feed.downloads).toBe(1);
  // Right after the download, unchecked: electron-updater does not arm itself.
  expect(feed.armedByItself).toEqual([false]);
  // The screen: from the manifest checked on — never before its signature —, the download and its progress, then the
  // restart once armed.
  expect(told).toEqual([
    { updateFlow: flow('downloading') }, { updateFlow: flow('downloading', { percent: 12 }) }, { updateFlow: flow('downloading', { percent: 57 }) },
    { updateFlow: flow('downloading', { percent: 100 }) }, { updateFlow: flow('restarting') },
  ]);
  expect(toldAfter[0]).toBe(2);
  // Checked: armed — autoInstallOnAppQuit —, the window asked to close, once; the app's quit installs it, silently,
  // and the app starts again after (D4).
  expect(feed.autoInstallOnAppQuit).toBe(true);
  expect(restarts()).toBe(1);
  expect(feed.installs).toEqual([]);
  u.quit(0);
  expect(feed.installs).toEqual([[true, true]]);
  u.dispose();
});

test('Updater : electron-updater inactif (une app non installée) — l’écran dit l’échec ; rien d’armé ni de fermé', async () => {
  setUp();
  const { u, feed, told, restarts } = updater({ files: published() });
  feed.latest = null;
  await u.heard('0.1.2');
  expect(stepsOf(told)).toEqual(['downloading', 'failed']);
  expect(told.at(-1)?.updateFlow).toMatchObject({ version: '0.1.2', attempt: 1, message: expect.stringContaining('installée') });
  expect(told.at(-1)?.updateRefused).toBeUndefined();
  expect(restarts()).toBe(0);
  u.quit(0);
  expect(feed.installs).toEqual([]);
  u.dispose();
});

test('Updater (Review Focus 2) : une signature fausse — rien n’est téléchargé ni installé ; un avertissement et une notification, une seule fois par session', async () => {
  setUp();
  const other = keyPair();
  const { u, feed, told, warned, made, restarts } = updater({ files: published({ sig: signed(manifestText(), other.priv) }) });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.heard('0.1.2');
  await u.heard('0.1.2');
  await u.formatRefused();
  expect(made()).toBe(0);
  expect(feed.checks).toEqual([]);
  // A false announcement never blocks the app: no screen, the notification only.
  expect(told).toEqual([{ updateRefused: REFUSED }]);
  expect(restarts()).toBe(0);
  expect(REFUSED).toBe('Mise à jour refusée : sa signature ne correspond pas.');
  expect(warned.filter((w) => w.includes('signature'))).toHaveLength(1);
  u.quit(0);
  expect(feed.installs).toEqual([]);
  u.dispose();
});

test('Updater (Review Focus 2) : le manifeste modifié après sa signature est refusé de même', async () => {
  setUp();
  const sig = signed(manifestText(), key.priv);
  const { u, feed, told } = updater({ files: published({ text: manifestText({ version: '0.1.9' }), sig }) });
  await u.heard('0.1.9');
  expect(feed.checks).toEqual([]);
  expect(told).toEqual([{ updateRefused: REFUSED }]);
  u.dispose();
});

test('Updater (Review Focus 2) : un installateur dont l’empreinte diffère du manifeste signé n’est pas armé ; l’écran dit le refus, la notification aussi ; ni fermeture ni installation ; il n’est pas retéléchargé pour ce manifeste', async () => {
  setUp();
  const other = join(dir, 'autre.exe');
  writeFileSync(other, randomBytes(installer.bytes.length));
  const { u, feed, told, warned, restarts } = updater({ files: published() });
  feed.download = { version: '0.1.2', file: other };
  await u.heard('0.1.2');
  expect(feed.checks).toHaveLength(1);
  expect(feed.autoInstallOnAppQuit).toBe(false);
  expect(feed.armedByItself).toEqual([false]);
  expect(stepsOf(told)).toEqual(['downloading', 'refused']);
  expect(told.at(-1)).toEqual({ updateFlow: flow('refused', { message: expect.stringContaining('empreinte') }), updateRefused: REFUSED });
  expect(restarts()).toBe(0);
  expect(warned.some((w) => w.includes('empreinte'))).toBe(true);
  u.quit(0);
  expect(feed.installs).toEqual([]);
  // The same manifest again: not downloaded again, nor shown again.
  await u.heard('0.1.2');
  expect(feed.checks).toHaveLength(1);
  expect(told).toHaveLength(2);
  u.dispose();
});

test('Updater : un second refus dans la session — un autre manifeste — l’écran le dit encore ; la notification et l’avertissement restent uniques', async () => {
  setUp();
  const files = published();
  const { u, feed, told, warned } = updater({ files });
  feed.latest = latestYml({ isAdminRightsRequired: true });
  await u.heard('0.1.2');
  Object.assign(files, published({ text: manifestText({ version: '0.1.3' }) }));
  await u.heard('0.1.3');
  expect(stepsOf(told)).toEqual(['downloading', 'refused', 'downloading', 'refused']);
  expect(told.at(-1)).toEqual({ updateFlow: { version: '0.1.3', attempt: 2, step: 'refused', message: expect.stringContaining('latest.yml') }, updateRefused: REFUSED });
  expect(warned.filter((w) => w.startsWith('Mise à jour refusée'))).toHaveLength(1);
  u.dispose();
});

test('Updater : electron-updater dit avoir téléchargé une autre version que celle du manifeste signé — refusé (seconde couche)', async () => {
  setUp();
  const { u, feed, told } = updater({ files: published() });
  feed.download = { version: '0.1.3', file: installer.path };
  await u.heard('0.1.2');
  expect(feed.autoInstallOnAppQuit).toBe(false);
  expect(told.at(-1)).toEqual({ updateFlow: flow('refused', { message: expect.any(String) }), updateRefused: REFUSED });
  u.quit(0);
  expect(feed.installs).toEqual([]);
  u.dispose();
});

test('Updater (revue, M2) : un latest.yml hostile — autre version, deux fichiers, une adresse absolue, un autre nom, une autre empreinte, une autre taille, les droits d’administrateur, des paquets : rien n’est téléchargé, refusé', async () => {
  setUp();
  const file = (f: Record<string, unknown>) => ({ files: [{ url: 'Cirrus Setup 0.1.2.exe', sha512: installer.sha512, size: installer.bytes.length, ...f }] });
  const hostile: Record<string, unknown>[] = [
    { version: '0.1.3' }, { version: '0.1.1' },
    { files: [latestYml().files, { url: 'autre.exe', sha512: installer.sha512, size: 1 }].flat() }, { files: [] }, { files: 'Cirrus Setup 0.1.2.exe' },
    file({ url: 'https://ailleurs.example/Cirrus Setup 0.1.2.exe' }), file({ url: '../Cirrus Setup 0.1.2.exe' }), file({ url: 'Autre Setup 0.1.2.exe' }),
    file({ sha512: createHash('sha512').update('autre').digest('base64') }), file({ size: installer.bytes.length + 1 }), file({ size: undefined }),
    file({ isAdminRightsRequired: true }), { isAdminRightsRequired: true },
    { packages: { x64: { path: 'paquet.7z', sha512: installer.sha512, size: 1 } } },
  ];
  for (const fields of hostile) {
    const { u, feed, told, warned } = updater({ files: published() });
    feed.latest = latestYml(fields);
    feed.download = { version: '0.1.2', file: installer.path };
    await u.heard('0.1.2');
    expect(feed.checks, JSON.stringify(fields)).toHaveLength(1);
    expect(feed.downloads, JSON.stringify(fields)).toBe(0);
    expect(stepsOf(told), JSON.stringify(fields)).toEqual(['downloading', 'refused']);
    expect(told.at(-1), JSON.stringify(fields)).toEqual({ updateFlow: flow('refused', { message: expect.stringMatching(/latest\.yml/) }), updateRefused: REFUSED });
    expect(warned.at(-1)).toMatch(/latest\.yml/);
    // The same manifest is not tried again this session.
    await u.heard('0.1.2');
    expect(feed.checks).toHaveLength(1);
    u.quit(0);
    expect(feed.installs).toEqual([]);
    u.dispose();
  }
});

test('Updater (revue, M2) : latest.yml celui du manifeste, mais d’autres octets servis — la vérification d’electron-updater échoue : refusé, non retéléchargé ; une panne du réseau : l’écran dit l’échec, sans refus, et la vérification suivante reprend le déroulement', async () => {
  setUp();
  const { u, feed, told, restarts } = updater({ files: published() });
  feed.downloadFails = Object.assign(new Error('sha512 checksum mismatch'), { code: 'ERR_CHECKSUM_MISMATCH' });
  await u.heard('0.1.2');
  expect(told.at(-1)).toEqual({ updateFlow: flow('refused', { message: expect.stringContaining('empreinte') }), updateRefused: REFUSED });
  await u.heard('0.1.2');
  expect(feed.downloads).toBe(1);
  expect(restarts()).toBe(0);
  u.dispose();
  const net = updater({ files: published() });
  net.feed.downloadFails = Object.assign(new Error('net::ERR_CONNECTION_RESET'), { code: 'ERR_CONNECTION_RESET' });
  await net.u.heard('0.1.2');
  expect(net.told).toEqual([{ updateFlow: flow('downloading') }, { updateFlow: flow('failed', { message: 'net::ERR_CONNECTION_RESET' }) }]);
  expect(net.restarts()).toBe(0);
  net.feed.downloadFails = null;
  net.feed.download = { version: '0.1.2', file: installer.path };
  await net.u.heard('0.1.2');
  expect(net.feed.downloads).toBe(2);
  // A new attempt: the screen comes back, even if the failure was dismissed.
  expect(net.told.slice(2)).toEqual([{ updateFlow: flow('downloading', { attempt: 2 }) }, { updateFlow: flow('restarting', { attempt: 2 }) }]);
  expect(net.restarts()).toBe(1);
  net.u.dispose();
});

test('Updater : un message d’échec démesuré est borné', async () => {
  setUp();
  const { u, feed, told } = updater({ files: published() });
  feed.fails = new Error('x'.repeat(10_000));
  await u.heard('0.1.2');
  const last = told.at(-1)?.updateFlow;
  expect(last?.step).toBe('failed');
  expect(last && 'message' in last ? last.message.length : 0).toBeLessThanOrEqual(300);
  u.dispose();
});

test('Updater (Review Focus 2 ; revue, M3) : un serveur qui ment sur sa version — /hello annonce 0.1.9, le manifeste signé est plus ancien ou égal : rien de téléchargé, refusé une fois ; la recherche périodique reste muette', async () => {
  setUp();
  for (const version of ['0.1.0', '0.1.1']) {
    const text = manifestText({ version });
    const { u, feed, told, warned } = updater({ files: published({ text }) });
    await u.heard('0.1.9');
    await u.heard('0.1.9');
    expect(feed.checks, version).toEqual([]);
    expect(told, version).toEqual([{ updateRefused: NOT_SERVED }]);
    expect(warned.filter((w) => w.includes('annonce'))).toHaveLength(1);
    // The same manifest found by a format refused, or the periodic check: nothing said.
    const quiet = updater({ files: published({ text }) });
    await quiet.u.formatRefused();
    await quiet.u.check();
    expect(quiet.told).toEqual([]);
    expect(quiet.warned).toEqual([]);
    u.dispose();
    quiet.u.dispose();
  }
  expect(NOT_SERVED).toBe('Mise à jour refusée : le serveur annonce une version qu’il ne sert pas.');
});

test('Updater : /hello sans version, ou une plus ancienne, ou égale — rien n’est demandé', async () => {
  setUp();
  const { u, asked, made } = updater({ files: published() });
  for (const v of [null, '0.1.0', '0.1.1', '0.0.9', 'n’importe quoi', '0.1.2-beta']) await u.heard(v);
  expect(asked).toEqual([]);
  expect(made()).toBe(0);
  u.dispose();
});

test('Updater (spec 18.1) : une app de développement, ou en pré-version, n’est jamais mise à jour, même au format refusé', async () => {
  setUp();
  for (const o of [{ dev: true }, { version: '0.1.1-dev' }, { version: '0.1.1-beta.2' }]) {
    const { u, asked, made } = updater({ ...o, files: published() });
    await u.heard('0.1.2');
    await u.formatRefused();
    expect(asked, JSON.stringify(o)).toEqual([]);
    expect(made()).toBe(0);
    u.dispose();
  }
});

test('Updater : la clé provisoire — rien n’est demandé ni installé ; un message dans la console, une fois', async () => {
  setUp();
  const { u, asked, made, warned, told } = updater({ publicKey: KEY_PLACEHOLDER, files: published() });
  await u.heard('0.1.2');
  await u.formatRefused();
  await u.heard('0.1.3');
  expect(asked).toEqual([]);
  expect(made()).toBe(0);
  expect(told).toEqual([]);
  expect(warned).toHaveLength(1);
  expect(warned[0]).toMatch(/clé/);
  u.dispose();
});

test('Updater (D4) : le format refusé par le serveur (409) fait chercher la mise à jour, sans version annoncée', async () => {
  setUp();
  const { u, feed, told } = updater({ files: published() });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.formatRefused();
  expect(feed.checks).toHaveLength(1);
  expect(stepsOf(told)).toEqual(['downloading', 'restarting']);
  u.dispose();
});

test('Updater (revue finale du plan 9, I1) : un format refusé pendant que le serveur sert encore l’ancien manifeste ; cherché de nouveau toutes les syncRetryMaxMs, connecté ou non, jusqu’au manifeste nouveau : armé sans clic', async () => {
  setUp();
  vi.useFakeTimers();
  const old = manifestText({ version: '0.1.1' });
  const files: Record<string, string> = { 'version.json': old, 'version.json.sig': signed(old, key.priv) };
  // Refused, the sync client is not connected: only the format's retry looks again.
  const { u, feed, told, asked } = updater({ files, connected: () => false, checkInstaller: async () => true });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.formatRefused();
  expect(asked).toEqual(['version.json', 'version.json.sig']);
  expect(told).toEqual([]);
  // The server, restarted on its new format, places its manifest a few seconds later.
  Object.assign(files, published());
  await vi.advanceTimersByTimeAsync(30_000);
  await vi.advanceTimersByTimeAsync(100);
  expect(asked).toHaveLength(4);
  expect(feed.downloads).toBe(1);
  expect(stepsOf(told)).toEqual(['downloading', 'restarting']);
  u.dispose();
});

test('Updater (revue finale du plan 9, I1) : un /hello passé après le format refusé arrête la recherche répétée ; hors connexion, plus rien', async () => {
  setUp();
  vi.useFakeTimers();
  const old = manifestText({ version: '0.1.1' });
  const { u, asked } = updater({ files: { 'version.json': old, 'version.json.sig': signed(old, key.priv) }, connected: () => false });
  await u.formatRefused();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(asked).toHaveLength(4);
  await u.heard('0.1.1');
  await vi.advanceTimersByTimeAsync(120_000);
  expect(asked).toHaveLength(4);
  u.dispose();
});

test('Updater : toutes les updateCheckMs tant que la connexion est ouverte ; rien hors connexion', async () => {
  setUp();
  vi.useFakeTimers();
  let connected = false;
  const { u, asked, told, warned } = updater({ files: { 'version.json': manifestText({ version: '0.1.1' }), 'version.json.sig': signed(manifestText({ version: '0.1.1' }), key.priv) }, connected: () => connected, params: () => ({ updateCheckMs: 600_000, syncRetryMaxMs: 30_000 }) });
  await vi.advanceTimersByTimeAsync(600_000);
  expect(asked).toEqual([]);
  connected = true;
  await vi.advanceTimersByTimeAsync(600_000);
  expect(asked).toEqual(['version.json', 'version.json.sig']);
  await vi.advanceTimersByTimeAsync(600_000);
  expect(asked).toHaveLength(4);
  // The version this app has already: silent (M3).
  expect(told).toEqual([]);
  expect(warned).toEqual([]);
  u.dispose();
  await vi.advanceTimersByTimeAsync(3_600_000);
  expect(asked).toHaveLength(4);
});

test('Updater (revue, M1 et M5) : une fermeture pendant la vérification n’installe rien ; une relance qui désarme pendant la vérification est définitive — rien d’armé ensuite, ni fermé, ni cherché', async () => {
  setUp();
  let release!: (ok: boolean) => void;
  const pending = () => new Promise<boolean>((r) => { release = r; });
  // A quit while the installer is checked: not armed yet, nothing installed; armed once checked.
  const first = updater({ files: published(), checkInstaller: pending });
  first.feed.download = { version: '0.1.2', file: installer.path };
  const looking = first.u.heard('0.1.2');
  await until(() => first.feed.downloads === 1 && first.feed.armedByItself.length === 1);
  first.u.quit(0);
  expect(first.feed.installs).toEqual([]);
  release(true);
  await looking;
  expect(stepsOf(first.told)).toEqual(['downloading', 'restarting']);
  first.u.dispose();
  // Disarmed (the app starting again, D7) while the installer is checked: the check ends, nothing is armed, quit(0)
  // installs nothing, and nothing more is looked for.
  const second = updater({ files: published(), checkInstaller: pending });
  second.feed.download = { version: '0.1.2', file: installer.path };
  const again = second.u.heard('0.1.2');
  await until(() => second.feed.downloads === 1 && second.feed.armedByItself.length === 1);
  second.u.disarm();
  release(true);
  await again;
  expect(second.feed.autoInstallOnAppQuit).toBe(false);
  // The screen said the download (the app quits anyway, D7); never the restart, and nothing closed by the updater.
  expect(stepsOf(second.told)).toEqual(['downloading']);
  expect(second.restarts()).toBe(0);
  second.u.quit(0);
  expect(second.feed.installs).toEqual([]);
  await second.u.heard('0.1.3');
  await second.u.check();
  expect(second.asked).toHaveLength(2);
  second.u.dispose();
});

test('updateModeOf (revue, I1) : une clé d’essai n’installe jamais, quelle que soit la variante ; « Cirrus Dev » ne cherche qu’avec CIRRUS_UPDATE_DEV=1 et la clé d’essai', () => {
  const testBase = { CIRRUS_DATA: 'C:\\essai', CIRRUS_BACKGROUND: '1' }, testKey = { CIRRUS_UPDATE_PUBLIC_KEY: key.pub };
  // The official app: the key it carries, installs.
  expect(updateModeOf({}, false, false)).toEqual({ publicKey: UPDATE_PUBLIC_KEY, dev: false, neverInstall: false });
  // The official app with a test key on a test base, without CIRRUS_UPDATE_DEV: checked by the test key, never installed.
  expect(updateModeOf({ ...testBase, ...testKey }, false, false)).toEqual({ publicKey: key.pub, dev: false, neverInstall: true });
  expect(updateModeOf({ CIRRUS_DATA: 'C:\\essai', ...testKey }, true, false)).toEqual({ publicKey: key.pub, dev: false, neverInstall: true });
  // A test key outside a test base: ignored, the app's own key.
  expect(updateModeOf({ ...testKey }, false, false)).toEqual({ publicKey: UPDATE_PUBLIC_KEY, dev: false, neverInstall: false });
  expect(updateModeOf({ CIRRUS_DATA: 'C:\\essai', ...testKey, CIRRUS_UPDATE_DEV: '1' }, false, true)).toEqual({ publicKey: UPDATE_PUBLIC_KEY, dev: true, neverInstall: false });
  // « Cirrus Dev »: never, but with CIRRUS_UPDATE_DEV=1 and the test key — never installing then either.
  expect(updateModeOf({}, false, true)).toEqual({ publicKey: UPDATE_PUBLIC_KEY, dev: true, neverInstall: false });
  expect(updateModeOf({ ...testBase, CIRRUS_UPDATE_DEV: '1' }, false, true)).toEqual({ publicKey: UPDATE_PUBLIC_KEY, dev: true, neverInstall: false });
  expect(updateModeOf({ ...testBase, ...testKey }, false, true)).toEqual({ publicKey: key.pub, dev: true, neverInstall: true });
  expect(updateModeOf({ ...testBase, ...testKey, CIRRUS_UPDATE_DEV: '1' }, false, true)).toEqual({ publicKey: key.pub, dev: false, neverInstall: true });
});

test('updateModeOf → Updater (revue, I1) : l’app officielle avec une clé d’essai arme une mise à jour signée par elle ; l’écran dit l’essai, rien n’est fermé, et sa fermeture n’installe rien', async () => {
  setUp();
  const mode = updateModeOf({ CIRRUS_DATA: 'C:\\essai', CIRRUS_BACKGROUND: '1', CIRRUS_UPDATE_PUBLIC_KEY: key.pub }, false, false);
  const { u, feed, told, restarts } = updater({ files: published(), ...mode });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.heard('0.1.2');
  expect(told.at(-1)).toEqual({ updateFlow: flow('trial') });
  expect(restarts()).toBe(0);
  u.quit(0);
  expect(feed.installs).toEqual([]);
  u.dispose();
});

test('Updater : armée, plus rien n’est cherché ni téléchargé ; une relance (base prise du serveur) la désarme ; une sortie en erreur n’installe pas', async () => {
  setUp();
  const { u, feed, asked } = updater({ files: published() });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.heard('0.1.2');
  expect(feed.autoInstallOnAppQuit).toBe(true);
  await u.heard('0.1.3');
  await u.formatRefused();
  expect(asked).toHaveLength(2);
  expect(feed.checks).toHaveLength(1);
  u.quit(2);
  expect(feed.installs).toEqual([]);
  u.disarm();
  expect(feed.autoInstallOnAppQuit).toBe(false);
  u.quit(0);
  expect(feed.installs).toEqual([]);
  u.dispose();
});

test('Updater : l’essai de bout en bout (neverInstall) arme la mise à jour, l’écran le dit, mais ne ferme rien et ne lance jamais l’installateur, même à une fermeture sans erreur', async () => {
  setUp();
  const { u, feed, told, warned, restarts } = updater({ files: published(), neverInstall: true });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.heard('0.1.2');
  expect(stepsOf(told)).toEqual(['downloading', 'trial']);
  expect(restarts()).toBe(0);
  u.quit(0);
  expect(feed.installs).toEqual([]);
  expect(warned.at(-1)).toMatch(/essai/);
  u.dispose();
});

test('Updater : un réseau qui échoue, un manifeste absent — rien de dit ; electron-updater en erreur après la signature — l’écran dit l’échec, sans refus ; le prochain essai repart', async () => {
  setUp();
  const files: Record<string, string | number | Error> = { 'version.json': new TypeError('fetch failed') };
  const { u, feed, told } = updater({ files });
  feed.download = { version: '0.1.2', file: installer.path };
  await u.heard('0.1.2');
  files['version.json'] = 404;
  await u.heard('0.1.2');
  expect(told).toEqual([]);
  Object.assign(files, published());
  feed.fails = new Error('net::ERR_CONNECTION_RESET');
  await u.heard('0.1.2');
  expect(told).toEqual([{ updateFlow: flow('downloading') }, { updateFlow: flow('failed', { message: 'net::ERR_CONNECTION_RESET' }) }]);
  expect(feed.autoInstallOnAppQuit).toBe(false);
  feed.fails = null;
  await u.heard('0.1.2');
  expect(told.slice(2)).toEqual([{ updateFlow: flow('downloading', { attempt: 2 }) }, { updateFlow: flow('restarting', { attempt: 2 }) }]);
  u.dispose();
});

// ——— The app: the client's word, the chip ———

let lab: Lab | null = null;
const apps: AppPc[] = [];
afterEach(async () => {
  for (const a of apps.splice(0)) await a.close();
  await lab?.close();
  lab = null;
});

test('le client (D4) : la version officielle de chaque /hello passée au chercheur de mises à jour ; un 409 de format le dit ; versionFile demande avec le jeton', async () => {
  setUp();
  const l = (lab = await Lab.start());
  mkdirSync(join(l.dataDir, 'versions'), { recursive: true });
  writeFileSync(join(l.dataDir, 'versions', 'version.json'), manifestText({ version: '0.1.7' }));
  writeFileSync(join(l.dataDir, 'versions', 'version.json.sig'), 'c2lnbmF0dXJl');
  const a = new AppPc(l, 'pc-a');
  apps.push(a);
  await a.open();
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.status?.state === 'live', 5000, () => JSON.stringify(a.statuses));
  expect(a.versionsHeard).toEqual(['0.1.7']);
  expect(a.formatRefusals).toBe(0);
  // The files of versions/ through the sync's network, with this PC's token.
  const res = await a.host.versionFile('version.json.sig');
  expect(res?.status).toBe(200);
  expect(await res?.text()).toBe('c2lnbmF0dXJl');
  expect(a.net.requests).toContainEqual({ method: 'GET', path: '/versions/version.json.sig' });
  // A 409 at /hello (another format): said before the client stops, refused.
  a.net.respond = (method, path) => (path === '/hello' ? Response.json({ error: 'Ce serveur garde ses données dans un autre format (schéma 4, ici 5) : mets à jour Cirrus, ou travaille sur un serveur local.' }, { status: 409 }) : null);
  await a.host.resume();
  await until(() => a.status?.state === 'refused', 5000, () => JSON.stringify(a.statuses));
  expect(a.formatRefusals).toBe(1);
});

test('l’écran et la pastille (D4, mise à jour forcée) : le mot du chercheur montre l’écran ; un échec écarté par « Continuer » ne revient qu’à l’essai suivant ; le refus, une notification, une fois', async () => {
  const l = (lab = await Lab.start());
  const a = new AppPc(l, 'pc-a');
  apps.push(a);
  await a.open();
  expect(await a.sync.pair(l.url, l.code('Portable'), 'Portable')).toEqual({ ok: true });
  await until(() => a.view?.chip?.text === 'À jour', 5000, () => JSON.stringify(a.views.at(-1)));
  expect(a.view?.update).toBeNull();
  a.host.updateWord({ updateRefused: REFUSED });
  await until(() => a.toasts.includes(REFUSED));
  a.host.updateWord({ updateRefused: REFUSED });
  a.host.updateWord({ updateFlow: flow('downloading', { percent: 30 }), updateRefused: REFUSED });
  await until(() => a.view?.update?.percent === 30, 5000, () => JSON.stringify(a.views.at(-1)));
  expect(a.view?.update).toMatchObject({ title: 'Mise à jour de Cirrus vers 0.1.2', line: 'Téléchargement…', action: null });
  expect(a.view?.chip).toMatchObject({ text: 'Mise à jour vers 0.1.2 : téléchargement…', retry: false, tone: 'busy' });
  // Nothing to dismiss while all goes well.
  a.sync.dismissUpdate();
  expect(a.view?.update?.line).toBe('Téléchargement…');
  a.host.updateWord({ updateFlow: flow('failed', { message: 'net::ERR_CONNECTION_RESET' }), updateRefused: REFUSED });
  await until(() => a.view?.update?.action === 'Continuer sans mettre à jour', 5000, () => JSON.stringify(a.views.at(-1)));
  a.sync.dismissUpdate();
  expect(a.view?.update).toBeNull();
  // The same word told again (a status of the sync carries it): still dismissed.
  const seen = a.views.length;
  a.host.updateWord({ updateFlow: flow('failed', { message: 'net::ERR_CONNECTION_RESET' }), updateRefused: REFUSED });
  await new Promise((r) => setTimeout(r, 50));
  expect(a.views.slice(seen).every((v) => v.update === null)).toBe(true);
  expect(a.view?.chip?.text).toBe('À jour');
  expect(a.view?.chip?.title).toContain('Mise à jour vers 0.1.2 : téléchargement échoué');
  // The next check: the screen comes back.
  a.host.updateWord({ updateFlow: flow('downloading', { attempt: 2 }), updateRefused: REFUSED });
  await until(() => a.view?.update?.line === 'Téléchargement…', 5000, () => JSON.stringify(a.views.at(-1)));
  a.host.updateWord({ updateFlow: flow('restarting', { attempt: 2 }), updateRefused: REFUSED });
  await until(() => a.view?.update?.line === 'Enregistrement, puis redémarrage…', 5000, () => JSON.stringify(a.views.at(-1)));
  expect(a.toasts.filter((t) => t === REFUSED)).toHaveLength(1);
});

test('chipOf : la mise à jour en cours (téléchargement, redémarrage, essai) prend la place de « À jour » et d’un refus du serveur ; les autres états gardent leur texte, l’infobulle la dit ; un échec ou un refus, dans l’infobulle seulement', () => {
  const DL = 'Mise à jour vers 0.1.2 : téléchargement…';
  expect(chipOf({ state: 'live', pending: 0, updateFlow: flow('downloading', { percent: 40 }) }, false)).toMatchObject({ text: DL, tone: 'busy', retry: false });
  const refused = chipOf({ state: 'refused', message: 'Ce serveur garde ses données dans un autre format (schéma 4, ici 5) : mets à jour Cirrus.', updateFlow: flow('restarting') }, false);
  expect(refused).toMatchObject({ text: 'Mise à jour vers 0.1.2 : redémarrage…', tone: 'busy', retry: false });
  expect(refused?.title).toContain('autre format');
  expect(chipOf({ state: 'live', pending: 0, updateFlow: flow('trial') }, false)).toMatchObject({ text: 'Mise à jour vers 0.1.2 : essai, non installée', tone: 'ok' });
  expect(chipOf({ state: 'offline', pending: 0, updateFlow: flow('downloading') }, false)).toMatchObject({ text: 'Hors ligne', retry: true, title: expect.stringContaining(DL) });
  expect(chipOf({ state: 'live', pending: 2, updateFlow: flow('downloading') }, false)).toMatchObject({ text: 'Envoi de 2 actions…', title: expect.stringContaining(DL) });
  expect(chipOf({ state: 'live', pending: 0, updateFlow: flow('failed', { message: 'x' }) }, false))
    .toMatchObject({ text: 'À jour', tone: 'ok', title: expect.stringContaining('Mise à jour vers 0.1.2 : téléchargement échoué') });
  expect(chipOf({ state: 'live', pending: 0, updateFlow: flow('refused', { message: 'x' }) }, false))
    .toMatchObject({ text: 'À jour', title: expect.stringContaining('Mise à jour vers 0.1.2 refusée') });
  expect(chipOf({ state: 'off', updateFlow: flow('downloading') }, false)).toBeNull();
});

test('l’écran de mise à jour : son texte à chaque étape ; aucun bouton tant que tout va bien ; « Continuer sans mettre à jour » après un échec ou un refus, « Continuer » après un essai, écartés pour leur essai seulement ; seuls Entrée et Espace sur son bouton passent', () => {
  const T = 'Mise à jour de Cirrus vers 0.1.2';
  expect(updateScreenOf(undefined, 0)).toBeNull();
  expect(updateScreenOf(flow('downloading'), 0)).toEqual({ title: T, line: 'Téléchargement…', percent: null, action: null, attempt: 1 });
  expect(updateScreenOf(flow('downloading', { percent: 42 }), 0)).toMatchObject({ percent: 42 });
  // Neither the download nor the restart can be dismissed, whatever was dismissed before.
  expect(updateScreenOf(flow('downloading'), 1)).not.toBeNull();
  expect(updateScreenOf(flow('restarting'), 1)).toEqual({ title: T, line: 'Enregistrement, puis redémarrage…', percent: null, action: null, attempt: 1 });
  const failed = updateScreenOf(flow('failed', { message: 'net::ERR_CONNECTION_RESET' }), 0);
  expect(failed).toMatchObject({ title: T, action: 'Continuer sans mettre à jour' });
  expect(failed?.line).toBe('Le téléchargement a échoué (net::ERR_CONNECTION_RESET). Cirrus réessaiera à la prochaine vérification.');
  expect(updateScreenOf(flow('failed', { message: 'x' }), 1)).toBeNull();
  expect(updateScreenOf(flow('failed', { message: 'x', attempt: 2 }), 1)).not.toBeNull();
  expect(updateScreenOf(flow('refused', { message: 'latest.yml demande les droits d’administrateur' }), 0))
    .toMatchObject({ line: 'Mise à jour refusée : latest.yml demande les droits d’administrateur. Rien n’est installé.', action: 'Continuer sans mettre à jour' });
  expect(updateScreenOf(flow('refused', { message: 'x' }), 1)).toBeNull();
  expect(updateScreenOf(flow('trial'), 0)).toMatchObject({ action: 'Continuer', line: expect.stringContaining('Essai de bout en bout') });
  expect(updateScreenOf(flow('trial'), 1)).toBeNull();
  for (const key of ['Enter', ' ']) expect(passesKey(key, true), key).toBe(true);
  for (const key of ['Enter', ' ', 'Tab', 'z', 'Escape', 'Delete', 'F2']) expect(passesKey(key, false), key).toBe(false);
  for (const key of ['Tab', 'z', 'Escape']) expect(passesKey(key, true), key).toBe(false);
});

// ——— The CI's signing, and the key's making ———

test('signer-version.mjs (D6) : version.json et sa signature écrits depuis l’installateur et latest.yml ; l’app les vérifie', async () => {
  setUp();
  const dist = join(dir, 'dist');
  mkdirSync(dist);
  copyFileSync(installer.path, join(dist, 'Cirrus Setup 0.1.2.exe'));
  const latest = (sha: string) => `version: 0.1.2\nfiles:\n  - url: Cirrus Setup 0.1.2.exe\n    sha512: ${sha}\n    size: ${installer.bytes.length}\npath: Cirrus Setup 0.1.2.exe\nsha512: ${sha}\nreleaseDate: '2026-11-10T09:00:00.000Z'\n`;
  writeFileSync(join(dist, 'latest.yml'), latest(installer.sha512));
  const pem = key.priv.export({ type: 'pkcs8', format: 'pem' }).toString();
  // The signer as the CI runs it, beside a key.ts that carries the test pair's public key (the repository's carries the
  // user's key since 2ca1817): it finds key.ts by its own place, ../src/main/update/key.ts.
  const app = join(dir, 'app');
  mkdirSync(join(app, 'scripts'), { recursive: true });
  mkdirSync(join(app, 'src', 'main', 'update'), { recursive: true });
  const script = join(app, 'scripts', 'signer-version.mjs');
  copyFileSync(join(import.meta.dirname, '..', 'scripts', 'signer-version.mjs'), script);
  writeFileSync(join(app, 'src', 'main', 'update', 'key.ts'), `export const UPDATE_PUBLIC_KEY: string = '${key.pub}';\n`);
  await run(process.execPath, [script, dist], { env: { ...process.env, CIRRUS_SIGNING_KEY: pem } });
  const text = readFileSync(join(dist, 'version.json'), 'utf8'), sig = readFileSync(join(dist, 'version.json.sig'), 'utf8');
  expect(verifyManifest(text, sig, key.pub)).toMatchObject({ version: '0.1.2', file: 'Cirrus Setup 0.1.2.exe', sha512: installer.sha512, size: installer.bytes.length });
  // Without the key, or with latest.yml naming other bytes: an error, nothing written.
  rmSync(join(dist, 'version.json'));
  rmSync(join(dist, 'version.json.sig'));
  const env = { ...process.env };
  delete env.CIRRUS_SIGNING_KEY;
  await expect(run(process.execPath, [script, dist], { env })).rejects.toThrow();
  writeFileSync(join(dist, 'latest.yml'), latest(createHash('sha512').update('autre').digest('base64')));
  await expect(run(process.execPath, [script, dist], { env: { ...process.env, CIRRUS_SIGNING_KEY: pem } })).rejects.toThrow();
  expect(existsSync(join(dist, 'version.json'))).toBe(false);
  expect(existsSync(join(dist, 'version.json.sig'))).toBe(false);
});

test('cle-de-signature.mjs (D4 ; revue, M4) : la clé publique écrite dans key.ts ; la privée jamais sur une sortie qui n’est pas un terminal, mais dans le fichier neuf que nomme --fichier ; une clé déjà là n’est remplacée qu’à la demande', async () => {
  setUp();
  const copy = join(dir, 'key.ts'), original = join(import.meta.dirname, '..', 'src', 'main', 'update', 'key.ts');
  // A key.ts as before the pair is made: the repository's own carries the user's key since 2ca1817.
  const before = readFileSync(original, 'utf8');
  writeFileSync(copy, before.replace(/(UPDATE_PUBLIC_KEY: string = ')[^']*'/, (_, head: string) => `${head}${KEY_PLACEHOLDER}'`));
  expect(readFileSync(copy, 'utf8')).toContain(`= '${KEY_PLACEHOLDER}'`);
  const script = join(ROOT, 'deploy', 'cle-de-signature.mjs');
  // Its output a pipe (not a terminal), no --fichier: refused before anything is made; key.ts untouched.
  const refused = await run(process.execPath, [script, '--source', copy]).then(() => null, (e: { stdout: string; stderr: string }) => e);
  expect(refused).not.toBeNull();
  expect(refused!.stderr).toMatch(/terminal/);
  expect(`${refused!.stdout}${refused!.stderr}`).not.toMatch(/PRIVATE KEY/);
  expect(readFileSync(copy, 'utf8')).toContain(`= '${KEY_PLACEHOLDER}'`);
  // --fichier: the private key in that new file, never on the output.
  const pemFile = join(dir, 'cle-privee.pem');
  const { stdout } = await run(process.execPath, [script, '--source', copy, '--fichier', pemFile]);
  expect(stdout).not.toMatch(/PRIVATE KEY/);
  expect(stdout).toMatch(/EFFACE/);
  const pem = readFileSync(pemFile, 'utf8');
  expect(pem).toMatch(/^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\n$/);
  const pub = /UPDATE_PUBLIC_KEY(?:: string)? = '([^']*)'/.exec(readFileSync(copy, 'utf8'))?.[1];
  expect(pub).toBeDefined();
  expect(pub).not.toBe(KEY_PLACEHOLDER);
  // The pair is one: what the private key signs, the public key in key.ts verifies.
  const text = manifestText();
  const sig = sign(null, Buffer.from(text), pem).toString('base64');
  expect(verifyManifest(text, sig, pub!)).not.toBeNull();
  expect(verify(null, Buffer.from(text), { key: Buffer.from(pub!, 'base64'), format: 'der', type: 'spki' }, Buffer.from(sig, 'base64'))).toBe(true);
  // Nothing else written.
  expect(readdirSync(dir).sort()).toEqual(['Cirrus Setup 0.1.2.exe', 'cle-privee.pem', 'key.ts']);
  // Again: a key already in key.ts is refused, key.ts untouched; with --remplacer, but a --fichier that exists: refused,
  // neither the file nor key.ts changed; with a new file, a new pair.
  await expect(run(process.execPath, [script, '--source', copy, '--fichier', join(dir, 'autre.pem')])).rejects.toThrow();
  expect(readFileSync(copy, 'utf8')).toContain(pub!);
  await expect(run(process.execPath, [script, '--source', copy, '--fichier', pemFile, '--remplacer'])).rejects.toThrow();
  expect(readFileSync(pemFile, 'utf8')).toBe(pem);
  expect(readFileSync(copy, 'utf8')).toContain(pub!);
  await run(process.execPath, [script, '--source', copy, '--fichier', join(dir, 'autre.pem'), '--remplacer']);
  expect(readFileSync(copy, 'utf8')).not.toContain(pub!);
  // The repository's key.ts never touched by these runs.
  expect(readFileSync(original, 'utf8')).toBe(before);
});
