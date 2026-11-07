// The interface's checks by real input: npm run interface -w packages/app
// Each scenario launches the app on a fresh artificial test base, with a profile of its own (never the user's base nor
// profile), and drives it by the mouse and keyboard events Chromium receives from the system (DevTools' Input domain):
// the browser's own default actions — the focus a press gives, a click after a press — happen as for the user, which
// the pointer replays of the captures (CIRRUS_POINTER) skip. Then it reads what the page shows and what the base kept.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The page of an app launched on `data`, by DevTools: evaluate, mouse, keys. `more`: launch options (CIRRUS_VIEW…). */
async function launch(data, profile, more = {}) {
  // CIRRUS_BACKGROUND: the window beyond the screens, without the focus (src/main/index.ts); the page is told it has it.
  const env = { ...process.env, CIRRUS_DATA: data, CIRRUS_SIZE: '1600,1000', CIRRUS_BACKGROUND: '1', ...more };
  delete env.ELECTRON_RUN_AS_NODE;
  // Port 0: Chromium picks a free one, and writes it in the profile (DevToolsActivePort).
  const child = spawn(electron, [appDir, `--user-data-dir=${profile}`, '--remote-debugging-port=0'], { env, stdio: 'ignore' });
  const portFile = join(profile, 'DevToolsActivePort');
  let target;
  for (let i = 0; i < 120 && !target; i++) {
    await sleep(250);
    if (!existsSync(portFile)) continue;
    const port = readFileSync(portFile, 'utf8').split('\n')[0].trim();
    try {
      target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
    } catch {}
  }
  if (!target) throw new Error('La fenêtre de Cirrus n’est pas apparue.');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r));
  let next = 0;
  const pending = new Map();
  /** DevTools' events by method: each waiter takes the next one. */
  const waiting = new Map();
  ws.addEventListener('message', (m) => {
    const x = JSON.parse(m.data);
    if (x.id && pending.has(x.id)) { pending.get(x.id)(x); pending.delete(x.id); }
    else if (x.method && waiting.has(x.method)) { const take = waiting.get(x.method); waiting.delete(x.method); take(x.params); }
  });
  /** The next event `method`, or null after `ms`. */
  const nextEvent = (method, ms) => new Promise((r) => {
    const timer = setTimeout(() => { waiting.delete(method); r(null); }, ms);
    waiting.set(method, (params) => { clearTimeout(timer); r(params); });
  });
  const send = (method, params = {}) => new Promise((r) => { const id = ++next; pending.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
  const evaluate = async (expr) => (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;
  // The focus as if the window had it: its focus events, document.hasFocus() (the drawing pauses without it).
  await send('Emulation.setFocusEmulationEnabled', { enabled: true });
  const mouse = (type, x, y, button = 'none') =>
    send('Input.dispatchMouseEvent', { type, x, y, button, clickCount: type === 'mouseMoved' ? 0 : 1, buttons: type === 'mousePressed' ? (button === 'right' ? 2 : 1) : 0 });
  const page = {
    evaluate,
    /** Whether `expr` becomes true within `ms`: a first launch after a build is slower than the next ones. */
    async until(expr, ms = 5000) {
      for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await evaluate(expr)) return true;
      return false;
    },
    async click(x, y, button = 'left') {
      await mouse('mouseMoved', x, y);
      await mouse('mousePressed', x, y, button);
      await sleep(30);
      await mouse('mouseReleased', x, y, button);
      await sleep(300);
    },
    async move(x, y) { await mouse('mouseMoved', x, y); await sleep(200); },
    /** The centre of the first element matching `selector` whose text matches `text`. */
    async centre(selector, text) {
      const r = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${new RegExp(text)}.test(e.textContent)); if (!el) return null; const b = el.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
      if (!r) throw new Error(`Pas d’élément ${selector} « ${text} ».`);
      return r;
    },
    async type(text) { await send('Input.insertText', { text }); await sleep(100); },
    /** A key; `modifiers` as DevTools counts them: Alt 1, Ctrl 2, Meta 4, Maj 8. */
    async press(key, code = key, keyCode, modifiers = 0) {
      for (const type of ['keyDown', 'keyUp']) await send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: keyCode, modifiers });
      await sleep(600);
    },
    /** The left button pressed at `from`, moved in `steps` to `to`, and let go there: a selection made by the mouse. */
    async drag(from, to, steps = 12) {
      await mouse('mouseMoved', from.x, from.y);
      await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps; i++) {
        const x = from.x + ((to.x - from.x) * i) / steps, y = from.y + ((to.y - from.y) * i) / steps;
        await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
        await sleep(20);
      }
      await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
      await sleep(400);
    },
    /**
     * A drag and drop (HTML5) by the mouse, from `from` to `to`: the left button pressed on the element at `from`, moved
     * until Chromium starts its drag — the element's own dragstart fills it —, then that drag, intercepted by DevTools
     * (Input.setInterceptDrags) instead of the system's, entered, moved over and let go at `to` (Input.dispatchDragEvent),
     * the page's dragenter, dragover and drop handlers receiving it as from the system. Resolves with what the drag
     * carried (its items), or throws if Chromium started none.
     */
    async dragDrop(from, to) {
      await send('Input.setInterceptDrags', { enabled: true });
      try {
        const intercepted = nextEvent('Input.dragIntercepted', 4000);
        await mouse('mouseMoved', from.x, from.y);
        await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: from.x, y: from.y, button: 'left', buttons: 1, clickCount: 1 });
        for (let i = 1; i <= 10; i++) {
          const x = from.x + ((to.x - from.x) * i) / 10, y = from.y + ((to.y - from.y) * i) / 10;
          await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', buttons: 1 });
          await sleep(30);
        }
        const drag = await intercepted;
        if (!drag) throw new Error('Chromium n’a commencé aucun glisser-déposer depuis cet élément');
        for (const [type, at] of [['dragEnter', to], ['dragOver', { x: to.x - 2, y: to.y }], ['dragOver', to]]) {
          await send('Input.dispatchDragEvent', { type, x: at.x, y: at.y, data: drag.data });
          await sleep(60);
        }
        await send('Input.dispatchDragEvent', { type: 'drop', x: to.x, y: to.y, data: drag.data });
        await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: to.x, y: to.y, button: 'left', buttons: 0, clickCount: 1 });
        await sleep(400);
        return drag.data.items;
      } finally {
        await send('Input.setInterceptDrags', { enabled: false });
      }
    },
    /**
     * The client rectangle of the `k`-th character of `needle`, found in the text of the first element `scope` (its
     * text nodes joined: pdf.js may split a line into runs), or null.
     */
    async charRect(scope, needle, k) {
      return evaluate(`(() => {
        const root = document.querySelector(${JSON.stringify(scope)});
        if (!root) return null;
        const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT), parts = [];
        let all = '';
        for (let n = w.nextNode(); n; n = w.nextNode()) { parts.push([n, all.length]); all += n.data; }
        const i = all.indexOf(${JSON.stringify(needle)});
        if (i < 0) return null;
        const at = i + ${k}, [node, start] = parts.findLast(([, s]) => s <= at);
        const r = document.createRange();
        r.setStart(node, at - start);
        r.setEnd(node, at - start + 1);
        const b = r.getBoundingClientRect();
        return { left: b.left, top: b.top, right: b.right, bottom: b.bottom };
      })()`);
    },
  };
  // The graph drawn, then a moment for the first frames.
  for (let i = 0; i < 120 && !(await evaluate(`!!document.querySelector('.graph canvas')`)); i++) await sleep(250);
  await sleep(2000);
  return { page, close: async () => { ws.close(); child.kill(); await new Promise((r) => (child.exitCode !== null ? r() : child.once('exit', r))); } };
}

