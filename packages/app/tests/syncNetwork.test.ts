import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createNode, createPlan, MIN_BODY_BYTES_PER_S, type RemoteUnit } from '@cirrus/core';
import { filePath, LocalStore, storeBytes } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { SyncClient, type SyncParams } from '../src/main/sync/client.ts';
import { fileSecrets, SERVER_FILE, type ServerConfig, serverUrl, type SecretStore } from '../src/main/sync/config.ts';
import { Connection, JSON_BODY } from '../src/main/sync/connection.ts';
import type { SyncStatus } from '../src/main/sync/protocol.ts';
import { seedBase } from '../src/main/sync/seed.ts';
import { chipOf } from '../src/renderer/sync/syncSession.ts';
import { created, image, Lab, PLAIN, sleep, T0, TEST_PARAMS, until } from './support/virtualPc.ts';

// The sync on a real network (plan 9, task 2, D7): a delay on every request, an idle delay on the transfers, a silent
// stream held as cut, the writes received in bounded batches, the clock's offset kept between connections, and an
// address that names https. Every server here is started by the test on 127.0.0.1.

let lab: Lab | null = null;
const dirs: string[] = [];
const closing: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const close of closing.splice(0).reverse()) await close();
  await lab?.close();
  lab = null;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'cirrus-reseau-'));
  dirs.push(d);
  return d;
};
const bytes = (text: string) => new TextEncoder().encode(text);
const TOKEN = 't'.repeat(43);

/** A server's configuration kept in memory, as serveur.json would keep it. */
function memorySecrets(c: ServerConfig | null): SecretStore & { config: ServerConfig | null } {
  const s = {
    config: c,
    read: () => (s.config ? { ...s.config } : null),
    write: (x: ServerConfig | null) => { s.config = x ? { ...x } : null; },
  };
  return s;
}

/**
 * A server of this machine that answers as Cirrus's does — /hello, an event stream with a ping every `pingMs` — until
 * told otherwise: `mute`, it takes every new request and never answers, and its streams fall silent, none closed;
 * `silent`, only its streams fall silent. Each request logged: its route, when it came, when its connection closed.
 */
