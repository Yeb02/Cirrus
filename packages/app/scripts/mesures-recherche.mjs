// Plan 6a's measures (task 6): npm run mesures -w packages/app -- recherche [tout|charge|cercle] [reference|enrichie|toutes]
// (or node scripts/mesures-recherche.mjs …, the app built). Never the user's base nor profile, never the network: each
// session opens a fresh copy of a base from the temporary folder, in a window out of the user's way (cdp.mjs).
// The bases, 50 000 nodes and 500 000 knowledge connections each:
// - « reference »: the bench's (seed 1; npm run bench makes it, in %TEMP%/cirrus-bench-1-50000-500000): its titles are
//   « Nœud n », some followed by θ, ∑ or « ≤ é », its summaries and tags empty;
// - « enrichie »: the same graph, made here once (%TEMP%/cirrus-bench-recherche-1-50000-500000), each node a title of
//   words (« Nœud n : … »), a summary of 50 to 110 words drawn by a Zipf law from a vocabulary of ~3 000, and three
//   tags: Review Focus 1's long summaries. Its snapshot is encoded from its tables, as the main process would.
// Each session's settings keep the snapshot from being rewritten while it measures (QUIET). Three passes each:
// - charge: one session per pass and base. Its page is reloaded twice (Page.reload), a probe set first, before the app's
//   scripts (Page.addScriptToEvaluateOnNewDocument): first with requestIdleCallback turned off — the search index is
//   never built: the first frame without it, then renames before the index —, then with requestIdleCallback timed —
//   only the index's build uses it (App.tsx): each slice, the first, the last —: the first frame with it and the build;
//   once the index is built, the keystrokes in Ctrl+K until their list is drawn, renames and moves after the index (and
//   what each costs the index: the measure cirrus:search:update of search/index.ts), and the frames of a wheel zoom
//   without and with the ring of 50 results;
// - cercle (the reference base only): one session per pass, searchMaxResults at 500: the frames of the same zoom without
//   and with the ring of 500 results.
// Prints a JSON report, for the registry.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { launch, quantile, sleep } from './cdp.mjs';

/** Three passes; fewer while the script itself is tried (CIRRUS_MESURES_PASSES). */
const PASSES = Number(process.env.CIRRUS_MESURES_PASSES ?? 3);
const REFERENCE = join(tmpdir(), 'cirrus-bench-1-50000-500000');
const ENRICHED = join(tmpdir(), 'cirrus-bench-recherche-1-50000-500000');
const ENRICHED_STAMP = 'recherche.json', ENRICHED_VERSION = 1;
/** Every session's settings: a snapshot made stale by the renames is not rewritten while the session measures. */
const QUIET = { snapshotIdleMs: 60_000, snapshotAfterActions: 10_000 };
const r1 = (x) => Math.round(x * 10) / 10;
const r2 = (x) => Math.round(x * 100) / 100;
/** The median, p95, smallest and largest of `xs`, to a tenth (null for none). */
const stats = (xs, round = r1) => (xs.length === 0 ? null : { n: xs.length, median: round(quantile(xs, 0.5)), p95: round(quantile(xs, 0.95)), min: round(Math.min(...xs)), max: round(Math.max(...xs)) });

// ——— The enriched base ———

