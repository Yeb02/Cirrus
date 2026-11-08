// The first sync's measures (plan 5a, task 5, R18): node scripts/mesures-synchro.mjs [<base de référence>]
// On a copy of the fixtures' reference base (50 000 nodes, 500 000 connections: the bench's, in the temporary folder),
// never the user's: a server started by this script on 127.0.0.1, a free port and a temporary folder; one PC sends it
// that base (seed), another takes it (adopt). Each in its own process, one after the other, so that no process holds
// two large states: the server's memory once the base is loaded is its own. Then the cost of rewriting downloads.json
// at each batch of a long catch-up (task 3, deferred minor). Prints a JSON report, for the registry.
import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const SCRIPT = import.meta.filename;
const node = (mode, args, extra = []) => spawn(process.execPath, ['--expose-gc', ...extra, SCRIPT, mode, ...args], { stdio: ['pipe', 'pipe', 'inherit'] });
const mb = (bytes) => Math.round(bytes / 2 ** 20);

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
  const { seedBase } = await import('../src/main/sync/firstSync.ts');
  const config = await pairing(url, dataDir, 'Mesure A', 'pc-mesure-a');
  const t0 = performance.now();
  const store = LocalStore.open(pcDir, { pc: 'pc-mesure-a' });
  const openMs = performance.now() - t0;
  const nodes = store.nodeCount(), lines = store.lastSeq(), snap = store.readSnapshot();
  const snapshotMb = snap ? mb(snap.data.byteLength) : null;
  const times = {}, sampler = peakSampler(), t1 = performance.now();
  await seedBase({ fetch: timedFetch(times), store, dir: pcDir, config, signal: new AbortController().signal });
  const seedMs = performance.now() - t1;
  store.close();
  console.log(JSON.stringify({ nodes, lines, snapshotMb, openMs: Math.round(openMs), seedMs: Math.round(seedMs), requests: rounded(times), peakMb: mb(sampler.stop()) }));
}

/** PC B, empty, takes the server's base, staged beside `pcDir`. */
async function prendre(url, dataDir, pcDir) {
  const { adoptBase, stagedDir } = await import('../src/main/sync/firstSync.ts');
  const { fileSecrets } = await import('../src/main/sync/config.ts');
  const { LocalStore } = await import('@cirrus/store');
  const config = await pairing(url, dataDir, 'Mesure B', 'pc-mesure-b');
  mkdirSync(pcDir, { recursive: true });
  const plain = { encrypt: (t) => Buffer.from(t), decrypt: (b) => b.toString() };
  const times = {}, sampler = peakSampler(), t0 = performance.now();
  const { last } = await adoptBase({ fetch: timedFetch(times), dir: pcDir, pc: 'pc-mesure-b', config, secrets: fileSecrets(stagedDir(pcDir), plain), signal: new AbortController().signal });
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

/** `node mesures-synchro.mjs [<base de référence>]`: everything; `… journal <lignes>`: the journal's paging only. */
async function orchestrate(args) {
  const report = {};
  if (args[0] !== 'journal') {
    const reference = args[0] ?? join(tmpdir(), 'cirrus-bench-1-50000-500000');
    if (!existsSync(join(reference, 'cirrus.db'))) throw new Error(`Pas de base de référence dans ${reference} (npm run bench la construit).`);
    const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-synchro-'));
    mkdirSync(join(root, 'pc-a'), { recursive: true });
    copyFileSync(join(reference, 'cirrus.db'), join(root, 'pc-a', 'cirrus.db'));
    const stamp = existsSync(join(reference, 'bench-base.json')) ? JSON.parse(readFileSync(join(reference, 'bench-base.json'), 'utf8')) : null;
    report.reference = await firstSyncRun(root, { base: reference, stamp });
  }
  const lines = Number(args[0] === 'journal' ? args[1] ?? 20_000 : 20_000);
  const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-synchro-'));
  const t0 = performance.now();
  await journalBase(join(root, 'pc-a'), lines);
  report.journal = await firstSyncRun(root, { lines, builtMs: Math.round(performance.now() - t0) });
  if (args[0] !== 'journal') report.downloads = [await telechargements(1000, 10), await telechargements(5000, 10)];
  console.log(JSON.stringify(report, null, 2));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'serveur') await serveur(args[0]);
else if (mode === 'envoyer') await envoyer(...args);
else if (mode === 'prendre') await prendre(...args);
else await orchestrate(process.argv.slice(2));