async function flakyServer(pingMs: number) {
  const state = { mode: 'ok' as 'ok' | 'mute' | 'silent' };
  const log: { path: string; at: number; closedAt: number | null }[] = [];
  const streams = new Set<ServerResponse>();
  const server = createServer((req, res) => {
    const entry = { path: new URL(req.url ?? '/', 'http://x').pathname, at: Date.now(), closedAt: null as number | null };
    log.push(entry);
    res.on('close', () => { entry.closedAt = Date.now(); });
    if (state.mode === 'mute') return;
    if (entry.path === '/hello') {
      res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ serverTime: Date.now(), lastSeq: 0, empty: false, nodes: 0, baseId: 'base-x' }));
    } else if (entry.path === '/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.flushHeaders();
      streams.add(res);
      res.on('close', () => streams.delete(res));
    } else {
      res.writeHead(404).end();
    }
  });
  const ping = setInterval(() => { if (state.mode === 'ok') for (const s of streams) s.write(': ping\n\n'); }, pingMs);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  closing.push(() => {
    clearInterval(ping);
    server.closeAllConnections();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { url: `http://127.0.0.1:${port}`, state, log, count: (path: string, after = 0) => log.filter((e) => e.path === path && e.at >= after).length };
}

/** A client of `url`, on a base of its own, Node's network, the test's settings over the lab's. */
function netClient(url: string, params: Partial<SyncParams>) {
  const dir = tempDir(), store = LocalStore.open(dir, { pc: 'pc-r' }), statuses: SyncStatus[] = [];
  closing.push(() => store.close());
  const client = new SyncClient({
    fetch, store, storeDir: dir, secrets: memorySecrets({ url, token: TOKEN, name: 'R' }), reconcile: async () => {}, now: Date.now,
    params: () => ({ ...TEST_PARAMS, ...params }), status: (s) => { statuses.push(s); },
  });
  closing.push(() => client.stop());
  return { client, statuses, last: () => statuses.at(-1) };
}

test('une adresse invalide : le message nomme https, et http://127.0.0.1 pour un serveur de cette machine', () => {
  const message = 'Adresse du serveur invalide : https://domaine (ou http://127.0.0.1:port pour un serveur de cette machine) attendu.';
  for (const bad of ['', 'ftp://127.0.0.1', 'cirrus.mondomaine.fr', 'https://cirrus.mondomaine.fr/cirrus', 'https://moi:secret@cirrus.mondomaine.fr', 'https://cirrus.mondomaine.fr/?a=1']) {
    expect(() => serverUrl(bad), bad).toThrow(new Error(message));
  }
  expect(serverUrl(' https://cirrus.mondomaine.fr/ ')).toBe('https://cirrus.mondomaine.fr');
  expect(serverUrl('http://127.0.0.1:7310')).toBe('http://127.0.0.1:7310');
});

test('un serveur qui ne répond plus, sans couper : le flux tenu pour coupé, chaque /hello abandonné après syncRequestTimeoutMs, « Hors ligne », puis la reconnexion quand il répond de nouveau', async () => {
  const server = await flakyServer(50);
  const { client, last } = netClient(server.url, { syncRequestTimeoutMs: 400, syncStreamSilenceMs: 700 });
  client.start();
  await until(() => last()?.state === 'live');
  server.state.mode = 'mute';
  const muted = Date.now();
  await until(() => last()?.state === 'offline', 8000, () => JSON.stringify(last()));
  // Held as cut once nothing came for syncStreamSilenceMs (the last ping, 50 ms at most before the server fell mute).
  expect(Date.now() - muted).toBeGreaterThanOrEqual(600);
  expect(chipOf(last()!, false)?.text).toBe('Hors ligne');
  // The hellos tried meanwhile: each given up after syncRequestTimeoutMs, its connection closed by the client.
  await until(() => server.log.filter((e) => e.path === '/hello' && e.at > muted && e.closedAt !== null).length >= 2, 8000);
  for (const h of server.log.filter((e) => e.path === '/hello' && e.at > muted && e.closedAt !== null)) {
    // 400 ms on the client's clock; the server's sees the close a little earlier or later (a loaded machine): a margin.
    expect(h.closedAt! - h.at).toBeGreaterThanOrEqual(300);
    expect(h.closedAt! - h.at).toBeLessThan(4000);
  }
  expect(last()?.state).toBe('offline');
  // It answers again: the next try connects.
  server.state.mode = 'ok';
  await until(() => last()?.state === 'live', 8000, () => JSON.stringify(last()));
}, 30_000);

test('un flux silencieux : coupé après syncStreamSilenceMs sans rien recevoir, puis rouvert ; un flux qui reçoit ses pings reste ouvert', async () => {
  const server = await flakyServer(50);
  const { client, statuses, last } = netClient(server.url, { syncRequestTimeoutMs: 400, syncStreamSilenceMs: 700 });
  client.start();
  await until(() => last()?.state === 'live');
  // Pinged every 50 ms: kept open well past syncStreamSilenceMs.
  await sleep(1500);
  expect(server.count('/events')).toBe(1);
  server.state.mode = 'silent';
  const silent = Date.now();
  await until(() => server.count('/events') === 2, 8000);
  // The silent one closed by the client, not left open beside the new one.
  await until(() => server.log.find((e) => e.path === '/events')!.closedAt !== null);
  const reopened = server.log.filter((e) => e.path === '/events').at(-1)!.at;
  expect(reopened - silent).toBeGreaterThanOrEqual(600);
  expect(statuses.some((s) => s.state === 'offline')).toBe(true);
  // Pinged again: the stream open now stays.
  server.state.mode = 'ok';
  await until(() => last()?.state === 'live');
  const streams = server.count('/events');
  await sleep(1500);
  expect(server.count('/events')).toBe(streams);
  expect(last()?.state).toBe('live');
}, 30_000);

test('un retard de 50 000 écritures : appliqué par lots de syncReceiveMaxUnits au plus, le flux lu seulement quand il y a de la place (mémoire bornée)', async () => {
  const N = 50_000, PER_CHUNK = 10, MAX = 500;
  /** The base's last server number, as the reconciliations write it. */
  let written = 0, produced = 0, peak = 0;
  const sizes: number[] = [];
  const unit = (seq: number) => ({ unit: `u${seq}`, action: `a${seq}`, label: 'Créer le plan « P »', at: T0, pc: 'pc-x', ops: [{ t: 'plan', before: null, after: { id: `p${seq}`, name: 'P', type: 'plan' } }], seq });
  // The server's stream: its frames made only as they are read, so that what the client holds is counted.
  const events = () => new ReadableStream<Uint8Array>({
    pull(c) {
      if (produced >= N) return new Promise<void>(() => {});
      let text = '';
      for (let i = 0; i < PER_CHUNK && produced < N; i++) text += `id: ${++produced}\nevent: unit\ndata: ${JSON.stringify(unit(produced))}\n\n`;
      peak = Math.max(peak, produced - written);
      c.enqueue(bytes(text));
    },
  }, { highWaterMark: 0 });
  const f: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/hello') return Response.json({ serverTime: T0, lastSeq: N, empty: false, nodes: N, baseId: 'base-x' });
    if (path === '/events') return new Response(events(), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error(`requête inattendue : ${path}`);
  };
  // The base as the client reads it: its last server number, nothing pending.
  const store = {
    baseId: () => 'base-x', setBaseId: () => {}, lastServerSeq: () => written, pendingCount: () => 0, pendingUnits: () => [],
  } as unknown as LocalStore;
  const statuses: SyncStatus[] = [];
  const client = new SyncClient({
    fetch: f, store, storeDir: tempDir(), secrets: memorySecrets({ url: 'http://127.0.0.1:7310', token: TOKEN, name: 'R' }), now: () => T0,
    params: () => ({ ...TEST_PARAMS, syncReceiveMaxUnits: MAX }), status: (s) => { statuses.push(s); },
    reconcile: async (incoming: RemoteUnit[]) => {
      sizes.push(incoming.length);
      // The interface's reconciliation and the base's transaction take their time.
      await sleep(1);
      written = incoming.at(-1)!.seq;
    },
  });
  closing.push(() => client.stop());
  client.start();
  await until(() => written === N, 30_000, () => `${written} écritures sur ${N}, ${sizes.length} lots`);
  expect(sizes.every((n) => n > 0 && n <= MAX), `lots : ${sizes.join(', ')}`).toBe(true);
  expect(sizes.reduce((a, b) => a + b, 0)).toBe(N);
  expect(sizes.length).toBeGreaterThanOrEqual(N / MAX);
  // Held at once, never more than a batch being reconciled, a batch waiting, and the frames of one chunk read.
  expect(peak).toBeLessThanOrEqual(2 * MAX + PER_CHUNK);
  await until(() => statuses.at(-1)?.state === 'live');
}, 60_000);

test('le rattrapage par le vrai serveur : par lots de syncReceiveMaxUnits écritures au plus, puis tout est là', async () => {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a'), b = await l.pc('pc-b', { start: false, params: { syncReceiveMaxUnits: 50 } });
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  for (let i = 0; i < 160; i++) a.act((s) => createNode(s, { plan: P, title: `n${i}`, x: (i % 20) * 250, y: Math.floor(i / 20) * 100, k: 0 }));
  await l.settle([a]);
  b.client.start();
  await l.settle();
  expect(image(b.s)).toBe(image(await l.state()));
  const sizes = b.reconciled.map((r) => r.incoming.length).filter((n) => n > 0);
  expect(sizes.every((n) => n <= 50), `lots : ${sizes.join(', ')}`).toBe(true);
  expect(sizes.reduce((x, y) => x + y, 0)).toBe(161);
}, 30_000);

test('l’écart d’horloge : gardé dans serveur.json quand il est mesuré, repris au démarrage suivant jusqu’au premier /hello, qui le mesure de nouveau', async () => {
  // serveur.json keeps it with the rest; an offset that is not a number is ignored, the server kept.
  const dir = tempDir(), secrets = fileSecrets(dir, PLAIN), url = 'http://127.0.0.1:7310';
  secrets.write({ url, token: TOKEN, name: 'R', clockOffsetMs: -600_000 });
  expect(secrets.read()).toEqual({ url, token: TOKEN, name: 'R', clockOffsetMs: -600_000 });
  const stored = JSON.parse(readFileSync(join(dir, SERVER_FILE), 'utf8')) as Record<string, unknown>;
  writeFileSync(join(dir, SERVER_FILE), JSON.stringify({ ...stored, clockOffsetMs: 'dix minutes' }));
  expect(secrets.read()).toEqual({ url, token: TOKEN, name: 'R' });
  secrets.write({ url, token: TOKEN, name: 'R', clockOffsetMs: -600_000 });
  // A client started on it: the offset kept, until its hello measures the server's clock again (4,321 s ahead).
  let answer: (() => void) | null = null;
  const f: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/hello') {
      await new Promise<void>((resolve) => { answer = resolve; });
      return Response.json({ serverTime: 1_004_321, lastSeq: 0, empty: false, nodes: 0, baseId: 'base-x' });
    }
    if (path === '/events') return new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error(`requête inattendue : ${path}`);
  };
  const store = LocalStore.open(tempDir(), { pc: 'pc-r' });
  closing.push(() => store.close());
  const make = () => new SyncClient({
    fetch: f, store, storeDir: tempDir(), secrets, reconcile: async () => {}, now: () => 1_000_000, params: () => TEST_PARAMS, status: () => {},
  });
  const first = make();
  closing.push(() => first.stop());
  expect(first.clockOffset()).toBe(-600_000);
  first.start();
  await until(() => answer !== null);
  expect(first.clockOffset()).toBe(-600_000);
  answer!();
  await until(() => first.connected());
  expect(first.clockOffset()).toBe(4321);
  expect(secrets.read()?.clockOffsetMs).toBe(4321);
  await first.stop();
  // The next start, before any hello: the last measure.
  const second = make();
  closing.push(() => second.stop());
  expect(second.clockOffset()).toBe(4321);
});

