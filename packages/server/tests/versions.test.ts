import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { linkSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MAX_VERSION_FILE_BYTES } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, FORMAT, newCode, pair, T0 } from './support.ts';

// The signed updates on the server's side (plan 9, task 4, D4): GET /versions/version.json, its signature, latest.yml
// (electron-updater's) and the installer version.json names, served from <data>/versions/ with a paired PC's token
// only; a name is a plain one of that folder, a regular file there, neither a link nor a hard link, opened as it was
// checked. /hello says the official version it serves. The server checks no signature: the app does (D4).

/**
 * A file of versions/ swapped between its check (lstat) and its opening, as a writer of versions/ racing the server
 * could: lstat of `path` answers for `other`, a regular file of its own, while the file opened is `path`'s.
 */
const swap = vi.hoisted(() => ({ path: '', other: '' }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  const lstat = ((path: string, opts?: unknown) => fs.lstat(swap.path !== '' && path === swap.path ? swap.other : path, opts as never)) as typeof fs.lstat;
  return { ...fs, default: { ...fs, lstat }, lstat };
});

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-versions-'));
  swap.path = '';
  swap.other = '';
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

async function start(): Promise<{ url: string; a: Client }> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0 });
  running.push(s);
  const res = await pair(s.url, { code: newCode(dir, 'Portable', T0), pc: 'pc-a', name: 'DESKTOP-A' });
  expect(res.status).toBe(200);
  return { url: s.url, a: new Client(s.url, ((await res.json()) as { token: string }).token, 'pc-a') };
}

const versions = (...parts: string[]) => join(dir, 'versions', ...parts);

/** A file of versions/, as the server's update script lays them out (D6). */
function put(name: string, bytes: Buffer | string): void {
  mkdirSync(versions(), { recursive: true });
  writeFileSync(versions(name), bytes);
}

const INSTALLER = 'Cirrus Setup 0.1.7.exe';

/** A version published whole: its installer, version.json naming it, its signature, latest.yml. */
function publish(o: { version?: string; file?: string; bytes?: Buffer } = {}): { bytes: Buffer; manifest: string; sig: string; latest: string } {
  const bytes = o.bytes ?? randomBytes(4096), file = o.file ?? INSTALLER;
  put(file, bytes);
  const manifest = `${JSON.stringify({ version: o.version ?? '0.1.7', file, sha512: 'ab'.repeat(44), size: bytes.length, date: '2026-11-10T09:00:00.000Z' }, null, 2)}\n`;
  const sig = Buffer.alloc(64, 7).toString('base64'), latest = `version: ${o.version ?? '0.1.7'}\nfiles:\n  - url: ${file}\n    sha512: x\n    size: ${bytes.length}\npath: ${file}\n`;
  put('version.json', manifest);
  put('version.json.sig', sig);
  put('latest.yml', latest);
  return { bytes, manifest, sig, latest };
}

/** GET /versions/<name>, the name percent-encoded as electron-updater's URL makes it (spaces as %20). */
const get = (c: Client, name: string) => c.get(`/versions/${encodeURIComponent(name)}`);

test('/hello (D4) : la version officielle que sert le serveur, lue dans versions/version.json ; null sans elle', async () => {
  const { a } = await start();
  expect(await a.hello()).toEqual({ serverTime: T0, lastSeq: 0, empty: true, nodes: 0, baseId: expect.any(String), version: null });
  mkdirSync(versions());
  expect((await a.hello()).version).toBeNull();
  publish({ version: '0.1.42' });
  expect((await a.hello()).version).toBe('0.1.42');
  // Read at each hello: the update script lays a new one down while the server runs.
  publish({ version: '0.1.43' });
  expect((await a.hello()).version).toBe('0.1.43');
});

