import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalStore, filePath } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { fileResponse } from '../src/main/files.ts';
import { SyncClient } from '../src/main/sync/client.ts';
import { fileSecrets } from '../src/main/sync/config.ts';
import { fileUrl } from '../src/renderer/files/kind.ts';
import { ReadError, readHead } from '../src/renderer/files/read.ts';
import { PLAIN, TEST_PARAMS } from './support/virtualPc.ts';

// cirrus-file: with a server (plan 5a, task 4, D6): a blob absent from the store — a PDF at its first reading — is
// fetched from the server (SyncClient.fetchBlob), checked against its hash, kept, then served; offline, 503; a
// thumbnail's request (?vignette) never downloads.

const dirs: string[] = [];
const stores: LocalStore[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const s of stores.splice(0)) s.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const PDF = new TextEncoder().encode('%PDF-1.4\n% un PDF du serveur\n%%EOF\n');
const HASH = createHash('sha256').update(PDF).digest('hex');
const REF = { name: 'Article.pdf', hash: HASH, size: PDF.length };

/**
 * A base paired with a fake server, which serves PDF's bytes at /files/<HASH> (altered when `corrupt`), or is
 * unreachable (`down`); its client stopped, as fetchBlob works without a connection. Every request is recorded.
 */
function paired() {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-fichiers-'));
  dirs.push(dir);
  const store = LocalStore.open(dir, { pc: 'pc-a' });
  stores.push(store);
  const secrets = fileSecrets(dir, PLAIN);
  secrets.write({ url: 'http://127.0.0.1:9', token: 'jeton', name: 'Portable' });
  const net = { requests: [] as string[], down: false, corrupt: false };
  const fake: typeof fetch = async (input, init) => {
    const url = String(input);
    net.requests.push(url);
    if (net.down) throw new TypeError('fetch failed');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer jeton');
    if (!url.endsWith(`/files/${HASH}`)) return new Response('{"error":"Fichier absent du serveur."}', { status: 404 });
    const bytes = net.corrupt ? PDF.map((b, i) => (i === 3 ? b ^ 1 : b)) : PDF;
    return new Response(bytes, { status: 200, headers: { 'Content-Length': String(bytes.length) } });
  };
  const client = new SyncClient({
    fetch: fake, store, storeDir: dir, secrets, reconcile: async () => {}, now: Date.now, params: () => TEST_PARAMS, status: () => {},
  });
  const get = (url: string, range?: string) =>
    Promise.resolve(fileResponse(dir, join(dir, 'cache'), new Request(url, { headers: range ? { Range: range } : {} }), (h) => client.fetchBlob(h)));
  return { dir, net, client, get };
}

test('un PDF absent : demandé au serveur, vérifié, gardé, puis servi (une plage aussi) ; la fois suivante, sans le serveur', async () => {
  const { dir, net, get } = paired();
  const res = await get(fileUrl(REF), 'bytes=0-3');
  expect(res.status).toBe(206);
  expect(new TextDecoder().decode(await res.arrayBuffer())).toBe('%PDF');
  expect(existsSync(filePath(dir, REF))).toBe(true);
  expect(net.requests).toEqual([`http://127.0.0.1:9/files/${HASH}`]);
  const again = await get(fileUrl(REF));
  expect([again.status, (await again.arrayBuffer()).byteLength, net.requests.length]).toEqual([200, PDF.length, 1]);
});

test('des octets qui ne sont pas ceux de l’empreinte sont refusés : rien de gardé, 503', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const { dir, net, get } = paired();
  net.corrupt = true;
  expect((await get(fileUrl(REF))).status).toBe(503);
  expect(existsSync(filePath(dir, REF))).toBe(false);
  expect(readdirSync(dir).some((f) => f.startsWith('.import-'))).toBe(false);
  expect(warn).toHaveBeenCalled();
});

test('hors ligne : 503 ; une vignette ne télécharge jamais (404, sans requête) ; sans serveur jumelé, 404 comme avant', async () => {
  const { dir, net, get } = paired();
  net.down = true;
  expect((await get(fileUrl(REF))).status).toBe(503);
  net.down = false;
  expect((await get(fileUrl(REF, { thumbnail: true }))).status).toBe(404);
  expect(net.requests).toHaveLength(1);
  // Unpaired: no fetchBlob; the protocol answers as in plan 4c.
  const alone = await Promise.resolve(fileResponse(dir, join(dir, 'cache'), new Request(fileUrl(REF)), null));
  expect(alone.status).toBe(404);
  expect(net.requests).toHaveLength(1);
});

test('le lecteur : « PDF pas encore téléchargé : serveur injoignable. » sur un 503 ; une vignette demande ?vignette', async () => {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => { asked.push(url); return new Response(null, { status: 503 }); });
  await expect(readHead(REF, 1024)).rejects.toEqual(new ReadError('PDF pas encore téléchargé : serveur injoignable.'));
  await expect(readHead({ name: 'notes.txt', hash: HASH, size: 3 }, 1024)).rejects.toEqual(new ReadError('« notes.txt » pas encore téléchargé : serveur injoignable.'));
  await expect(readHead(REF, 1024, undefined, { thumbnail: true })).rejects.toBeInstanceOf(ReadError);
  expect(asked.at(-1)).toBe(`${fileUrl(REF)}?vignette`);
  expect(fileUrl(REF, { thumbnail: true })).toBe(`cirrus-file://blob/${HASH}/Article.pdf?vignette`);
});
