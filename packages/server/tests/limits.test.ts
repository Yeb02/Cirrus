import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createPlan, emptyState } from '@cirrus/core';
import type { FetchFn } from '@cirrus/sources';
import { MAX_FILE_BYTES, MAX_SEED_BYTES, SERVER_IDLE_MS } from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, EventReader, newCode, pair, sha256, T0 } from './support.ts';

// The bounds of a server on the Internet (plan 9, task 1, D1, D8, Review Focus 1), on a small scale: the file and seed
// caps and the idle delay brought down, the ping brought under the idle delay as it is in bounds.ts, so that a test
// reaches them in a moment. An upload past its cap gets its 413, a silent one is cut, neither leaves anything behind;
// what is long but not silent (an event stream, an import of a publication) is not cut.

vi.mock('../src/bounds.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bounds.ts')>()),
  MAX_FILE_BYTES: 64 * 1024,
  MAX_SEED_BYTES: 64 * 1024,
  SERVER_IDLE_MS: 400,
  SSE_PING_MS: 100,
}));

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-bornes-'));
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(sources?: Parameters<typeof startServer>[0]['sources']): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0, sources });
  running.push(s);
  return s;
}

async function paired(url: string, pc: string): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, pc, T0), pc, name: `Machine ${pc}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What a streamed upload came to: the answer (its status and body), or the connection ended without one, and when. */
interface Upload { status: number | null; body: string; error: string | null; ms: number }

/**
 * A body sent by pieces of « a », its length not announced (chunked), up to `total` bytes — as a client streams a file.
 * Two kinds of client: one that sends its whole body before it reads the answer (as Chromium's uploads do), done once
 * both are through, and one that stops at the answer (`stopOnAnswer`, as Node's fetch). `stallAfter`: the bytes after
 * which it says nothing more, its connection kept open. Resolves with the answer, or the connection ended (`error`: its
 * code; an answer may have come before); `limitMs` past, it gives up. Written on a plain socket: Node's own client stops
 * sending once an answer has come whole, which neither kind does.
 */
function upload(
  url: string, method: string, path: string, headers: Record<string, string>, opts: { total: number; stallAfter?: number; stopOnAnswer?: boolean; limitMs?: number },
): Promise<Upload> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = connect(Number(port), hostname);
    let settled = false, answer: { status: number; body: string } | null = null, sentAll = false, received = Buffer.alloc(0);
    const done = (error: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(limit);
      socket.destroy();
      resolve({ status: answer?.status ?? null, body: answer?.body ?? '', error, ms: Date.now() - t0 });
    };
    const through = () => {
      if (answer && (sentAll || opts.stopOnAnswer)) done(null);
    };
    const limit = setTimeout(() => done('toujours ouverte'), opts.limitMs ?? 5000);
    // The answer: its status line, its headers, then Content-Length bytes (the server's every answer has it, or none).
    socket.on('data', (d: Buffer) => {
      received = Buffer.concat([received, d]);
      const end = received.indexOf('\r\n\r\n');
      if (answer || end < 0) return;
      const head = received.subarray(0, end).toString('latin1');
      const length = Number(/^content-length:\s*(\d+)$/im.exec(head)?.[1] ?? 0);
      if (received.length < end + 4 + length) return;
      answer = { status: Number(head.split(' ')[1]), body: received.subarray(end + 4, end + 4 + length).toString('utf8') };
      through();
    });
    socket.on('error', (e: NodeJS.ErrnoException) => done(e.code ?? e.message));
    socket.on('close', () => done('fermée'));
    socket.write(`${method} ${path} HTTP/1.1\r\nHost: ${hostname}:${port}\r\n${Object.entries(headers).map(([k, v]) => `${k}: ${v}\r\n`).join('')}Transfer-Encoding: chunked\r\n\r\n`);
    const piece = Buffer.alloc(4096, 0x61);
    let sent = 0;
    const pump = () => {
      while (!settled && sent < opts.total) {
        if (opts.stallAfter !== undefined && sent >= opts.stallAfter) return;
        if (opts.stopOnAnswer && answer) return;
        const n = Math.min(piece.length, opts.total - sent);
        sent += n;
        if (!socket.write(Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), piece.subarray(0, n), Buffer.from('\r\n')]))) {
          socket.once('drain', pump);
          return;
        }
      }
      if (settled || sent < opts.total) return;
      socket.write('0\r\n\r\n', () => {
        sentAll = true;
        through();
      });
    };
    pump();
  });
}

const filesDir = () => join(dir, 'base', 'files');
/** Every file under the store's files, by its path there: blobs and temporaries. */
const stored = () => (existsSync(filesDir())
  ? readdirSync(filesDir(), { recursive: true, withFileTypes: true }).filter((d) => d.isFile()).map((d) => relative(filesDir(), join(d.parentPath, d.name)))
  : []);

/** Waits until `check` holds, `ms` at most. */
async function until(check: () => boolean, ms = 3000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('jamais atteint');
    await sleep(20);
  }
}

test('les bornes de ce fichier sont petites (le reste du serveur les lit dans bounds.ts)', () => {
  expect([MAX_FILE_BYTES, MAX_SEED_BYTES, SERVER_IDLE_MS]).toEqual([64 * 1024, 64 * 1024, 400]);
});

test('413 en cours de route (D8) : un PUT /files sans longueur annoncée qui passe la borne reçoit 413, rien n’est gardé ; à la borne, il passe', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const auth = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream' };
  const path = `/files/${sha256('a'.repeat(MAX_FILE_BYTES + 1))}`;
  // A client that sends its whole body, then reads: the answer waits for it, the connection is not cut under it.
  for (const stopOnAnswer of [false, true]) {
    const over = await upload(url, 'PUT', path, auth, { total: 16 * MAX_FILE_BYTES, stopOnAnswer, limitMs: 2000 });
    expect(over, `stopOnAnswer ${stopOnAnswer}`).toMatchObject({ status: 413, error: null });
    expect(JSON.parse(over.body)).toEqual({ error: `Requête trop grosse : ${MAX_FILE_BYTES} octets au plus.` });
    // Neither the blob nor a temporary.
    await until(() => stored().length === 0);
  }
  // The server still serves, the same PC on a new connection; a file of exactly the cap passes.
  expect((await a.hello()).lastSeq).toBe(0);
  const hash = sha256('a'.repeat(MAX_FILE_BYTES));
  expect(await upload(url, 'PUT', `/files/${hash}`, auth, { total: MAX_FILE_BYTES })).toMatchObject({ status: 204, error: null });
  expect(stored()).toEqual([join(hash.slice(0, 2), hash)]);
});

test('413 en cours de route : un POST /seed sans longueur annoncée qui passe la borne reçoit 413, rien n’est gardé', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const headers = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream', 'Cirrus-Seq': '0' };
  for (const stopOnAnswer of [false, true]) {
    const over = await upload(url, 'POST', '/seed', headers, { total: 16 * MAX_SEED_BYTES, stopOnAnswer, limitMs: 2000 });
    expect(over, `stopOnAnswer ${stopOnAnswer}`).toMatchObject({ status: 413, error: null });
    expect(JSON.parse(over.body)).toEqual({ error: `Instantané trop gros : ${MAX_SEED_BYTES} octets au plus.` });
    await until(() => !existsSync(join(dir, 'seed')) || readdirSync(join(dir, 'seed')).length === 0);
  }
  expect((await a.hello()).empty).toBe(true);
});

test('inactivité (D1) : un envoi qui ne dit plus rien pendant SERVER_IDLE_MS est coupé, sans rien garder ; le serveur sert encore', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const stalled = await upload(url, 'PUT', `/files/${sha256('peu importe')}`, { Authorization: `Bearer ${a.token}` }, { total: MAX_FILE_BYTES, stallAfter: 8192, limitMs: 3000 });
  expect(stalled.status).toBeNull();
  expect(stalled.error).not.toBeNull();
  expect(stalled.error).not.toBe('toujours ouverte');
  expect(stalled.ms).toBeGreaterThanOrEqual(SERVER_IDLE_MS - 50);
  await until(() => stored().length === 0);
  expect((await a.hello()).lastSeq).toBe(0);
});

test('inactivité : un flux d’événements, que ses pings font parler, n’est pas coupé', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const reader = await EventReader.open(a);
  try {
    await sleep(SERVER_IDLE_MS * 4);
    expect(reader.closed).toBe(false);
    const s = emptyState();
    await a.units([a.unit(createPlan(s, 'P', 'plan'))]);
    expect((await reader.units(1)).map((u) => u.seq)).toEqual([1]);
  } finally {
    reader.close();
  }
});

test('inactivité : un import de publication plus long que le délai n’est pas coupé (ses propres délais le bornent)', async () => {
  // Every metadata request answered « introuvable », each after twice the idle delay.
  const slow: FetchFn = async () => {
    await sleep(SERVER_IDLE_MS * 2);
    return new Response('introuvable', { status: 404 });
  };
  const { url } = await start({ fetch: slow, open: null });
  const a = await paired(url, 'pc-a');
  const res = await a.send('POST', '/publications', { text: '10.1007/cirrus-introuvable', maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 10_000, pdfMaxMs: 60_000 });
  expect(res.status).toBe(200);
  expect(((await res.json()) as { ok: boolean }).ok).toBe(false);
});

test('redémarrage pendant un envoi (Review Focus 1) : l’envoi est coupé sans rien laisser, puis repris sur le serveur relancé', async () => {
  const s = await start();
  const a = await paired(s.url, 'pc-a');
  const hash = sha256('a'.repeat(8192));
  const cut = upload(s.url, 'PUT', `/files/${hash}`, { Authorization: `Bearer ${a.token}` }, { total: 8192 * 2, stallAfter: 4096 });
  // The temporary is there: the upload is under way.
  await until(() => stored().some((p) => p.startsWith('.import-')));
  running.splice(running.indexOf(s), 1);
  await s.close();
  expect((await cut).status).toBeNull();
  expect(stored()).toEqual([]);
  // Started again on the same data, the same PC (its token in serveur.db) sends it again.
  const again = await start();
  const b = new Client(again.url, a.token, 'pc-a');
  expect(await upload(again.url, 'PUT', `/files/${hash}`, { Authorization: `Bearer ${b.token}` }, { total: 8192 })).toMatchObject({ status: 204 });
  expect(stored()).toEqual([join(hash.slice(0, 2), hash)]);
});

test('arrêt brutal pendant un envoi : le temporaire qu’il laisse est ôté au démarrage suivant, les fichiers gardés', async () => {
  // As a server killed during an upload leaves them: a temporary of the store, beside a blob in place.
  const bytes = 'un fichier gardé', hash = sha256(bytes);
  mkdirSync(join(filesDir(), hash.slice(0, 2)), { recursive: true });
  writeFileSync(join(filesDir(), hash.slice(0, 2), hash), bytes);
  writeFileSync(join(filesDir(), '.import-0123456789abcdef'), 'a'.repeat(1000));
  await start();
  expect(stored()).toEqual([join(hash.slice(0, 2), hash)]);
});
