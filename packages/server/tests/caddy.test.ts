import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { request, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DRAIN_LINGER_MS, DRAIN_MAX_BYTES, DRAIN_MAX_MS, MAX_SMALL_BODY_MS, MIN_BODY_BYTES_PER_S, SERVER_HEADERS_TIMEOUT_MS, SERVER_IDLE_MS, SERVER_KEEP_ALIVE_MS, SERVER_REQUEST_TIMEOUT_MS,
  SSE_PING_MS,
} from '../src/bounds.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { Client, FORMAT, newCode, pair, T0 } from './support.ts';

// The server behind Caddy (plan 9, task 1, D1): Caddy carries HTTPS and passes the client's Host on; the server admits
// the names `--nom` gives it, and reads no X-Forwarded-* header. Its delays are explicit, and its event stream tells a
// proxy not to hold it back. The bounds on a small scale (413, idle): limits.test.ts; the command line: cli.test.ts.

/** Every HTTP server the server makes, as made: its delays are read on it (createServer passed through, unchanged). */
const servers = vi.hoisted(() => [] as Server[]);
vi.mock('node:http', async (importOriginal) => {
  const http = await importOriginal<typeof import('node:http')>();
  const createServer = (...args: unknown[]): Server => {
    const s = (http.createServer as (...a: unknown[]) => Server)(...args);
    servers.push(s);
    return s;
  };
  return { ...http, createServer };
});

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-caddy-'));
});
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

async function start(names?: string[]): Promise<RunningServer> {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0, names });
  running.push(s);
  return s;
}

async function paired(url: string, pc: string): Promise<Client> {
  const res = await pair(url, { code: newCode(dir, pc, T0), pc, name: `Machine ${pc}` });
  expect(res.status).toBe(200);
  return new Client(url, ((await res.json()) as { token: string }).token, pc);
}

/** A request carrying its own Host header, as Caddy passes the client's on (node:http: fetch sets it from the address). */
function call(url: string, host: string, path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url + path, { method: init.method ?? 'GET', headers: { ...init.headers, Host: host } }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode!, body }));
    });
    req.on('error', reject);
    req.end(init.body);
  });
}

// ---------------------------------------------------------------------------------------------------------------------
// The names it answers to

test('Caddy devant (D1) : un Host égal à un nom admis est servi, casse et port ignorés ; un autre est refusé, X-Forwarded-Host ignoré', async () => {
  const { url } = await start(['Cirrus.Exemple.fr']);
  const a = await paired(url, 'pc-a');
  const hello = (host: string, more: Record<string, string> = {}) => call(url, host, '/hello', { headers: { Authorization: `Bearer ${a.token}`, ...FORMAT, ...more } });
  for (const host of ['cirrus.exemple.fr', 'CIRRUS.Exemple.FR', 'cirrus.exemple.fr:443', '127.0.0.1', 'localhost:7310']) {
    expect((await hello(host)).status, host).toBe(200);
  }
  for (const host of ['autre.exemple.fr', 'exemple.fr', 'cirrus.exemple.fr.pirate.org', 'pirate.org', 'cirrus.exemple.fr.', 'cirrus.exemple.fr:']) {
    const res = await hello(host);
    expect(res.status, host).toBe(403);
    // The refusal names none of the server's names.
    expect(res.body, host).not.toContain('exemple.fr');
  }
  // What a proxy would say of the client is not trusted: only Host counts.
  expect((await hello('pirate.org', { 'X-Forwarded-Host': 'cirrus.exemple.fr', Forwarded: 'host=cirrus.exemple.fr' })).status).toBe(403);
  // Pairing, the route without a token, under the name too.
  const res = await call(url, 'cirrus.exemple.fr', '/pair', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ code: newCode(dir, 'pc-b', T0), pc: 'pc-b', name: 'Machine B' }),
  });
  expect(res.status).toBe(200);
});

test('Caddy devant (D1) : sans nom admis, le nom de domaine est refusé ; cette machine reste servie', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const hello = (host: string) => call(url, host, '/hello', { headers: { Authorization: `Bearer ${a.token}`, ...FORMAT } });
  expect((await hello('cirrus.exemple.fr')).status).toBe(403);
  expect((await hello('[::1]:7310')).status).toBe(200);
});