test('/hello : une version qui n’est pas x.y.z, un manifeste abîmé ou trop gros, un lien dur : null, et le reste du hello répond', async () => {
  const { a } = await start();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const text of [
    '{', '[]', 'null', '"0.1.7"', JSON.stringify({ version: 7 }), JSON.stringify({ version: '0.1' }), JSON.stringify({ version: '0.1.7-beta' }),
    JSON.stringify({ version: 'v0.1.7' }), JSON.stringify({ version: '0.1.7 ' }), JSON.stringify({ version: '01.1.7' }), JSON.stringify({ version: `0.1.${'9'.repeat(20)}` }),
    `${JSON.stringify({ version: '0.1.7' })}${' '.repeat(MAX_VERSION_FILE_BYTES)}`,
  ]) {
    put('version.json', text);
    const hello = await a.hello();
    expect(hello.version, text.slice(0, 40)).toBeNull();
    expect(hello.lastSeq).toBe(0);
  }
  // A hard link as version.json: not read either.
  writeFileSync(join(dir, 'ailleurs.json'), JSON.stringify({ version: '9.9.9' }));
  rmSync(versions('version.json'));
  linkSync(join(dir, 'ailleurs.json'), versions('version.json'));
  expect((await a.hello()).version).toBeNull();
  expect(warn).toHaveBeenCalled();
});

test('/versions/* (D4) : sans jeton, ou avec un jeton inconnu, 401, quel que soit le nom ; rien ne sort', async () => {
  const { url } = await start();
  const { bytes } = publish();
  const stranger = new Client(url, 'x'.repeat(43), 'pc-x');
  for (const name of ['version.json', 'version.json.sig', 'latest.yml', INSTALLER, '../serveur.db', 'absent.exe', '']) {
    const path = `/versions/${encodeURIComponent(name)}`;
    const bare = await fetch(url + path);
    expect(bare.status, name).toBe(401);
    expect(bare.headers.get('www-authenticate')).toBe('Bearer');
    expect(Buffer.from(await bare.arrayBuffer()).includes(bytes.subarray(0, 64))).toBe(false);
    expect((await stranger.get(path)).status, name).toBe(401);
  }
});

test('/versions/* (D4) : avec le jeton, version.json, sa signature, latest.yml et l’installateur, octet pour octet, leur longueur annoncée', async () => {
  const { a } = await start();
  const { bytes, manifest, sig, latest } = publish();
  for (const [name, want, type] of [['version.json', manifest, 'application/json'], ['version.json.sig', sig, 'text/plain'], ['latest.yml', latest, 'text/yaml']] as const) {
    const res = await get(a, name);
    expect(res.status, name).toBe(200);
    expect(res.headers.get('content-type')).toBe(`${type}; charset=utf-8`);
    expect(res.headers.get('content-length')).toBe(String(Buffer.byteLength(want)));
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(await res.text()).toBe(want);
  }
  // The installer, its name with spaces as electron-updater asks for it (%20), streamed whole.
  const res = await get(a, INSTALLER);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('application/octet-stream');
  expect(res.headers.get('content-length')).toBe(String(bytes.length));
  expect(Buffer.from(await res.arrayBuffer()).equals(bytes)).toBe(true);
});

test('/versions/* : un nom qui sort de versions/, un chemin, un autre fichier que ceux du manifeste, un absent : 404 ; un encodage abîmé : 400 ; rien ne sort', async () => {
  const { url, a } = await start();
  publish();
  const secret = 'SECRET : hors de versions/';
  writeFileSync(join(dir, 'x'), secret);
  put('autre.exe', secret);
  mkdirSync(versions('dossier'));
  writeFileSync(versions('dossier', 'x'), secret);
  for (const raw of ['..%2Fx', '..%5Cx', '%2E%2E', '.', 'dossier%2Fx', 'dossier%5Cx', 'dossier', 'C%3Ax', encodeURIComponent(join(dir, 'x')), 'autre.exe', 'absent.exe', 'serveur.db', 'version.json%00']) {
    const res = await a.get(`/versions/${raw}`);
    expect(res.status, raw).toBe(404);
    expect(await res.text(), raw).not.toContain('SECRET');
  }
  // The URL parser takes « .. » itself: what is left is no route of versions/.
  expect((await a.get('/versions/../x')).status).toBe(404);
  expect((await a.get('/versions/%E0%A4%A')).status).toBe(400);
  // The installer only once version.json names it, with its size.
  rmSync(versions('version.json'));
  expect((await get(a, INSTALLER)).status).toBe(404);
  // Another method than GET: 405, the token or not.
  const post = await fetch(`${url}/versions/version.json`, { method: 'POST', headers: { Authorization: `Bearer ${a.token}` } });
  expect(post.status).toBe(405);
  expect(post.headers.get('allow')).toBe('GET');
});

