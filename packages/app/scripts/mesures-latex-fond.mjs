// Plan 5b's measures of the background recompilation (D1, task 8): npm run mesures -w packages/app -- latex-fond
// [<réglages en JSON>] (or node scripts/mesures-latex-fond.mjs, the app built; the settings written beside the base, to
// compare one, `{"latexWarmProcesses":3}` say, with the defaults). Three passes, each on a fresh artificial test base (make-fixture.ts)
// to which this script adds a grid of 100 nodes with a summary each, and « Frappe », a node whose summary is the one
// plan 4b typed in (the test base's entropy, its label left out). The app (Electron, out of the user's way: cdp.mjs) sends
// that base to a server of this machine through its block « Serveur », as the user pairs (serveur-local.mjs: 127.0.0.1, a
// free port, a temporary folder); a virtual PC (tests/support/virtualPc.ts, in this process) then changes the 100
// summaries in one write. LaTeX is the bench's TinyTeX (CIRRUS_TINYTEX), as at plan 4b's measures: read, never installed
// into, never %LOCALAPPDATA%\Cirrus. Never the user's base nor profile, never the network. Nothing of the app changes to
// measure: the PDFs the background compiles are seen arriving in the base's cache (<base>/latex/cache/<key>.json, written
// after its PDF), the page is watched from DevTools as plan 4b watched it (its typing pause's timer, the canvases put in
// the page).
// - fond: from the virtual PC's write of 100 summaries to the 100th PDF in the cache, nothing else running (round 0);
// - frappe: the preview of « Frappe »'s summary typed in its compact editor (« ␣a », then 1.2 s of rest), from the end
//   of the typing pause (latexTypingPauseMs) to the canvas of its new PDF put in the page — before any background work,
//   while the background compiles 100 summaries changed by a sync (rounds 1 and 2, the keystrokes whose pause ended
//   before the background's last PDF), and after it;
// - ouverture: the pop-up of a node of the grid whose summary the background compiled, from the release of the click
//   to its canvas: the first of the session (pdf.js not loaded yet), then ten others, pdf.js loaded.
// Prints a JSON report, for the registry.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDir, launch, quantile, sleep } from './cdp.mjs';
import { chipSays, closeSettings, localServer, pairThrough, virtualPc } from './serveur-local.mjs';

const PASSES = 3;
/** Settings written beside each base (the first argument, in JSON), or none: the defaults. */
const SETTINGS = process.argv[2] ? JSON.parse(process.argv[2]) : null;
const tinyTex = join(appDir, '..', '..', 'bench', 'latex', 'vendor', 'TinyTeX');
const fixtures = join(appDir, '..', 'fixtures');
/** latexTypingPauseMs (300, its default): the scheduler's timer that ends a typing pause. */
const PAUSE_MS = 300;
/** The rest after each keystroke, as plan 4b's condition. */
const REST_MS = 1200;
/** Keystrokes before and after the background's rounds, each a session's baseline. */
const BASELINE = 10;
/**
 * The view: the world's (3100, 300) at the graph's centre, zoom 1 — (792, 499) in the page, under the tabs (38 px). The
 * grid: 10 columns of 120 px from x = 2500, 10 rows of 65 px from y = 0; « Frappe » at (3750, 300), right of it.
 */
const VIEW = { x: 3100, y: 300 };
const atPage = (wx, wy) => ({ x: 792 + (wx - VIEW.x), y: 499 + (wy - VIEW.y) });
const cell = (i) => ({ x: 2500 + 120 * (i % 10), y: 65 * Math.floor(i / 10) });
const FRAPPE = { title: 'Frappe', x: 3750, y: 300 };
const title = (i) => `F${String(i).padStart(2, '0')}`;
/** A grid node's summary at revision `r`: some text and mathematics, each node's own. */
const summary = (i, r) => String.raw`Résumé ${i} : pour une chaîne $x$ de longueur $n$, $K(x) \le n + 2\log_2 n + O(1)$, et $\sum_x 2^{-K(x)} \le 1$ (révision ${r}).`;
/** The test base's entropy, as plan 4b typed in it, its \label left out (it would be defined twice). */
const FRAPPE_SUMMARY = String.raw`Pour une source $X$ de loi $p$ :\begin{equation}H(X) = -\sum_x p(x) \log_2 p(x)\end{equation}en bits.`;
/** The ten nodes opened warm (one per row and column), and the one opened first, cold. */
const WARM = [0, 11, 22, 33, 44, 55, 66, 77, 88, 99];
const COLD = 50;