/** A seeded generator (mulberry32): the same base at every making. */
function random(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Words of the field, each also with endings: the vocabulary of the summaries, titles and tags. */
const STEMS = [
  'complexité', 'algorithme', 'algorithmique', 'entropie', 'information', 'compression', 'théorème', 'invariance', 'induction', 'déduction',
  'apprentissage', 'profond', 'réseau', 'neurone', 'gradient', 'descente', 'stochastique', 'optimisation', 'généralisation', 'régularisation',
  'surparamétrisation', 'biais', 'variance', 'modèle', 'données', 'mesure', 'probabilité', 'distribution', 'estimation', 'vraisemblance',
  'posteriore', 'priore', 'bayésien', 'hypothèse', 'principe', 'longueur', 'description', 'code', 'préfixe', 'machine', 'universelle',
  'calcul', 'calculabilité', 'décidable', 'récursion', 'fonction', 'ensemble', 'topologie', 'espace', 'métrique', 'norme', 'vecteur',
  'matrice', 'tenseur', 'spectre', 'valeur', 'propre', 'noyau', 'graphe', 'arbre', 'chemin', 'cycle', 'flot', 'coupe', 'clique', 'couleur',
  'symétrie', 'groupe', 'anneau', 'corps', 'idéal', 'module', 'catégorie', 'foncteur', 'morphisme', 'limite', 'continuité', 'dérivée',
  'intégrale', 'série', 'convergence', 'divergence', 'borne', 'inégalité', 'égalité', 'constante', 'variable', 'aléatoire', 'processus',
  'martingale', 'chaîne', 'markov', 'ergodique', 'mélange', 'temps', 'arrêt', 'source', 'canal', 'capacité', 'débit', 'bruit', 'signal',
  'filtre', 'fréquence', 'fourier', 'ondelette', 'échantillon', 'quantification', 'erreur', 'perte', 'risque', 'empirique', 'structurel',
  'dimension', 'rademacher', 'marge', 'séparateur', 'hyperplan', 'support', 'classifieur', 'régression', 'logistique', 'linéaire', 'convexe',
  'dualité', 'lagrangien', 'contrainte', 'point', 'selle', 'équilibre', 'jeu', 'stratégie', 'agent', 'récompense', 'politique', 'exploration',
  'exploitation', 'bandit', 'regret', 'adversaire', 'robustesse', 'attaque', 'défense', 'confiance', 'calibration', 'incertitude', 'entraînement',
  'validation', 'test', 'protocole', 'expérience', 'résultat', 'figure', 'tableau', 'preuve', 'lemme', 'corollaire', 'définition', 'proposition',
  'conjecture', 'contre-exemple', 'axiome', 'logique', 'prédicat', 'formule', 'sémantique', 'syntaxe', 'grammaire', 'langage', 'automate',
  'transducteur', 'état', 'transition', 'alphabet', 'mot', 'suite', 'occurrence', 'motif', 'régularité', 'hasard', 'déterminisme', 'causalité',
  'intervention', 'contrefactuel', 'corrélation', 'indépendance', 'conditionnelle', 'marginale', 'jointe', 'mutuelle', 'divergence', 'kullback',
  'wasserstein', 'transport', 'optimal', 'couplage', 'diffusion', 'score', 'bruitage', 'débruitage', 'génératif', 'discriminant', 'encodeur',
  'décodeur', 'attention', 'transformeur', 'jeton', 'contexte', 'mémoire', 'récurrent', 'convolution', 'pooling', 'activation', 'normalisation',
  'initialisation', 'taux', 'momentum', 'adam', 'lot', 'époque', 'surapprentissage', 'sous-apprentissage', 'capacité', 'expressivité', 'approximation',
  'universalité', 'profondeur', 'largeur', 'paysage', 'minimum', 'local', 'global', 'plateau', 'phase', 'transition', 'double', 'simplicité',
  'occam', 'rasoir', 'solomonoff', 'kolmogorov', 'shannon', 'chaitin', 'levin', 'vitányi', 'rissanen', 'kraft', 'huffman', 'arithmétique',
];
const ENDINGS = ['', 's', 'ique', 'iques', 'ité', 'isation', 'iste', 'al', 'aux', 'ement', 'eur', 'ion', 'aire'];
/** The typed queries of the enriched base (words of STEMS, typed without accents), and its letters. */
const ENRICHED_TYPED = { sequences: ['complexite algorithmique', 'theoreme invariance', 'apprentissage profond'], letters: ['a', 'c', 'd', 'e', 'i', 'm', 'p', 's', 't', 'n'], burst: 'entropie mesure' };
const REFERENCE_TYPED = { sequences: ['noeud 4217', 'noeud 305', 'noeud θ'], letters: ['n', 'e', '1', '2', '3', '4', '5', 'θ', 'q'], burst: 'noeud 2468' };

/** The enriched base, made once from the reference (its stamp says from which), and its snapshot from its tables. */
async function ensureEnriched() {
  const stampFile = join(ENRICHED, ENRICHED_STAMP);
  const stamp = JSON.stringify({ version: ENRICHED_VERSION, reference: JSON.parse(readFileSync(join(REFERENCE, 'bench-base.json'), 'utf8')) });
  if (existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return;
  console.error('Base enrichie…');
  rmSync(ENRICHED, { recursive: true, force: true });
  mkdirSync(ENRICHED, { recursive: true });
  copyFileSync(join(REFERENCE, 'cirrus.db'), join(ENRICHED, 'cirrus.db'));
  const rand = random(20261110);
  const words = [...new Set(STEMS.flatMap((s) => ENDINGS.map((e) => s + e)))];
  // Shuffled, then drawn by a Zipf law (weight 1 / rank): the stems themselves among the frequent ones.
  const order = [...STEMS, ...words.filter((w) => !STEMS.includes(w)).sort(() => rand() - 0.5)];
  const cumulative = [];
  let total = 0;
  for (let i = 0; i < order.length; i++) cumulative.push((total += 1 / (i + 1)));
  const draw = () => {
    const x = rand() * total;
    let lo = 0, hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < x) lo = mid + 1; else hi = mid; }
    return order[lo];
  };
  const some = (n) => Array.from({ length: n }, draw);
  const db = new DatabaseSync(join(ENRICHED, 'cirrus.db'));
  try {
    db.exec('BEGIN');
    const update = db.prepare('UPDATE nodes SET json = ? WHERE id = ?');
    for (const row of db.prepare('SELECT id, json FROM nodes').all()) {
      const n = JSON.parse(row.json);
      const number = /^Nœud (\d+)/.exec(n.title)?.[1] ?? '';
      const summary = some(50 + Math.floor(rand() * 61)).map((w, i) => (i > 0 && rand() < 0.08 ? `, ${w}` : ` ${w}`)).join('').trim();
      n.title = `Nœud ${number} : ${some(2 + Math.floor(rand() * 3)).join(' ')}`;
      n.summary = `${summary[0].toUpperCase()}${summary.slice(1)}, avec $x_${number % 10}$.`;
      n.tags = [{ key: 'domaine', value: draw() }, { key: 'méthode', value: draw() }, { key: draw() }];
      update.run(JSON.stringify(n), row.id);
    }
    db.exec('COMMIT');
  } finally {
    db.close();
  }
  const { LocalStore } = await import('@cirrus/store');
  const { encodeState } = await import('@cirrus/core');
  const store = LocalStore.open(ENRICHED, { pc: 'mesures' });
  try {
    const data = encodeState(store.loadState());
    store.dropSnapshot();
    store.writeSnapshot(data, store.lastSeq());
  } finally {
    store.close();
  }
  writeFileSync(stampFile, stamp, 'utf8');
  console.error(`Base enrichie faite : ${words.length} mots distincts au vocabulaire.`);
}

