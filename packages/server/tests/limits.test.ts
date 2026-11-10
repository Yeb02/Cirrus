import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { createPlan, emptyState } from '@cirrus/core';
import type { FetchFn } from '@cirrus/sources';
import {
  DRAIN_MAX_BYTES, DRAIN_MAX_MS, MAX_FILE_BYTES, MAX_SEED_BYTES, MAX_SMALL_BODY_MS, MIN_BODY_BYTES_PER_S, SERVER_IDLE_MS,
} from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, EventReader, FORMAT, newCode, pair, sha256, T0 } from './support.ts';

// The bounds of a server on the Internet (plan 9, task 1, D1, D8, Review Focus 1), on a small scale: the file and seed
// caps, the idle delay, the drain after an answer and the deadline of a JSON body brought down, the ping brought under
// the idle delay as it is in bounds.ts, so that a test reaches them in a moment. An upload past its cap gets its 413, a
// silent one is cut, neither leaves anything behind; what is long but not silent (an event stream, an import of a
// publication) is not cut; what follows a refusal is read within bounds, then the connection is cut, token or not.

vi.mock('../src/bounds.ts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/bounds.ts')>()),
  MAX_FILE_BYTES: 64 * 1024,
  MAX_SEED_BYTES: 64 * 1024,
  SERVER_IDLE_MS: 400,
  SSE_PING_MS: 100,
  DRAIN_MAX_BYTES: 32 * 1024,
  DRAIN_MAX_MS: 800,
  DRAIN_LINGER_MS: 200,
  MAX_SMALL_BODY_MS: 400,
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
 * which it says nothing more, its connection kept open; `pauseMs`: a pause after each piece (a slow line). Resolves with
 * the answer, or the connection ended (`error`: its code; an answer may have come before); `limitMs` past, it gives up.
 * Written on a plain socket: Node's own client stops sending once an answer has come whole, which neither kind does.
 */
function upload(
  url: string, method: string, path: string, headers: Record<string, string>,
  opts: { total: number; stallAfter?: number; stopOnAnswer?: boolean; pauseMs?: number; limitMs?: number },
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
        if (opts.pauseMs !== undefined && sent < opts.total) {
          setTimeout(pump, opts.pauseMs);
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

/**
 * What a raw connection came to: the status of its first answer, and of every answer, the bytes of body it wrote, when
 * the server cut it (null: still open).
 */
interface Raw { status: number | null; statuses: number[]; sent: number; closedMs: number | null }

/** A chunk of `n` bytes of « a », framed. */
const chunk = (n: number) => Buffer.concat([Buffer.from(`${n.toString(16)}\r\n`), Buffer.alloc(n, 0x61), Buffer.from('\r\n')]);

/**
 * A raw connection: `head` written, then, for `windowMs` or until the server cuts it, a body: `flood`, `lead` chunks of
 * 4 Kio, then — the answer read, as a client that reads while it sends — chunks of 64 Kio at full speed (the answer's
 * bytes are not lost to the reset that cuts the connection: Windows drops what a socket has not read yet); `trickle`
 * written every `everyMs`; or nothing (`silent`).
 */
function raw(
  url: string, head: string, opts: { windowMs: number; body: { flood: true; lead?: number } | 'silent' | { trickle: string; everyMs: number } },
): Promise<Raw> {
  const { hostname, port } = new URL(url);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const socket = connect(Number(port), hostname);
    let got = '', sent = 0, closedMs: number | null = null, timer: NodeJS.Timeout | undefined, answered: (() => void) | null = null;
    socket.on('data', (d: Buffer) => {
      got += d.toString('latin1');
      answered?.();
    });
    /** Done: cut by the server, or the window over. */
    const done = () => {
      clearInterval(timer);
      clearTimeout(limit);
      const statuses = [...got.matchAll(/HTTP\/1\.1 (\d{3})/g)].map((m) => Number(m[1]));
      resolve({ status: statuses[0] ?? null, statuses, sent, closedMs });
      socket.destroy();
    };
    const limit = setTimeout(done, opts.windowMs);
    socket.on('error', () => { closedMs ??= Date.now() - t0; });
    socket.on('close', () => {
      closedMs ??= Date.now() - t0;
      done();
    });
    socket.write(head);
    const body = opts.body;
    if (typeof body === 'object' && 'flood' in body) {
      for (let i = 0; i < (body.lead ?? 0); i++) {
        sent += 4096;
        socket.write(chunk(4096));
      }
      const frame = chunk(0x10000);
      const pump = () => {
        while (closedMs === null && Date.now() - t0 < opts.windowMs) {
          sent += 0x10000;
          if (!socket.write(frame)) {
            socket.once('drain', pump);
            return;
          }
        }
      };
      answered = () => {
        answered = null;
        pump();
      };
    } else if (body !== 'silent') {
      timer = setInterval(() => {
        if (closedMs !== null) return;
        sent += body.trickle.length;
        socket.write(body.trickle);
      }, body.everyMs);
    }
  });
}