// Plan 4c, task 2: the test base's publication (−420, −300 in the world) at the view's centre, its chapter's preview
// wide enough to read it at about its real size beside its margin.
const CHAPTER = 'Li_Vitányi_chapitre_1.pdf';
const PUBLICATION = { env: { CIRRUS_VIEW: '-420,-300,1' }, settings: { previewWidthPx: 1000, previewHeightPx: 820 } };
const PAGE_1 = '.file-preview .pdf-page[data-page="1"] .textLayer';
/** The publication's pop-up, by a click on it, then its chapter's preview, by a click on the file, read to its text. */
async function openChapter(page) {
  for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.node-popup')`, 1000)); i++) await page.click(792, 461);
  await page.evaluate(`document.querySelector('.node-popup .file[data-name="${CHAPTER}"]')?.scrollIntoView({ block: 'center' })`);
  const file = await page.centre(`.node-popup .file[data-name="${CHAPTER}"]`, '');
  await page.click(file.x, file.y);
  if (!(await page.until(`!!document.querySelector('${PAGE_1} span') && !!document.querySelector('.file-preview .annotation-margin li')`, 15000))) {
    throw new Error('l’aperçu du chapitre ne montre pas le texte de sa première page, ou pas sa marge');
  }
}
/** The base's live annotations: identifier and anchor. */
const anchorsOf = (base) => base(`SELECT id, json_extract(json, '$.anchor') AS a FROM nodes WHERE trashed = 0 AND json_extract(json, '$.anchor') IS NOT NULL`)
  .map((r) => ({ id: r.id, ...JSON.parse(r.a) }));
/** Whether `check` becomes true within `ms` (the base is written by the main process, a moment after the action). */
async function until(check, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (check()) return true;
  return false;
}
/** A real drag over the text of `scope`, from the first character of `from` to the last of `to` (the caret after it). */
async function selectText(page, scope, from, to) {
  const a = await page.charRect(scope, from, 0), b = await page.charRect(scope, to, to.length - 1);
  if (!a || !b) throw new Error(`« ${from} » ou « ${to} » n’est pas dans le texte de la page`);
  await page.drag({ x: a.left + (a.right - a.left) * 0.25, y: (a.top + a.bottom) / 2 }, { x: b.right - (b.right - b.left) * 0.2, y: (b.top + b.bottom) / 2 });
}
/** How far a highlight's rectangle is from the characters it covers, in pixels: its left and right sides, its middle's height. */
async function alignment(page, mark, scope, first, last) {
  const m = await page.evaluate(`(() => { const b = document.querySelector(${JSON.stringify(mark)})?.getBoundingClientRect(); return b && { left: b.left, top: b.top, right: b.right, bottom: b.bottom }; })()`);
  const a = await page.charRect(scope, first, 0), b = await page.charRect(scope, last, last.length - 1);
  if (!m || !a || !b) throw new Error('pas de surlignage, ou pas son texte');
  return { left: m.left - a.left, right: m.right - b.right, middle: (m.top + m.bottom) / 2 - (a.top + a.bottom) / 2, height: m.bottom - m.top, text: a.bottom - a.top };
}
const fmt = (o) => Object.entries(o).map(([k, v]) => `${k} ${v.toFixed(2)}`).join(', ');
/**
 * The tolerance of a highlight's sides, in pixels at the reader's zoom: 0.75 point. The text layer's characters, drawn
 * in a font of the system stretched to each run's width, stand up to half a point from the glyphs the canvas draws,
 * where the test base's rectangles (Helvetica's widths) are.
 */
async function sideTolerance(page, scope) {
  const zoom = parseFloat(await page.evaluate(`document.querySelector('${scope} .pdf-tools .zoom').textContent`)) / 100;
  return 0.75 * zoom * (96 / 72);
}