test('l’écart d’horloge repris : un PC en avance de 10 min, rouvert sans serveur, date ses actions à l’heure du serveur', async () => {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a', { skewMs: 10 * 60_000 });
  await l.settle();
  expect((JSON.parse(readFileSync(join(a.dir, SERVER_FILE), 'utf8')) as { clockOffsetMs?: number }).clockOffsetMs).toBe(-600_000);
  await l.stopServer();
  await a.restart();
  await until(() => a.status?.state === 'offline');
  expect(a.client.clockOffset()).toBe(-600_000);
  l.clock += 5000;
  const u = a.act((s) => createPlan(s, 'Hors ligne', 'plan'))!;
  expect(u.at).toBe(T0 + 5000);
}, 30_000);

test('un envoi de fichier qui s’arrête en route : abandonné après syncRequestTimeoutMs sans rien envoyer ni recevoir, « Hors ligne », puis repris en entier à la connexion suivante', async () => {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a', { params: { syncRequestTimeoutMs: 1000 } }), b = await l.pc('pc-b');
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  await l.settle();
  // A file of several chunks; its first sending stops once the network has taken the first: nothing more is taken,
  // nothing answered — until the client gives up.
  const data = new Uint8Array(300_000).map((_, i) => (i * 7) % 251);
  const file = storeBytes(a.dir, 'mesures.bin', data);
  let stall: { at: number; reason: unknown; abortedAt: number } | null = null;
  a.net.stalls = (method, path) => method === 'PUT' && path === `/files/${file.hash}` && stall === null;
  a.net.onStall = (s) => { stall = s; };
  const n = created(a.act((s) => createNode(s, { plan: P, title: 'Mesures', x: 0, y: 0, k: 0, files: [file] })), 'node');
  await until(() => a.status?.state === 'offline', 8000, () => JSON.stringify(a.status));
  await until(() => stall !== null && stall.abortedAt > 0);
  const st = stall!;
  expect(st.abortedAt - st.at).toBeGreaterThanOrEqual(900);
  expect(String((st.reason as Error)?.message ?? st.reason)).toMatch(/mesures|\/files\//);
  // Sent again, whole, at the next connection; the write follows it, and B gets the file.
  await l.settle();
  expect(a.net.count('PUT', `/files/${file.hash}`)).toBe(2);
  expect((await l.state()).nodes.get(n)?.files).toEqual([file]);
  await until(() => existsSync(filePath(b.dir, file)));
  expect(new Uint8Array(readFileSync(filePath(b.dir, file)))).toEqual(data);
}, 30_000);

/** A connection's requests on `f`, with the delay of `ms`. */
const connection = (f: typeof fetch, ms: number) =>
  new Connection({ url: 'http://127.0.0.1:7310', token: TOKEN, name: 'R' }, { fetch: f, params: () => ({ ...TEST_PARAMS, syncRequestTimeoutMs: ms }) });

/** A body of `n` chunks, each given after `everyMs` (the simulated clock). */
const slowBody = (n: number, everyMs: number) => {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    async pull(c) {
      await new Promise((r) => setTimeout(r, everyMs));
      if (i++ < n) c.enqueue(new Uint8Array(1000));
      else c.close();
    },
  }, { highWaterMark: 0 });
};