// ——— A session ———

/** A fresh copy of `base` and a profile of its own, with QUIET and `settings`; removed by `done`. */
function copyOf(base, settings = {}) {
  const data = mkdtempSync(join(tmpdir(), 'cirrus-mesures-recherche-'));
  copyFileSync(join(base, 'cirrus.db'), join(data, 'cirrus.db'));
  writeFileSync(join(data, 'settings.json'), JSON.stringify({ ...QUIET, ...settings }), 'utf8');
  const profile = mkdtempSync(join(tmpdir(), 'cirrus-mesures-recherche-profil-'));
  return { data, profile, done: () => { for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } };
}

/**
 * The node renamed and moved: a leaf of the lobby (no group's target) at the readable step, the nearest to the origin;
 * its place frames the view (CIRRUS_VIEW, at zoom 2).
 */
function leafOf(base) {
  const db = new DatabaseSync(join(base, 'cirrus.db'), { readOnly: true });
  try {
    const groups = new Set(db.prepare(`SELECT json_extract(value, '$.node') AS node FROM connections, json_each(json_extract(connections.json, '$.members'))
      WHERE kind = 'inclusion' AND json_extract(value, '$.role') = 'target'`).all().map((r) => r.node));
    let best = null;
    for (const p of db.prepare('SELECT node, json FROM placements').all()) {
      if (groups.has(p.node)) continue;
      const { x, y, k } = JSON.parse(p.json);
      if (k !== 0) continue;
      const d = Math.abs(x) + Math.abs(y);
      if (!best || d < best.d) best = { node: p.node, x, y, d };
    }
    const title = JSON.parse(db.prepare('SELECT json FROM nodes WHERE id = ?').get(best.node).json).title;
    return { ...best, title };
  } finally {
    db.close();
  }
}

/**
 * The probe set before the app's scripts at a reload. `idle`: 'off', requestIdleCallback never calls back (the index is
 * never built); 'timed', each idle callback timed (the search's slices: only the index's build and its .tex reading use
 * it). Also: the index's updates (cirrus:search:update), the long tasks, and while `recording`, each animation frame's
 * callback timed — on the CPU, and on the GPU by a timer query when the context has the extension —, with the moment
 * after its frame is painted (a message posted from it runs once the frame is done).
 */
