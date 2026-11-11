// Plan 5a's measures: npm run mesures -w packages/app -- synchro [tout|latence|reconciliation|acceptation|premier|journal]
// [<base de référence> | <lignes>] (or node --expose-gc scripts/mesures-synchro.mjs …; latence needs the app built).
// Never the user's base, never the network: every server is started by this script on 127.0.0.1, a free port and a
// temporary folder; the reference base is a copy of the fixtures' (the bench's, 50 000 nodes and 500 000 connections, in
// the temporary folder: npm run bench makes it). Each large state in a process of its own, one after the other.
// Three passes each (task 7), the default « tout » running the first three:
// - latence: from the commit of a write on a virtual PC (in this process: tests/support/virtualPc.ts) to the new title
//   shown by app B (Electron, out of the user's way: cdp.mjs), 50 renames a pass; the server in its own process;
// - reconciliation: 10 pending writes against 100 received — the core's reconcile, then the base's
//   applyReconciliation —, on a copy of the reference base and on a base of 600 nodes, a process each;
// - acceptation: one write accepted by the server that holds the reference base (sent to it, then the server started
//   again on it), 50 a pass, one by one, with a stream open;
// - premier (task 5, R18): sending and taking the reference base, the server's memory, the journal by pages, the cost
//   of downloads.json; « journal <lignes> »: the journal by pages alone.
// Prints a JSON report, for the registry.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';
import { launch, quantile, sleep } from './cdp.mjs';

const SCRIPT = import.meta.filename;
const node = (mode, args, extra = []) => spawn(process.execPath, ['--expose-gc', ...extra, SCRIPT, mode, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
const mb = (bytes) => Math.round(bytes / 2 ** 20);
const PASSES = 3;
const REFERENCE = join(tmpdir(), 'cirrus-bench-1-50000-500000');
/** This process's time as the page's (`performance.timeOrigin + performance.now()`): absolute, under the millisecond. */
const now = () => performance.timeOrigin + performance.now();
const r1 = (x) => Math.round(x * 10) / 10;
/** The median, p95, smallest and largest of `xs`, to a tenth of a millisecond. */
const stats = (xs) => ({ n: xs.length, median: r1(quantile(xs, 0.5)), p95: r1(quantile(xs, 0.95)), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)) });

/** The process's resident memory sampled every 20 ms: its peak. */
function peakSampler() {
  let peak = process.memoryUsage().rss;
  const timer = setInterval(() => { peak = Math.max(peak, process.memoryUsage().rss); }, 20);
  timer.unref();
  return { peak: () => Math.max(peak, process.memoryUsage().rss), stop: () => { clearInterval(timer); return Math.max(peak, process.memoryUsage().rss); } };
}

/** A fetch that times each request by its path (its query aside), until its body is read. */
function timedFetch(times) {
  return async (input, init) => {
    const path = new URL(String(input)).pathname, t0 = performance.now();
    const res = await fetch(input, init);
    const body = res.status === 204 ? null : await res.arrayBuffer();
    const t = (times[path] ??= { count: 0, ms: 0 });
    t.count++;
    t.ms += performance.now() - t0;
    return new Response(body, { status: res.status, headers: res.headers });
  };
}

/** The server: started on `dataDir`, its address on stdout; « rss » on stdin answers its memory (after a collection) and its peak. */
async function serveur(dataDir) {
  const { startServer } = await import('@cirrus/server');
  const sampler = peakSampler(), t0 = performance.now();
  const server = await startServer({ dataDir, port: 0 });
  const startMs = performance.now() - t0;
  console.log(JSON.stringify({ url: server.url, startMs: Math.round(startMs) }));
  for await (const line of createInterface({ input: process.stdin })) {
    if (line === 'rss') {
      globalThis.gc?.();
      const m = process.memoryUsage();
      console.log(JSON.stringify({ rssMb: mb(m.rss), heapMb: mb(m.heapUsed), externalMb: mb(m.external + m.arrayBuffers), peakMb: mb(sampler.peak()) }));
    } else if (line === 'stop') {
      break;
    }
  }
  // « stop », or the script that started it gone (its stdin closed): stopped either way.
  await server.close();
  process.exit(0);
}