test('le délai d’une requête (horloge simulée) : toute la réponse, son corps lu, en syncRequestTimeoutMs ; dépassé, une panne du réseau (pas un refus), la requête abandonnée', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const signals: AbortSignal[] = [];
  // An answer that never comes.
  const never = connection(async (_input, init) => { signals.push(init!.signal!); return new Promise<Response>(() => {}); }, 500);
  const silent = never.request('/hello').then(() => 'répondu', (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(499);
  expect(signals[0].aborted).toBe(false);
  await vi.advanceTimersByTimeAsync(2);
  const e = await silent;
  expect(e).toBeInstanceOf(Error);
  expect((e as Error).constructor.name).not.toBe('Refusal');
  expect(signals[0].aborted).toBe(true);
  // An answer whose body takes longer than the delay, though it moves: cut too (an ordinary request is bounded whole).
  const slow = connection(async () => new Response(slowBody(10, 100)), 500);
  const read = slow.request('/status').then((r) => r.arrayBuffer()).then(() => 'lu', (x: unknown) => x);
  await vi.advanceTimersByTimeAsync(2000);
  expect(await read).toBeInstanceOf(Error);
  // The connection itself is not ended by a request's delay.
  expect(never.closed).toBe(false);
});

test('un transfert (horloge simulée) : aucun délai total, un délai d’inactivité — l’envoi et la réception qui avancent passent, au-delà de dix délais ; un arrêt de syncRequestTimeoutMs les abandonne', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Sent slowly: the network takes a chunk every 300 ms, for 6 s, then answers.
  const taken: number[] = [];
  const up = connection(async (_input, init) => {
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    for (;;) {
      await new Promise((r) => setTimeout(r, 300));
      const { done } = await reader.read();
      if (done) break;
      taken.push(Date.now());
    }
    return new Response(null, { status: 204 });
  }, 500);
  const blob = new Blob([new Uint8Array(20 * 65_536)]);
  const sent = up.request('/files/x', { method: 'PUT', body: blob }, { transfer: true }).then((r) => r.status, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await sent).toBe(204);
  expect(taken.length).toBeGreaterThanOrEqual(20);
  // Received slowly: a chunk every 300 ms for 6 s.
  const down = connection(async () => new Response(slowBody(20, 300)), 500);
  const got = down.request('/files/y', {}, { transfer: true }).then((r) => r.arrayBuffer()).then((b) => b.byteLength, (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(10_000);
  expect(await got).toBe(20_000);
  // The reader that pauses (the disk, a full inbox) is not the network: no delay runs while nothing is asked of it.
  const paused = connection(async () => new Response(slowBody(3, 10)), 500);
  const res = await paused.request('/files/z', {}, { transfer: true });
  const reader = res.body!.getReader();
  const first = reader.read();
  await vi.advanceTimersByTimeAsync(20);
  expect((await first).done).toBe(false);
  await vi.advanceTimersByTimeAsync(5000);
  const next = reader.read();
  await vi.advanceTimersByTimeAsync(20);
  expect((await next).done).toBe(false);
  // A transfer that stops: abandoned once nothing moved for the delay.
  const stuck = connection(async () => new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) })), 500);
  const stopped = stuck.request('/files/w', {}, { transfer: true }).then((r) => r.arrayBuffer()).then(() => 'lu', (e: unknown) => e);
  await vi.advanceTimersByTimeAsync(499);
  await vi.advanceTimersByTimeAsync(2);
  expect(await stopped).toBeInstanceOf(Error);
});