/** What the kernel's buffers of a loopback connection take on their own, the server reading nothing: generous. */
const KERNEL_SLACK = 32 * 2 ** 20;

test('les bornes de ce fichier sont petites (le reste du serveur les lit dans bounds.ts)', () => {
  expect([MAX_FILE_BYTES, MAX_SEED_BYTES, SERVER_IDLE_MS, DRAIN_MAX_BYTES, DRAIN_MAX_MS, MAX_SMALL_BODY_MS]).toEqual([64 * 1024, 64 * 1024, 400, 32 * 1024, 800, 400]);
});

test('vidange bornée (relecture, I1) : après une réponse, avec ou sans jeton, le corps qui suit est lu DRAIN_MAX_BYTES au plus, puis la connexion coupée', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const { host } = new URL(url);
  const head = (line: string, more = '', name = host) => `${line}\r\nHost: ${name}\r\n${more}Transfer-Encoding: chunked\r\n\r\n`;
  const json = 'Content-Type: application/json\r\n', token = `Authorization: Bearer ${a.token}\r\n`;
  const format = Object.entries(FORMAT).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  // [case, head, status, 4 Kio chunks sent before the answer comes: 2 past /pair's cap, 17 past the file's]
  const cases: [string, string, number, number][] = [
    ['401 sans jeton', head('POST /units HTTP/1.1', json), 401, 0],
    ['403 un autre hôte', head('POST /units HTTP/1.1', json, 'pirate.example'), 403, 0],
    ['404', head('POST /inconnue HTTP/1.1'), 404, 0],
    ['405', head('PUT /pair HTTP/1.1'), 405, 0],
    ['413 /pair', head('POST /pair HTTP/1.1', json), 413, 2],
    ['401 /files', head(`PUT /files/${'0'.repeat(64)} HTTP/1.1`), 401, 0],
    ['413 /files avec jeton', head(`PUT /files/${'0'.repeat(64)} HTTP/1.1`, token), 413, 17],
    ['200 /hello avec jeton, un corps qu’il ne lit pas', head('GET /hello HTTP/1.1', token + format), 200, 0],
  ];
  for (const [name, text, status, lead] of cases) {
    const r = await raw(url, text, { windowMs: 2000, body: { flood: true, lead } });
    expect(r.status, name).toBe(status);
    // Cut by the byte bound, well before the time bound.
    expect(r.closedMs, name).not.toBeNull();
    expect(r.closedMs!, name).toBeLessThan(DRAIN_MAX_MS);
    expect(r.sent, name).toBeLessThan(DRAIN_MAX_BYTES + KERNEL_SLACK);
  }
  // The server still serves.
  expect((await a.hello()).lastSeq).toBe(0);
}, 30_000);