// Plan 4c, task 3: an annotation put down in the lobby from a list, by a real drag (dragDrop).
const LI = 'An Introduction to Kolmogorov Complexity and Its Applications';
/** The lobby's identifier, the publication's, and its annotation of page 2 (in no plan in the test base). */
function idsOf(base) {
  const lobby = base(`SELECT id FROM plans WHERE json_extract(json, '$.type') = 'lobby'`)[0].id;
  const publication = base(`SELECT id FROM nodes WHERE json_extract(json, '$.title') = '${LI}'`)[0].id;
  return { lobby, publication, page2: anchorsOf(base).find((a) => a.page === 2).id };
}
/** Node `node`'s place in `plan`, or null. */
const placementOf = (base, plan, node) => {
  const r = base(`SELECT json FROM placements WHERE plan = '${plan}' AND node = '${node}'`)[0];
  return r ? JSON.parse(r.json) : null;
};
/** The group node `node` is in, in `plan`, as the base has it (the target of its inclusion shown there), or null. */
function groupIn(base, plan, node) {
  for (const r of base(`SELECT c.json FROM connections c JOIN branches b ON b.connection = c.id WHERE c.kind = 'inclusion' AND c.trashed = 0 AND b.plan = '${plan}' AND b.node = '${node}'`)) {
    const m = JSON.parse(r.json).members;
    if (m.some((x) => x.node === node && x.role === 'source')) return m.find((x) => x.role === 'target')?.node ?? null;
  }
  return null;
}
/** The world point under (x, y) of the window, the view centred on PUBLICATION's (−420, −300) at zoom 1. */
async function worldAt(page, at) {
  const c = await page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  return { x: -420 + at.x - c.x, y: -300 + at.y - c.y };
}
/** The publication's box on the graph, left of its pop-up (which opens right of the click): what of it shows there. */
const ON_PUBLICATION = { x: 720, y: 500 };
/** The sky at the top right of the view, over no node nor envelope (the test base's lobby). */
const SKY = { x: 1530, y: 110 };
/** The publication's pop-up, by a click on it, its list of annotations in view; the centre of its row « p. `n` ». */
async function popupRow(page, n) {
  for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.node-popup .annotation-list li')`, 1000)); i++) await page.click(792, 461);
  await page.evaluate(`document.querySelector('.node-popup .annotation-list')?.scrollIntoView({ block: 'center' })`);
  await sleep(200);
  return page.centre('.node-popup .annotation-list li', `p\\. ${n}`);
}
/** The text of the rows of `list`. */
const rows = (page, list) => page.evaluate(`[...document.querySelectorAll('${list} li')].map((li) => li.textContent)`);
const said = (page, text) => page.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent === ${JSON.stringify(text)})`);

/** A scenario: what it does in the page, then what it checks; a failure throws its reason, in French. */
const SCENARIOS = [
  {
    // « Nouveau nœud » (spec 12): the ghost put down, the title typed in place, Entrée: the node is in the base.
    name: 'nouveau nœud par le menu',
    async run(page, base) {
      // The graph takes its first clicks once its engine is up: the menu is asked again until it opens.
      for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(250, 850, 'right');
      const item = await page.centre('.context-menu button', 'Nouveau nœud');
      await page.click(item.x, item.y);
      await page.move(400, 800);
      if (!(await page.until(`document.querySelector('.ghost')?.textContent === 'Nouveau nœud'`))) throw new Error('le fantôme ne suit pas le curseur');
      await page.click(400, 800);
      const focused = await page.evaluate(`document.activeElement?.className === 'title-editor'`);
      if (!focused) throw new Error('l’éditeur du titre n’a pas le focus après le dépôt (il s’est refermé)');
      await page.type('Nœud d’essai');
      await page.press('Enter', 'Enter', 13);
      const titles = base(`SELECT json_extract(json, '$.title') AS t FROM nodes WHERE json_extract(json, '$.title') = 'Nœud d’essai'`);
      if (titles.length !== 1) throw new Error('le nœud n’est pas dans la base');
    },
  },
  {
    // The settings by rubrics (the user, 2026-11-07): a rubric opens on a click; a search finds a setting by its label.
    name: 'réglages par rubriques et recherche',
    async run(page) {
      const gear = await page.centre('.tabs .gear', '⚙');
      await page.click(gear.x, gear.y);
      const rubric = await page.centre('.settings .rubric-title', 'LaTeX');
      await page.click(rubric.x, rubric.y);
      const shown = await page.evaluate(`[...document.querySelectorAll('.settings .rubric[data-rubric="LaTeX"] .param .label')].map((l) => l.textContent)`);
      if (!shown.some((t) => t.startsWith('Largeur du résumé'))) throw new Error('la largeur du résumé compilé n’est pas parmi les réglages principaux de « LaTeX »');
      const search = await page.centre('.settings input.search', '');
      await page.click(search.x, search.y);
      await page.type('largeur du resume');
      const found = await page.evaluate(`[...document.querySelectorAll('.settings .param .label')].map((l) => l.textContent)`);
      if (found.length !== 1 || !found[0].startsWith('Largeur du résumé et de la relation compilés')) throw new Error(`la recherche montre ${JSON.stringify(found)}`);
    },
  },
  {
    // Plan 4c, D3: a passage of the preview selected by the mouse, « Annoter »: a node in the base, its highlight drawn,
    // in the margin; Ctrl+Z removes it, from the base, the page and the margin (Review Focus 4).
    name: 'surligner dans l’aperçu, puis Ctrl+Z',
    ...PUBLICATION,
    async run(page, base) {
      await openChapter(page);
      const before = anchorsOf(base);
      // The fixture's page 1 annotation, on this version: the same passage, as the user would select it.
      await selectText(page, PAGE_1, 'La complexité de Kolmogorov', 'constante près.');
      if (!(await page.until(`!!document.querySelector('.file-preview .annotate')`))) throw new Error('« Annoter » n’apparaît pas au bord de la sélection');
      const selected = await page.evaluate('getSelection().toString()');
      const button = await page.centre('.file-preview .annotate', 'Annoter');
      await page.click(button.x, button.y);
      if (!(await until(() => anchorsOf(base).length === before.length + 1))) throw new Error('l’annotation n’est pas dans la base');
      const made = anchorsOf(base).find((a) => !before.some((b) => b.id === a.id));
      const fixture = before.find((a) => a.hash === made.hash && a.page === 1);
      if (made.page !== 1 || made.file !== CHAPTER || !fixture) throw new Error(`ancre inattendue : ${JSON.stringify(made)}`);
      const diff = made.rects.map((r, i) => r.map((v, k) => Math.abs(v - (fixture.rects[i]?.[k] ?? Number.NaN))));
      console.log(`     texte sélectionné ${JSON.stringify(selected)} ; texte de l’ancre ${JSON.stringify(made.text)} ; celui de la base de test ${JSON.stringify(fixture.text)}`);
      console.log(`     rectangles ${JSON.stringify(made.rects)} ; écarts à ceux de la base de test (pt) ${JSON.stringify(diff.map((d) => d.map((v) => +v.toFixed(2))))}`);
      if (made.text !== fixture.text) throw new Error('le texte de l’ancre n’est pas celui que la base de test donne pour ce passage');
      if (made.rects.length !== 2 || diff.some((d) => d[0] > 1.5 || d[2] > 1.5)) throw new Error('les rectangles ne suivent pas les lignes du passage');
      if (await page.evaluate('getSelection().isCollapsed') !== true) throw new Error('la sélection reste après l’annotation');
      if (!(await page.until(`document.querySelectorAll('.file-preview .annotation-margin li').length === 4`))) throw new Error('la marge ne montre pas l’annotation');
      if (!(await page.until(`document.querySelectorAll('.file-preview .pdf-page[data-page="1"] .annotation-layer .mark').length === 4`))) throw new Error('le surlignage n’est pas dessiné');
      // Ctrl+Z, the focus in the reader (the drag gave it): the annotation goes, from the base, the page and the margin.
      if (!(await page.evaluate(`!!document.activeElement?.closest('.file-preview .pdf-scroll')`))) throw new Error('le lecteur n’a pas le focus après la sélection');
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => anchorsOf(base).length === before.length))) throw new Error('Ctrl+Z n’a pas retiré l’annotation de la base');
      if (!(await page.until(`document.querySelectorAll('.file-preview .annotation-margin li').length === 3 && document.querySelectorAll('.file-preview .pdf-page[data-page="1"] .annotation-layer .mark').length === 2`))) {
        throw new Error('l’annotation retirée reste dans la marge ou sur la page');
      }
    },
  },
  {
    // In full screen (D3, D4): select, Ctrl+Maj+A; Ctrl+Z there undoes that step of the full screen, never one made
    // before it (the preview's annotation stays), and Ctrl+Y redoes it. The margin's annotations are not dragged out of
    // the full screen (modal); the preview's are.
    name: 'surligner en plein écran, Ctrl+Maj+A, puis Ctrl+Z et Ctrl+Y sur ses seuls pas',
    ...PUBLICATION,
    async run(page, base) {
      await openChapter(page);
      const dragged = await page.evaluate(`document.querySelectorAll('.file-preview .annotation-margin li[draggable="true"]').length`);
      if (dragged !== 3) throw new Error(`l’aperçu offre ${dragged} annotations à glisser au lieu de 3`);
      const start = anchorsOf(base).length;
      // A step made in the preview, before the full screen.
      await selectText(page, PAGE_1, 'Ce chapitre fixe', 'notations du livre');
      await page.press('A', 'KeyA', 65, 2 | 8);
      if (!(await until(() => anchorsOf(base).length === start + 1))) throw new Error('Ctrl+Maj+A n’a pas annoté dans l’aperçu');
      const expand = await page.centre('.file-preview .expand', '');
      await page.click(expand.x, expand.y);
      const scope = '.full-screen .pdf-page[data-page="1"] .textLayer';
      if (!(await page.until(`!!document.querySelector('${scope} span')`, 15000))) throw new Error('le plein écran ne montre pas le texte du chapitre');
      if (await page.evaluate(`document.querySelectorAll('.full-screen .annotation-margin li[draggable="true"]').length`) !== 0) throw new Error('le plein écran offre ses annotations au glisser');
      const stay = async (what) => { await sleep(800); if (anchorsOf(base).length !== start + 1) throw new Error(what); };
      await page.press('z', 'KeyZ', 90, 2);
      await stay('Ctrl+Z en plein écran a défait l’annotation faite dans l’aperçu');
      const before = anchorsOf(base);
      await selectText(page, scope, 'Fichier d’exemple', 'base de test');
      await page.press('A', 'KeyA', 65, 2 | 8);
      if (!(await until(() => anchorsOf(base).length === before.length + 1))) throw new Error('Ctrl+Maj+A n’a pas créé l’annotation en plein écran');
      const made = anchorsOf(base).find((a) => !before.some((b) => b.id === a.id));
      console.log(`     ancre ${JSON.stringify({ page: made.page, text: made.text, rects: made.rects })}`);
      if (made.text !== 'Fichier d’exemple de la base de test' || made.rects.length !== 1) throw new Error(`ancre inattendue : ${JSON.stringify(made)}`);
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => anchorsOf(base).length === before.length))) throw new Error('Ctrl+Z en plein écran n’a pas retiré son annotation');
      await page.press('z', 'KeyZ', 90, 2);
      await stay('un second Ctrl+Z en plein écran a défait l’annotation faite dans l’aperçu');
      await page.press('y', 'KeyY', 89, 2);
      if (!(await until(() => anchorsOf(base).length === before.length + 1))) throw new Error('Ctrl+Y en plein écran n’a pas rétabli son annotation');
      if (!(await page.until(`!!document.querySelector('.full-screen')`))) throw new Error('le plein écran s’est fermé');
    },
  },
  {
    // D3, Review Focus 3: a selection dragged from page 1 into page 2 annotates page 1 only, cut at its end (its last
    // line, then its page number, in the order its text is drawn).
    name: 'une sélection sur deux pages est coupée à la fin de la première',
    ...PUBLICATION,
    async run(page, base) {
      await openChapter(page);
      const page2 = '.file-preview .pdf-page[data-page="2"] .textLayer';
      // Page 1's last lines and page 2's heading in view together: page 1's « Écrire » just under the view's top.
      const start = await page.charRect(PAGE_1, 'Écrire à', 0);
      await page.evaluate(`(() => { const s = document.querySelector('.file-preview .pdf-scroll'); s.scrollTop += ${start.top} - s.getBoundingClientRect().top - 24; })()`);
      if (!(await page.until(`!!document.querySelector('${page2} span')`, 10000))) throw new Error('la page 2 n’est pas dessinée');
      await sleep(300);
      const before = anchorsOf(base);
      const a = await page.charRect(PAGE_1, 'Écrire à', 0), b = await page.charRect(page2, 'Notations et', 'Notations'.length - 1);
      if (!a || !b) throw new Error('le texte de la fin de la page 1 ou du début de la page 2 n’est pas trouvé');
      const view = await page.evaluate(`(() => { const r = document.querySelector('.file-preview .pdf-scroll').getBoundingClientRect(); return { top: r.top, bottom: r.bottom }; })()`);
      if (a.top < view.top || b.bottom > view.bottom) throw new Error(`les deux bouts de la sélection ne sont pas dans la vue : ${JSON.stringify({ a, b, view })}`);
      await page.drag({ x: a.left + (a.right - a.left) * 0.25, y: (a.top + a.bottom) / 2 }, { x: b.right - (b.right - b.left) * 0.2, y: (b.top + b.bottom) / 2 }, 20);
      const selected = await page.evaluate('getSelection().toString()');
      if (!/Notations/.test(selected)) throw new Error(`la sélection ne passe pas sur la page 2 : ${JSON.stringify(selected)}`);
      if (!(await page.until(`!!document.querySelector('.file-preview .annotate')`))) throw new Error('« Annoter » n’apparaît pas');
      await page.press('A', 'KeyA', 65, 2 | 8);
      if (!(await until(() => anchorsOf(base).length === before.length + 1))) throw new Error('l’annotation n’est pas dans la base');
      const made = anchorsOf(base).find((x) => !before.some((y) => y.id === x.id));
      console.log(`     sélection ${JSON.stringify(selected)} ; ancre ${JSON.stringify({ page: made.page, text: made.text, rects: made.rects })}`);
      if (made.page !== 1 || !made.text.startsWith('Écrire à l’auteur : auteur@example.org') || /Notations/.test(made.text)) throw new Error('la sélection n’est pas coupée à la fin de la page 1');
      if (made.rects.some((r) => r[1] < 0 || r[3] > 842)) throw new Error('un rectangle sort de la page 1');
    },
  },
  {
    // D4: an annotation opened from the margin shows its page, its passage blinking; the highlights stay on their text
    // at the fit and at a strong zoom (Review Focus 3).
    name: 'ouvrir une annotation depuis la marge, surlignage aligné à deux zooms',
    ...PUBLICATION,
    async run(page) {
      await openChapter(page);
      const mark = '.file-preview .pdf-page[data-page="1"] .annotation-layer .mark';
      if (!(await page.until(`document.querySelectorAll('${mark}').length === 2`))) throw new Error('le surlignage de la page 1 n’est pas dessiné');
      const zoomOf = () => page.evaluate(`document.querySelector('.file-preview .pdf-tools .zoom').textContent`);
      const check = async () => {
        const a = await alignment(page, mark, PAGE_1, 'La complexité de Kolmogorov', 'Kolmogorov d’une'), tol = await sideTolerance(page, '.file-preview');
        console.log(`     à ${await zoomOf()} (tolérance ${tol.toFixed(2)} px) : ${fmt(a)}`);
        if (Math.abs(a.left) > tol || Math.abs(a.right) > tol || Math.abs(a.middle) > a.text / 2) throw new Error(`surlignage décalé à ${await zoomOf()} : ${fmt(a)}`);
      };
      await check();
      for (let i = 0; i < 8; i++) {
        const plus = await page.centre('.file-preview .zoom-in', '');
        await page.click(plus.x, plus.y);
      }
      await page.until(`document.querySelectorAll('${mark}').length === 2`);
      await page.evaluate(`document.querySelector('${mark}').scrollIntoView({ block: 'center', inline: 'center' })`);
      await sleep(500);
      await check();
      const entry = await page.centre('.file-preview .annotation-margin li', 'p\\. 2');
      await page.click(entry.x, entry.y);
      const flash = '.file-preview .pdf-page[data-page="2"] .annotation-layer .flash';
      if (!(await page.until(`!!document.querySelector('${flash}')`))) throw new Error('le passage de la page 2 ne clignote pas');
      const shownPage = await page.evaluate(`document.querySelector('.file-preview .pdf-tools .page input').value`);
      if (shownPage !== '2') throw new Error(`la page montrée est la ${shownPage}, pas la 2`);
      // Wider than the view at this zoom: its start in it, on its first word.
      const f = await alignment(page, flash, '.file-preview .pdf-page[data-page="2"] .textLayer', 'Un code est préfixe', 'Un');
      const inView = await page.evaluate(`(() => { const v = document.querySelector('.file-preview .pdf-scroll').getBoundingClientRect(), b = document.querySelector('${flash}').getBoundingClientRect(); return b.top >= v.top && b.bottom <= v.bottom && b.left >= v.left && b.left < v.right; })()`);
      if (!inView || Math.abs(f.left) > (await sideTolerance(page, '.file-preview'))) throw new Error(`le début du passage clignotant n’est pas sur son texte, dans la vue : ${fmt(f)}`);
      const animated = await page.evaluate(`document.querySelector('${flash}').getAnimations().length`);
      if (animated < 1) throw new Error('le passage ne clignote pas (aucune animation)');
    },
  },
  {
    // D2, Review Focus 2: the annotation of the version before the re-import opens on that version (its blob, kept by
    // the store), its passage blinking, drawn there and only there; a banner leads back to the current version.
    name: 'l’annotation d’une version précédente s’ouvre sur sa version',
    ...PUBLICATION,
    async run(page) {
      await openChapter(page);
      const label = await page.evaluate(`[...document.querySelectorAll('.file-preview .annotation-margin li .version')].map((e) => e.textContent)`);
      if (label.length !== 1 || label[0] !== 'sur une version précédente') throw new Error(`la marge nomme ${JSON.stringify(label)}`);
      const entry = await page.centre('.file-preview .annotation-margin li', 'version précédente');
      await page.click(entry.x, entry.y);
      if (!(await page.until(`!!document.querySelector('.file-preview .version-banner') && /qui l’engendre\\./.test(document.querySelector('${PAGE_1}')?.textContent ?? '')`, 15000))) {
        throw new Error('la version précédente ne s’ouvre pas');
      }
      const mark = '.file-preview .pdf-page[data-page="1"] .annotation-layer .mark';
      if (!(await page.until(`document.querySelectorAll('${mark}').length === 2 && !!document.querySelector('.file-preview .pdf-page[data-page="1"] .annotation-layer .flash')`))) {
        throw new Error('l’annotation de la version précédente n’y est pas dessinée, ou ne clignote pas');
      }
      const a = await alignment(page, mark, PAGE_1, 'La complexité de Kolmogorov', 'Kolmogorov d’une'), tol = await sideTolerance(page, '.file-preview');
      if (Math.abs(a.left) > tol || Math.abs(a.right) > tol) throw new Error(`surlignage décalé sur la version précédente : ${fmt(a)}`);
      const back = await page.centre('.file-preview .version-banner button', 'Revenir');
      await page.click(back.x, back.y);
      if (!(await page.until(`!document.querySelector('.file-preview .version-banner') && /constante près\\./.test(document.querySelector('${PAGE_1}')?.textContent ?? '')`, 15000))) {
        throw new Error('« Revenir à la version actuelle » ne ramène pas la version actuelle');
      }
    },
  },
  {
    // Review Focus 4: that version's blob missing from the store (a base copied without it): the reader says so in its
    // place, the margin stays, and the current version comes back.
    name: 'une version absente du magasin le dit, et rien ne casse',
    ...PUBLICATION,
    async run(page, base, data) {
      await openChapter(page);
      const current = JSON.parse(base(`SELECT json FROM nodes WHERE json_extract(json, '$.anchor') IS NULL AND json LIKE '%${CHAPTER}%'`)[0].json)
        .files.find((f) => f.name === CHAPTER).hash;
      const earlier = anchorsOf(base).find((a) => a.hash !== current).hash;
      rmSync(join(data, 'files', earlier.slice(0, 2), earlier));
      const entry = await page.centre('.file-preview .annotation-margin li', 'version précédente');
      await page.click(entry.x, entry.y);
      const said = `Cette version de « ${CHAPTER} » est introuvable dans la base.`;
      if (!(await page.until(`[...document.querySelectorAll('.file-preview .viewer-message')].some((m) => m.textContent === ${JSON.stringify(said)})`, 10000))) {
        throw new Error('le lecteur ne dit pas que la version manque');
      }
      if (await page.evaluate(`document.querySelectorAll('.file-preview .annotation-margin li').length`) !== 3) throw new Error('la marge n’est plus là');
      const back = await page.centre('.file-preview .version-banner button', 'Revenir');
      await page.click(back.x, back.y);
      if (!(await page.until(`/constante près\\./.test(document.querySelector('${PAGE_1}')?.textContent ?? '')`, 15000))) throw new Error('la version actuelle ne revient pas');
    },
  },
  {
    // Plan 4c, D4 (task 3): the PDF's pop-up lists its annotations, as the margin; one dragged from there onto the PDF's
    // simple node enters it, the node becoming a group above it (plan 3's rules); Ctrl+Z gives the plan back.
    name: 'poser une annotation depuis le pop-up sur le nœud du PDF, qui devient un groupe ; Ctrl+Z',
    env: PUBLICATION.env, settings: { popupHeightPx: 720 },
    async run(page, base) {
      const { lobby, publication, page2 } = idsOf(base);
      const row = await popupRow(page, 2);
      const listed = await rows(page, '.node-popup .annotation-list');
      console.log(`     liste du pop-up : ${JSON.stringify(listed)}`);
      if (listed.length !== 3 || !listed.some((t) => /p\. 1.*Lecture/.test(t)) || !listed.some((t) => /p\. 2.*dans aucun plan/.test(t))
        || listed.filter((t) => t.includes('sur une version précédente')).length !== 1) throw new Error('la liste du pop-up n’est pas celle de la marge');
      const before = placementOf(base, lobby, publication);
      const items = await page.dragDrop(row, ON_PUBLICATION);
      console.log(`     glissé : ${JSON.stringify(items)}`);
      if (items.length !== 1 || items[0].mimeType !== 'application/x-cirrus-node' || items[0].data !== page2) throw new Error('le glisser ne porte pas le seul nœud de l’annotation');
      if (!(await until(() => placementOf(base, lobby, page2) !== null))) throw new Error('l’annotation n’est pas posée dans le lobby');
      const placed = placementOf(base, lobby, page2), group = groupIn(base, lobby, page2), k = placementOf(base, lobby, publication).k;
      console.log(`     posée ${JSON.stringify(placed)} ; groupe ${group === publication ? 'la publication' : group} ; cran de la publication ${before.k} → ${k}`);
      if (group !== publication) throw new Error('l’annotation n’est pas entrée dans le nœud du PDF');
      if (placed.k !== 0 || k !== 2) throw new Error('les crans ne sont pas le cran lisible et celui d’un groupe au-dessus de son membre');
      if (!(await page.until(`[...document.querySelectorAll('.node-popup .annotation-list li')].some((li) => /p\\. 2.*Lobby/.test(li.textContent))`))) {
        throw new Error('la liste ne dit pas le plan où l’annotation est posée');
      }
      if (!(await page.evaluate(`document.activeElement?.classList.contains('graph')`))) throw new Error('le graphe n’a pas le focus après le dépôt');
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => placementOf(base, lobby, page2) === null))) throw new Error('Ctrl+Z n’a pas retiré l’annotation du lobby');
      const after = placementOf(base, lobby, publication);
      if (after.k !== before.k || groupIn(base, lobby, page2) !== null) throw new Error('Ctrl+Z n’a pas rendu au nœud du PDF son cran et sa simplicité');
      if (anchorsOf(base).length !== 3) throw new Error('une annotation a quitté la base');
    },
  },
  {
    // D4: dragged from the preview's margin onto the sky, an annotation takes the drop's place at the readable step, in
    // no group; dragged there again, « Déjà dans ce plan. », nothing written.
    name: 'poser une annotation depuis l’aperçu sur le fond ; reposée, « Déjà dans ce plan. »',
    ...PUBLICATION,
    async run(page, base) {
      const { lobby, page2 } = idsOf(base);
      await openChapter(page);
      const covered = await page.evaluate(`[...document.querySelectorAll('.panel')].some((p) => { const r = p.getBoundingClientRect(); return ${SKY.x} >= r.left && ${SKY.x} <= r.right && ${SKY.y} >= r.top && ${SKY.y} <= r.bottom; })`);
      if (covered) throw new Error('un panneau couvre le point du dépôt');
      const row = await page.centre('.file-preview .annotation-margin li', 'p\\. 2');
      await page.dragDrop(row, SKY);
      if (!(await until(() => placementOf(base, lobby, page2) !== null))) throw new Error('l’annotation n’est pas posée dans le lobby');
      const placed = placementOf(base, lobby, page2), want = await worldAt(page, SKY);
      console.log(`     posée ${JSON.stringify(placed)} ; point du dépôt ${JSON.stringify(want)}`);
      if (Math.abs(placed.x - want.x) > 1 || Math.abs(placed.y - want.y) > 1 || placed.k !== 0) throw new Error('l’annotation n’est pas à la place du dépôt, au cran lisible');
      if (groupIn(base, lobby, page2) !== null) throw new Error('l’annotation est entrée dans un groupe');
      if (!(await page.until(`[...document.querySelectorAll('.file-preview .annotation-margin li')].some((li) => /p\\. 2.*Lobby/.test(li.textContent))`))) {
        throw new Error('la marge ne dit pas le plan où l’annotation est posée');
      }
      await page.dragDrop(row, { x: SKY.x - 40, y: SKY.y + 30 });
      if (!(await said(page, 'Déjà dans ce plan.'))) throw new Error('« Déjà dans ce plan. » n’est pas dit');
      await sleep(500);
      const again = placementOf(base, lobby, page2);
      if (again.x !== placed.x || again.y !== placed.y) throw new Error('l’annotation déjà là a bougé');
    },
  },
  {
    // Review Focus 4: the PDF's node deleted everywhere while its pop-up's list, its reader and an annotation's pop-up
    // show it: each says what is missing, nothing breaks; Ctrl+Z brings it all back. The annotation's line opens its
    // PDF at its page, its passage blinking.
    name: 'le nœud du PDF mis à la corbeille pendant que ses listes sont ouvertes',
    env: PUBLICATION.env, settings: { popupHeightPx: 720, previewWidthPx: 500, previewHeightPx: 400 },
    async run(page, base) {
      const { lobby, page2 } = idsOf(base);
      await page.dragDrop(await popupRow(page, 2), SKY);
      if (!(await until(() => placementOf(base, lobby, page2) !== null))) throw new Error('l’annotation n’est pas posée dans le lobby');
      // Its own pop-up: its PDF and its page, a click opening it there.
      const line = `Annotation de « ${LI} », p. 2`;
      for (let i = 0; i < 10 && !(await page.until(`document.querySelector('.node-popup .annotation-of button')?.textContent === ${JSON.stringify(line)}`, 1000)); i++) {
        await page.click(SKY.x, SKY.y);
      }
      const pin = (panel) => page.evaluate(`document.querySelector('${panel} .pin:not(.on)')?.click()`);
      await pin('.node-popup');
      const button = await page.centre('.node-popup .annotation-of button', 'Annotation de');
      await page.click(button.x, button.y);
      const flash = '.file-preview .pdf-page[data-page="2"] .annotation-layer .flash';
      if (!(await page.until(`!!document.querySelector('${flash}') && document.querySelector('.file-preview .pdf-tools .page input')?.value === '2'`, 15000))) {
        throw new Error('la ligne de l’annotation n’ouvre pas son PDF à sa page, le passage clignotant');
      }
      // The reader pinned, and taken by its header to the bottom left, off the PDF's node.
      await pin('.file-preview');
      const header = await page.centre('.file-preview > header .title', '');
      await page.drag(header, { x: 200, y: 600 });
      // The PDF's pop-up (its list) by a click on its node, which selects it; Suppr, « Partout ».
      await page.click(ON_PUBLICATION.x, ON_PUBLICATION.y);
      if (!(await page.until(`document.querySelectorAll('.node-popup .annotation-list li').length === 3`))) throw new Error('le pop-up du PDF ne liste pas ses annotations');
      await page.press('Delete', 'Delete', 46);
      const everywhere = await page.centre('.ask button', '^Partout$');
      await page.click(everywhere.x, everywhere.y);
      const trashed = `Le PDF « ${LI} » est à la corbeille.`;
      if (!(await page.until(`document.querySelector('.node-popup .annotation-of .why')?.textContent === ${JSON.stringify(trashed)} && !document.querySelector('.node-popup .annotation-of button')`))) {
        throw new Error('la ligne de l’annotation ne dit pas que son PDF est à la corbeille');
      }
      const gone = await page.evaluate(`[...document.querySelectorAll('.panel .body .dim')].map((p) => p.textContent)`);
      console.log(`     panneaux : ${JSON.stringify(gone)}`);
      if (gone.filter((t) => t === 'Ce nœud n’existe plus.').length !== 2) throw new Error('le pop-up du PDF et son lecteur ne disent pas que le nœud n’existe plus');
      if (await page.evaluate(`[...document.querySelectorAll('.panel')].some((p) => /n’a pas pu s’afficher/.test(p.textContent))`)) throw new Error('un panneau a échoué');
      if (base(`SELECT trashed FROM nodes WHERE id = '${page2}'`)[0].trashed !== 0) throw new Error('l’annotation est partie à la corbeille avec son PDF');
      // Ctrl+Z: the PDF back, its annotation's line opens it again, its reader shows it.
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await page.until(`document.querySelector('.node-popup .annotation-of button')?.textContent === ${JSON.stringify(line)}`))) throw new Error('Ctrl+Z ne rend pas à l’annotation son PDF');
      if (!(await page.until(`!!document.querySelector('.file-preview .pdf-page')`, 15000))) throw new Error('Ctrl+Z ne rend pas son lecteur au PDF');
    },
  },
  {
    // Plan 4c, task 4: a publication's import through the bridge, on the recorded answers (CIRRUS_PUBLICATIONS_REPLAY),
    // never the network: the arXiv article's metadata, its PDF in the test base's store; the refusals in French, whatever
    // the page sends; nothing created (task 5 builds the nodes).
    name: 'importer une publication par le pont, réponses rejouées',
    env: { CIRRUS_PUBLICATIONS_REPLAY: join(appDir, 'tests', 'data', 'publications') },
    async run(page, base, data) {
      const nodes = () => base('SELECT count(*) AS n FROM nodes')[0].n;
      const before = nodes();
      const ask = (expr) => page.evaluate(`window.cirrus.publicationFetch(${expr})`);
      const r = await ask(JSON.stringify('arXiv:1706.03762'));
      if (!r?.ok) throw new Error(`l’import d’arXiv a échoué : ${JSON.stringify(r)}`);
      if (r.id?.arxiv !== '1706.03762' || r.csl?.title !== 'Attention Is All You Need' || !r.bibtex?.startsWith('@misc{')) {
        throw new Error('l’identifiant, le CSL ou le BibTeX ne sont pas ceux enregistrés');
      }
      const pdf = readFileSync(join(appDir, 'tests', 'data', 'publications', 'arxiv-1706.03762.pdf'));
      if (r.pdf?.name !== '1706.03762.pdf' || r.pdf.size !== pdf.length) throw new Error(`le PDF rendu n’est pas celui enregistré : ${JSON.stringify(r.pdf)}`);
      const blob = join(data, 'files', r.pdf.hash.slice(0, 2), r.pdf.hash);
      if (!existsSync(blob) || !readFileSync(blob).equals(pdf)) throw new Error('le PDF n’est pas au magasin de la base de test');
      const book = await ask(JSON.stringify('https://doi.org/10.1007/978-0-387-49820-1'));
      if (!book?.ok || book.csl?.type !== 'book' || book.pdf !== undefined) throw new Error(`le livre de Crossref n’est pas importé sans PDF : ${JSON.stringify(book).slice(0, 200)}`);
      const refusals = [
        ['bonjour', 'Identifiant non reconnu.'], ['10.1007/cirrus-introuvable', 'Publication introuvable.'],
        // Not recorded: as without a network, never the real one.
        ['10.1234/jamais-enregistre', 'Pas de connexion.'],
      ];
      for (const [text, message] of refusals) {
        const x = await ask(JSON.stringify(text));
        if (x?.ok !== false || x.message !== message) throw new Error(`« ${text} » : ${JSON.stringify(x)} au lieu de « ${message} »`);
      }
      // Whatever the page sends: a number, an object, a text too long.
      for (const expr of ['42', '{ doi: "10.1234/essai" }', `'10.1234/' + 'x'.repeat(5000)`]) {
        const x = await ask(expr);
        if (x?.message !== 'Identifiant non reconnu.') throw new Error(`${expr} : ${JSON.stringify(x)}`);
      }
      if (nodes() !== before) throw new Error('l’import a créé des nœuds');
    },
  },
];

// `node scripts/interface.mjs <texte>`: only the scenarios whose name holds that text.
const only = process.argv[2];
const chosen = only ? SCENARIOS.filter((s) => s.name.includes(only)) : SCENARIOS;
let failed = 0;
for (const s of chosen) {
  const data = mkdtempSync(join(tmpdir(), 'cirrus-interface-'));
  const profile = mkdtempSync(join(tmpdir(), 'cirrus-interface-profil-'));
  let app = null;
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    if (s.settings) writeFileSync(join(data, 'settings.json'), JSON.stringify(s.settings), 'utf8');
    app = await launch(data, profile, s.env);
    const base = (sql) => {
      const db = new DatabaseSync(join(data, 'cirrus.db'), { readOnly: true });
      try { return db.prepare(sql).all(); } finally { db.close(); }
    };
    await s.run(app.page, base, data);
    console.log(`ok   ${s.name}`);
  } catch (e) {
    failed++;
    console.error(`ÉCHEC ${s.name} : ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await app?.close();
    rmSync(data, { recursive: true, force: true, maxRetries: 5 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
console.log(`${chosen.length - failed} scénarios sur ${chosen.length} réussis`);
process.exit(failed > 0 ? 1 : 0);