test('l’import d’une publication par le serveur (horloge simulée) : borné à 60 s plus publicationPdfMaxMs, et non à syncRequestTimeoutMs ; dépassé, ce PC l’importe lui-même', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const f: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/hello') return Response.json({ serverTime: Date.now(), lastSeq: 0, empty: false, nodes: 0, baseId: 'base-x' });
    if (path === '/events') return new Response(new ReadableStream({ pull: () => new Promise<void>(() => {}) }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    if (path === '/publications') return new Promise<Response>(() => {});
    throw new Error(`requête inattendue : ${path}`);
  };
  const store = LocalStore.open(tempDir(), { pc: 'pc-r' });
  closing.push(() => store.close());
  const client = new SyncClient({
    fetch: f, store, storeDir: tempDir(), secrets: memorySecrets({ url: 'http://127.0.0.1:7310', token: TOKEN, name: 'R' }), reconcile: async () => {}, now: () => Date.now(),
    params: () => ({ ...TEST_PARAMS, syncStreamSilenceMs: 3_600_000 }), status: () => {},
  });
  closing.push(() => client.stop());
  client.start();
  await vi.advanceTimersByTimeAsync(10);
  expect(client.connected()).toBe(true);
  let outcome: unknown = null;
  void client.publication({ text: 'arXiv:1706.03762', maxKb: 256, maxPdfBytes: 2 ** 20, timeoutMs: 10_000, pdfMaxMs: 300_000 }).then((r) => { outcome = r; }, (e: unknown) => { outcome = e; });
  await vi.advanceTimersByTimeAsync(360_000 - 50);
  expect(outcome).toBeNull();
  await vi.advanceTimersByTimeAsync(100);
  expect(outcome).toBeInstanceOf(Error);
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review of task 2).

/** What happened to a promise by now: its value, its error, or still nothing. */
function watch<T>(p: Promise<T>): { outcome: T | Error | null } {
  const w: { outcome: T | Error | null } = { outcome: null };
  p.then((x) => { w.outcome = x; }, (e: unknown) => { w.outcome = e instanceof Error ? e : new Error(String(e)); });
  return w;
}

/**
 * A network as Electron's net.fetch sends a body (C1): the request's body read whole into memory first, then sent in
 * `uploadMs`, where nothing can see it, then the answer; with `stallAfter`, it stops reading after so many chunks.
 */
const buffering = (uploadMs: number, stallAfter?: number): typeof fetch => async (_input, init) => {
  const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
  for (let n = 0; ; n++) {
    if (n === stallAfter) await new Promise<never>(() => {});
    if ((await reader.read()).done) break;
  }
  await new Promise((r) => setTimeout(r, uploadMs));
  return new Response(null, { status: 204 });
};

test('C1 (horloge simulée) : un envoi que le réseau lit d’un bloc puis envoie sans qu’on le voie (net.fetch d’Electron) passe au-delà du délai ; sa réponse attendue syncRequestTimeoutMs plus sa taille au rythme de MIN_BODY_BYTES_PER_S ; un envoi arrêté avant sa fin échoue encore après le délai', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // Bytes, cut in chunks without reading anything (a Blob in memory is read by Node outside the simulated clock; the
  // reviewer's reproduction, on the real clock, sends a Blob).
  const size = 5 * 2 ** 20, put = () => ({ method: 'PUT', body: new Uint8Array(size) });
  // Sent in 3 s, the delay 1 s: it passes.
  const sent = watch(connection(buffering(3000), 1000).request('/files/a', put(), { transfer: true }));
  await vi.advanceTimersByTimeAsync(3100);
  expect(sent.outcome instanceof Error ? sent.outcome.message : (sent.outcome as Response | null)?.status).toBe(204);
  // Never answered: given up once the delay and the body's time at the slowest pace have passed after its last chunk.
  const bound = 1000 + Math.ceil((size / MIN_BODY_BYTES_PER_S) * 1000);
  expect(bound).toBeGreaterThan(600_000);
  const silent = watch(connection(buffering(10 * bound), 1000).request('/files/b', put(), { transfer: true }));
  await vi.advanceTimersByTimeAsync(bound - 100);
  expect(silent.outcome).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  expect(silent.outcome).toBeInstanceOf(Error);
  // Stopped after three chunks of its body: given up after the delay, as any transfer that stops.
  const stalled = watch(connection(buffering(0, 3), 1000).request('/files/c', put(), { transfer: true }));
  await vi.advanceTimersByTimeAsync(900);
  expect(stalled.outcome).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  expect(stalled.outcome).toBeInstanceOf(Error);
});

