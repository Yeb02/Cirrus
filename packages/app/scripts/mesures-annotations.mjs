// The measures of plan 4c, task 7, in the app built: npm run mesures -w packages/app [-- bib|ouverture|defilement]
// (`-- synchro …`: plan 5a's, mesures-synchro.mjs, in a process of its own with its collector exposed; `-- latex-fond`:
// plan 5b's, mesures-latex-fond.mjs, the recompilation in the background; `-- recherche`: plan 6a's,
// mesures-recherche.mjs, the search.)
// Three passes each, on fresh artificial test bases (make-fixture.ts, then add-reading.ts: a PDF of 25 pages annotated
// 50 times, and the same file in a node without annotations), in windows out of the user's way (cdp.mjs): never the
// user's base nor profile, never the network.
// - bib: a .bib of 2 000 entries, analysed (parseBibtex alone, in Node; then in the app, from the drop to the ghost,
//   by the import's marks) and put down (from the click to the action, then to the frame drawn after it);
// - ouverture: the PDF of 50 annotations opened in a node's preview, from the click on its file to its first page
//   drawn, its highlights and its margin; cold (the first PDF of the session), then warm; the same file without
//   annotations for comparison;
// - defilement: the preview scrolled from its first page to its last by the wheel (real input): the frames' intervals,
//   the long animation frames, and at each frame the pages in view and those that hold highlights.
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseBibtex } from '@cirrus/core';
import { appDir, launch, quantile, sleep } from './cdp.mjs';