const PROBE = (idle) => `(() => {
  const m = { idle: ${JSON.stringify(idle)}, calls: 0, slices: [], waiting: new Set(), updates: [], longTasks: [], frames: [], recording: false, gl: null, timer: null };
  window.__mesure = m;
  const ric = window.requestIdleCallback.bind(window), cic = window.cancelIdleCallback.bind(window);
  if (m.idle === 'off') {
    window.requestIdleCallback = () => { m.calls++; return 0; };
    window.cancelIdleCallback = () => {};
  } else {
    window.requestIdleCallback = (fn, opts) => {
      m.calls++;
      const asked = performance.now();
      const h = ric((deadline) => {
        m.waiting.delete(h);
        const start = performance.now();
        try { fn(deadline); } finally { m.slices.push({ asked, start, ms: performance.now() - start }); }
      }, opts);
      m.waiting.add(h);
      return h;
    };
    window.cancelIdleCallback = (h) => { m.waiting.delete(h); cic(h); };
  }
  new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.name === 'cirrus:search:update') m.updates.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'measure' });
  try { new PerformanceObserver((l) => { for (const e of l.getEntries()) m.longTasks.push({ at: e.startTime, ms: e.duration }); }).observe({ type: 'longtask' }); } catch {}
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, attrs) {
    const ctx = getContext.call(this, type, attrs);
    if (type === 'webgl2' && ctx && !m.gl) { m.gl = ctx; m.timer = ctx.getExtension('EXT_disjoint_timer_query_webgl2'); }
    return ctx;
  };
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = (fn) => raf((now) => {
    if (!m.recording || fn.__probe) return fn(now);
    const gl = m.gl, ext = m.timer;
    let q = null;
    if (gl && ext && !gl.isContextLost()) { q = gl.createQuery(); gl.beginQuery(ext.TIME_ELAPSED_EXT, q); }
    const start = performance.now();
    const f = { start, ms: null, painted: null, gpu: null, q };
    m.frames.push(f);
    try { return fn(now); } finally {
      f.ms = performance.now() - start;
      if (q) gl.endQuery(ext.TIME_ELAPSED_EXT);
      const ch = new MessageChannel();
      ch.port1.onmessage = () => { f.painted = performance.now(); };
      ch.port2.postMessage(0);
    }
  });
  /** The GPU times known so far; how many are still waited for. */
  m.pollGpu = () => {
    const gl = m.gl, ext = m.timer;
    if (!gl || !ext) return 0;
    const disjoint = gl.getParameter(ext.GPU_DISJOINT_EXT);
    let left = 0;
    for (const f of m.frames) {
      if (!f.q) continue;
      if (!gl.getQueryParameter(f.q, gl.QUERY_RESULT_AVAILABLE)) { left++; continue; }
      f.gpu = disjoint ? null : gl.getQueryParameter(f.q, gl.QUERY_RESULT) / 1e6;
      gl.deleteQuery(f.q);
      f.q = null;
    }
    return left;
  };
  /** Waits for the GPU times of the frames recorded (two seconds at most), then gives them without their queries. */
  m.takeFrames = () => new Promise((done) => {
    let n = 0;
    const tick = () => {
      if (m.pollGpu() === 0 || ++n > 240) { done(m.frames.map(({ start, ms, painted, gpu }) => ({ start, ms, painted, gpu }))); m.frames = []; }
      else requestAnimationFrame(tick);
    };
    tick.__probe = true;
    requestAnimationFrame(tick);
  });
})()`;

/** The page reloaded with PROBE(idle) set before its scripts; resolves once its first frame is drawn. */
async function reloadWith(page, idle) {
  await page.send('Page.enable');
  const { result } = await page.send('Page.addScriptToEvaluateOnNewDocument', { source: PROBE(idle) });
  try {
    await page.send('Page.reload', { ignoreCache: false });
    await sleep(500);
    if (!(await page.until(`!!window.__mesure && performance.getEntriesByName('cirrus:load:firstFrame').length > 0`, 120_000))) throw new Error(`pas de première image après le rechargement (${idle})`);
  } finally {
    await page.send('Page.removeScriptToEvaluateOnNewDocument', { identifier: result.identifier });
  }
  await page.send('Emulation.setFocusEmulationEnabled', { enabled: true });
}

/** The load marks of the page shown (ms since its navigation). */
const loadMarks = (page) => page.evaluate(`Object.fromEntries(['dataReceived', 'stateReady', 'sceneReady', 'engineReady', 'firstFrame'].map((k) => [k, performance.getEntriesByName('cirrus:load:' + k)[0]?.startTime ?? null]))`);