test('I1 (horloge simulée) : une requête qui envoie un corps (POST /units) a syncRequestTimeoutMs plus le temps de son corps au rythme de MIN_BODY_BYTES_PER_S, et non un délai plat', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  // About 160 Kio: 20 s at the slowest pace.
  const body = JSON.stringify({ units: ['é'.repeat(80 * 1024)] }), bound = 1000 + Math.ceil((Buffer.byteLength(body) / MIN_BODY_BYTES_PER_S) * 1000);
  expect(bound).toBeGreaterThan(20_000);
  const answeredAfter = (ms: number): typeof fetch => async () => {
    await new Promise((r) => setTimeout(r, ms));
    return Response.json({ results: [] });
  };
  // A slow line takes 15 s to send it: it passes.
  const slow = watch(connection(answeredAfter(15_000), 1000).request('/units', { method: 'POST', headers: JSON_BODY, body }).then((r) => r.json()));
  await vi.advanceTimersByTimeAsync(15_100);
  expect(slow.outcome).toEqual({ results: [] });
  // Never answered: given up at that bound, not before.
  const never = watch(connection(answeredAfter(10 * bound), 1000).request('/units', { method: 'POST', headers: JSON_BODY, body }));
  await vi.advanceTimersByTimeAsync(bound - 100);
  expect(never.outcome).toBeNull();
  await vi.advanceTimersByTimeAsync(200);
  expect(never.outcome).toBeInstanceOf(Error);
  // A request without a body keeps the delay alone.
  const hello = watch(connection(answeredAfter(10_000), 1000).request('/hello'));
  await vi.advanceTimersByTimeAsync(1100);
  expect(hello.outcome).toBeInstanceOf(Error);
});