test('vidange bornée dans le temps (relecture, I1) : un refus suivi d’un corps au compte-gouttes, la connexion coupée après DRAIN_MAX_MS', async () => {
  const { url } = await start();
  const { host } = new URL(url);
  const head = `POST /units HTTP/1.1\r\nHost: ${host}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n`;
  const r = await raw(url, head, { windowMs: 3 * DRAIN_MAX_MS, body: { trickle: '1\r\na\r\n', everyMs: 100 } });
  expect(r.status).toBe(401);
  expect(r.closedMs).not.toBeNull();
  expect(r.closedMs!).toBeGreaterThanOrEqual(DRAIN_MAX_MS - 50);
  expect(r.closedMs!).toBeLessThan(2 * DRAIN_MAX_MS);
});

test('corps JSON lent (relecture, I2) : au compte-gouttes, /pair comme une route à jeton reçoit 408 à son échéance, puis la connexion est coupée', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const { host } = new URL(url);
  // 4 000 bytes announced: the deadline is MAX_SMALL_BODY_MS, and a second per MIN_BODY_BYTES_PER_S of them.
  const deadline = MAX_SMALL_BODY_MS + (4000 / MIN_BODY_BYTES_PER_S) * 1000;
  for (const [line, more] of [['POST /pair HTTP/1.1', ''], ['POST /units HTTP/1.1', `Authorization: Bearer ${a.token}\r\n`]]) {
    const head = `${line}\r\nHost: ${host}\r\n${more}Content-Type: application/json\r\nContent-Length: 4000\r\n\r\n{`;
    // A byte every quarter of the idle delay: never silent long enough to be cut for it.
    const r = await raw(url, head, { windowMs: deadline + 1500, body: { trickle: ' ', everyMs: SERVER_IDLE_MS / 4 } });
    expect(r.status, line).toBe(408);
    expect(r.closedMs, line).not.toBeNull();
    expect(r.closedMs!, line).toBeGreaterThanOrEqual(deadline - 50);
    expect(r.closedMs!, line).toBeLessThan(deadline + 1000);
  }
  // A body that comes in time passes, and the server still serves.
  expect(await a.units([])).toEqual([]);
});