/** The build seen by the timed probe, once over (no idle callback waited for during a second after the last slice). */
async function buildOf(page) {
  const done = `(() => { const m = window.__mesure; const last = m.slices.at(-1); return m.slices.length > 0 && m.waiting.size === 0 && performance.now() - (last.start + last.ms) > 1000; })()`;
  if (!(await page.until(done, 180_000))) throw new Error('la construction de l’index ne finit pas');
  const { slices, longTasks, firstFrame } = await page.evaluate(`({ slices: window.__mesure.slices, longTasks: window.__mesure.longTasks, firstFrame: performance.getEntriesByName('cirrus:load:firstFrame')[0].startTime })`);
  const first = slices[0], last = slices.at(-1), ms = slices.map((s) => s.ms);
  const during = longTasks.filter((t) => t.at + t.ms >= first.start && t.at <= last.start + last.ms);
  return {
    firstFrame: r1(firstFrame), firstSliceAfterFrame: r1(first.start - firstFrame), readyAfterFrame: Math.round(last.start + last.ms - firstFrame),
    spanMs: Math.round(last.start + last.ms - first.start), workMs: Math.round(ms.reduce((a, b) => a + b, 0)), slices: slices.length,
    slice: stats(ms, r2), longTasksDuring: during.map((t) => r1(t.ms)),
  };
}

/** Clicks at `at` until the node's pop-up shows `title`. */
async function openNodePopup(page, at, title) {
  const shown = `document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(title)}`;
  for (let i = 0; i < 10 && !(await page.until(shown, 1000)); i++) await page.dblclick(at.x, at.y);
  if (!(await page.evaluate(shown))) throw new Error(`le pop-up de « ${title} » ne s’ouvre pas`);
}

/** Records, for each Enter in a node pop-up's title, its moment and when the pop-up shows the new title (the state applied). */
const RENAME_PROBE = `(() => {
  if (window.__renommer) return;
  const r = { runs: [] };
  window.__renommer = r;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || !e.target.matches?.('.node-popup input.title')) return;
    const run = { t0: e.timeStamp, want: e.target.value.trim(), dom: null };
    r.runs.push(run);
    const popup = e.target.closest('.node-popup');
    const o = new MutationObserver(() => {
      const input = popup.querySelector('input.title');
      if (!input || input.value !== run.want || run.dom !== null) return;
      run.dom = performance.now();
      o.disconnect();
    });
    o.observe(popup, { childList: true, subtree: true });
  }, true);
})()`;

/**
 * `count` renames of the node in its pop-up (Entrée), the frames recorded: each, from Entrée to the end of the first
 * frame drawn after the pop-up shows the new title (the graph draws the new scene then), and to its paint; the index's
 * update during it, if any.
 */
async function renames(page, leaf, at, count, tag) {
  await page.evaluate(RENAME_PROBE);
  await openNodePopup(page, at, leaf.title);
  const out = [];
  for (let i = 0; i < count; i++) {
    const want = `${leaf.title} ${tag} ${i + 1}`;
    const field = await page.centre('.node-popup input.title', '');
    await page.click(field.x, field.y);
    await page.press('a', 'KeyA', 65, 2);
    await page.evaluate(`window.__mesure.frames = []; window.__mesure.updates = []; window.__mesure.recording = true`);
    await page.type(want);
    await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    if (!(await page.until(`window.__renommer.runs.at(-1)?.want === ${JSON.stringify(want)} && window.__renommer.runs.at(-1).dom !== null`, 10_000))) throw new Error(`le renommage en « ${want} » ne se voit pas`);
    await sleep(600);
    await page.evaluate(`window.__mesure.recording = false`);
    const run = await page.evaluate(`window.__renommer.runs.at(-1)`);
    const frames = await page.evaluate(`window.__mesure.takeFrames()`);
    const updates = await page.evaluate(`window.__mesure.updates`);
    const frame = frames.find((f) => f.start >= run.dom);
    out.push({ dom: run.dom - run.t0, frame: frame ? frame.start + frame.ms - run.t0 : null, painted: frame?.painted ? frame.painted - run.t0 : null, update: updates.find((u) => u.at >= run.t0)?.ms ?? null });
    await sleep(300);
  }
  // Back to the graph: the pop-up closed.
  for (let i = 0; i < 3 && (await page.evaluate(`!!document.querySelector('.node-popup')`)); i++) await page.press('Escape', 'Escape', 27);
  return out;
}

/**
 * `count` moves of the node at `at` by the mouse (60 px to the right, then back), the frames recorded: each, the index's
 * update its action made, and from the release to the end of the first frame drawn after that update (the new scene).
 */