test('M3 (horloge simulée) : une réponse arrivée avant que le corps soit tout pris ; le reste du corps pris ensuite ne réarme plus aucun délai : la requête finie n’est jamais abandonnée', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  let signal: AbortSignal | null = null;
  const early: typeof fetch = async (_input, init) => {
    signal = init!.signal!;
    const reader = (init!.body as ReadableStream<Uint8Array>).getReader();
    // The answer at once; the body still taken afterwards, a chunk every 100 ms.
    void (async () => {
      for (;;) {
        await new Promise((r) => setTimeout(r, 100));
        if ((await reader.read()).done) return;
      }
    })();
    return new Response('reçu');
  };
  const res = await connection(early, 500).request('/files/d', { method: 'PUT', body: new Blob([new Uint8Array(10 * 65_536)]) }, { transfer: true });
  expect(await res.text()).toBe('reçu');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(signal!.aborted).toBe(false);
});

test('M2 (horloge simulée) : un flux ouvert mais muet (un mandataire qui le retient) ne fait pas ses preuves : l’attente avant l’essai suivant continue de croître', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const hellos: number[] = [];
  let mode: 'closes' | 'holds' = 'closes', held: ReadableStreamDefaultController<Uint8Array> | null = null;
  const f: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname, m = mode;
    if (path === '/hello') {
      hellos.push(Date.now());
      return Response.json({ serverTime: Date.now(), lastSeq: 0, empty: false, nodes: 0, baseId: 'base-x' });
    }
    if (path !== '/events') throw new Error(`requête inattendue : ${path}`);
    // Open, its headers given, and not a byte after (a proxy that holds the stream back).
    return new Response(new ReadableStream<Uint8Array>({ start(c) { if (m === 'closes') c.close(); else held = c; } }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
  };
  const store = LocalStore.open(tempDir(), { pc: 'pc-r' });
  closing.push(() => store.close());
  const client = new SyncClient({
    fetch: f, store, storeDir: tempDir(), secrets: memorySecrets({ url: 'http://127.0.0.1:7310', token: TOKEN, name: 'R' }), reconcile: async () => {}, now: () => Date.now(),
    params: () => ({ ...TEST_PARAMS, syncRetryMinMs: 1000, syncRetryMaxMs: 30_000, syncStreamSilenceMs: 3_600_000 }), status: () => {},
  });
  closing.push(() => client.stop());
  const t0 = Date.now();
  client.start();
  await vi.advanceTimersByTimeAsync(15_000);
  mode = 'holds';
  await vi.advanceTimersByTimeAsync(46_000);
  mode = 'closes';
  held!.close();
  await vi.advanceTimersByTimeAsync(31_000);
  // Open 30 s without a byte: not proven; the pause after it the longest, not the shortest.
  expect(hellos.map((t) => t - t0)).toEqual([0, 1000, 3000, 7000, 15_000, 31_000, 91_000]);
});