test('/versions/* et /installer : un lien dur dans versions/ vers un fichier d’ailleurs n’est jamais servi (nlink ≠ 1)', async () => {
  const { url, a } = await start();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { bytes } = publish();
  const secret = Buffer.from('SECRET : serveur.db, ou tout fichier que l’utilisateur cirrus lit');
  writeFileSync(join(dir, 'secret'), secret);
  // latest.yml, then the installer, each a hard link to the secret.
  rmSync(versions('latest.yml'));
  linkSync(join(dir, 'secret'), versions('latest.yml'));
  const latest = await get(a, 'latest.yml');
  expect(latest.status).toBe(404);
  expect(await latest.text()).not.toContain('SECRET');
  rmSync(versions(INSTALLER));
  linkSync(join(dir, 'secret'), versions(INSTALLER));
  put('version.json', JSON.stringify({ version: '0.1.7', file: INSTALLER, sha512: 'ab'.repeat(44), size: secret.length, date: 'x' }));
  const installer = await get(a, INSTALLER);
  expect(installer.status).toBe(404);
  expect(await installer.text()).not.toContain('SECRET');
  // The download page refuses it as well: a good code gets « Aucune version… », never the file.
  const code = newCode(dir, 'Fixe', T0);
  const page = await fetch(`${url}/installer`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${code}` });
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  const html = await page.text();
  expect(html).toContain('Aucune version n’est encore publiée sur ce serveur.');
  expect(html).not.toContain('SECRET');
  // Two names of one file inside versions/ count as well: the file is not served by either.
  rmSync(versions(INSTALLER));
  writeFileSync(versions(INSTALLER), bytes);
  put('version.json', JSON.stringify({ version: '0.1.7', file: INSTALLER, sha512: 'ab'.repeat(44), size: bytes.length, date: 'x' }));
  linkSync(versions(INSTALLER), versions('copie.exe'));
  expect((await get(a, INSTALLER)).status).toBe(404);
  rmSync(versions('copie.exe'));
  expect((await get(a, INSTALLER)).status).toBe(200);
  expect(warn).toHaveBeenCalled();
});

test('/versions/* et /installer : un fichier remplacé entre sa vérification et son ouverture (dev et ino différents) n’est pas servi', async () => {
  const { url, a } = await start();
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { bytes } = publish();
  put('leurre', 'un fichier ordinaire de versions/');
  // latest.yml checked as « leurre », then opened as itself: refused.
  swap.path = versions('latest.yml');
  swap.other = versions('leurre');
  expect((await get(a, 'latest.yml')).status).toBe(404);
  // The installer, the same way: neither /versions/ nor the download page serves it.
  swap.path = versions(INSTALLER);
  put('leurre', bytes);
  expect((await get(a, INSTALLER)).status).toBe(404);
  const code = newCode(dir, 'Fixe', T0);
  const page = await fetch(`${url}/installer`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: `code=${code}` });
  expect(page.headers.get('content-type')).toBe('text/html; charset=utf-8');
  // No swap: served.
  swap.path = '';
  expect((await get(a, 'latest.yml')).status).toBe(200);
  expect((await get(a, INSTALLER)).status).toBe(200);
  expect(warn).toHaveBeenCalled();
});

test('/versions/* : un fichier de version plus gros que MAX_VERSION_FILE_BYTES n’est pas servi', async () => {
  const { a } = await start();
  publish();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  put('latest.yml', 'x'.repeat(MAX_VERSION_FILE_BYTES + 1));
  expect((await get(a, 'latest.yml')).status).toBe(404);
  put('latest.yml', 'x'.repeat(MAX_VERSION_FILE_BYTES));
  expect((await get(a, 'latest.yml')).status).toBe(200);
});

test('/versions/* : un Host étranger est refusé (403) avant le jeton', async () => {
  const { url, a } = await start();
  publish();
  const status = await new Promise<number>((resolve, reject) => {
    const req = request(`${url}/versions/version.json`, { headers: { Host: 'cirrus.exemple.org', Authorization: `Bearer ${a.token}`, ...FORMAT } }, (res) => {
      res.resume();
      resolve(res.statusCode!);
    });
    req.on('error', reject);
    req.end();
  });
  expect(status).toBe(403);
});