const now = () => performance.timeOrigin + performance.now();
const r1 = (x) => Math.round(x * 10) / 10;
const stats = (xs) => (xs.length === 0 ? { n: 0 } : { n: xs.length, median: r1(quantile(xs, 0.5)), p95: r1(quantile(xs, 0.95)), min: r1(Math.min(...xs)), max: r1(Math.max(...xs)) });

/** The grid's 100 nodes and « Frappe » written into the test base in `dir`, signed as make-fixture's lines; their ids. */
async function addNodes(dir) {
  const { applyOps, createNode } = await import('@cirrus/core');
  const { LocalStore } = await import('@cirrus/store');
  const store = LocalStore.open(dir, { pc: 'fixture' });
  try {
    const s = store.loadState(), lobby = [...s.plans.values()].find((p) => p.type === 'lobby').id;
    const add = (o) => {
      const a = createNode(s, { plan: lobby, k: 0, ...o });
      store.commit(a);
      applyOps(s, a.ops);
      return a.ops.find((op) => op.t === 'node' && op.before === null).after.id;
    };
    const grid = Array.from({ length: 100 }, (_, i) => add({ title: title(i), ...cell(i), summary: summary(i, 0) }));
    const frappe = add({ title: FRAPPE.title, x: FRAPPE.x, y: FRAPPE.y, summary: FRAPPE_SUMMARY });
    return { grid, frappe };
  } finally {
    store.close();
  }
}

/** The page's clock against this process's: the DevTools round trip with the shortest time, its middle taken as the page's read. */
async function clockOffset(page) {
  let best = null;
  for (let i = 0; i < 30; i++) {
    const a = now(), p = await page.evaluate('performance.timeOrigin + performance.now()'), b = now();
    if (best === null || b - a < best.rttMs) best = { rttMs: b - a, ms: p - (a + b) / 2 };
  }
  return { ms: r1(best.ms), rttMs: r1(best.rttMs) };
}

/**
 * The page's watch (plan 4b's, from outside the app): each end of a typing pause (the scheduler's timer of
 * latexTypingPauseMs, window.setTimeout wrapped), each canvas put in the page under the compact editor's draft, or in a
 * pop-up's compiled summary (with the pop-up's title), and each release of the mouse; on the page's absolute clock.
 */
const PROBE = `(() => {
  const L = window.__fond = { pauses: [], drafts: [], popups: [], ups: [] };
  const abs = () => performance.timeOrigin + performance.now(), set = window.setTimeout;
  window.setTimeout = function (fn, ms, ...rest) {
    if (ms === ${PAUSE_MS} && typeof fn === 'function') return set.call(window, () => { L.pauses.push(abs()); fn(); }, ms, ...rest);
    return set.call(window, fn, ms, ...rest);
  };
  document.addEventListener('mouseup', () => L.ups.push(abs()), true);
  new MutationObserver((ms) => {
    const t = abs();
    for (const m of ms) for (const n of m.addedNodes) {
      if (n.nodeName !== 'CANVAS' || !n.isConnected) continue;
      if (n.closest('.latex-draft')) L.drafts.push(t);
      else if (n.closest('.node-popup .latex-snippet')) L.popups.push({ t, title: document.querySelector('.node-popup input.title')?.value ?? null });
    }
  }).observe(document.body, { subtree: true, childList: true });
  return true;
})()`;

/**
 * The base's LaTeX cache, watched from this process (a listing every 10 ms): each PDF compiled since `start()` (its
 * description, <key>.json, written after it), with the time it was first seen.
 */