async function moves(page, at, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const from = i % 2 === 0 ? at : { x: at.x + 60, y: at.y }, to = i % 2 === 0 ? { x: at.x + 60, y: at.y } : at;
    await page.evaluate(`window.__mesure.frames = []; window.__mesure.updates = []; window.__mesure.recording = true; window.__lacher = null;
      window.addEventListener('pointerup', (e) => { window.__lacher = e.timeStamp; }, { capture: true, once: true })`);
    await page.drag(from, to, 8);
    if (!(await page.until(`window.__mesure.updates.length > 0`, 10_000))) throw new Error(`le déplacement n° ${i + 1} ne touche pas l’index`);
    await sleep(600);
    await page.evaluate(`window.__mesure.recording = false`);
    const released = await page.evaluate(`window.__lacher`);
    const updates = await page.evaluate(`window.__mesure.updates`);
    const frames = await page.evaluate(`window.__mesure.takeFrames()`);
    const u = updates[0], frame = frames.find((f) => f.start >= u.at + u.ms);
    out.push({ update: u.ms, updates: updates.length, frame: frame && released !== null ? frame.start + frame.ms - released : null, painted: frame?.painted && released !== null ? frame.painted - released : null });
    await sleep(300);
  }
  return out;
}

/** Each keystroke in the search box: its moment (the event's), when its input has rendered the box, the frame after. */
const KEY_PROBE = `(() => {
  if (window.__frappe) return;
  const k = { events: [] };
  window.__frappe = k;
  window.addEventListener('keydown', (e) => { if (e.target.closest?.('.search-box')) k.events.push({ key: e.key, ctrl: e.ctrlKey, t0: e.timeStamp, dom: null, frame: null, rows: null }); }, true);
  // In the bubbling phase at the window: after React's own listener, whose render of the input is done by then.
  window.addEventListener('input', (e) => {
    if (!e.target.closest?.('.search-box')) return;
    const ev = k.events.at(-1);
    if (!ev || ev.dom !== null) return;
    ev.dom = performance.now();
    ev.rows = document.querySelectorAll('.search-box .search-results li').length;
    const f = () => { const ch = new MessageChannel(); ch.port1.onmessage = () => { ev.frame = performance.now(); }; ch.port2.postMessage(0); };
    f.__probe = true;
    requestAnimationFrame(f);
  });
})()`;

const keyCode = (ch) => (ch === ' ' ? 32 : /^[a-z0-9]$/i.test(ch) ? ch.toUpperCase().charCodeAt(0) : 0);
async function key(page, ch) {
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch, windowsVirtualKeyCode: keyCode(ch) });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: ch, windowsVirtualKeyCode: keyCode(ch) });
}
/** The last keystroke's frame drawn (3 s at most). */
const settled = (page) => page.evaluate(`new Promise((done) => { const end = performance.now() + 3000; const check = () => { const e = window.__frappe.events.at(-1); if ((e && e.frame !== null) || performance.now() > end) done(true); else setTimeout(check, 5); }; check(); })`);
/** The field emptied, if it holds anything: Ctrl+A, then Retour arrière (not counted). */
async function clearField(page) {
  if (await page.evaluate(`document.querySelector('.search-box .search-field')?.value === ''`)) return;
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await settled(page);
  await sleep(150);
}
const FIELD = `document.activeElement?.matches('.search-box .search-field') === true`;
async function openSearch(page) {
  for (let i = 0; i < 10 && !(await page.until(FIELD, 1000)); i++) await page.press('k', 'KeyK', 75, 2);
  if (!(await page.evaluate(FIELD))) throw new Error('Ctrl+K n’ouvre pas la recherche');
  if (!(await page.until(`!document.querySelector('.search-box .search-status') || document.querySelector('.search-box .search-status').textContent !== 'Préparation de la recherche…'`, 60_000))) throw new Error('l’index n’est jamais prêt');
}
async function closeSearch(page) {
  for (let i = 0; i < 3 && (await page.evaluate(`!!document.querySelector('.search-box')`)); i++) await page.press('Escape', 'Escape', 27);
}

/**
 * The keystrokes of `typed`: each sequence typed key by key, each waiting for the previous one's frame; each letter alone
 * in an empty field; then a burst, a key every 35 ms without waiting. Each: from the key's event to its input rendered
 * (the list in the box), and to the frame after.
 */