test('413 en cours de route (D8) : un PUT /files sans longueur annoncée qui passe la borne reçoit 413, rien n’est gardé ; à la borne, il passe', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const auth = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream' };
  const path = `/files/${sha256('a'.repeat(MAX_FILE_BYTES + 1))}`;
  // A client that sends its whole body, then reads: the answer waits for it, the connection is not cut under it while
  // what follows stays under DRAIN_MAX_BYTES.
  for (const stopOnAnswer of [false, true]) {
    const over = await upload(url, 'PUT', path, auth, { total: MAX_FILE_BYTES + 16 * 1024, stopOnAnswer, limitMs: 2000 });
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

test('un fichier que le serveur a déjà, renvoyé entier (deux PC à la fois) : 204, ses octets lus jusqu’au bout, pas laissés à la vidange', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const auth = { Authorization: `Bearer ${a.token}` }, hash = sha256('a'.repeat(MAX_FILE_BYTES));
  // A file longer than what a drain reads.
  expect(DRAIN_MAX_BYTES).toBeLessThan(MAX_FILE_BYTES);
  expect(await upload(url, 'PUT', `/files/${hash}`, auth, { total: MAX_FILE_BYTES })).toMatchObject({ status: 204, error: null });
  // Sent again whole, and a request behind it on the same connection: both answered, the connection kept.
  const { host } = new URL(url);
  const format = Object.entries(FORMAT).map(([k, v]) => `${k}: ${v}\r\n`).join('');
  const again = Buffer.concat([
    Buffer.from(`PUT /files/${hash} HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${a.token}\r\nTransfer-Encoding: chunked\r\n\r\n`),
    ...Array.from({ length: MAX_FILE_BYTES / 4096 }, () => chunk(4096)),
    Buffer.from(`0\r\n\r\nGET /hello HTTP/1.1\r\nHost: ${host}\r\nAuthorization: Bearer ${a.token}\r\n${format}\r\n`),
  ]);
  const r = await raw(url, again.toString('latin1'), { windowMs: 1000, body: 'silent' });
  expect(r).toMatchObject({ statuses: [204, 200], closedMs: null });
  // Past the cap, even so: 413.
  expect(await upload(url, 'PUT', `/files/${hash}`, auth, { total: MAX_FILE_BYTES + 16 * 1024, stopOnAnswer: true })).toMatchObject({ status: 413 });
  expect(stored()).toEqual([join(hash.slice(0, 2), hash)]);
});

test('413 en cours de route : un POST /seed sans longueur annoncée qui passe la borne reçoit 413, rien n’est gardé', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const headers = { Authorization: `Bearer ${a.token}`, 'Content-Type': 'application/octet-stream', 'Cirrus-Seq': '0' };
  for (const stopOnAnswer of [false, true]) {
    const over = await upload(url, 'POST', '/seed', headers, { total: MAX_SEED_BYTES + 16 * 1024, stopOnAnswer, limitMs: 2000 });
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

test('un envoi lent (Review Focus 1) : plus long que plusieurs délais d’inactivité, mais jamais muet si longtemps, il passe', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  // 16 pieces, one every SERVER_IDLE_MS / 4: about four idle delays in all.
  const total = 16 * 4096, hash = sha256('a'.repeat(total));
  const slow = await upload(url, 'PUT', `/files/${hash}`, { Authorization: `Bearer ${a.token}` }, { total, pauseMs: SERVER_IDLE_MS / 4 });
  expect(slow).toMatchObject({ status: 204, error: null });
  expect(slow.ms).toBeGreaterThan(SERVER_IDLE_MS * 3);
  expect(stored()).toEqual([join(hash.slice(0, 2), hash)]);
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

test('inactivité : une requête en file derrière un import, sur la même connexion, retrouve le délai (relecture, M1)', async () => {
  const slow: FetchFn = async () => {
    await sleep(SERVER_IDLE_MS * 2);
    return new Response('introuvable', { status: 404 });
  };
  const { url } = await start({ fetch: slow, open: null });
  const a = await paired(url, 'pc-a');
  const { host } = new URL(url);
  const body = JSON.stringify({ text: '10.1007/cirrus-introuvable', maxKb: 64, maxPdfBytes: 2 ** 20, timeoutMs: 10_000, pdfMaxMs: 60_000 });
  const auth = `Host: ${host}\r\nAuthorization: Bearer ${a.token}\r\n`;
  const pub = `POST /publications HTTP/1.1\r\n${auth}Content-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`;
  // Behind it, a file whose body stalls after 4 bytes.
  const put = `PUT /files/${sha256('peu importe')} HTTP/1.1\r\n${auth}Transfer-Encoding: chunked\r\n\r\n4\r\nabcd\r\n`;
  const r = await raw(url, pub + put, { windowMs: 4000, body: 'silent' });
  expect(r.status).toBe(200);
  // The import's answer, then the stalled file cut after an idle delay.
  expect(r.closedMs).not.toBeNull();
  expect(r.closedMs!).toBeLessThan(3000);
  await until(() => stored().length === 0);
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

test('un temporaire qui ne s’ôte pas n’empêche pas le démarrage (relecture, M6) : un avertissement, il partira au suivant', async () => {
  // A temporary that cannot be removed as a file (another program holding it would do the same).
  mkdirSync(join(filesDir(), '.import-0123456789abcdef', 'dedans'), { recursive: true });
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    const { url } = await start();
    expect((await fetch(`${url}/hello`)).status).toBe(401);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('.import-0123456789abcdef'));
  } finally {
    warn.mockRestore();
  }
});