/** A pairing as the app makes it: a code of `jumeler`, traded for a token (config.pair). */
async function pairing(url, dataDir, name, pc) {
  const { Tokens } = await import('@cirrus/server');
  const { pair } = await import('../src/main/sync/config.ts');
  const tokens = Tokens.open(dataDir);
  let code;
  try { code = tokens.createCode(name, Date.now()).code; } finally { tokens.close(); }
  return pair(fetch, url, code, pc, name);
}

/** PC A sends its base (the copy in `pcDir`) to the server at `url`. */
async function envoyer(url, dataDir, pcDir) {
  const { LocalStore } = await import('@cirrus/store');
  const { seedBase } = await import('../src/main/sync/seed.ts');
  const config = await pairing(url, dataDir, 'Mesure A', 'pc-mesure-a');
  const t0 = performance.now();
  const store = LocalStore.open(pcDir, { pc: 'pc-mesure-a' });
  const openMs = performance.now() - t0;
  const nodes = store.nodeCount(), lines = store.lastSeq(), snap = store.readSnapshot();
  const snapshotMb = snap ? mb(snap.data.byteLength) : null;
  const times = {}, sampler = peakSampler(), t1 = performance.now();
  // The pairing's time, kept with the seed (B1): the app takes it from /hello, of a server that runs here too.
  // The requests' delay (plan 9, D7) at its longest: a measure is never cut by it.
  await seedBase({ fetch: timedFetch(times), store, dir: pcDir, config, pairedAt: Date.now(), signal: new AbortController().signal, timeoutMs: 600_000 });
  const seedMs = performance.now() - t1;
  store.close();
  console.log(JSON.stringify({ nodes, lines, snapshotMb, openMs: Math.round(openMs), seedMs: Math.round(seedMs), requests: rounded(times), peakMb: mb(sampler.stop()) }));
}

/** PC B, empty, takes the server's base, staged beside `pcDir`. */
async function prendre(url, dataDir, pcDir) {
  const { adoptBase } = await import('../src/main/sync/adopt.ts');
  const { stagedDir } = await import('../src/main/sync/firstSync.ts');
  const { fileSecrets } = await import('../src/main/sync/config.ts');
  const { FORMAT } = await import('../src/main/sync/connection.ts');
  const { LocalStore } = await import('@cirrus/store');
  const config = await pairing(url, dataDir, 'Mesure B', 'pc-mesure-b');
  mkdirSync(pcDir, { recursive: true });
  // The identity of the server's base, as the pairing's /hello gives it (R31): the base taken keeps it.
  const { baseId } = await (await fetch(`${url}/hello`, { headers: { ...FORMAT, Authorization: `Bearer ${config.token}` } })).json();
  const plain = { encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() };
  const times = {}, sampler = peakSampler(), t0 = performance.now();
  const { last } = await adoptBase({
    fetch: timedFetch(times), dir: pcDir, pc: 'pc-mesure-b', config, baseId, secrets: fileSecrets(stagedDir(pcDir), plain), signal: new AbortController().signal, timeoutMs: 600_000,
  });
  const adoptMs = performance.now() - t0, peakMb = mb(sampler.stop());
  const store = LocalStore.open(stagedDir(pcDir), { pc: 'pc-mesure-b' });
  const nodes = store.nodeCount();
  store.close();
  console.log(JSON.stringify({ last, nodes, adoptMs: Math.round(adoptMs), requests: rounded(times), peakMb }));
}

const rounded = (times) => Object.fromEntries(Object.entries(times).map(([k, v]) => [k, { count: v.count, ms: Math.round(v.ms) }]));