function cacheWatch(dir) {
  const seen = new Map();
  const list = () => { try { return readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return []; } };
  let before = new Set(), timer = null;
  const tick = () => { const t = now(); for (const f of list()) if (!before.has(f) && !seen.has(f)) seen.set(f, t); };
  return {
    start() { before = new Set(list()); seen.clear(); timer ??= setInterval(tick, 10); },
    count: () => seen.size,
    times: () => [...seen.values()].sort((a, b) => a - b),
    stop() { clearInterval(timer); timer = null; },
  };
}

/** A keystroke at the end of the compact editor (« ␣x »), then its pause's end and the canvas of its PDF, on the page's clock. */
async function keystroke(page, ch) {
  const typed = await page.evaluate('performance.timeOrigin + performance.now()');
  await page.send('Input.insertText', { text: ` ${ch}` });
  const found = `(() => { const L = window.__fond, p = L.pauses.find((t) => t > ${typed}); const c = p === undefined ? undefined : L.drafts.find((t) => t > p); return c === undefined ? null : { typed: ${typed}, pause: p, canvas: c }; })()`;
  if (!(await page.until(`${found} !== null`, 15_000))) throw new Error(`pas d’aperçu après la frappe « ${ch} »`);
  const k = await page.evaluate(found);
  await sleep(REST_MS);
  return { ...k, ms: k.canvas - k.pause };
}

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/** The node titled `name`'s pop-up, by clicks at `at` until it shows it. */
async function openPopup(page, at, name) {
  const shown = `document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(name)}`;
  for (let i = 0; i < 10 && !(await page.until(shown, 1000)); i++) await page.click(at.x, at.y);
  if (!(await page.evaluate(shown))) throw new Error(`pas de pop-up « ${name} »`);
}

/** Escape until no pop-up is open (the compact editor first, its draft given up, then the pop-up). */
async function closePopups(page) {
  for (let i = 0; i < 4 && (await page.evaluate(`!!document.querySelector('.node-popup')`)); i++) await page.press('Escape', 'Escape', 27);
  if (await page.evaluate(`!!document.querySelector('.node-popup')`)) throw new Error('Échap ne ferme pas le pop-up');
}

/**
 * The pop-up of the grid's node `i`, opened by a click: from the click's release to its summary's canvas; whether a PDF
 * was compiled meanwhile (none: its PDF was in the cache, compiled in the background).
 */
async function openTimed(page, cache, i) {
  const at = atPage(cell(i).x, cell(i).y);
  const marks = await page.evaluate(`({ ups: window.__fond.ups.length, popups: window.__fond.popups.length })`);
  const before = cache.count();
  await page.click(at.x, at.y);
  const found = `(() => { const L = window.__fond, up = L.ups[${marks.ups}], c = L.popups.slice(${marks.popups}).find((p) => p.title === ${JSON.stringify(title(i))}); return up === undefined || c === undefined ? null : c.t - up; })()`;
  if (!(await page.until(`${found} !== null`, 10_000))) throw new Error(`pas de résumé dessiné dans le pop-up de « ${title(i)} »`);
  const ms = await page.evaluate(found);
  await sleep(300);
  const compiled = cache.count() - before;
  await closePopups(page);
  await sleep(400);
  return { node: title(i), ms: r1(ms), compiled };
}

/**
 * A round: the virtual PC changes the grid's 100 summaries in one write (revision `r`); its time `t0`. Without typing, the
 * 100 PDFs awaited in the cache. With typing, keystrokes in « Frappe »'s editor until the background has put its 100:
 * the cache then also holds one PDF per keystroke, each counted out once its canvas is drawn — the background's last
 * PDF is when the PDFs seen, less the keystrokes' drawn by then, reach 100.
 */