async function keystrokes(page, typed) {
  await page.evaluate(KEY_PROBE);
  await openSearch(page);
  await page.evaluate(`window.__frappe.events = []`);
  /** A key, its frame waited for, then named: `kind` and the text typed so far. */
  const one = async (ch, kind, query) => {
    await key(page, ch);
    await settled(page);
    await page.evaluate(`Object.assign(window.__frappe.events.at(-1), { kind: ${JSON.stringify(kind)}, query: ${JSON.stringify(query)} })`);
    await sleep(80);
  };
  for (const q of typed.sequences) {
    await clearField(page);
    for (let i = 0; i < q.length; i++) await one(q[i], 'suite', q.slice(0, i + 1));
  }
  for (const ch of typed.letters) {
    await clearField(page);
    await one(ch, 'lettre', ch);
  }
  await clearField(page);
  for (const ch of typed.burst) { await key(page, ch); await sleep(35); }
  await sleep(1500);
  const events = await page.evaluate(`window.__frappe.events`);
  const burstEvents = events.filter((e) => !e.kind && !e.ctrl && e.key !== 'Backspace' && e.dom !== null).slice(-typed.burst.length);
  burstEvents.forEach((e, i) => { e.kind = 'rafale'; e.query = typed.burst.slice(0, i + 1); });
  await clearField(page);
  await closeSearch(page);
  return events.filter((e) => e.kind).map((e) => ({ kind: e.kind, query: e.query, dom: e.dom === null ? null : e.dom - e.t0, frame: e.frame === null ? null : e.frame - e.t0, rows: e.rows }));
}

/** The frames of a wheel zoom at `at` (15 steps in, 15 out, one each 40 ms): each frame's CPU and GPU time. */
async function zoomFrames(page, at) {
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: at.x, y: at.y });
  await sleep(300);
  await page.evaluate(`window.__mesure.frames = []; window.__mesure.recording = true`);
  for (const deltaY of [...Array(15).fill(-120), ...Array(15).fill(120)]) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: at.x, y: at.y, deltaX: 0, deltaY });
    await sleep(40);
  }
  await sleep(800);
  await page.evaluate(`window.__mesure.recording = false`);
  // The frames that drew (a turn of the loop with nothing to draw takes a few microseconds).
  return (await page.evaluate(`window.__mesure.takeFrames()`)).filter((f) => f.ms > 0.05);
}

/**
 * The same zoom without and with the ring (the box open on « noeud », which every title answers: as many rings as
 * results, searchMaxResults), three times each, alternately; the box closed after.
 */
async function ringFrames(page, at) {
  const off = [], on = [];
  let rings = null;
  for (let i = 0; i < 3; i++) {
    await closeSearch(page);
    off.push(...(await zoomFrames(page, at)));
    await openSearch(page);
    await page.type('noeud');
    if (!(await page.until(`document.querySelectorAll('.search-box .search-results li').length > 0`, 10_000))) throw new Error('« noeud » ne trouve rien');
    rings = await page.evaluate(`[...document.querySelectorAll('.search-box .search-results li .where')].filter((w) => w.textContent === 'ce plan').length`);
    on.push(...(await zoomFrames(page, at)));
  }
  await closeSearch(page);
  const sum = (fs) => ({ frames: fs.length, cpu: stats(fs.map((f) => f.ms), r2), gpu: stats(fs.filter((f) => f.gpu !== null).map((f) => f.gpu), r2) });
  return { rings, sans: sum(off), avec: sum(on) };
}