/**
 * downloads.json during a long catch-up (task 3, deferred minor): `batches` reconciled batches, each bringing `per` new
 * files, while no download ends (the network holds them): each batch rewrites the whole list. The time of each rewrite
 * as the list grows.
 */
async function telechargements(batches, per) {
  const { Downloads } = await import('../src/main/sync/downloads.ts');
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-mesure-downloads-'));
  try {
    const held = new Promise(() => {});
    const d = new Downloads(dir, () => held, () => 4);
    const hex = (i) => i.toString(16).padStart(64, '0');
    const marks = [];
    let total = 0;
    for (let b = 0; b < batches; b++) {
      const hashes = Array.from({ length: per }, (_, i) => hex(b * per + i + 1));
      const t0 = performance.now();
      d.want(hashes);
      const ms = performance.now() - t0;
      total += ms;
      if ((b + 1) % (batches / 5) === 0) marks.push({ listed: (b + 1) * per, lastMs: Number(ms.toFixed(2)) });
    }
    const fileKb = Math.round(readFileSync(join(dir, 'downloads.json')).length / 1024);
    return { batches, perBatch: per, totalMs: Math.round(total), fileKb, marks };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Reads one JSON line of a child's stdout. */
function line(child) {
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.once('line', (l) => { rl.close(); resolve(JSON.parse(l)); });
    child.once('exit', (code) => reject(new Error(`processus terminé (${code}) sans réponse`)));
  });
}

async function run(child) {
  const out = await line(child);
  await new Promise((r) => child.once('exit', r));
  return out;
}

/**
 * A base of `lines` journal lines: a lobby, a node, then that node renamed again and again, each its own write, as the
 * app writes them — the journal's paging measured apart (the reference base, built in bulk, has none).
 */
async function journalBase(dir, lines) {
  const { createNode, createPlan, editNode, emptyState, applyOps } = await import('@cirrus/core');
  const { LocalStore } = await import('@cirrus/store');
  const store = LocalStore.open(dir, { pc: 'pc-mesure-a' }), s = emptyState();
  const run = (a) => { store.commit(a); applyOps(s, a.ops); return a; };
  const lobby = run(createPlan(s, 'Lobby', 'lobby')).ops[0].after.id;
  const X = run(createNode(s, { plan: lobby, title: 'X', x: 0, y: 0, k: 0 })).ops[0].after.id;
  while (store.lastSeq() < lines) run(editNode(s, X, { title: `X ${store.lastSeq()}`, summary: 'Un résumé de quelques mots, comme on en écrit.' }));
  store.close();
}