test('M4 : l’écart d’horloge mesuré n’est écrit dans serveur.json que s’il a changé d’une seconde au moins ; en mémoire, toujours la dernière mesure', async () => {
  const times = [1_004_321, 1_004_821, 1_005_821];
  let hello = 0;
  const f: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/hello') return Response.json({ serverTime: times[Math.min(hello++, times.length - 1)], lastSeq: 0, empty: false, nodes: 0, baseId: 'base-x' });
    // A stream that ends at once: a new connection, a new hello.
    if (path === '/events') return new Response(new ReadableStream({ start: (c) => c.close() }), { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    throw new Error(`requête inattendue : ${path}`);
  };
  const secrets = memorySecrets({ url: 'http://127.0.0.1:7310', token: TOKEN, name: 'R', clockOffsetMs: -600_000 }), written: number[] = [];
  const write = secrets.write;
  secrets.write = (c) => {
    written.push(c?.clockOffsetMs ?? Number.NaN);
    write(c);
  };
  const store = LocalStore.open(tempDir(), { pc: 'pc-r' });
  closing.push(() => store.close());
  const offsets: number[] = [];
  const client = new SyncClient({
    fetch: f, store, storeDir: tempDir(), secrets, reconcile: async () => {}, now: () => 1_000_000, params: () => TEST_PARAMS,
    status: () => { offsets.push(client.clockOffset()); },
  });
  closing.push(() => client.stop());
  client.start();
  await until(() => hello >= 4);
  await client.stop();
  // 4 321, then 4 821 (half a second more: not written, but used), then 5 821 (a second and a half from the one written).
  expect(offsets).toContain(4821);
  expect(written).toEqual([4321, 5821]);
  expect(secrets.config?.clockOffsetMs).toBe(5821);
});

test('M5 : un fichier que le serveur refuse (413) pendant son envoi en flux : dit dans la console, l’écriture refusée par le serveur et écartée, rien d’envoyé de nouveau, la synchro à jour', async () => {
  const l = (lab = await Lab.start());
  const a = await l.pc('pc-a');
  const P = created(a.act((s) => createPlan(s, 'P', 'plan')), 'plan');
  await l.settle();
  const file = storeBytes(a.dir, 'grand.bin', new Uint8Array(200_000).map((_, i) => i % 7));
  let streamed: boolean | null = null;
  a.net.respond = (method, path, _signal, init) => {
    if (method !== 'PUT' || path !== `/files/${file.hash}`) return null;
    streamed = init?.body instanceof ReadableStream;
    return Response.json({ error: 'Fichier trop gros pour le serveur.' }, { status: 413 });
  };
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  a.act((s) => createNode(s, { plan: P, title: 'Grand', x: 0, y: 0, k: 0, files: [file] }));
  await until(() => a.dropped.length > 0, 8000, () => JSON.stringify(a.status));
  expect(streamed).toBe(true);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/refusé par le serveur : Fichier trop gros pour le serveur\.$/));
  expect(a.dropped).toEqual([expect.stringMatching(/écartée : Fichier manquant au serveur\.$/)]);
  await l.settle();
  expect(a.net.count('PUT', `/files/${file.hash}`)).toBe(1);
  expect(a.statuses.some((s) => s.state === 'offline')).toBe(false);
}, 30_000);

test('M1 (horloge simulée) : /seed/done, que le serveur fait attendre le temps d’importer la base, a dix minutes, et non syncRequestTimeoutMs', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const dir = tempDir(), store = LocalStore.open(dir, { pc: 'pc-s' });
  closing.push(() => store.close());
  store.commit(createPlan(store.loadState(), 'P', 'plan'));
  const last = store.lastSeq();
  const f: typeof fetch = async (input) => {
    const path = new URL(String(input)).pathname;
    if (path === '/seed') return Response.json({ baseId: 'base-s' });
    if (path === '/seed/journal') return Response.json({ ok: true });
    if (path === '/seed/done') {
      // The server imports the base before it answers (A1).
      await new Promise((r) => setTimeout(r, 5 * 60_000));
      return Response.json({ lastSeq: last, baseId: 'base-s' });
    }
    throw new Error(`requête inattendue : ${path}`);
  };
  const seeded = watch(seedBase({ fetch: f, store, dir, config: { url: 'http://127.0.0.1:7310', token: TOKEN, name: 'S' }, pairedAt: 0, signal: new AbortController().signal, timeoutMs: 1000 }));
  await vi.advanceTimersByTimeAsync(5 * 60_000 + 100);
  expect(seeded.outcome).toBe(last);
});