const graphCentre = (page) => page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
/** A point of the graph away from the search box (top, centred) and from the node's pop-up. */
const zoomPoint = (page) => page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width * 0.2, y: r.top + r.height * 0.8 }; })()`);

/** One pass of « charge » on `base`. */
async function chargePass(base, typed, n) {
  const leaf = leafOf(base);
  const b = copyOf(base);
  const app = await launch(b.data, b.profile, { CIRRUS_VIEW: `${leaf.x},${leaf.y},2` });
  try {
    const { page } = app;
    const cold = await loadMarks(page);
    // Without the index: requestIdleCallback never calls back.
    await reloadWith(page, 'off');
    const without = await loadMarks(page);
    await sleep(3000);
    const blocked = await page.evaluate(`window.__mesure.calls`);
    const centre = await graphCentre(page);
    const before = await renames(page, leaf, centre, 10, 'avant');
    // With it, timed.
    await reloadWith(page, 'timed');
    const withIndex = await loadMarks(page);
    const build = await buildOf(page);
    const keys = await keystrokes(page, typed);
    const after = await renames(page, { ...leaf, title: `${leaf.title} avant 10` }, centre, 10, 'après');
    const moved = await moves(page, centre, 10);
    const ring = await ringFrames(page, await zoomPoint(page));
    console.error(`passe ${n + 1} : index prêt ${build.readyAfterFrame} ms après la première image, ${keys.length} frappes`);
    return { leaf: leaf.title, cold, without, blocked, withIndex, build, keys, renames: { before, after }, moves: moved, ring };
  } finally {
    await app.close();
    b.done();
  }
}

/** One pass of « cercle »: searchMaxResults at 500, the index built (Ctrl+K waits for it), the zoom without and with 500 rings. */
async function cerclePass(base, n) {
  const leaf = leafOf(base);
  const b = copyOf(base, { searchMaxResults: 500 });
  const app = await launch(b.data, b.profile, { CIRRUS_VIEW: `${leaf.x},${leaf.y},2` });
  try {
    const { page } = app;
    await reloadWith(page, 'timed');
    await buildOf(page);
    const ring = await ringFrames(page, await zoomPoint(page));
    console.error(`cercle, passe ${n + 1} : ${ring.rings} cercles`);
    return ring;
  } finally {
    await app.close();
    b.done();
  }
}

/** The passes' figures put together. */
function summary(passes) {
  const all = (f) => passes.flatMap(f);
  const keys = all((p) => p.keys);
  const byKind = (k) => keys.filter((e) => e.kind === k);
  const fr = (es) => stats(es.filter((e) => e.frame !== null).map((e) => e.frame));
  const dom = (es) => stats(es.filter((e) => e.dom !== null).map((e) => e.dom));
  const ff = (k) => passes.map((p) => r1(p[k].firstFrame));
  return {
    firstFrame: { cold: ff('cold'), withoutIndex: ff('without'), withIndex: ff('withIndex') },
    build: passes.map((p) => p.build),
    keystrokes: {
      all: { frame: fr(keys.filter((e) => e.kind !== 'rafale')), dom: dom(keys.filter((e) => e.kind !== 'rafale')) },
      suite: { frame: fr(byKind('suite')), dom: dom(byKind('suite')) },
      lettre: { frame: fr(byKind('lettre')), dom: dom(byKind('lettre')) },
      rafale: { frame: fr(byKind('rafale')), dom: dom(byKind('rafale')) },
      worst: [...keys].filter((e) => e.frame !== null).sort((a, b) => b.frame - a.frame).slice(0, 5),
    },
    renames: {
      before: { dom: stats(all((p) => p.renames.before.map((r) => r.dom))), frame: stats(all((p) => p.renames.before.filter((r) => r.frame !== null).map((r) => r.frame))), painted: stats(all((p) => p.renames.before.filter((r) => r.painted !== null).map((r) => r.painted))) },
      after: { dom: stats(all((p) => p.renames.after.map((r) => r.dom))), frame: stats(all((p) => p.renames.after.filter((r) => r.frame !== null).map((r) => r.frame))), painted: stats(all((p) => p.renames.after.filter((r) => r.painted !== null).map((r) => r.painted))), update: stats(all((p) => p.renames.after.filter((r) => r.update !== null).map((r) => r.update)), r2) },
    },
    moves: { update: stats(all((p) => p.moves.map((m) => m.update)), r2), frame: stats(all((p) => p.moves.filter((m) => m.frame !== null).map((m) => m.frame))), painted: stats(all((p) => p.moves.filter((m) => m.painted !== null).map((m) => m.painted))) },
    ring: passes.map((p) => p.ring),
  };
}

const [what = 'tout', which = 'toutes'] = process.argv.slice(2);
if (!['tout', 'charge', 'cercle'].includes(what) || !['reference', 'enrichie', 'toutes'].includes(which)) {
  console.error('Usage : npm run mesures -w packages/app -- recherche [tout|charge|cercle] [reference|enrichie|toutes]');
  process.exit(2);
}
if (!existsSync(join(REFERENCE, 'cirrus.db'))) {
  console.error(`Pas de base de référence dans ${REFERENCE} (npm run bench la construit).`);
  process.exit(2);
}
const report = {};
const bases = which === 'toutes' ? ['reference', 'enrichie'] : [which];
if (what === 'tout' || what === 'charge') {
  for (const kind of bases) {
    if (kind === 'enrichie') await ensureEnriched();
    const base = kind === 'reference' ? REFERENCE : ENRICHED, typed = kind === 'reference' ? REFERENCE_TYPED : ENRICHED_TYPED;
    const passes = [];
    for (let n = 0; n < PASSES; n++) {
      console.error(`charge, base ${kind}, passe ${n + 1}…`);
      passes.push(await chargePass(base, typed, n));
    }
    report[kind] = { summary: summary(passes), passes };
  }
}
if ((what === 'tout' || what === 'cercle') && bases.includes('reference')) {
  const passes = [];
  for (let n = 0; n < PASSES; n++) passes.push(await cerclePass(REFERENCE, n));
  report.cercle500 = passes;
}
console.log(JSON.stringify(report, null, 2));