/** A seed then an adopt of the base in `pcA`, the server started, stopped, started again (its base loaded) around them. */
async function firstSyncRun(root, report) {
  let server = null;
  try {
    const pcA = join(root, 'pc-a'), pcB = join(root, 'pc-b'), data = join(root, 'serveur');
    server = node('serveur', [data]);
    const started = await line(server);
    const ask = async (what) => { server.stdin.write(`${what}\n`); return line(server); };
    report.serverEmpty = await ask('rss');
    report.seed = await run(node('envoyer', [started.url, data, pcA]));
    report.serverAfterSeed = await ask('rss');
    server.stdin.write('stop\n');
    await new Promise((r) => server.once('exit', r));
    // Started again: the base loaded from its snapshot.
    server = node('serveur', [data]);
    const again = await line(server);
    report.restart = { startMs: again.startMs, ...(await ask('rss')) };
    report.adopt = await run(node('prendre', [again.url, data, pcB]));
    report.serverAfterAdopt = await ask('rss');
    server.stdin.write('stop\n');
    await new Promise((r) => server.once('exit', r));
    report.sizesMb = {
      sent: mb(statSync(join(pcA, 'cirrus.db')).size),
      server: mb(statSync(join(data, 'base', 'cirrus.db')).size),
      adopted: mb(statSync(join(pcB + '-nouvelle', 'cirrus.db')).size),
    };
  } finally {
    // A failure on the way: the server stopped (its stdin closed) before its folder is removed.
    if (server && server.exitCode === null) {
      server.stdin.end();
      await new Promise((r) => server.once('exit', r));
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
  return report;
}

// ——— Task 7 ———

/** The page's clock against this process's: the DevTools round trip with the shortest time, its middle taken as the page's read. */
async function clockOffset(page) {
  let best = null;
  for (let i = 0; i < 30; i++) {
    const a = now(), p = await page.evaluate('performance.timeOrigin + performance.now()'), b = now();
    if (best === null || b - a < best.rttMs) best = { rttMs: b - a, ms: p - (a + b) / 2 };
  }
  return { ms: r1(best.ms), rttMs: r1(best.rttMs) };
}

/** Stops a server started by `node('serveur')`, and waits for it. */
async function stopServer(server) {
  if (!server || server.exitCode !== null) return;
  server.stdin.end('stop\n');
  await new Promise((r) => server.once('exit', r));
}

/**
 * From the commit of a write on a virtual PC to the action applied in app B, shown: 50 renames of a node whose pop-up
 * is open in B, each awaited before the next; the time the pop-up's title shows the new one, read by the page itself
 * (TITLE_PROBE), set against the commit's time in this process (the clocks aligned by clockOffset). A fresh server, B
 * and virtual PC each pass; B paired through its block, as the user pairs it.
 */
async function latence() {
  const { chipSays, closeSettings, pairingCode, pairThrough, TITLE_PROBE, virtualPc } = await import('./serveur-local.mjs');
  const { createNode, editNode } = await import('@cirrus/core');
  const passes = [], all = [];
  for (let pass = 1; pass <= PASSES; pass++) {
    const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-latence-'));
    const serverData = join(root, 'serveur'), data = join(root, 'b'), profile = join(root, 'profil');
    for (const d of [data, profile]) mkdirSync(d);
    let server = null, app = null, virtual = null;
    try {
      server = node('serveur', [serverData]);
      const { url } = await line(server);
      const code = (name) => pairingCode(serverData, name);
      app = await launch(data, profile, { CIRRUS_VIEW: '0,0,1' });
      const { page } = app;
      await pairThrough(page, url, code('B'));
      if (!(await chipSays(page, 'À jour'))) throw new Error('B ne se jumelle pas au serveur');
      await closeSettings(page);
      virtual = await virtualPc({ url, code }, 'pc-virtuel');
      const pc = virtual.pc;
      const lobbyOf = () => [...pc.s.plans.values()].find((p) => p.type === 'lobby')?.id;
      for (let i = 0; i < 100 && !lobbyOf(); i++) await sleep(100);
      if (!lobbyOf()) throw new Error('le PC virtuel ne reçoit pas le lobby de B');
      // A node at the world's origin, the centre of B's graph: its pop-up opened there by a click.
      const made = pc.act((s) => createNode(s, { plan: lobbyOf(), title: 'Mesure 0', x: 0, y: 0, k: 0 }));
      const id = made.ops.find((o) => o.t === 'node' && o.before === null).after.id;
      const centre = await page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      const opened = `document.querySelector('.node-popup input.title')?.value === 'Mesure 0'`;
      for (let i = 0; i < 20 && !(await page.until(opened, 1000)); i++) await page.dblclick(centre.x, centre.y);
      if (!(await page.evaluate(opened))) throw new Error('pas de pop-up du nœud du PC virtuel dans B');
      const clock = await clockOffset(page);
      const samples = [];
      for (let i = 1; i <= 50; i++) {
        const title = `Mesure ${i}`;
        await page.evaluate(TITLE_PROBE(title));
        const t0 = now();
        pc.act((s) => editNode(s, id, { title }));
        const shown = await page.evaluate('window.__shown');
        if (typeof shown !== 'number') throw new Error(`B ne montre pas « ${title} »`);
        samples.push(shown - clock.ms - t0);
        await sleep(100);
      }
      all.push(...samples);
      passes.push({ pass, clock, ...stats(samples) });
      console.error(`latence, passe ${pass} : médiane ${stats(samples).median} ms, p95 ${stats(samples).p95} ms`);
    } finally {
      await app?.close();
      await virtual?.close();
      await stopServer(server);
      rmSync(root, { recursive: true, force: true, maxRetries: 5 });
    }
  }
  return { criterion: 'p95 < 200 ms', passes, all: stats(all) };
}

/**
 * One pass of the reconciliation, a process of its own: `rounds` times, 10 writes made here and pending, against 100
 * received from another PC — 5 on the same nodes and the same field (the title: the most recent, here, wins), 5 on the
 * same nodes and another field (the summary: both kept), 90 on other nodes. Timed: the core's reconcile on the state,
 * then the base's applyReconciliation (one transaction, each « before » checked). The writes still pending are then
 * acknowledged, untimed, so that each round starts from none. `kind`: the reference base's copy in `dir`, or « petite »,
 * a base of 600 nodes made here, its lines numbered as a server's.
 */
async function reconcilier(dir, kind, rounds) {
  const { applyOps, createNode, createPlan, decodeState, editNode, emptyState, reconcile, uuidv7 } = await import('@cirrus/core');
  const { LocalStore } = await import('@cirrus/store');
  if (kind === 'petite') {
    const built = LocalStore.open(dir, { pc: 'pc-mesure' }), s = emptyState();
    const run = (a) => { built.commit(a); applyOps(s, a.ops); return a; };
    const lobby = run(createPlan(s, 'Lobby', 'lobby')).ops[0].after.id;
    for (let i = 0; i < 600; i++) run(createNode(s, { plan: lobby, title: `Nœud ${i}`, x: (i % 20) * 200, y: Math.floor(i / 20) * 120, k: 0 }));
    built.numberSeeded(built.lastSeq(), uuidv7());
    built.close();
  }
  const store = LocalStore.open(dir, { pc: 'pc-mesure' });
  const t0 = performance.now(), snap = store.readSnapshot();
  const s = snap && snap.seq === store.lastSeq() ? decodeState(snap.data) : store.loadState();
  const loadMs = Math.round(performance.now() - t0);
  if (store.pendingCount() !== 0) throw new Error(`${store.pendingCount()} écritures déjà en attente dans la base mesurée`);
  const ids = [...s.nodes.values()].filter((n) => n.trashedAt === undefined && n.anchor === undefined).map((n) => n.id);
  if (ids.length < rounds * 100) throw new Error(`${ids.length} nœuds : il en faut ${rounds * 100}`);
  let seq = store.lastServerSeq(), at = Date.now();
  const out = [];
  for (let r = 0; r < rounds; r++) {
    const pick = ids.slice(r * 100, r * 100 + 100);
    // Received: made on the state as the server has it, without this PC's pending writes, earlier than them.
    const incoming = pick.map((id, j) => {
      const a = editNode(s, id, j >= 5 && j < 10 ? { summary: `Résumé reçu ${r}.${j}` } : { title: `Reçu ${r}.${j}` });
      seq += a.ops.length;
      return { unit: uuidv7(), action: a.id, label: a.label, at: at - 1000, pc: 'pc-autre', ops: a.ops, seq };
    });
    const pending = pick.slice(0, 10).map((id, i) => {
      const a = editNode(s, id, { title: `Local ${r}.${i}` });
      const u = { unit: uuidv7(), action: a.id, label: a.label, at: at++, pc: 'pc-mesure', ops: a.ops };
      store.commit(a, { at: u.at, unit: u.unit });
      applyOps(s, a.ops);
      return u;
    });
    const t1 = performance.now();
    const rec = reconcile(s, pending, incoming, []);
    const t2 = performance.now();
    store.applyReconciliation(rec);
    const t3 = performance.now();
    out.push({ reconcileMs: r1(t2 - t1), writeMs: r1(t3 - t2), totalMs: r1(t3 - t1), rewind: rec.rewind.length, rebased: rec.rebased.length, dropped: rec.dropped.length });
    // The server takes them as they now are: acknowledged.
    const acks = rec.rebased.map((u) => { seq += u.ops.length; return { ...u, seq }; });
    const ack = reconcile(s, rec.rebased, acks, []);
    if (ack.acked.length !== rec.rebased.length) throw new Error('accusés de réception non reconnus');
    store.applyReconciliation(ack);
  }
  store.close();
  console.log(JSON.stringify({ kind, nodes: s.nodes.size, loadMs, rounds: out }));
}

/** Three passes of reconcilier on each base, a fresh copy and a process each: the first round cold, the others warm. */
async function reconciliation(reference) {
  const result = { criterion: '< 50 ms' };
  for (const kind of ['petite', 'reference']) {
    const passes = [];
    for (let pass = 1; pass <= PASSES; pass++) {
      const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-reconciliation-'));
      try {
        if (kind === 'reference') copyFileSync(join(reference, 'cirrus.db'), join(root, 'cirrus.db'));
        const o = await run(node('reconcilier', [root, kind, '6']));
        const warm = o.rounds.slice(1), of = (k) => stats(warm.map((x) => x[k]));
        passes.push({ pass, nodes: o.nodes, loadMs: o.loadMs, cold: o.rounds[0], warm: { reconcile: of('reconcileMs'), write: of('writeMs'), total: of('totalMs') }, rounds: o.rounds });
        console.error(`réconciliation, ${kind}, passe ${pass} : à froid ${o.rounds[0].totalMs} ms, à chaud ${of('totalMs').median} ms (médiane)`);
      } finally {
        rmSync(root, { recursive: true, force: true, maxRetries: 5 });
      }
    }
    result[kind] = passes;
  }
  return result;
}

/**
 * One write accepted by the server holding the reference base: the base sent to an empty server (seed), the server
 * stopped and started again on it (loaded from its snapshot), then a third PC, paired as the app pairs, sends 50 writes a
 * pass one by one (POST /units, a rename each, its « before » the node as the reference base has it), a stream of its
 * own open meanwhile (each write relayed to it). Timed from the request to its answer read: an upper bound of the
 * acceptance (parseUnit, applyOps on the 50 000 nodes' state, addedViolation, the commit synchronised on the disk, the
 * relay), HTTP on this machine included.
 */
async function acceptation(reference) {
  const { uuidv7 } = await import('@cirrus/core');
  const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-acceptation-'));
  const pcA = join(root, 'pc-a'), data = join(root, 'serveur');
  mkdirSync(pcA);
  copyFileSync(join(reference, 'cirrus.db'), join(pcA, 'cirrus.db'));
  let server = null;
  const stream = new AbortController();
  try {
    server = node('serveur', [data]);
    const first = await line(server);
    const seed = await run(node('envoyer', [first.url, data, pcA]));
    console.error(`acceptation : base de référence envoyée en ${(seed.seedMs / 1000).toFixed(1)} s`);
    await stopServer(server);
    server = node('serveur', [data]);
    const started = await line(server);
    const ask = async (what) => { server.stdin.write(`${what}\n`); return line(server); };
    const config = await pairing(started.url, data, 'Mesure C', 'pc-mesure-c');
    const auth = { Authorization: `Bearer ${config.token}` };
    // The stream from the start, read and dropped: each accepted write is relayed to it.
    const events = await fetch(`${started.url}/events?after=0`, { headers: auth, signal: stream.signal });
    void (async () => { try { for await (const _ of events.body) { /* relayed, dropped */ } } catch {} })();
    const db = new DatabaseSync(join(pcA, 'cirrus.db'), { readOnly: true });
    let nodes;
    try { nodes = db.prepare(`SELECT json FROM nodes WHERE trashed = 0 ORDER BY id LIMIT ${PASSES * 50}`).all().map((r) => JSON.parse(r.json)); } finally { db.close(); }
    const passes = [], all = [];
    for (let pass = 0; pass < PASSES; pass++) {
      const samples = [];
      for (let i = 0; i < 50; i++) {
        const before = nodes[pass * 50 + i], after = { ...before, title: `${before.title} (mesure)` };
        const unit = { unit: uuidv7(), action: uuidv7(), label: 'Modifier un titre (mesure)', at: Date.now(), pc: 'pc-mesure-c', ops: [{ t: 'node', before, after }] };
        const t0 = now();
        const res = await fetch(`${started.url}/units`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ units: [unit] }) });
        const body = await res.json();
        samples.push(now() - t0);
        if (!('accepted' in (body.results?.[0] ?? {}))) throw new Error(`écriture non acceptée : ${res.status} ${JSON.stringify(body)}`);
      }
      all.push(...samples);
      passes.push({ pass: pass + 1, ...stats(samples) });
      console.error(`acceptation, passe ${pass + 1} : médiane ${stats(samples).median} ms, p95 ${stats(samples).p95} ms`);
    }
    const memory = await ask('rss');
    return { criterion: 'médiane < 10 ms', seed: { seedMs: seed.seedMs, nodes: seed.nodes }, restart: { startMs: started.startMs }, serverAfter: memory, passes, all: stats(all) };
  } finally {
    stream.abort();
    await stopServer(server);
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

/** Task 5's measures (R18): seed and adopt of the reference base (if given), the journal by pages, downloads.json. */
async function premier(reference, lines) {
  const report = {};
  if (reference) {
    const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-synchro-'));
    mkdirSync(join(root, 'pc-a'), { recursive: true });
    copyFileSync(join(reference, 'cirrus.db'), join(root, 'pc-a', 'cirrus.db'));
    const stamp = existsSync(join(reference, 'bench-base.json')) ? JSON.parse(readFileSync(join(reference, 'bench-base.json'), 'utf8')) : null;
    report.reference = await firstSyncRun(root, { base: reference, stamp });
  }
  const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-synchro-'));
  const t0 = performance.now();
  await journalBase(join(root, 'pc-a'), lines);
  report.journal = await firstSyncRun(root, { lines, builtMs: Math.round(performance.now() - t0) });
  if (reference) report.downloads = [await telechargements(1000, 10), await telechargements(5000, 10)];
  return report;
}

/** The reference base named, or the bench's; refused if absent. */
function referenceOf(path) {
  const reference = path ?? REFERENCE;
  if (!existsSync(join(reference, 'cirrus.db'))) throw new Error(`Pas de base de référence dans ${reference} (npm run bench la construit).`);
  return reference;
}

async function orchestrate([what = 'tout', arg]) {
  const report = {};
  if (what === 'journal') Object.assign(report, await premier(null, Number(arg ?? 20_000)));
  else if (what === 'premier') Object.assign(report, await premier(referenceOf(arg), 20_000));
  else if (['tout', 'latence', 'reconciliation', 'acceptation'].includes(what)) {
    const reference = what === 'latence' ? null : referenceOf(arg);
    if (what === 'tout' || what === 'latence') report.latence = await latence();
    if (what === 'tout' || what === 'reconciliation') report.reconciliation = await reconciliation(reference);
    if (what === 'tout' || what === 'acceptation') report.acceptation = await acceptation(reference);
  } else {
    throw new Error(`Mesure inconnue : ${what} (tout, latence, reconciliation, acceptation, premier ou journal).`);
  }
  console.log(JSON.stringify(report, null, 2));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'serveur') await serveur(args[0]);
else if (mode === 'envoyer') await envoyer(...args);
else if (mode === 'prendre') await prendre(...args);
else if (mode === 'reconcilier') await reconcilier(args[0], args[1], Number(args[2]));
else await orchestrate(process.argv.slice(2));