async function round(ctx, r, typing) {
  const { page, pc, grid, cache, clock } = ctx;
  const { editNode, uuidv7 } = await import('@cirrus/core');
  cache.start();
  const t0 = now();
  pc.act((s) => ({ id: uuidv7(), label: `Modifier 100 résumés (mesure, révision ${r})`, ops: grid.flatMap((id, i) => editNode(s, id, { summary: summary(i, r) }).ops) }));
  const keys = [];
  if (!typing) {
    for (const end = Date.now() + 180_000; cache.count() < 100 && Date.now() < end;) await sleep(20);
  } else {
    for (const end = Date.now() + 180_000; cache.count() - keys.length < 100 && Date.now() < end;) keys.push(await keystroke(page, LETTERS[(ctx.typed++) % 26]));
  }
  // The background's PDFs: the times of the PDFs seen, each keystroke's taken out (its canvas, on this process's clock).
  await sleep(200);
  const all = cache.times(), drawn = keys.map((k) => k.canvas - clock.ms).sort((a, b) => a - b);
  const bg = typing ? backgroundOf(all, drawn) : all;
  if (bg.length < 100) throw new Error(`révision ${r} : ${bg.length} PDF de fond sur 100 dans le cache (${all.length} en tout)`);
  const gaps = bg.slice(1, 100).map((t, j) => t - bg[j]);
  const during = keys.filter((k) => k.pause - clock.ms < bg[99]);
  return {
    revision: r, firstMs: Math.round(bg[0] - t0), lastMs: Math.round(bg[99] - t0), gaps: stats(gaps), gapsMs: gaps.map(Math.round),
    keystrokes: keys.length, during: during.map((k) => r1(k.ms)), all: keys.map((k) => r1(k.ms)),
  };
}

/**
 * The background's PDFs among `all` (sorted times), `drawn` being the canvases of the keystrokes' PDFs (sorted): each
 * keystroke's PDF is the latest one seen before its canvas, taken out once.
 */
function backgroundOf(all, drawn) {
  const left = [...all];
  for (const d of drawn) {
    let j = -1;
    for (let k = 0; k < left.length && left[k] <= d + 20; k++) j = k;
    if (j >= 0) left.splice(j, 1);
  }
  return left;
}