test('noms admis : un nom qui n’est pas un nom de domaine nu est refusé au démarrage, rien n’est créé ; 253 caractères passent', async () => {
  const label = 'a'.repeat(63);
  const longest = `${label}.${label}.${label}.${'b'.repeat(61)}`;
  expect(longest.length).toBe(253);
  const bad = [
    'https://cirrus.exemple.fr', 'cirrus.exemple.fr/installer', 'cirrus.exemple.fr:443', '', ' cirrus.exemple.fr', 'cirrus..exemple.fr', '-cirrus.exemple.fr',
    'cirrus-.exemple.fr', 'cirrus_x.exemple.fr', `${'a'.repeat(64)}.fr`, `${longest}c`, 'cirrus.exemple.fr.', 'moi@cirrus.exemple.fr', '*.exemple.fr', '[::1]',
    'cirrus.exemple.fr?x', 'cïrrus.exemple.fr',
  ];
  for (const name of bad) {
    await expect(startServer({ dataDir: dir, port: 0, names: [name] }), name).rejects.toThrow(/Nom/);
    await expect(startServer({ dataDir: dir, port: 0, names: ['cirrus.exemple.fr', name] }), name).rejects.toThrow(/Nom/);
  }
  expect(readdirSync(dir)).toEqual([]);
  const { url } = await start([longest, 'cirrus', '203.0.113.7']);
  const a = await paired(url, 'pc-a');
  for (const host of [longest.toUpperCase(), 'cirrus', '203.0.113.7:443']) {
    expect((await call(url, host, '/hello', { headers: { Authorization: `Bearer ${a.token}`, ...FORMAT } })).status, host).toBe(200);
  }
});

// ---------------------------------------------------------------------------------------------------------------------
// The stream and the delays

test('flux (D1) : l’en-tête X-Accel-Buffering: no, qu’un mandataire ne le retienne pas', async () => {
  const { url } = await start();
  const a = await paired(url, 'pc-a');
  const abort = new AbortController();
  const res = await fetch(`${url}/events`, { headers: { Authorization: `Bearer ${a.token}` }, signal: abort.signal });
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toMatch(/^text\/event-stream/);
  expect(res.headers.get('x-accel-buffering')).toBe('no');
  abort.abort();
});

test('délais (D1) : en-têtes 60 s, requête entière sans délai, connexion gardée 65 s, inactivité 2 min ; un ping bien avant', async () => {
  expect([SERVER_HEADERS_TIMEOUT_MS, SERVER_REQUEST_TIMEOUT_MS, SERVER_KEEP_ALIVE_MS, SERVER_IDLE_MS]).toEqual([60_000, 0, 65_000, 120_000]);
  // What follows an answer is read 1 Mio or 5 s at most; a JSON body arrives within 30 s, plus a second per 8 Kio (review, I1, I2).
  expect([DRAIN_MAX_BYTES, DRAIN_MAX_MS, DRAIN_LINGER_MS, MAX_SMALL_BODY_MS, MIN_BODY_BYTES_PER_S]).toEqual([2 ** 20, 5000, 1000, 30_000, 8192]);
  // An event stream says something well within the idle delay: it is never cut for silence.
  expect(SSE_PING_MS * 4).toBeLessThanOrEqual(SERVER_IDLE_MS);
  const before = servers.length;
  const { url } = await start();
  expect(servers.length).toBe(before + 1);
  const server = servers.at(-1)!;
  expect({ headers: server.headersTimeout, request: server.requestTimeout, keepAlive: server.keepAliveTimeout, idle: server.timeout })
    .toEqual({ headers: SERVER_HEADERS_TIMEOUT_MS, request: SERVER_REQUEST_TIMEOUT_MS, keepAlive: SERVER_KEEP_ALIVE_MS, idle: SERVER_IDLE_MS });
  // What a client is told of the connection kept.
  const res = await fetch(`${url}/hello`);
  await res.text();
  expect(res.headers.get('keep-alive')).toBe(`timeout=${SERVER_KEEP_ALIVE_MS / 1000}`);
});