const SCRIPTS = { synchro: 'mesures-synchro.mjs', 'latex-fond': 'mesures-latex-fond.mjs', recherche: 'mesures-recherche.mjs' };
if (Object.hasOwn(SCRIPTS, process.argv[2] ?? '')) {
  const script = SCRIPTS[process.argv[2]];
  const r = spawnSync(process.execPath, ['--expose-gc', join(appDir, 'scripts', script), ...process.argv.slice(3)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const PASSES = 3;
const fixtures = join(appDir, '..', 'fixtures');
const what = process.argv[2] ?? 'tout';
const ms = (v) => (v === null || v === undefined ? '—' : `${Math.round(v)} ms`);

/** A fresh test base, with the long annotated PDF if `reading`, and its settings; removed by `done`. */
function testBase(reading, settings) {
  const data = mkdtempSync(join(tmpdir(), 'cirrus-mesures-'));
  execFileSync(process.execPath, [join(fixtures, 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
  if (reading) execFileSync(process.execPath, [join(fixtures, 'scripts', 'add-reading.ts'), data], { stdio: 'ignore' });
  if (settings) writeFileSync(join(data, 'settings.json'), JSON.stringify(settings), 'utf8');
  const profile = mkdtempSync(join(tmpdir(), 'cirrus-mesures-profil-'));
  const base = (sql) => {
    const db = new DatabaseSync(join(data, 'cirrus.db'), { readOnly: true });
    try { return db.prepare(sql).all(); } finally { db.close(); }
  };
  return { data, profile, base, done: () => { for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } };
}

// ——— A .bib of 2 000 entries ———

/** The real references of core's tests (50, written as JabRef, Scholar, DBLP, Crossref and by hand) made 2 000 distinct ones. */
const REAL = readFileSync(join(appDir, '..', 'core', 'tests', 'data', 'reel-50.bib'), 'utf8');
function realBib(pass) {
  const pad = (n, w) => String(n).padStart(w, '0');
  return Array.from({ length: 40 }, (_, r) => {
    const c = pass * 40 + r;
    return REAL
      .replace(/^(@(?!string|comment|preamble)\w+\s*[{(]\s*)([^,\s]+)(\s*,)/gim, (_, a, k, e) => `${a}${k}-p${pass}c${r}${e}`)
      .replace(/(\btitle\s*=\s*)([{"])/gi, `$1$2[${pass}.${r}] `)
      .replace(/(\bdoi\s*=\s*[{"]\s*)(?!10\.48550)([^}"]+?)(\s*[}"])/gi, `$1$2.p${pass}c${r}$3`)
      .replace(/\b(\d{4})\.(\d{4,5})\b/g, (_, ym, n) => `${ym}.${pad(c, 3)}${n.slice(3)}`)
      .replace(/\b([a-z-]+)\/(\d{4})(\d{3})\b/g, (_, a, ym) => `${a}/${ym}${pad(c, 3)}`);
  }).join('\n');
}
/** Task 6's measure: 2 000 entries of six lines, each its key, title and DOI. */
function plainBib(pass) {
  return Array.from({ length: 2000 }, (_, i) => [
    `@article{auteur${pass}x${i},`, `  author = {Nom${i}, Prénom and Autre, Jean},`, `  title = {Titre ${pass}.${i} d’un article -- avec {\\'e}},`,
    `  journal = {Revue}, year = ${1950 + (i % 70)},`, `  doi = {10.5555/run${pass}.${i}}`, '}',
  ].join('\n')).join('\n');
}

async function measureBib() {
  console.log('\n— Un .bib de 2 000 entrées —');
  for (const [name, make] of [['réelles', realBib], ['de la tâche 6', plainBib]]) {
    for (let pass = 0; pass < PASSES; pass++) {
      const text = make(pass), t0 = performance.now(), read = parseBibtex(text), t1 = performance.now();
      console.log(`  parseBibtex seul (Node), entrées ${name}, passe ${pass + 1} : ${(t1 - t0).toFixed(1)} ms, ${read.entries.length} entrées, ${read.problems.length} problèmes, ${(text.length / 1024).toFixed(0)} Ko`);
    }
  }
  const t = testBase(false);
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-mesures-bib-'));
  const app = await launch(t.data, t.profile, { CIRRUS_VIEW: '-420,-300,1' });
  try {
    const { page } = app, count = () => t.base('SELECT count(*) AS n FROM nodes')[0].n, before = count();
    const SKY = { x: 1530, y: 110 }, SKY2 = { x: 1530, y: 250 };
    const markAt = (m) => page.evaluate(`performance.getEntriesByName('cirrus:bib:${m}').at(-1)?.startTime ?? null`);
    for (const [name, make] of [['réelles', realBib], ['de la tâche 6', plainBib]]) {
      for (let pass = 0; pass < PASSES; pass++) {
        const path = join(dir, `${name === 'réelles' ? 'reelles' : 'tache6'}-${pass + 1}.bib`);
        writeFileSync(path, make(pass + 10), 'utf8');
        await page.move(SKY2.x, SKY2.y);
        await page.dropFiles(SKY2, [path]);
        if (!(await page.until(`/^Importer 2.000 publications$/.test(document.querySelector('.ghost')?.textContent ?? '')`, 90000))) {
          throw new Error(`pas de fantôme de 2 000 publications enregistrées : « ${await page.evaluate(`document.querySelector('.ghost')?.textContent ?? ''`)} »`);
        }
        await page.move(SKY.x, SKY.y);
        await page.click(SKY.x, SKY.y);
        const ok = async () => count() === before + 2000;
        for (let i = 0; i < 900 && !(await ok()); i++) await sleep(100);
        if (!(await ok())) throw new Error(`${count() - before} nœuds créés au lieu de 2 000`);
        if (!(await page.until(`performance.getEntriesByName('cirrus:bib:placed').length > 0 && !document.querySelector('.ghost')`, 10000))) throw new Error('pas de marque de la pose');
        const drawn = await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))`);
        const [drop, read, planned, ghost, stored, click, placed] = await Promise.all(['drop', 'read', 'planned', 'ghost', 'stored', 'click', 'placed'].map(markAt));
        console.log(`  app, entrées ${name}, passe ${pass + 1} : dépôt → fichier lu ${ms(read - drop)} ; lu → analysé et planifié ${ms(planned - read)} ; → fantôme ${ms(ghost - planned)} (dépôt → fantôme ${ms(ghost - drop)}) ; fantôme → .bib enregistrés ${ms(stored - ghost)} ; clic → action ${ms(placed - click)}, → image ${ms(drawn - click)}`);
        await page.press('Escape', 'Escape', 27);
        await page.press('z', 'KeyZ', 90, 2);
        for (let i = 0; i < 300 && count() !== before; i++) await sleep(100);
        if (count() !== before) throw new Error('un Ctrl+Z ne retire pas tout l’import');
        await sleep(1000);
      }
    }
  } finally {
    await app.close();
    t.done();
    rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
}

// ——— The PDF of 50 annotations: opened, then scrolled ———

const READING = 'lecture_de_mesure.pdf';
/** The reader's preview wide and tall enough to read its pages beside its margin (as the interface's checks). */
const PREVIEW = { previewWidthPx: 1000, previewHeightPx: 820 };
/**
 * The node of the annotated PDF (−700, −300), or of the same file without annotations (−700, −140), at the view's
 * centre: (792, 499) in the window, under the tabs (a title of two lines leaves 461 above its box).
 */
const VIEWS = { annotated: '-700,-300,1', plain: '-700,-140,1' };
const CENTRE = { x: 792, y: 499 };

/** Records, from the next click on a file of a pop-up, when page 1 is drawn, its text, its highlights and the margin. */
const OPEN_PROBE = (marks, margin) => `(() => {
  const m = { t0: null, canvas: null, text: null, marks: null, margin: null, all: null, frame: null };
  window.__open = m;
  const want = { marks: ${marks}, margin: ${margin} };
  document.addEventListener('click', (e) => { if (m.t0 === null && e.target.closest && e.target.closest('.node-popup .file')) m.t0 = performance.now(); }, true);
  const check = () => {
    if (m.t0 === null || m.all !== null) return;
    const now = performance.now(), p1 = document.querySelector('.file-preview .pdf-page[data-page="1"]');
    if (m.canvas === null && p1 && p1.querySelector('canvas')) m.canvas = now;
    if (m.text === null && p1 && p1.querySelector('.textLayer span')) m.text = now;
    if (m.marks === null && want.marks > 0 && p1 && p1.querySelectorAll('.annotation-layer .mark').length >= want.marks) m.marks = now;
    if (m.margin === null && want.margin > 0 && document.querySelectorAll('.file-preview .annotation-margin li').length >= want.margin) m.margin = now;
    if (m.canvas !== null && m.text !== null && (want.marks === 0 || m.marks !== null) && (want.margin === 0 || m.margin !== null)) {
      m.all = now;
      requestAnimationFrame(() => requestAnimationFrame(() => { m.frame = performance.now(); }));
    }
  };
  const o = new MutationObserver(check);
  o.observe(document.body, { subtree: true, childList: true });
  m.stop = () => o.disconnect();
})()`;

/** Opens the reading's file from its node's pop-up (opened first, by a click on the node), and returns the probe's times. */
async function openReading(page, marks, margin) {
  await page.evaluate(OPEN_PROBE(marks, margin));
  const row = await page.centre(`.node-popup .file[data-name="${READING}"]`, '');
  await page.click(row.x, row.y);
  if (!(await page.until(`window.__open.frame !== null`, 30000))) throw new Error(`le PDF ne s’ouvre pas : ${JSON.stringify(await page.evaluate('window.__open'))}`);
  const m = await page.evaluate(`(() => { window.__open.stop(); return window.__open; })()`);
  const at = (k) => (m[k] === null ? null : m[k] - m.t0);
  const view = await page.evaluate(`(() => ({ zoom: document.querySelector('.file-preview .pdf-tools .zoom')?.textContent, width: document.querySelector('.file-preview .pdf-scroll')?.clientWidth }))()`);
  return { canvas: at('canvas'), text: at('text'), marks: at('marks'), margin: at('margin'), all: at('all'), frame: at('frame'), ...view };
}

/**
 * The preview scrolled by the wheel from its top to its end: at each frame, its interval since the last one, the time to
 * the task after it (rendering), the scroll, the pages in view (from the pages' places and the scroll, without layout)
 * and those that hold a layer of highlights, and the marks in the page; the long animation frames meanwhile.
 */
const SCROLL_PROBE = `(() => {
  const box = document.querySelector('.file-preview .pdf-scroll'), H = box.clientHeight, pages = [...box.querySelectorAll('.pdf-page')];
  const rec = { frames: [], loaf: [], stop: false, H, ahead: null };
  window.__scroll = rec;
  const po = new PerformanceObserver((l) => { for (const e of l.getEntries()) rec.loaf.push({ start: e.startTime, duration: e.duration, blocking: e.blockingDuration }); });
  try { po.observe({ type: 'long-animation-frame' }); } catch {}
  rec.end = () => { rec.stop = true; po.disconnect(); };
  const tick = (t) => {
    if (rec.stop) return;
    const top = box.scrollTop, visible = [], layers = [], canvases = [];
    let marks = 0;
    for (const el of pages) {
      const y = parseFloat(el.style.top), h = parseFloat(el.style.height), n = Number(el.dataset.page);
      if (y < top + H && y + h > top) visible.push(n);
      const layer = el.querySelector('.annotation-layer');
      if (layer) { layers.push(n); marks += layer.childElementCount; }
      if (el.querySelector('canvas')) canvases.push(n);
    }
    const f = { t, top, visible, layers, canvases, marks, work: null };
    rec.frames.push(f);
    const start = performance.now(), ch = new MessageChannel();
    ch.port1.onmessage = () => { f.work = performance.now() - start; };
    ch.port2.postMessage(0);
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})()`;

async function scrollReading(page) {
  const box = await page.evaluate(`(() => { const r = document.querySelector('.file-preview .pdf-scroll').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
  await page.move(box.x, box.y);
  await page.evaluate(SCROLL_PROBE);
  let last = -1;
  for (let i = 0; i < 2000; i++) {
    await page.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: box.x, y: box.y, deltaX: 0, deltaY: 100 });
    await sleep(16);
    if (i % 25 === 24) {
      const top = await page.evaluate(`document.querySelector('.file-preview .pdf-scroll').scrollTop`);
      if (top === last) break;
      last = top;
    }
  }
  await sleep(500);
  const r = await page.evaluate(`(() => { window.__scroll.end(); const { frames, loaf, H } = window.__scroll; return { frames, loaf, H }; })()`);
  const fs = r.frames.slice(1);
  const intervals = fs.map((f, i) => f.t - r.frames[i].t), work = fs.map((f) => f.work).filter((w) => w !== null);
  // The pages that hold highlights against those in view: the reader draws the pages in view and pdfPagesAhead (1) on
  // each side. A page's highlights that come before it is that near (`early`) would be drawn ahead of time; those that
  // stay once it has left are counted by how long since it was last that near (`late`), and whether its canvas stays
  // with them (the page let go: the same effect lets both go).
  const near = (vis, n) => vis.length > 0 && n >= Math.min(...vis) - 1 && n <= Math.max(...vis) + 1;
  let early = 0, late = 0, lateMaxFrames = 0, lateMaxMs = 0, lateWithoutCanvas = 0, maxLayers = 0, maxMarks = 0, withoutLayer = 0;
  const ever = new Set(), lastNear = new Map();
  r.frames.forEach((f, i) => {
    for (const n of f.visible) lastNear.set(n, i);
    for (let n = Math.min(...f.visible) - 1; n <= Math.max(...f.visible) + 1; n++) lastNear.set(n, i);
    for (const n of f.layers) {
      ever.add(n);
      if (near(f.visible, n)) continue;
      if (!lastNear.has(n)) { early++; continue; }
      late++;
      const j = lastNear.get(n);
      lateMaxFrames = Math.max(lateMaxFrames, i - j);
      lateMaxMs = Math.max(lateMaxMs, f.t - r.frames[j].t);
      if (!f.canvases.includes(n)) lateWithoutCanvas++;
    }
    // A page in view, drawn, and still without its highlights (every page of the PDF has some).
    for (const n of f.visible) if (f.canvases.includes(n) && !f.layers.includes(n)) withoutLayer++;
    maxLayers = Math.max(maxLayers, f.layers.length);
    maxMarks = Math.max(maxMarks, f.marks);
  });
  const maxVisible = Math.max(...r.frames.map((f) => f.visible.length));
  return {
    frames: r.frames.length, scrolled: r.frames.at(-1).top, seconds: (r.frames.at(-1).t - r.frames[0].t) / 1000,
    p50: quantile(intervals, 0.5), p95: quantile(intervals, 0.95), max: Math.max(...intervals),
    missed: intervals.filter((x) => x > 1.5 * quantile(intervals, 0.5)).length,
    work50: quantile(work, 0.5), work95: quantile(work, 0.95), workMax: Math.max(...work),
    loaf: r.loaf.length, loafMax: r.loaf.reduce((m, e) => Math.max(m, e.duration), 0),
    early, late, lateMaxFrames, lateMaxMs, lateWithoutCanvas, withoutLayer, maxLayers, maxMarks, maxVisible, ever: ever.size,
  };
}

async function measureReading(kind, scroll) {
  console.log(`\n— Le PDF de 25 pages, ${kind === 'annotated' ? '50 annotations' : 'sans annotation (même fichier)'} —`);
  for (let pass = 1; pass <= PASSES; pass++) {
    // Without annotations, no margin: the preview narrower by its width (annotationMarginPx, 240), for the same reader.
    const t = testBase(true, kind === 'plain' ? { ...PREVIEW, previewWidthPx: PREVIEW.previewWidthPx - 240 } : PREVIEW);
    const app = await launch(t.data, t.profile, { CIRRUS_VIEW: VIEWS[kind] });
    try {
      const { page } = app;
      const node = t.base(`SELECT id FROM nodes WHERE json_extract(json, '$.title') = 'Lecture de mesure (50 annotations)'`)[0].id;
      const rects = t.base(`SELECT json_extract(json, '$.anchor.page') AS p, json_array_length(json, '$.anchor.rects') AS n FROM nodes WHERE json_extract(json, '$.anchor.pdf') = '${node}'`);
      const marks = kind === 'annotated' ? rects.filter((x) => x.p === 1).reduce((s, x) => s + x.n, 0) : 0, margin = kind === 'annotated' ? rects.length : 0;
      for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.node-popup .file[data-name="${READING}"]')`, 1000)); i++) await page.dblclick(CENTRE.x, CENTRE.y);
      const cold = await openReading(page, marks, margin);
      const close = await page.centre('.file-preview .close', '×');
      await page.click(close.x, close.y);
      if (!(await page.until(`!document.querySelector('.file-preview')`))) throw new Error('l’aperçu ne se ferme pas');
      await sleep(500);
      const warm = await openReading(page, marks, margin);
      for (const [when, o] of [['à froid', cold], ['à chaud', warm]]) {
        console.log(`  passe ${pass}, ${when} : clic → page 1 dessinée ${ms(o.canvas)}, son texte ${ms(o.text)}${kind === 'annotated' ? `, ses ${marks} surlignages ${ms(o.marks)}, la marge de ${margin} annotations ${ms(o.margin)}` : ''} ; tout → image ${ms(o.frame)} (zoom ${o.zoom}, lecteur de ${o.width} px)`);
      }
      if (scroll) {
        await sleep(1000);
        const s = await scrollReading(page);
        console.log(`  passe ${pass}, défilement : ${s.frames} images en ${s.seconds.toFixed(1)} s, ${Math.round(s.scrolled)} px ; intervalle p50 ${s.p50.toFixed(1)} ms, p95 ${s.p95.toFixed(1)} ms, max ${s.max.toFixed(1)} ms, ${s.missed} au-delà de 1,5 × p50 ; rendu après l’image p50 ${s.work50.toFixed(1)} ms, p95 ${s.work95.toFixed(1)} ms, max ${s.workMax.toFixed(1)} ms ; ${s.loaf} images longues (≥ 50 ms)${s.loaf > 0 ? `, la plus longue ${s.loafMax.toFixed(0)} ms` : ''}`);
        if (kind === 'annotated') {
          console.log(`  passe ${pass}, pages : au plus ${s.maxVisible} en vue, au plus ${s.maxLayers} avec leurs surlignages, ${s.maxMarks} rectangles au plus dans la page (101 en tout) ; ${s.ever} pages les ont dessinés tour à tour ; avant d’être en vue ± 1 page : ${s.early} fois ; après en être sortie : ${s.late} fois, au plus ${s.lateMaxFrames} images (${s.lateMaxMs.toFixed(0)} ms) après, ${s.lateWithoutCanvas} fois sans son canevas ; page en vue, dessinée, sans ses surlignages : ${s.withoutLayer} fois`);
        }
      }
    } finally {
      await app.close();
      t.done();
    }
  }
}

if (what === 'tout' || what === 'bib') await measureBib();
if (what === 'tout' || what === 'ouverture' || what === 'defilement') {
  const scroll = what !== 'ouverture';
  await measureReading('annotated', scroll);
  await measureReading('plain', scroll);
}