async function pass(n) {
  const root = mkdtempSync(join(tmpdir(), 'cirrus-mesure-fond-'));
  const data = join(root, 'b'), profile = join(root, 'profil');
  mkdirSync(profile);
  execFileSync(process.execPath, [join(fixtures, 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
  const { grid, frappe } = await addNodes(data);
  if (SETTINGS) writeFileSync(join(data, 'settings.json'), JSON.stringify(SETTINGS), 'utf8');
  const server = await localServer(), cache = cacheWatch(join(data, 'latex', 'cache'));
  let app = null, virtual = null;
  try {
    app = await launch(data, profile, { CIRRUS_VIEW: `${VIEW.x},${VIEW.y},1`, CIRRUS_TINYTEX: tinyTex });
    const { page } = app;
    if (!(await page.until(`window.cirrus.latexStatus().then((s) => s.state === 'ready')`, 20_000))) throw new Error('LaTeX n’est pas prêt (TinyTeX du banc)');
    // The test base and the nodes sent to the server through the block, as the user pairs a full base (D7).
    await pairThrough(page, server.url, server.code('B'));
    if (!(await page.until(`!!document.querySelector('.server-offer button')`, 10_000))) throw new Error('pas d’offre d’envoyer la base');
    const send = await page.centre('.server-offer button', '^Envoyer la base');
    await page.click(send.x, send.y);
    const paired = `[...document.querySelectorAll('.server-block button')].some((b) => b.textContent === 'Dissocier ce PC')`;
    if (!(await page.until(paired, 60_000)) || !(await chipSays(page, 'À jour'))) throw new Error('la base n’est pas envoyée au serveur');
    await closeSettings(page);
    virtual = await virtualPc(server, 'pc-virtuel');
    const pc = virtual.pc;
    for (let i = 0; i < 300 && !(grid.every((id) => pc.s.nodes.has(id)) && pc.status?.state === 'live'); i++) await sleep(100);
    if (!grid.every((id) => pc.s.nodes.has(id))) throw new Error('le PC virtuel ne reçoit pas la base');
    await page.evaluate(PROBE);
    await sleep(2000);
    const clock = await clockOffset(page);
    const ctx = { page, pc, grid, cache, clock, typed: 0 };
    const out = { pass: n, clock };
    // 1. The background alone.
    out.fond = await round(ctx, 1, false);
    console.error(`passe ${n}, fond seul : premier PDF ${out.fond.firstMs} ms, centième ${out.fond.lastMs} ms`);
    await sleep(1000);
    // 3, cold: the first pop-up of the session, pdf.js not loaded yet.
    out.froid = await openTimed(page, cache, COLD);
    console.error(`passe ${n}, premier pop-up de la session : ${out.froid.ms} ms`);
    // 2. « Frappe »'s summary in its compact editor, its first keystroke not counted.
    await openPopup(page, atPage(FRAPPE.x, FRAPPE.y), FRAPPE.title);
    const field = await page.centre('.node-popup .latex-field', '');
    await page.click(field.x, field.y);
    if (!(await page.until(`!!document.querySelector('.node-popup .latex-editor.compact .cm-content') && document.activeElement?.classList.contains('cm-content')`, 10_000))) throw new Error('l’éditeur du résumé ne s’ouvre pas');
    await sleep(1500);
    await keystroke(page, '0');
    const before = [];
    for (let i = 0; i < BASELINE; i++) before.push((await keystroke(page, LETTERS[(ctx.typed++) % 26])).ms);
    out.avant = before.map(r1);
    out.frappe = [await round(ctx, 2, true), await round(ctx, 3, true)];
    await sleep(1000);
    const after = [];
    for (let i = 0; i < BASELINE; i++) after.push((await keystroke(page, LETTERS[(ctx.typed++) % 26])).ms);
    out.apres = after.map(r1);
    console.error(`passe ${n}, frappe : sans fond ${stats([...before, ...after]).median} ms (médiane), pendant le fond ${stats(out.frappe.flatMap((x) => x.during)).median} ms`);
    // 3, warm: ten pop-ups whose summary the background compiled at the last round.
    await closePopups(page);
    await sleep(1000);
    out.chaud = [];
    for (const i of WARM) out.chaud.push(await openTimed(page, cache, i));
    console.error(`passe ${n}, pop-ups compilés en fond : ${out.chaud.map((o) => o.ms).join(', ')} ms`);
    out.frappeId = frappe;
    return out;
  } finally {
    cache.stop();
    await app?.close();
    await virtual?.close();
    await server.close();
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  }
}

const passes = [];
for (let n = 1; n <= PASSES; n++) passes.push(await pass(n));
const report = {
  settings: SETTINGS ?? 'défauts',
  passes,
  fond: { lastMs: stats(passes.map((p) => p.fond.lastMs)), firstMs: stats(passes.map((p) => p.fond.firstMs)), gaps: stats(passes.flatMap((p) => p.fond.gapsMs)) },
  fondPendantLaFrappe: { lastMs: stats(passes.flatMap((p) => p.frappe.map((x) => x.lastMs))), gaps: stats(passes.flatMap((p) => p.frappe.flatMap((x) => x.gapsMs))) },
  frappe: {
    criterion: 'p95 < 300 ms',
    sansFond: stats(passes.flatMap((p) => [...p.avant, ...p.apres])),
    avant: stats(passes.flatMap((p) => p.avant)),
    apres: stats(passes.flatMap((p) => p.apres)),
    pendantLeFond: stats(passes.flatMap((p) => p.frappe.flatMap((x) => x.during))),
  },
  ouverture: { criterion: '< 50 ms', froid: stats(passes.map((p) => p.froid.ms)), chaud: stats(passes.flatMap((p) => p.chaud.map((o) => o.ms))), compilees: passes.flatMap((p) => p.chaud).filter((o) => o.compiled > 0).length },
};
console.log(JSON.stringify(report, null, 2));
