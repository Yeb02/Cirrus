// The interface's checks by real input: npm run interface -w packages/app
// Each scenario launches the app on a fresh artificial test base, with a profile of its own (never the user's base nor
// profile), and drives it by the mouse and keyboard events Chromium receives from the system (DevTools' Input domain):
// the browser's own default actions — the focus a press gives, a click after a press — happen as for the user, which
// the pointer replays of the captures (CIRRUS_POINTER) skip. Then it reads what the page shows and what the base kept.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { bibFileName, editNode } from '@cirrus/core';
import { storeBytes } from '@cirrus/store';
import { appDir, launch, sleep } from './cdp.mjs';
import { chipSays, closeSettings, localServer, pairThrough, serverField, TITLE_PROBE, virtualPc } from './serveur-local.mjs';

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

// Plan 4c, task 5: publications imported from the dialog of the background's menu, on recorded answers (never the
// network), the view as PUBLICATION's (the test base's book at its centre, the sky at SKY).
const IMPORT = { env: { ...PUBLICATION.env, CIRRUS_PUBLICATIONS_REPLAY: join(appDir, 'tests', 'data', 'publications') } };
const ATTENTION = 'Attention Is All You Need';
/** Another point of the sky, 140 px under SKY: free once a node is put down at SKY. */
const SKY2 = { x: SKY.x, y: SKY.y + 140 };
/** « Importer une publication… » in the menu of the sky's background at `at`: the dialog, its field focused. */
async function openImport(page, at = SKY) {
  for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(at.x, at.y, 'right');
  const item = await page.centre('.context-menu button', 'Importer une publication');
  await page.click(item.x, item.y);
  if (!(await page.until(`document.activeElement?.matches('.publication-dialog input') === true`))) throw new Error('le dialogue d’import ne s’ouvre pas, ou son champ n’a pas le focus');
}
const sql = (s) => `'${s.replaceAll('\'', '\'\'')}'`;
/** The live nodes of that title, their records. */
const titledIn = (base, title) => base(`SELECT json FROM nodes WHERE trashed = 0 AND json_extract(json, '$.title') = ${sql(title)}`).map((r) => JSON.parse(r.json));
const statusOf = (page) => page.evaluate(`document.querySelector('.publication-dialog .status')?.textContent ?? null`);
const dialogOpen = (page) => page.evaluate(`!!document.querySelector('.publication-dialog')`);
/** A blob of the test base's store. */
const blob = (data, hash) => readFileSync(join(data, 'files', hash.slice(0, 2), hash));
/** The node's tags, `key: value` each. */
const tagsOf = (n) => n.tags.map((t) => `${t.key}: ${t.value}`);
/** The number of blobs in the test base's store (plan 5b, task 4: a request refused stores nothing). */
const blobCount = (data) => {
  const store = join(data, 'files');
  return existsSync(store) ? readdirSync(store).filter((d) => /^[0-9a-f]{2}$/.test(d)).reduce((n, d) => n + readdirSync(join(store, d)).length, 0) : 0;
};
/** The arXiv article's PDF of the recorded answers, which « Choisir un PDF… » takes by CIRRUS_PDF_PICK. */
const ARXIV_PDF = join(appDir, 'tests', 'data', 'publications', 'arxiv-1706.03762.pdf');

// Plan 4c, task 6: a whole .bib — the test base's (fixtures/assets) — dropped on the sky's background, or chosen by
// the background's menu (CIRRUS_BIB_PICK: the system's dialog never opens), its block following the cursor until a click.
const BIB = join(appDir, '..', 'fixtures', 'assets', 'bibliographie.bib');
const BIB_TITLES = [
  'A Mathematical Theory of Communication', 'Three approaches to the quantitative definition of information', 'A formal theory of inductive inference. Part I',
  'Modeling by shortest data description', 'The Minimum Description Length Principle', ATTENTION,
  'Universal Artificial Intelligence: Sequential Decisions Based on Algorithmic Probability',
];
// DBLP's key kept (final review, R1 revised), its file named without « : » nor « / ».
const BIB_KEYS = ['shannon1948', 'DBLP:journals/ppi/Kolmogorov65', 'solomonoff1964', 'rissanen1978', 'grunwald2007', 'vaswani2017attention', 'hutter2005'];
/** The live nodes of the test .bib's publications. */
const bibNodes = (base) => BIB_TITLES.flatMap((t) => titledIn(base, t));
const ghostText = (page) => page.evaluate(`document.querySelector('.ghost')?.textContent ?? null`);
const toastsText = (page) => page.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`);
/** A mark of the import (GraphView's bibMark), in ms of the page's clock; null if not reached. */
const markAt = (page, name) => page.evaluate(`performance.getEntriesByName('cirrus:bib:${name}').at(-1)?.startTime ?? null`);
/** The ghost of the .bib's block shown, saying `text` (a regular expression's source). */
const bibGhost = (page, text, ms = 8000) => page.until(`new RegExp(${JSON.stringify(text)}).test(document.querySelector('.ghost')?.textContent ?? '') && !!document.querySelector('.ghost-block')`, ms);
/** « Importer un fichier .bib… » in the menu of the sky's background at `at`. */
async function pickBibByMenu(page, at = SKY) {
  for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(at.x, at.y, 'right');
  const item = await page.centre('.context-menu button', 'Importer un fichier \\.bib');
  await page.click(item.x, item.y);
}

// Plan 5a, task 4: a server of this machine, started by the scenario on 127.0.0.1 and a free port, its data in a
// temporary folder (never %LOCALAPPDATA%\Cirrus); a pairing code made as `jumeler` makes it; the block « Serveur »
// driven as the user does (serveur-local.mjs).
const chipText = (page) => page.evaluate(`document.querySelector('.tabs .sync-chip')?.textContent ?? null`);
/** A base read by SQL, as the scenarios read theirs (the main process writes it). */
const reader = (data) => (sql) => {
  const db = new DatabaseSync(join(data, 'cirrus.db'), { readOnly: true });
  try { return db.prepare(sql).all(); } finally { db.close(); }
};
/** « Nouveau nœud » from the menu of the background (opened at `menu`), put down at `at`, its title typed in place, Entrée. */
async function newNode(page, at, title, menu = { x: at.x - 150, y: at.y + 50 }) {
  for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(menu.x, menu.y, 'right');
  const item = await page.centre('.context-menu button', 'Nouveau nœud');
  await page.click(item.x, item.y);
  await page.move(at.x, at.y);
  await page.click(at.x, at.y);
  await page.type(title);
  await page.press('Enter', 'Enter', 13);
}
/** What the block says when pairing failed, for a failure's message. */
const blockText = (page) => page.evaluate(`document.querySelector('.server-error')?.textContent ?? document.querySelector('.server-block')?.textContent ?? '(pas de bloc)'`);

// Plan 5a, task 7: two PCs and a server, one Electron at a time (the user's machine: never two windows at once), each in
// its window out of the user's way. The server is started by the suite (serveur-local.mjs), the pairing codes made as
// `jumeler` makes them; the virtual PC (tests/support/virtualPc.ts) runs in this process, on Node's fetch.
/** Both apps' view: the world's origin at the graph's centre, at zoom 1 — the node A puts down at NODE_AT, B shows there. */
const SYNC_VIEW = { CIRRUS_VIEW: '0,0,1' };
const NODE_AT = { x: 400, y: 800 };
const A_TITLE = 'Nœud de A', A_FILE = 'notes_de_A.txt', A_TEXT = 'Écrit sur le PC A, lu sur le PC B.\n';
const CHAPTER_PATH = join(appDir, '..', 'fixtures', 'assets', CHAPTER);
const blobIn = (data, hash) => join(data, 'files', hash.slice(0, 2), hash);
// Plan 5b, D6: a .tex of the virtual PC's, open on both PCs; its versions written there.
const TEX_NAME = 'note.tex';
const texVersion = (n) => `\\section{Écrit sur le PC virtuel, version ${n}}\n`;
/** The text of the .tex's editor in the full screen, its lines joined by « \n ». */
const EDITOR_TEXT = `[...document.querySelectorAll('.full-screen .tex-source .cm-line')].map((l) => l.textContent).join('\\n')`;
/** The full screen's banner over the .tex (D6). */
const TEX_BANNER = `document.querySelector('.full-screen .tex-workbench .viewer-banner')?.textContent ?? ''`;
/** Whether a notification says `text` within `ms`. */
const toastSays = (page, text, ms = 5000) => page.until(`[...document.querySelectorAll('.toast')].some((t) => ${text instanceof RegExp ? `${text}.test(t.textContent)` : `t.textContent === ${JSON.stringify(text)}`})`, ms);
/** The node's pop-up, by a click on it, showing `title`. */
async function openPopup(page, at, title) {
  for (let i = 0; i < 10 && !(await page.until(`document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(title)}`, 1000)); i++) {
    await page.click(at.x, at.y);
  }
  if (!(await page.evaluate(`document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(title)}`))) {
    throw new Error(`pas de pop-up « ${title} » au clic sur le nœud`);
  }
}
// Plan 6a, task 2: previous and next. The window's pixels say where the view is: one plan at one camera is one image.
/** The graph as it is once the pointer rests on a free corner (a hover lights what is under it) and nothing blinks: its pixels, not the tabs'. */
async function viewImage(page) {
  await page.move(1590, 995);
  await sleep(1500);
  const r = await page.evaluate(`(() => { const b = document.querySelector('.graph').getBoundingClientRect(); return { x: b.left, y: b.top, width: b.width, height: b.height, scale: 1 }; })()`);
  const shot = await page.send('Page.captureScreenshot', { format: 'png', clip: r });
  if (!shot.result?.data) throw new Error(`Pas de capture : ${shot.error?.message ?? 'réponse vide'}`);
  return Buffer.from(shot.result.data, 'base64');
}
/**
 * The share (in %) of pixels where two images differ by more than 16 levels on a channel, counted by the page (as the
 * captures' comparison does): a plan shown again is drawn from the same scene, to within a few levels at the edges.
 */
async function imageDiff(page, a, b) {
  return page.evaluate(`(async () => {
    const load = async (b64) => {
      const bmp = await createImageBitmap(new Blob([Uint8Array.from(atob(b64), (c) => c.charCodeAt(0))], { type: 'image/png' }));
      const g = new OffscreenCanvas(bmp.width, bmp.height).getContext('2d');
      g.drawImage(bmp, 0, 0);
      return g.getImageData(0, 0, bmp.width, bmp.height);
    };
    const x = await load(${JSON.stringify(a.toString('base64'))}), y = await load(${JSON.stringify(b.toString('base64'))});
    if (x.width !== y.width || x.height !== y.height) return 100;
    let n = 0;
    for (let i = 0; i < x.data.length; i += 4) {
      if (Math.abs(x.data[i] - y.data[i]) > 16 || Math.abs(x.data[i + 1] - y.data[i + 1]) > 16 || Math.abs(x.data[i + 2] - y.data[i + 2]) > 16) n++;
    }
    return (100 * n) / (x.width * x.height);
  })()`);
}
/** The graph is now the image `expected`, to the pixel (a hundredth of a percent at most): else `message`. */
async function sameView(page, expected, message) {
  const diff = await imageDiff(page, await viewImage(page), expected);
  if (diff >= 0.01) throw new Error(`${message} (${diff.toFixed(3)} % des pixels diffèrent)`);
}
/** The mouse's side button `which` ('back' or 'forward') pressed and released at (x, y), as the system sends it. */
async function sideClick(page, x, y, which) {
  const buttons = which === 'back' ? 8 : 16;
  await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: which, buttons, clickCount: 1 });
  await sleep(30);
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: which, buttons: 0, clickCount: 1 });
  await sleep(600);
}
/** The active tab's text. */
const activeTab = (page) => page.evaluate(`document.querySelector('.tabs .tab.on')?.textContent ?? ''`);
const onTab = async (page, name, what) => {
  if (!(await page.until(`document.querySelector('.tabs .tab.on')?.textContent.includes(${JSON.stringify(name)}) === true`))) throw new Error(`${what} : l’onglet actif est « ${await activeTab(page)} », pas « ${name} »`);
};
/** Ctrl+K, `query` typed, its row `title` listed first: Entrée jumps to it (the box closes, the graph has the focus). */
async function searchJump(page, query, title) {
  const FIELD = `document.activeElement?.matches('.search-box .search-field') === true`;
  for (let i = 0; i < 10 && !(await page.until(FIELD, 1000)); i++) await page.press('k', 'KeyK', 75, 2);
  if (!(await page.evaluate(FIELD))) throw new Error('Ctrl+K n’ouvre pas la recherche');
  await page.type(query);
  if (!(await page.until(`document.querySelector('.search-box .search-results li .title')?.textContent === ${JSON.stringify(title)}`, 10000))) {
    throw new Error(`la recherche de « ${query} » ne met pas « ${title} » en tête : ${JSON.stringify(await page.evaluate(`[...document.querySelectorAll('.search-box .search-results li .title')].map((t) => t.textContent)`))}`);
  }
  await page.press('Enter', 'Enter', 13);
  if (await page.evaluate(`!!document.querySelector('.search-box')`)) throw new Error('Entrée ne ferme pas la recherche');
}
// Plan 6a, task 5 (D6): the recording of consultations, in consultations.db beside the base.
/** The consultations' rows as the app wrote them (a read-only connection of this script's own), or null if the file is not there. */
function consultationsOf(data) {
  const file = join(data, 'consultations.db');
  if (!existsSync(file)) return null;
  const db = new DatabaseSync(file, { readOnly: true });
  try { return db.prepare('SELECT at, pc, kind, subject, plan, detail FROM events ORDER BY rowid').all(); } finally { db.close(); }
}
/**
 * The window closed as a click on its button does: Browser.close reaches the window's own « close » event, where the app's
 * closing runs (the last snapshot, the last consultations), which `app.quit()` (window.close() from the page, which destroys
 * the window at once) does not. Whether the app quit by itself within `ms`.
 */
async function closeAsUser(app, ms = 20_000) {
  void app.page.send('Browser.close');
  const code = await Promise.race([app.exited, sleep(ms).then(() => null)]);
  return code !== null;
}
/** The events that tell what was looked at: the window's focus, which these background windows emulate, is left out. */
const looked = (rows) => rows.filter((r) => r.kind !== 'focus' && r.kind !== 'blur');
/** The centre of the graph, where a jump frames its object. */
const graphCentre = (page) => page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);

const TWO_PCS = {
  name: 'synchronisation entre deux PC (plan 5a, tâche 7)',
  async setup() {
    const dirs = [];
    const temp = (prefix) => { const d = mkdtempSync(join(tmpdir(), prefix)); dirs.push(d); return d; };
    return {
      server: await localServer(), dirs, temp,
      a: { data: temp('cirrus-interface-a-'), profile: temp('cirrus-interface-profil-a-') },
      b: { data: temp('cirrus-interface-b-'), profile: temp('cirrus-interface-profil-b-') },
      app: null, virtual: null, node: null,
    };
  },
  async teardown(ctx) {
    await ctx.app?.close();
    await ctx.virtual?.close();
    await ctx.server.close();
    // B's base taken from the server may leave a staged one beside it if it failed, or its old one
    // (« …-avant-jumelage-… ») if that was not vierge.
    const b = basename(ctx.b.data);
    for (const name of readdirSync(tmpdir())) if (name.startsWith(`${b}-`)) ctx.dirs.push(join(tmpdir(), name));
    for (const d of ctx.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  },
  steps: [
    {
      name: '1. A crée un nœud avec un .txt et quitte ; B, neuve, prend la base du serveur dès le code accepté, sans offre, redémarre sur elle, sa base vierge effacée, puis montre le nœud et son fichier (plan 5a)',
      async run(ctx) {
        const { server, a, b } = ctx;
        // A: a new base paired with the empty server (both empty: the sync starts, A's lobby its first write).
        ctx.app = await launch(a.data, a.profile, SYNC_VIEW);
        let page = ctx.app.page;
        await pairThrough(page, server.url, server.code('A'));
        if (!(await chipSays(page, 'À jour'))) throw new Error(`A n’est pas jumelée : ${await blockText(page)} ; la pastille dit « ${await chipText(page)} »`);
        await closeSettings(page);
        await newNode(page, NODE_AT, A_TITLE);
        const file = join(ctx.temp('cirrus-interface-depot-'), A_FILE), hash = createHash('sha256').update(A_TEXT).digest('hex');
        writeFileSync(file, A_TEXT, 'utf8');
        await page.dropFiles(NODE_AT, [file]);
        const sent = () => server.hasBlob(hash) && server.journal().some((op) => op.t === 'node' && op.after?.title === A_TITLE && op.after.files.some((f) => f.hash === hash));
        if (!(await until(sent, 10_000))) throw new Error(`le nœud de A et son fichier n’arrivent pas au serveur ; ${await toastsText(page)}`);
        if (!(await chipSays(page, 'À jour'))) throw new Error(`la pastille de A dit « ${await chipText(page)} »`);
        // A quits as the user does, by closing its window.
        if (!(await ctx.app.quit())) throw new Error('A ne se ferme pas');
        const codeA = await ctx.app.exited;
        if (codeA !== 0) throw new Error(`A se ferme avec le code ${codeA}`);
        ctx.app = null;
        // B: a new base, vierge; the server holds A's, so the pairing takes it at once, nothing asked (D7, R7; after
        // the short review of plan 5a): no offer to click.
        const env = { ...SYNC_VIEW, CIRRUS_NO_RELAUNCH: '1' };
        ctx.app = await launch(b.data, b.profile, env);
        page = ctx.app.page;
        await pairThrough(page, server.url, server.code('B'));
        // Taken, staged beside B's base; B quits instead of starting again (R27: the relaunch stays this script's). An
        // offer would wait for a click that never comes: B would not quit.
        const code = await Promise.race([ctx.app.exited, sleep(30_000).then(() => null)]);
        if (code === null) throw new Error(`B ne quitte pas après le jumelage : ${await blockText(page)}`);
        if (code !== 0) throw new Error(`B quitte avec le code ${code} après la prise`);
        await ctx.app.close();
        ctx.app = null;
        const staged = `${b.data}-nouvelle`;
        if (!existsSync(join(staged, 'complete.json'))) throw new Error('pas de base prise complète à côté de celle de B');
        // B started again as the relaunch would (its profile, which holds the key of its token): the base taken swapped
        // in before it opens, the old one, vierge, deleted — nothing kept beside it.
        ctx.app = await launch(b.data, b.profile, env);
        page = ctx.app.page;
        const beside = readdirSync(tmpdir()).filter((n) => n.startsWith(`${basename(b.data)}-`));
        if (existsSync(staged) || beside.length !== 0 || !existsSync(join(b.data, 'cirrus.db'))) {
          throw new Error(`l’échange n’a pas eu lieu comme prévu : base prise ${existsSync(staged) ? 'encore à côté' : 'en place'}, à côté de B : ${JSON.stringify(beside)}`);
        }
        if (!(await chipSays(page, 'À jour'))) throw new Error(`B ne se synchronise pas après la prise : la pastille dit « ${await chipText(page)} »`);
        // The node and its file in B's base and store (taken with the base, D7), then shown: its pop-up, by a click where
        // A put it down, lists the file; opened beside it, the file shows A's text.
        const base = reader(b.data), node = titledIn(base, A_TITLE)[0];
        if (!node?.files.some((f) => f.name === A_FILE && f.hash === hash) || !existsSync(blobIn(b.data, hash))) {
          throw new Error(`B n’a pas le nœud de A, ou pas son fichier : ${JSON.stringify(node)}`);
        }
        ctx.node = node.id;
        await openPopup(page, NODE_AT, A_TITLE);
        const row = await page.centre(`.node-popup .file[data-name="${A_FILE}"]`, '');
        await page.click(row.x, row.y);
        if (!(await page.until(`(document.querySelector('.file-preview')?.textContent ?? '').includes(${JSON.stringify(A_TEXT.trim())})`, 10_000))) {
          throw new Error('l’aperçu du fichier de A ne montre pas son texte');
        }
        const close = await page.centre('.file-preview .close', '×');
        await page.click(close.x, close.y);
      },
    },
    {
      name: '2. B ouverte, un PC virtuel renomme le nœud : B montre le nouveau titre en moins d’une seconde (plan 5a)',
      async run(ctx) {
        const page = ctx.app.page;
        // Its .tex open sent to the server (plan 5b, D6: step 5).
        ctx.virtual = await virtualPc(ctx.server, 'pc-virtuel', { presence: true });
        const pc = ctx.virtual.pc;
        if (!(await until(() => pc.s.nodes.get(ctx.node) !== undefined && pc.status?.state === 'live', 10_000))) throw new Error(`le PC virtuel ne rattrape pas le serveur : ${JSON.stringify(pc.status)}`);
        const title = 'Renommé par le PC virtuel';
        await page.evaluate(TITLE_PROBE(title));
        const t0 = performance.timeOrigin + performance.now();
        pc.act((s) => editNode(s, ctx.node, { title }));
        const shown = await page.evaluate('window.__shown');
        if (shown === null || shown === undefined) throw new Error('B ne montre pas le nouveau titre dans le pop-up du nœud');
        console.log(`     nouveau titre montré par B ${Math.round(shown - t0)} ms après l’écriture du PC virtuel`);
        if (shown - t0 >= 1000) throw new Error(`B montre le nouveau titre ${Math.round(shown - t0)} ms après l’écriture du PC virtuel`);
        if (!(await until(() => titledIn(reader(ctx.b.data), title).length === 1))) throw new Error('le nouveau titre n’est pas dans la base de B');
      },
    },
    {
      name: '3. le serveur arrêté, la pastille de B dit « Hors ligne » ; B renomme le nœud, puis le serveur revient : l’action part, et le PC virtuel la reçoit (plan 5a)',
      async run(ctx) {
        const { server } = ctx, page = ctx.app.page, pc = ctx.virtual.pc, base = reader(ctx.b.data);
        await server.stop();
        if (!(await chipSays(page, 'Hors ligne'))) throw new Error(`la pastille dit « ${await chipText(page)} » une fois le serveur arrêté`);
        // B acts: the node renamed in its pop-up, written here, pending.
        const title = 'Renommé par B hors ligne';
        const field = await page.centre('.node-popup input.title', '');
        await page.click(field.x, field.y);
        await page.press('a', 'KeyA', 65, 2);
        await page.type(title);
        await page.press('Enter', 'Enter', 13);
        const pending = () => base(`SELECT count(*) AS n FROM changes WHERE server_seq IS NULL`)[0].n;
        if (!(await until(() => titledIn(base, title).length === 1 && pending() > 0))) throw new Error('le renommage n’est pas dans la base de B, en attente');
        if (server.journal().some((op) => op.after?.title === title)) throw new Error('le serveur arrêté a reçu le renommage');
        if ((await chipText(page)) !== 'Hors ligne') throw new Error(`la pastille dit « ${await chipText(page)} » après l’action hors ligne`);
        // The server back on its port: B's next attempt (syncRetryMinMs, doubling) sends the action; the virtual PC receives it.
        await server.restart();
        if (!(await until(() => server.journal().some((op) => op.t === 'node' && op.after?.title === title), 40_000))) throw new Error('le renommage hors ligne n’arrive pas au serveur');
        if (!(await until(() => pc.s.nodes.get(ctx.node)?.title === title, 10_000))) throw new Error(`le PC virtuel ne reçoit pas le renommage : ${pc.s.nodes.get(ctx.node)?.title}`);
        if (!(await chipSays(page, 'À jour')) || !(await until(() => pending() === 0))) throw new Error(`B ne revient pas à jour : « ${await chipText(page)} », ${pending()} lignes en attente`);
      },
    },
    {
      name: '4. un PDF ajouté par le PC virtuel arrive au nœud sans ses octets ; ouvert dans B, il est téléchargé, puis affiché (plan 5a)',
      async run(ctx) {
        const { server } = ctx, page = ctx.app.page, pc = ctx.virtual.pc, base = reader(ctx.b.data);
        // The virtual PC adds the test base's chapter to the node: its bytes go to the server before the write (D6).
        const ref = storeBytes(pc.dir, CHAPTER, readFileSync(CHAPTER_PATH));
        pc.act((s) => editNode(s, ctx.node, { files: [...s.nodes.get(ctx.node).files, ref] }));
        const listed = () => base(`SELECT json FROM nodes WHERE id = '${ctx.node}'`).map((r) => JSON.parse(r.json))[0]?.files.some((f) => f.hash === ref.hash);
        if (!(await until(() => server.hasBlob(ref.hash) && listed(), 10_000))) throw new Error('le PDF n’arrive pas au serveur, ou son écriture pas à B');
        // B has the write but not the PDF: a PDF waits for its first reading (D6), and its thumbnail downloads nothing.
        if (!(await page.until(`!!document.querySelector('.node-popup .file[data-name="${CHAPTER}"]')`, 10_000))) throw new Error('le pop-up de B ne montre pas le PDF reçu');
        await sleep(1500);
        if (existsSync(blobIn(ctx.b.data, ref.hash))) throw new Error('B a téléchargé le PDF avant de l’ouvrir');
        // Opened: downloaded, checked against its hash, kept, then shown — its first page's text.
        const row = await page.centre(`.node-popup .file[data-name="${CHAPTER}"]`, '');
        await page.click(row.x, row.y);
        if (!(await page.until(`(document.querySelector('${PAGE_1}')?.textContent ?? '').includes('Kolmogorov')`, 20_000))) {
          throw new Error(`le PDF ne s’affiche pas : ${await page.evaluate(`document.querySelector('.file-preview')?.textContent ?? '(pas d’aperçu)'`)}`);
        }
        const kept = blobIn(ctx.b.data, ref.hash);
        if (!existsSync(kept) || createHash('sha256').update(readFileSync(kept)).digest('hex') !== ref.hash) throw new Error('le PDF affiché n’est pas gardé dans le magasin de B');
      },
    },
    {
      name: '5. un .tex ouvert en plein écran sur le PC virtuel : B, qui l’ouvre à son tour, le dit dans son bandeau ; le PC virtuel apprend que B l’a ouvert (plan 5b, D6)',
      async run(ctx) {
        const page = ctx.app.page, pc = ctx.virtual.pc;
        // The virtual PC adds note.tex to the node, and opens it: nobody else has it.
        const ref = storeBytes(pc.dir, TEX_NAME, Buffer.from(texVersion(0), 'utf8'));
        pc.act((s) => editNode(s, ctx.node, { files: [...s.nodes.get(ctx.node).files, ref] }));
        pc.openTex.push({ node: ctx.node, name: TEX_NAME });
        const first = await pc.client.presence();
        if (JSON.stringify(first) !== '[]') throw new Error(`le PC virtuel n’envoie pas son .tex ouvert : ${JSON.stringify(first)}`);
        // B: the .tex in the node's pop-up — the chapter's preview of step 4 closed, the row brought into view —, its
        // preview, then its full screen (⤢).
        if (!(await page.until(`!!document.querySelector('.node-popup .file[data-name="${TEX_NAME}"]')`, 10_000))) throw new Error('le pop-up de B ne montre pas le .tex reçu');
        for (let i = 0; i < 3 && (await page.evaluate(`!!document.querySelector('.file-preview .close')`)); i++) {
          const close = await page.centre('.file-preview .close', '×');
          await page.click(close.x, close.y);
        }
        await page.evaluate(`document.querySelector('.node-popup .file[data-name="${TEX_NAME}"]').scrollIntoView({ block: 'center' })`);
        const row = await page.centre(`.node-popup .file[data-name="${TEX_NAME}"]`, '');
        await page.click(row.x, row.y);
        const expand = `[...document.querySelectorAll('.file-preview')].find((p) => p.querySelector('.title')?.textContent === '${TEX_NAME}')?.querySelector('.expand')`;
        if (!(await page.until(`!!${expand}`, 10_000))) {
          const shown = await page.evaluate(`[...document.querySelectorAll('.file-preview')].map((p) => p.querySelector('.title')?.textContent)`);
          throw new Error(`pas d’aperçu du .tex, ou pas de ⤢ : aperçus ${JSON.stringify(shown)}`);
        }
        const at = await page.evaluate(`(() => { const b = ${expand}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        await page.click(at.x, at.y);
        if (!(await page.until(`(${EDITOR_TEXT}).includes('version 0')`, 15_000))) throw new Error('le plein écran de B ne montre pas le .tex');
        // Its banner names the virtual PC (its name at the server), since when.
        const banner = /^Ce \.tex est ouvert sur « PC-VIRTUEL » depuis \d{2}h\d{2} : sa dernière version y est peut-être restée\.$/;
        if (!(await page.until(`${banner}.test(${TEX_BANNER})`, 10_000))) throw new Error(`le bandeau du plein écran dit « ${await page.evaluate(TEX_BANNER)} »`);
        // The virtual PC hears of B's, under the name `jumeler` gave B.
        const back = await pc.client.presence();
        if (!back?.some((o) => o.node === ctx.node && o.name === TEX_NAME && o.pc === 'B')) throw new Error(`le PC virtuel n’apprend pas que B a ouvert le .tex : ${JSON.stringify(back)}`);
      },
    },
    {
      name: '6. le .tex changé par le PC virtuel pendant qu’il est ouvert dans B : rien de tapé, la nouvelle version chargée et dite ; du texte tapé, le bandeau, puis Ctrl+S garde les deux versions en une action ; Échap, et le PC virtuel ne l’apprend plus ouvert (plan 5b, D6)',
      async run(ctx) {
        const page = ctx.app.page, pc = ctx.virtual.pc, base = reader(ctx.b.data);
        /** A version written by the virtual PC, under the .tex's name. */
        const changed = (n) => {
          const ref = storeBytes(pc.dir, TEX_NAME, Buffer.from(texVersion(n), 'utf8'));
          pc.act((s) => editNode(s, ctx.node, { files: s.nodes.get(ctx.node).files.map((f) => (f.name === TEX_NAME ? ref : f)) }));
          return ref;
        };
        // Nothing typed in B: version 1 replaces the editor's text, and a notification says so.
        changed(1);
        if (!(await page.until(`(${EDITOR_TEXT}).includes('version 1')`, 15_000))) throw new Error(`l’éditeur de B ne montre pas la version 1 : « ${await page.evaluate(EDITOR_TEXT)} »`);
        if (!(await toastSays(page, `« ${TEX_NAME} » a été modifié sur un autre PC : sa nouvelle version est chargée.`))) throw new Error(`pas de notification : ${await toastsText(page)}`);
        // A key at once, then Ctrl+Z twice: the key undone, never version 0 back — the load is no step of the editor's
        // history (fix round 1 of the review, Important 1).
        const line = await page.centre('.full-screen .tex-source .cm-line', 'version 1');
        await page.click(line.x, line.y);
        await page.type('Z');
        for (let i = 0; i < 2; i++) await page.press('z', 'KeyZ', 90, 2);
        const undone = await page.evaluate(EDITOR_TEXT);
        if (undone !== texVersion(1).trimEnd() && undone !== texVersion(1)) throw new Error(`Ctrl+Z après le chargement rend « ${undone} »`);
        // Typed in B, then version 2 there: the typed text stays, and the banner says that version will be kept.
        await page.click(line.x, line.y);
        await page.press('End', 'End', 35);
        await page.type(' % tapé dans B');
        const v2 = changed(2);
        const also = `« ${TEX_NAME} » a aussi été modifié sur un autre PC : à l’enregistrement, cette version-là sera gardée sous « note (conflit du … ).tex ».`;
        if (!(await page.until(`(${TEX_BANNER}).includes(${JSON.stringify(also)})`, 15_000))) throw new Error(`le bandeau dit « ${await page.evaluate(TEX_BANNER)} »`);
        if (!(await page.evaluate(`(${EDITOR_TEXT}).includes('version 1} % tapé dans B')`))) throw new Error(`le texte tapé n’est plus là : « ${await page.evaluate(EDITOR_TEXT)} »`);
        // Ctrl+S: the typed text under the name, version 2 under its conflict name, in one write of B's base; said.
        await page.press('s', 'KeyS', 83, 2);
        const copy = /^note \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex$/;
        const last = () => base(`SELECT op FROM changes ORDER BY local_seq DESC LIMIT 1`).map((r) => JSON.parse(r.op))[0];
        const both = () => {
          const files = last()?.after?.files ?? [];
          return files.some((f) => f.name === TEX_NAME && f.hash !== v2.hash) && files.some((f) => copy.test(f.name) && f.hash === v2.hash);
        };
        if (!(await until(both, 10_000))) throw new Error(`l’enregistrement n’écrit pas les deux versions en une écriture : ${JSON.stringify(last())}`);
        if (!(await toastSays(page, /^« note\.tex » a été modifié sur deux PC : l’autre version est gardée sous « note \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex »\.$/))) {
          throw new Error(`pas de notification de la copie : ${await toastsText(page)}`);
        }
        if ((await page.evaluate(TEX_BANNER)).includes('a aussi été modifié')) throw new Error('le bandeau parle encore de la version gardée');
        // The virtual PC receives both.
        if (!(await until(() => pc.s.nodes.get(ctx.node).files.some((f) => copy.test(f.name) && f.hash === v2.hash), 10_000))) throw new Error('le PC virtuel ne reçoit pas la copie de conflit');
        // Escape leaves the full screen: B's .tex no longer open for the virtual PC.
        for (let i = 0; i < 3 && (await page.evaluate(`!!document.querySelector('.full-screen')`)); i++) {
          await page.press('Escape', 'Escape', 27);
          await sleep(300);
        }
        if (await page.evaluate(`!!document.querySelector('.full-screen')`)) throw new Error('Échap ne ferme pas le plein écran');
        let others = await pc.client.presence();
        for (const end = Date.now() + 5000; others?.length !== 0 && Date.now() < end; others = await pc.client.presence()) await sleep(100);
        if (others?.length !== 0) throw new Error(`le PC virtuel apprend encore que B a ouvert le .tex : ${JSON.stringify(others)}`);
      },
    },
    {
      // The conflict copy step 6 left in the node is the one compared: made by the sync itself, as the user meets it.
      name: '7. la copie de conflit du pas 6 comparée à son original : « Comparer » sur elle seule, les deux textes côte à côte, un bloc repris et un mot tapé, Échap qui demande « Abandonner la réconciliation ? », « Enregistrer et retirer la copie » écrit en une action ; la copie n’est plus au nœud, son blob reste, le PC virtuel reçoit (plan 5b, D7)',
      async run(ctx) {
        const page = ctx.app.page, pc = ctx.virtual.pc, base = reader(ctx.b.data);
        const copyRow = `.node-popup .file[data-name^="note (conflit du"]`;
        // « Comparer » is on the copy's row, not on note.tex's.
        if (!(await page.until(`!!document.querySelector('${copyRow} .compare')`, 10_000))) throw new Error('le pop-up ne propose pas « Comparer » sur la copie de conflit');
        if (await page.evaluate(`!!document.querySelector('.node-popup .file[data-name="${TEX_NAME}"] .compare')`)) throw new Error('« Comparer » est offert sur l’original');
        const copyName = await page.evaluate(`document.querySelector('${copyRow}').dataset.name`);
        const copyRef = pc.s.nodes.get(ctx.node).files.find((f) => f.name === copyName);
        await page.evaluate(`document.querySelector('${copyRow}').scrollIntoView({ block: 'center' })`);
        const open = await page.centre(`${copyRow} .compare`, 'Comparer');
        await page.click(open.x, open.y);
        /** The text of one side of the comparison (`a`: the original, `b`: the copy), its lines joined by « \n ». */
        const side = (s) => `[...document.querySelectorAll('.compare-view .cm-merge-${s} .cm-line')].map((l) => l.textContent).join('\\n')`;
        if (!(await page.until(`(${side('a')}).includes('version 1')`, 15_000))) throw new Error(`la comparaison ne s’ouvre pas : « ${await page.evaluate(`document.querySelector('.compare-view')?.textContent ?? '(pas de plein écran)'`)} »`);
        const title = await page.evaluate(`document.querySelector('.compare-view > header .name').textContent`);
        if (title !== `Comparer « ${TEX_NAME} » et « ${copyName} »`) throw new Error(`l’en-tête dit « ${title} »`);
        // The original on the left, with what B typed; the copy on the right, read-only, with version 2.
        if (!(await page.evaluate(`(${side('a')}).includes('version 1} % tapé dans B')`)) || !(await page.evaluate(`(${side('b')}).includes('version 2')`))) {
          throw new Error(`les côtés ne montrent pas les deux versions : « ${await page.evaluate(side('a'))} » | « ${await page.evaluate(side('b'))} »`);
        }
        if (!(await page.evaluate(`document.querySelector('.compare-view .cm-merge-b .cm-content').getAttribute('aria-readonly') === 'true'`))) throw new Error('le côté de la copie n’est pas en lecture seule');
        if (await page.evaluate(`document.querySelector('.compare-view .cm-merge-a .cm-content').getAttribute('aria-readonly') === 'true'`)) throw new Error('le côté de l’original est en lecture seule');
        // The block of the copy taken by its arrow, then a word typed after it.
        // The notifications of the earlier steps stand over the middle of the window, where the arrow is: the offer to install
        // LaTeX put away, the others waited out.
        if (await page.evaluate(`!!document.querySelector('.toast .later')`)) {
          const later = await page.centre('.toast .later', 'Plus tard');
          await page.click(later.x, later.y);
        }
        if (!(await page.until(`!document.querySelector('.toast')`, 20_000))) throw new Error(`des notifications couvrent la comparaison : ${await toastsText(page)}`);
        const arrow = await page.centre('.compare-view .cm-merge-revert button', '');
        await page.click(arrow.x, arrow.y);
        if (!(await page.until(`(${side('a')}).includes('version 2') && !(${side('a')}).includes('version 1')`, 5000))) throw new Error(`la flèche ne reprend pas le bloc : « ${await page.evaluate(side('a'))} »`);
        const line = await page.centre('.compare-view .cm-merge-a .cm-line', 'version 2');
        await page.click(line.x, line.y);
        await page.press('End', 'End', 35);
        await page.type(' % repris');
        // Escape asks, « Annuler » having the focus; it keeps the comparison and what was taken.
        await page.press('Escape', 'Escape', 27);
        if (!(await page.until(`(document.querySelector('.compare-view .ask')?.textContent ?? '').includes('Abandonner la réconciliation ?')`, 5000))) throw new Error('Échap, avec des changements, ne pose pas la question');
        if (!(await page.evaluate(`document.activeElement?.classList.contains('cancel') && document.activeElement.textContent === 'Annuler'`))) throw new Error('« Annuler » n’a pas le focus');
        const cancel = await page.centre('.compare-view .ask .cancel', 'Annuler');
        await page.click(cancel.x, cancel.y);
        if (await page.evaluate(`!document.querySelector('.compare-view') || !!document.querySelector('.compare-view .ask')`)) throw new Error('« Annuler » ne laisse pas la comparaison ouverte');
        if (!(await page.evaluate(`(${side('a')}).includes('version 2} % repris')`))) throw new Error(`le texte repris est perdu : « ${await page.evaluate(side('a'))} »`);
        // Saved and the copy taken out: one action, « Réconcilier « note.tex » ».
        const before = base(`SELECT max(local_seq) AS n FROM changes`)[0].n;
        const save = await page.centre('.compare-view > header button', '^Enregistrer et retirer la copie$');
        await page.click(save.x, save.y);
        if (!(await page.until(`!document.querySelector('.compare-view')`, 10_000))) throw new Error(`la comparaison ne se ferme pas : « ${await page.evaluate(`document.querySelector('.compare-view .viewer-banner')?.textContent ?? ''`)} »`);
        const text = texVersion(2).replace('}\n', '} % repris\n'), hash = createHash('sha256').update(text).digest('hex');
        const lines = () => base(`SELECT label, op FROM changes WHERE local_seq > ${before} ORDER BY local_seq`);
        if (!(await until(() => lines().length === 1 && lines()[0].label === `Réconcilier « ${TEX_NAME} »`, 10_000))) throw new Error(`l’enregistrement n’est pas une seule écriture « Réconcilier » : ${JSON.stringify(lines())}`);
        const files = JSON.parse(lines()[0].op).after.files;
        if (files.some((f) => f.name === copyName) || files.find((f) => f.name === TEX_NAME)?.hash !== hash) throw new Error(`les fichiers du nœud sont ${JSON.stringify(files)}`);
        // The copy's blob stays in B's store; the virtual PC receives the same files.
        if (!existsSync(blobIn(ctx.b.data, copyRef.hash))) throw new Error('le blob de la copie n’est plus dans le magasin de B');
        if (!(await until(() => { const f = pc.s.nodes.get(ctx.node).files; return !f.some((x) => x.name === copyName) && f.find((x) => x.name === TEX_NAME)?.hash === hash; }, 10_000))) {
          throw new Error('le PC virtuel ne reçoit pas la réconciliation');
        }
        if (await page.evaluate(`!!document.querySelector('${copyRow}')`)) throw new Error('le pop-up montre encore la copie');
      },
    },
    {
      // Task 8a (reviews of tasks 5 and 6): the comparison's original, and its copy, changed on another PC while it is open.
      name: '8. une comparaison ouverte dans B pendant que le PC virtuel change l’original : rien de repris, le côté gauche rechargé et dit ; la copie changée, le côté droit aussi ; un bloc repris puis l’original changé de nouveau, le bandeau ; « Enregistrer » garde cette version sous son nom de conflit, dit, la copie restant (plan 5b, D6, D7)',
      async run(ctx) {
        const page = ctx.app.page, pc = ctx.virtual.pc, base = reader(ctx.b.data);
        /** A version of the node's file `name` written by the virtual PC: replaced in its place, or added. */
        const write = (name, text) => {
          const ref = storeBytes(pc.dir, name, Buffer.from(text, 'utf8'));
          pc.act((s) => {
            const files = s.nodes.get(ctx.node).files;
            return editNode(s, ctx.node, { files: files.some((f) => f.name === name) ? files.map((f) => (f.name === name ? ref : f)) : [...files, ref] });
          });
          return ref;
        };
        const copyName = 'note (conflit du 2026-01-01 09h00).tex', copyText = (n) => `\\section{Copie du PC virtuel, version ${n}}\n`;
        const side = (s) => `[...document.querySelectorAll('.compare-view .cm-merge-${s} .cm-line')].map((l) => l.textContent).join('\\n')`;
        const banner = `document.querySelector('.compare-view .viewer-banner')?.textContent ?? ''`;
        // A conflict copy the virtual PC's own save kept (D6 there), compared in B.
        write(copyName, copyText(1));
        const copyRow = `.node-popup .file[data-name="${copyName}"]`;
        if (!(await page.until(`!!document.querySelector('${copyRow} .compare')`, 10_000))) throw new Error('le pop-up de B ne propose pas « Comparer » sur la copie du PC virtuel');
        await page.evaluate(`document.querySelector('${copyRow}').scrollIntoView({ block: 'center' })`);
        const open = await page.centre(`${copyRow} .compare`, 'Comparer');
        await page.click(open.x, open.y);
        if (!(await page.until(`(${side('a')}).includes('version 2} % repris') && (${side('b')}).includes('Copie du PC virtuel, version 1')`, 15_000))) {
          throw new Error(`la comparaison ne montre pas les deux textes : « ${await page.evaluate(`document.querySelector('.compare-view')?.textContent ?? '(pas de plein écran)'`)} »`);
        }
        // Nothing taken: the original's new version replaces the left side, and a notification says so.
        write(TEX_NAME, texVersion(3));
        if (!(await page.until(`(${side('a')}).includes('version 3')`, 15_000))) throw new Error(`le côté gauche ne montre pas la version 3 : « ${await page.evaluate(side('a'))} »`);
        if (!(await toastSays(page, `« ${TEX_NAME} » a été modifié sur un autre PC : sa nouvelle version est chargée.`))) throw new Error(`pas de notification du rechargement : ${await toastsText(page)}`);
        if ((await page.evaluate(banner)) !== '') throw new Error(`le bandeau dit « ${await page.evaluate(banner)} »`);
        // The copy's new version replaces the right side, and is said.
        write(copyName, copyText(2));
        if (!(await page.until(`(${side('b')}).includes('Copie du PC virtuel, version 2')`, 15_000))) throw new Error(`le côté droit ne montre pas la nouvelle copie : « ${await page.evaluate(side('b'))} »`);
        if (!(await toastSays(page, `La copie « ${copyName} » a changé sur un autre PC : sa nouvelle version est montrée.`))) throw new Error(`pas de notification de la copie : ${await toastsText(page)}`);
        // A block taken by its arrow (the notifications over the middle of the window waited out), then the original
        // changed there again: the text taken stays, and the banner says that version will be kept.
        if (!(await page.until(`!document.querySelector('.toast')`, 20_000))) throw new Error(`des notifications couvrent la comparaison : ${await toastsText(page)}`);
        const arrow = await page.centre('.compare-view .cm-merge-revert button', '');
        await page.click(arrow.x, arrow.y);
        if (!(await page.until(`(${side('a')}).includes('Copie du PC virtuel, version 2')`, 5000))) throw new Error(`la flèche ne reprend pas le bloc : « ${await page.evaluate(side('a'))} »`);
        const v4 = write(TEX_NAME, texVersion(4));
        const also = `« ${TEX_NAME} » a aussi été modifié sur un autre PC : à l’enregistrement, cette version-là sera gardée sous « note (conflit du … ).tex ».`;
        if (!(await page.until(`(${banner}).includes(${JSON.stringify(also)})`, 15_000))) throw new Error(`le bandeau dit « ${await page.evaluate(banner)} »`);
        if (!(await page.evaluate(`(${side('a')}).includes('Copie du PC virtuel, version 2') && !(${side('a')}).includes('version 4')`))) throw new Error(`le texte repris n’est plus là : « ${await page.evaluate(side('a'))} »`);
        // « Enregistrer »: the original takes the text, version 4 kept under its conflict name, the copy compared left in the
        // node — one write « Réconcilier « note.tex » »; a notification names the version kept.
        const before = base(`SELECT max(local_seq) AS n FROM changes`)[0].n;
        const save = await page.centre('.compare-view > header button', '^Enregistrer$');
        await page.click(save.x, save.y);
        if (!(await page.until(`!document.querySelector('.compare-view')`, 10_000))) throw new Error(`la comparaison ne se ferme pas : « ${await page.evaluate(banner)} »`);
        const taken = createHash('sha256').update(copyText(2)).digest('hex');
        const kept = (f) => f.name !== copyName && /^note \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex$/.test(f.name) && f.hash === v4.hash;
        const lines = () => base(`SELECT label, op FROM changes WHERE local_seq > ${before} ORDER BY local_seq`);
        if (!(await until(() => lines().length === 1 && lines()[0].label === `Réconcilier « ${TEX_NAME} »`, 10_000))) throw new Error(`l’enregistrement n’est pas une seule écriture « Réconcilier » : ${JSON.stringify(lines())}`);
        const files = JSON.parse(lines()[0].op).after.files;
        if (files.find((f) => f.name === TEX_NAME)?.hash !== taken || !files.some((f) => f.name === copyName) || !files.some(kept)) throw new Error(`les fichiers du nœud sont ${JSON.stringify(files)}`);
        if (!(await toastSays(page, /^« note\.tex » a été modifié sur deux PC : l’autre version est gardée sous « note \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex »\.$/))) {
          throw new Error(`pas de notification de la version gardée : ${await toastsText(page)}`);
        }
        if (!(await until(() => pc.s.nodes.get(ctx.node).files.some(kept), 10_000))) throw new Error('le PC virtuel ne reçoit pas la version gardée');
      },
    },
  ],
};

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
    // Plan 6a, D1 and D2: Ctrl+K opens the search, its field focused; Échap closes it, the focus back to the graph. Opened
    // again, a word typed lists « Motivation », in the article's plan only; Entrée jumps there: its tab opens, the node
    // framed at the view's centre (a click there opens its pop-up), the box closed and the graph focused.
    name: 'recherche : Ctrl+K, une frappe, Entrée saute vers un nœud d’un autre plan',
    async run(page) {
      const FIELD = `document.activeElement?.matches('.search-box .search-field') === true`;
      // The graph takes its keys once its engine is up: Ctrl+K is asked again until the box opens.
      for (let i = 0; i < 10 && !(await page.until(FIELD, 1000)); i++) await page.press('k', 'KeyK', 75, 2);
      if (!(await page.evaluate(FIELD))) throw new Error('Ctrl+K n’ouvre pas la recherche, ou son champ n’a pas le focus');
      await page.press('Escape', 'Escape', 27);
      if (await page.evaluate(`!!document.querySelector('.search-box')`)) throw new Error('Échap ne ferme pas la recherche');
      if (!(await page.evaluate(`document.activeElement?.classList.contains('graph') === true`))) throw new Error('le graphe n’a pas le focus après Échap');
      await page.press('k', 'KeyK', 75, 2);
      if (!(await page.until(FIELD))) throw new Error('Ctrl+K ne rouvre pas la recherche');
      await page.type('motiv');
      const ROWS = `[...document.querySelectorAll('.search-box .search-results li')].map((li) => [li.querySelector('.title').textContent, li.querySelector('.where').textContent])`;
      if (!(await page.until(`JSON.stringify(${ROWS}) === ${JSON.stringify(JSON.stringify([['Motivation', 'Article MDL']]))}`, 10000))) {
        throw new Error(`la recherche montre ${JSON.stringify(await page.evaluate(ROWS))}`);
      }
      await page.press('Enter', 'Enter', 13);
      if (await page.evaluate(`!!document.querySelector('.search-box')`)) throw new Error('Entrée ne ferme pas la recherche');
      if (!(await page.until(`document.querySelector('.tabs .tab.on')?.textContent.includes('Article MDL') === true`))) {
        throw new Error(`l’onglet actif est « ${await page.evaluate(`document.querySelector('.tabs .tab.on')?.textContent ?? ''`)} »`);
      }
      if (!(await page.evaluate(`document.activeElement?.classList.contains('graph') === true`))) throw new Error('le graphe n’a pas le focus après le saut');
      // Framed: the node fills the view's centre.
      const centre = await page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      await openPopup(page, centre, 'Motivation');
    },
  },
  {
    // Fix round 1 of plan 6a's task 1: Ctrl+K from a connection's pop-up, which keeps every key from the graph, opens the
    // search (App hears it first, Important 1); a click on the graph's background closes it, and its ring, as it closes
    // the loose pop-ups (M4).
    name: 'recherche : Ctrl+K depuis le pop-up d’une connexion ; un clic sur le fond la ferme',
    env: { CIRRUS_VIEW: '0,140,1' },
    async run(page) {
      const FIELD = `document.activeElement?.matches('.search-box .search-field') === true`;
      // The connection at the view's centre (the captures' « fenetre-connexion », whose point is the graph's): its pop-up,
      // its title field focused.
      const centre = await page.evaluate(`(() => { const r = document.querySelector('.graph canvas').getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
      for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.popup input.title')`, 1000)); i++) await page.click(centre.x, centre.y);
      const title = await page.centre('.popup input.title', '');
      await page.click(title.x, title.y);
      if (!(await page.evaluate(`document.activeElement?.matches('.popup input.title') === true`))) throw new Error('le titre du pop-up de la connexion n’a pas le focus');
      await page.press('k', 'KeyK', 75, 2);
      if (!(await page.until(FIELD))) throw new Error('Ctrl+K, depuis le pop-up d’une connexion, n’ouvre pas la recherche');
      await page.type('comp');
      if (!(await page.until(`document.querySelectorAll('.search-box .search-results li').length > 0`))) throw new Error('la recherche ne montre rien pour « comp »');
      // The sky at the left, over no node nor envelope (above the hierarchy's corner): the box goes.
      await page.click(60, 800);
      if (!(await page.until(`!document.querySelector('.search-box')`))) throw new Error('un clic sur le fond ne ferme pas la recherche');
    },
  },
  {
    // Plan 6a, D2: « précédent » et « suivant ». A jump by the search pushes the place left (a plan and its camera); Alt+←
    // brings the view back to it exactly (the same image, the plan's tab back), Alt+→ forward again, and so do the mouse's
    // side buttons, which are not left clicks. A plain move of the view is not a jump; the arrows with Alt move nothing.
    name: 'précédent et suivant : un saut par la recherche, Alt+←, Alt+→, les boutons latéraux',
    async run(page) {
      await onTab(page, 'Lobby', 'au départ');
      // The graph has the focus; Alt+← with nothing behind moves nothing — the arrows with Alt no longer pan.
      await page.evaluate(`document.querySelector('.graph').focus()`);
      const start = await viewImage(page);
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await sameView(page, start, 'Alt+← déplace la vue (ou fait autre chose) sans rien derrière');
      // The arrow alone pans: this moved view is the place the jump leaves (a move is not a jump).
      await page.press('ArrowLeft', 'ArrowLeft', 37);
      const moved = await viewImage(page);
      if ((await imageDiff(page, moved, start)) < 1) throw new Error('la flèche seule ne déplace plus la vue');
      await searchJump(page, 'motiv', 'Motivation');
      await onTab(page, 'Article MDL', 'après le saut');
      const jumped = await viewImage(page);
      // Alt+←: the lobby, its camera as it was left.
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await onTab(page, 'Lobby', 'Alt+←');
      await sameView(page, moved, 'Alt+← ne rend pas la vue du lobby telle qu’elle était, ou y fait un cercle');
      // Alt+→: the article's plan, the node framed as the jump left it.
      await page.press('ArrowRight', 'ArrowRight', 39, 1);
      await onTab(page, 'Article MDL', 'Alt+→');
      await sameView(page, jumped, 'Alt+→ ne rend pas la vue du saut');
      // The side buttons, over the node framed at the centre: a left press there would open its pop-up.
      const centre = await graphCentre(page);
      await sideClick(page, centre.x, centre.y, 'back');
      await onTab(page, 'Lobby', 'le bouton latéral « précédent »');
      if (await page.evaluate(`!!document.querySelector('.node-popup')`)) throw new Error('un bouton latéral compte comme un clic gauche (un pop-up s’est ouvert)');
      await sameView(page, moved, 'le bouton « précédent » ne rend pas la vue du lobby');
      await sideClick(page, centre.x, centre.y, 'forward');
      await onTab(page, 'Article MDL', 'le bouton latéral « suivant »');
      await sameView(page, jumped, 'le bouton « suivant » ne rend pas la vue du saut');
      if (await page.evaluate(`!!document.querySelector('.node-popup')`)) throw new Error('un bouton latéral ouvre un pop-up');
      // A jump after a step back clears what was ahead: back, jump, then Alt+→ does nothing.
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await onTab(page, 'Lobby', 'Alt+← (2)');
      await searchJump(page, 'sans perte', 'Compression sans perte');
      const compression = await viewImage(page);
      await page.press('ArrowRight', 'ArrowRight', 39, 1);
      await sameView(page, compression, 'un saut après un retour n’a pas effacé ce qui était devant');
      if ((await activeTab(page)).includes('Article MDL')) throw new Error('un saut après un retour n’a pas effacé ce qui était devant');
    },
  },
  {
    // Plan 6a, D3: « Voir dans un autre plan » in a node's menu, only when it is in another plan. In one other plan (Compression
    // sans perte: the lobby and « Thèse »), it jumps there at once; in two (MDL, seen from « Thèse »: the lobby and « Article
    // MDL »), a question lists them by name, the lobby first. Alt+← then goes back through the jumps, plans and views.
    name: '« Voir dans un autre plan » : un autre plan, saut direct ; deux autres plans, une question ; puis Alt+← et Alt+→',
    async run(page) {
      const menuAt = async (at) => {
        for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(at.x, at.y, 'right');
        return page.evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent)`);
      };
      await onTab(page, 'Lobby', 'au départ');
      // A node of the lobby alone has no such entry: « Monde algorithmique ».
      await searchJump(page, 'monde algo', 'Monde algorithmique');
      let centre = await graphCentre(page);
      let items = await menuAt(centre);
      if (items.includes('Voir dans un autre plan')) throw new Error(`« Voir dans un autre plan » est proposé à un nœud d’un seul plan : ${JSON.stringify(items)}`);
      await page.press('Escape', 'Escape', 27);
      // One other plan: a jump at once, no question.
      await searchJump(page, 'sans perte', 'Compression sans perte');
      centre = await graphCentre(page);
      items = await menuAt(centre);
      if (items.at(-1) !== 'Voir dans un autre plan') throw new Error(`pas de « Voir dans un autre plan » en dernier : ${JSON.stringify(items)}`);
      const see = await page.centre('.context-menu button', '^Voir dans un autre plan$');
      await page.click(see.x, see.y);
      await onTab(page, 'Thèse', 'un seul autre plan');
      if (await page.evaluate(`!!document.querySelector('.ask')`)) throw new Error('une question pour un seul autre plan');
      // Two other plans: the question lists them by name, the lobby first, then the plans without a tab by name.
      await searchJump(page, 'minimum desc', 'Minimum Description Length Principle (MDL)');
      centre = await graphCentre(page);
      await menuAt(centre);
      const see2 = await page.centre('.context-menu button', '^Voir dans un autre plan$');
      await page.click(see2.x, see2.y);
      if (!(await page.until(`!!document.querySelector('.ask')`))) throw new Error('pas de question pour deux autres plans');
      const choices = await page.evaluate(`[...document.querySelectorAll('.ask .choices button')].map((b) => b.textContent)`);
      if (JSON.stringify(choices) !== JSON.stringify(['Lobby', 'Article MDL', 'Annuler'])) throw new Error(`la question montre ${JSON.stringify(choices)}`);
      const article = await page.centre('.ask .choices button', '^Article MDL$');
      await page.click(article.x, article.y);
      await onTab(page, 'Article MDL', 'deux autres plans');
      if (await page.evaluate(`!!document.querySelector('.ask')`)) throw new Error('la question reste ouverte');
      // Back through the jumps: « Thèse » (the view the search framed, then the one before it), then the lobby.
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await onTab(page, 'Thèse', 'Alt+← (1)');
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await onTab(page, 'Thèse', 'Alt+← (2)');
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await onTab(page, 'Lobby', 'Alt+← (3)');
      for (let i = 0; i < 2; i++) await page.press('ArrowRight', 'ArrowRight', 39, 1);
      await onTab(page, 'Thèse', 'Alt+→ ×2');
      await page.press('ArrowRight', 'ArrowRight', 39, 1);
      await onTab(page, 'Article MDL', 'Alt+→ ×3');
    },
  },
  {
    // Plan 6a, D6 and Review Focus 5: the consultations are written as they happen, by batches every consultationsFlushMs
    // (10 s) and at closing. A plan shown, a search, a jump, a pop-up: in consultations.db after one interval, with this
    // PC's identifier; what is done just before the window closes (Alt+←) is in it too, with the app's closing.
    name: 'consultations : un plan, une recherche, un saut, un pop-up, puis la fermeture ; tout est dans consultations.db',
    async run(page, base, data, app) {
      await onTab(page, 'Lobby', 'au départ');
      await searchJump(page, 'motiv', 'Motivation');
      await onTab(page, 'Article MDL', 'après le saut');
      await openPopup(page, await graphCentre(page), 'Motivation');
      // After one interval, with no closing: the batches go by themselves.
      if (!(await until(() => consultationsOf(data)?.some((r) => r.kind === 'node_popup'), 30_000))) {
        throw new Error(`les consultations ne sont pas écrites toutes les 10 s : ${JSON.stringify(consultationsOf(data)?.map((r) => r.kind) ?? null)}`);
      }
      // And what comes after that, by the closing alone: back to the lobby, then the window closed.
      await page.press('Escape', 'Escape', 27);
      await page.evaluate(`document.querySelector('.graph').focus()`);
      await page.press('ArrowLeft', 'ArrowLeft', 37, 1);
      await onTab(page, 'Lobby', 'Alt+←');
      if (!(await closeAsUser(app))) throw new Error('la fenêtre ne se ferme pas d’elle-même');
      const rows = consultationsOf(data);
      if (!rows) throw new Error('pas de consultations.db après la fermeture');
      const seen = looked(rows);
      const motivation = base(`SELECT id FROM nodes WHERE json_extract(json, '$.title') = 'Motivation'`)[0].id;
      const plan = (name) => base(`SELECT id FROM plans WHERE json_extract(json, '$.name') = '${name}'`)[0].id;
      const lobby = base(`SELECT id FROM plans WHERE json_extract(json, '$.type') = 'lobby'`)[0].id, article = plan('Article MDL');
      const pc = JSON.parse(readFileSync(join(data, 'pc.json'), 'utf8')).id;
      if (rows.some((r) => r.pc !== pc)) throw new Error(`une ligne ne porte pas l’identifiant de ce PC : ${JSON.stringify([...new Set(rows.map((r) => r.pc))])}`);
      // In order (the jump is told as it is made, the plan when it is drawn).
      const wanted = [
        ['app_open', null, null, null], ['plan_shown', null, lobby, null], ['search', motivation, lobby, 'motiv'], ['jump', motivation, article, null],
        ['plan_shown', null, article, null], ['node_popup', motivation, article, null], ['jump', null, lobby, 'back'], ['plan_shown', null, lobby, null],
        ['app_close', null, lobby, null],
      ];
      const got = seen.map((r) => [r.kind, r.subject, r.plan, r.detail]);
      if (JSON.stringify(got) !== JSON.stringify(wanted)) throw new Error(`les consultations sont ${JSON.stringify(got)}, pas ${JSON.stringify(wanted)}`);
      if (seen.some((r, i) => i > 0 && r.at < seen[i - 1].at)) throw new Error('les consultations ne sont pas dans l’ordre du temps');
    },
  },
  {
    // Plan 6a, D6: the switch « Enregistrer mes consultations » at 0: nothing is queued, nothing is written, not even the file.
    name: 'consultations : l’interrupteur éteint, rien n’est écrit, pas même le fichier',
    settings: { consultationsRecord: 0, consultationsFlushMs: 1000 },
    async run(page, base, data, app) {
      await searchJump(page, 'motiv', 'Motivation');
      await onTab(page, 'Article MDL', 'après le saut');
      await openPopup(page, await graphCentre(page), 'Motivation');
      await sleep(3500);
      if (consultationsOf(data)) throw new Error('un fichier de consultations existe, interrupteur éteint');
      if (!(await closeAsUser(app))) throw new Error('la fenêtre ne se ferme pas d’elle-même');
      if (consultationsOf(data)) throw new Error('un fichier de consultations existe après la fermeture, interrupteur éteint');
    },
  },
  {
    // Plan 6a, Review Focus 5: a consultations.db that cannot be written (here, damaged): nothing visible, the app goes on,
    // and closing is not held up. The interval is the longest, so that the batch goes at closing.
    name: 'consultations : un fichier abîmé, rien de visible, et la fermeture n’attend pas',
    settings: { consultationsFlushMs: 600_000 },
    async run(page, base, data, app) {
      const damaged = 'ceci n’est pas une base de données SQLite '.repeat(60);
      writeFileSync(join(data, 'consultations.db'), damaged, 'utf8');
      await searchJump(page, 'motiv', 'Motivation');
      await onTab(page, 'Article MDL', 'après le saut');
      await openPopup(page, await graphCentre(page), 'Motivation');
      // The notice of LaTeX, absent from the test machine, may be there: it is not about the file.
      const toasts = await toastsText(page);
      if (/consultation|enregistr|fichier|base de donn/i.test(toasts)) throw new Error(`une notification parle du fichier des consultations : ${toasts}`);
      const t0 = Date.now();
      if (!(await closeAsUser(app))) throw new Error('la fenêtre ne se ferme pas d’elle-même, un fichier abîmé');
      if (Date.now() - t0 > 10_000) throw new Error(`la fermeture a pris ${Date.now() - t0} ms`);
      if (readFileSync(join(data, 'consultations.db'), 'utf8') !== damaged) throw new Error('le fichier abîmé a été changé');
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
    // Final review of plan 4c, I1: an annotation opened from the pop-up shows once. Its preview, left for its full
    // screen and back (⤢, another page, Escape), stays where the full screen leaves it, nothing blinking again. On the
    // way, the pop-up's line has its menu (I2), which Escape closes alone.
    name: '(revue finale, I1) ouvrir une annotation depuis le pop-up, ⤢, changer de page, Échap : l’aperçu garde la page du plein écran, sans rejouer l’annotation',
    env: PUBLICATION.env, settings: { popupHeightPx: 720 },
    async run(page) {
      const row = await popupRow(page, 2);
      await page.click(row.x, row.y, 'right');
      if (!(await page.until(`!!document.querySelector('.node-popup .context-menu')`))) throw new Error('le clic droit n’ouvre pas le menu de la ligne du pop-up');
      const items = await page.evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent)`);
      if (JSON.stringify(items) !== '["Ouvrir sa fiche","Supprimer"]') throw new Error(`menu du pop-up : ${JSON.stringify(items)}`);
      await page.press('Escape', 'Escape', 27);
      if (!(await page.until(`!document.querySelector('.context-menu') && !!document.querySelector('.node-popup')`))) throw new Error('Échap ne ferme pas le menu seul');
      await page.click(row.x, row.y);
      const preview = (what) => page.evaluate(`document.querySelector('.file-preview .pdf-tools .page input')?.value === '${what}'`);
      if (!(await page.until(`!!document.querySelector('.file-preview .pdf-page[data-page="2"] .annotation-layer .flash') && document.querySelector('.file-preview .pdf-tools .page input')?.value === '2'`, 15000))) {
        throw new Error('l’annotation ne s’ouvre pas dans l’aperçu, à sa page, le passage clignotant');
      }
      const expand = await page.centre('.file-preview .expand', '');
      await page.click(expand.x, expand.y);
      if (!(await page.until(`!!document.querySelector('.full-screen .pdf-page .textLayer span')`, 15000))) throw new Error('le plein écran ne montre pas le chapitre');
      // Page 1, typed in its field; Escape lets the field go, the next one leaves the full screen.
      const field = await page.centre('.full-screen .pdf-tools .page input', '');
      await page.click(field.x, field.y);
      await page.type('1');
      await page.press('Enter', 'Enter', 13);
      if (!(await page.until(`document.querySelector('.full-screen .pdf-tools .page input')?.value === '1'`))) throw new Error('le plein écran ne va pas à la page 1');
      for (let i = 0; i < 3 && (await page.evaluate(`!!document.querySelector('.full-screen')`)); i++) {
        await page.press('Escape', 'Escape', 27);
        await sleep(300);
      }
      if (await page.evaluate(`!!document.querySelector('.full-screen')`)) throw new Error('Échap ne ferme pas le plein écran');
      if (!(await page.until(`!!document.querySelector('.file-preview .pdf-page[data-page="1"] .textLayer span')`, 15000))) throw new Error('l’aperçu ne revient pas, à la page 1');
      // Two seconds: still page 1, nothing blinking.
      for (const end = Date.now() + 2000; Date.now() < end; await sleep(100)) {
        const flash = await page.evaluate(`!!document.querySelector('.file-preview .annotation-layer .flash')`);
        if (!(await preview('1')) || flash) {
          const now = await page.evaluate(`document.querySelector('.file-preview .pdf-tools .page input')?.value`);
          throw new Error(`l’aperçu revient à la page ${now}${flash ? ', le passage clignotant' : ''}, et non à la page 1 que le plein écran a laissée`);
        }
      }
    },
  },
  {
    // Final review of plan 4c, I2: an annotation in no plan, deleted from the reader's margin by its line's menu (a
    // real right click): its highlight and its line go; Ctrl+Z gives them back. « Ouvrir sa fiche » opens its pop-up.
    name: '(revue finale, I2) supprimer une annotation hors plan par le menu de sa ligne dans la marge : son surlignage disparaît ; Ctrl+Z la rend',
    ...PUBLICATION,
    async run(page, base) {
      const { page2 } = idsOf(base);
      const trashed = () => base(`SELECT trashed FROM nodes WHERE id = '${page2}'`)[0].trashed;
      await openChapter(page);
      // Page 2 in view, by its field: its highlight drawn.
      const field = await page.centre('.file-preview .pdf-tools .page input', '');
      await page.click(field.x, field.y);
      await page.type('2');
      await page.press('Enter', 'Enter', 13);
      const marks = '.file-preview .pdf-page[data-page="2"] .annotation-layer .mark';
      if (!(await page.until(`document.querySelectorAll('${marks}').length > 0`, 10000))) throw new Error('le surlignage de la page 2 n’est pas dessiné');
      const drawn = await page.evaluate(`document.querySelectorAll('${marks}').length`);
      const menuOf = async () => {
        const row = await page.centre('.file-preview .annotation-margin li', 'p\\. 2');
        await page.click(row.x, row.y, 'right');
        if (!(await page.until(`!!document.querySelector('.file-preview .context-menu')`))) throw new Error('le clic droit n’ouvre pas le menu de la ligne');
        return page.evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent)`);
      };
      const items = await menuOf();
      if (JSON.stringify(items) !== '["Ouvrir sa fiche","Supprimer"]') throw new Error(`menu de la marge : ${JSON.stringify(items)}`);
      // « Ouvrir sa fiche »: the annotation's pop-up, beside the preview; Escape closes it.
      const card = await page.centre('.context-menu button', '^Ouvrir sa fiche$');
      await page.click(card.x, card.y);
      const line = `Annotation de « ${LI} », p. 2`;
      if (!(await page.until(`document.querySelector('.node-popup .annotation-of button')?.textContent === ${JSON.stringify(line)}`))) throw new Error('« Ouvrir sa fiche » n’ouvre pas le pop-up de l’annotation');
      await page.press('Escape', 'Escape', 27);
      if (!(await page.until(`!document.querySelector('.node-popup .annotation-of') && !!document.querySelector('.file-preview')`))) throw new Error('Échap ne ferme pas le pop-up de l’annotation seul');
      await menuOf();
      const remove = await page.centre('.context-menu button', '^Supprimer$');
      await page.click(remove.x, remove.y);
      if (!(await until(() => trashed() === 1))) throw new Error('l’annotation n’est pas à la corbeille');
      if (!(await page.until(`document.querySelectorAll('${marks}').length === 0 && ![...document.querySelectorAll('.file-preview .annotation-margin li')].some((li) => /p\\. 2/.test(li.textContent))`))) {
        throw new Error('son surlignage ou sa ligne reste');
      }
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => trashed() === 0))) throw new Error('Ctrl+Z ne rend pas l’annotation');
      if (!(await page.until(`document.querySelectorAll('${marks}').length === ${drawn} && [...document.querySelectorAll('.file-preview .annotation-margin li')].some((li) => /p\\. 2/.test(li.textContent))`))) {
        throw new Error('Ctrl+Z ne rend pas son surlignage et sa ligne');
      }
    },
  },
  {
    // I2 in full screen, modal: the line's menu offers « Supprimer » only; that step is the full screen's own, which
    // its Ctrl+Z undoes and its Ctrl+Y redoes.
    name: '(revue finale, I2) en plein écran, le menu d’une ligne d’annotation n’offre que « Supprimer » ; Ctrl+Z et Ctrl+Y défont et refont ce pas',
    ...PUBLICATION,
    async run(page, base) {
      const { page2 } = idsOf(base);
      const trashed = () => base(`SELECT trashed FROM nodes WHERE id = '${page2}'`)[0].trashed;
      await openChapter(page);
      const expand = await page.centre('.file-preview .expand', '');
      await page.click(expand.x, expand.y);
      if (!(await page.until(`document.querySelectorAll('.full-screen .annotation-margin li').length === 3`, 15000))) throw new Error('le plein écran ne montre pas la marge');
      const row = await page.centre('.full-screen .annotation-margin li', 'p\\. 2');
      await page.click(row.x, row.y, 'right');
      if (!(await page.until(`!!document.querySelector('.full-screen .context-menu')`))) throw new Error('le clic droit n’ouvre pas le menu en plein écran');
      const items = await page.evaluate(`[...document.querySelectorAll('.context-menu button')].map((b) => b.textContent)`);
      if (JSON.stringify(items) !== '["Supprimer"]') throw new Error(`menu du plein écran : ${JSON.stringify(items)}`);
      const remove = await page.centre('.full-screen .context-menu button', '^Supprimer$');
      await page.click(remove.x, remove.y);
      if (!(await until(() => trashed() === 1))) throw new Error('l’annotation n’est pas à la corbeille');
      if (!(await page.until(`document.querySelectorAll('.full-screen .annotation-margin li').length === 2`))) throw new Error('sa ligne reste dans la marge');
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => trashed() === 0))) throw new Error('Ctrl+Z en plein écran ne rend pas l’annotation supprimée');
      await page.press('y', 'KeyY', 89, 2);
      if (!(await until(() => trashed() === 1))) throw new Error('Ctrl+Y en plein écran ne la supprime pas de nouveau');
      if (!(await page.evaluate(`!!document.querySelector('.full-screen')`))) throw new Error('le plein écran s’est fermé');
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
      // Plan 5b, D4: a publisher's address, its DOI read without asking the publisher.
      const wiley = await ask(JSON.stringify('https://onlinelibrary.wiley.com/doi/full/10.1002/j.1538-7305.1948.tb01338.x'));
      if (!wiley?.ok || wiley.id?.doi !== '10.1002/j.1538-7305.1948.tb01338.x') throw new Error(`l’adresse de Wiley ne donne pas son DOI : ${JSON.stringify(wiley).slice(0, 200)}`);
      // D3: the open web, replayed as well (editeur.example and interne.example exist on no network): a page, its DOI's
      // metadata and its PDF; a PDF without identifier; the guards.
      const opened = await ask(JSON.stringify('https://editeur.example/articles/shannon-1948'));
      const shannon = readFileSync(join(appDir, 'tests', 'data', 'publications', 'editeur-shannon-1948.pdf'));
      if (!opened?.ok || opened.id?.doi !== '10.1002/j.1538-7305.1948.tb01338.x' || opened.pdf?.name !== 'shannon-1948.pdf' || opened.pdf.size !== shannon.length) {
        throw new Error(`la page de l’éditeur n’est pas importée avec son PDF : ${JSON.stringify(opened).slice(0, 300)}`);
      }
      const note = await ask(JSON.stringify('https://editeur.example/papiers/note.pdf'));
      if (note?.ok !== true || note.kind !== 'pdf' || note.pdf?.name !== 'note.pdf') throw new Error(`le PDF sans identifiant n’est pas rendu comme tel : ${JSON.stringify(note)}`);
      for (const ref of [opened.pdf, note.pdf]) {
        if (!existsSync(join(data, 'files', ref.hash.slice(0, 2), ref.hash))) throw new Error(`${ref.name} n’est pas au magasin de la base de test`);
      }
      const local = 'Adresse refusée : elle mène à une machine du réseau local.';
      for (const [text, message] of [
        ['http://editeur.example/papiers/note.pdf', 'Seules les adresses https sont acceptées.'], ['https://interne.example/a.pdf', local], ['https://127.0.0.1/', local],
        ['https://2130706433/', local], ['https://editeur.example/interne', local],
      ]) {
        const x = await ask(JSON.stringify(text));
        if (x?.ok !== false || x.message !== message) throw new Error(`« ${text} » : ${JSON.stringify(x)} au lieu de « ${message} »`);
      }
      if (nodes() !== before) throw new Error('l’import a créé des nœuds');
    },
  },
  {
    // D5 to D7: an arXiv identifier typed, Entrée; the node put down where the menu was opened, its tags, its PDF
    // (downloaded: replayed) and its .bib — DataCite's key, an address, set aside for vaswani2017 —, the dialog closed;
    // one Ctrl+Z removes it.
    name: 'importer une publication par arXiv, avec son PDF ; Ctrl+Z',
    ...IMPORT,
    async run(page, base, data) {
      const at = await worldAt(page, SKY);
      await openImport(page);
      await page.type('arXiv:1706.03762');
      await page.press('Enter', 'Enter', 13);
      if (!(await until(() => titledIn(base, ATTENTION).length === 1, 8000))) throw new Error(`le nœud n’est pas dans la base (le dialogue dit « ${await statusOf(page)} »)`);
      const n = titledIn(base, ATTENTION)[0];
      const authors = ['Ashish Vaswani', 'Noam Shazeer', 'Niki Parmar', 'Jakob Uszkoreit', 'Llion Jones', 'Aidan N. Gomez', 'Lukasz Kaiser', 'Illia Polosukhin'];
      const tags = [...authors.map((a) => `auteur: ${a}`), 'date_de_publication: 2017', 'clé_bibtex: vaswani2017', 'arxiv: 1706.03762'];
      if (JSON.stringify(tagsOf(n)) !== JSON.stringify(tags)) throw new Error(`tags inattendus : ${JSON.stringify(tagsOf(n))}`);
      if (JSON.stringify(n.files.map((f) => f.name)) !== '["1706.03762.pdf","vaswani2017.bib"]') throw new Error(`fichiers inattendus : ${JSON.stringify(n.files)}`);
      const pdf = readFileSync(join(appDir, 'tests', 'data', 'publications', 'arxiv-1706.03762.pdf'));
      if (!blob(data, n.files[0].hash).equals(pdf)) throw new Error('le PDF du nœud n’est pas celui d’arXiv (rejoué)');
      const bib = blob(data, n.files[1].hash).toString('utf8');
      if (!bib.startsWith('@misc{vaswani2017,\n') || !bib.includes('title = {Attention Is All You Need}')) throw new Error(`.bib inattendu : ${bib.slice(0, 120)}`);
      const p = placementOf(base, idsOf(base).lobby, n.id);
      if (!p || Math.abs(p.x - at.x) > 1 || Math.abs(p.y - at.y) > 1) throw new Error(`le nœud n’est pas posé où le menu s’est ouvert : ${JSON.stringify(p)} au lieu de ${JSON.stringify(at)}`);
      if (await dialogOpen(page)) throw new Error('le dialogue reste ouvert après l’import');
      console.log(`     ${n.files.map((f) => `${f.name} (${f.size} o)`).join(', ')} ; posé en ${p.x.toFixed(1)}, ${p.y.toFixed(1)}, cran ${p.k}`);
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => titledIn(base, ATTENTION).length === 0))) throw new Error('un Ctrl+Z ne retire pas toute l’importation');
    },
  },
  {
    // D5, D7: a DOI of Crossref (replayed: composed on Crossref's model), « Importer » clicked; Crossref's key kept, its
    // month a macro in the .bib.
    name: 'importer une publication par DOI',
    ...IMPORT,
    async run(page, base, data) {
      await openImport(page);
      await page.type('10.1002/j.1538-7305.1948.tb01338.x');
      const button = await page.centre('.publication-dialog button.import', 'Importer');
      await page.click(button.x, button.y);
      const title = 'A Mathematical Theory of Communication';
      if (!(await until(() => titledIn(base, title).length === 1, 8000))) throw new Error(`le nœud n’est pas dans la base (le dialogue dit « ${await statusOf(page)} »)`);
      const n = titledIn(base, title)[0];
      const tags = ['auteur: C. E. Shannon', 'date_de_publication: 1948', 'clé_bibtex: Shannon_1948', 'doi: 10.1002/j.1538-7305.1948.tb01338.x'];
      if (JSON.stringify(tagsOf(n)) !== JSON.stringify(tags)) throw new Error(`tags inattendus : ${JSON.stringify(tagsOf(n))}`);
      if (JSON.stringify(n.files.map((f) => f.name)) !== '["Shannon_1948.bib"]') throw new Error(`fichiers inattendus : ${JSON.stringify(n.files)}`);
      const bib = blob(data, n.files[0].hash).toString('utf8');
      if (!bib.startsWith('@article{Shannon_1948,\n') || !bib.includes('  month = jul,\n')) throw new Error(`.bib inattendu : ${bib}`);
    },
  },
  {
    // D8: a PDF dropped on the dialog (a real drag of a file of the disk) enters the store; its arXiv identifier, found
    // in its text, fills the field; « Importer » keeps it (arXiv's not downloaded). Then a PDF without an identifier:
    // « Créer le nœud », its file's name as title, the PDF attached.
    name: 'importer une publication par un PDF déposé, puis un PDF sans identifiant',
    ...IMPORT,
    async run(page, base, data) {
      const dir = mkdtempSync(join(tmpdir(), 'cirrus-depot-'));
      try {
        const dropped = join(dir, 'attention.pdf'), plain = join(dir, 'Li_Vitányi_extrait.pdf');
        copyFileSync(join(appDir, 'tests', 'data', 'publications', 'arxiv-1706.03762.pdf'), dropped);
        copyFileSync(join(appDir, '..', 'fixtures', 'assets', 'Li_Vitányi_extrait.pdf'), plain);
        await openImport(page);
        const zone = await page.centre('.publication-dialog .status', '');
        await page.dropFiles(zone, [dropped]);
        if (!(await page.until(`document.querySelector('.publication-dialog input')?.value === 'arXiv:1706.03762'`, 8000))) {
          throw new Error(`l’identifiant n’est pas trouvé dans le PDF déposé (le dialogue dit « ${await statusOf(page)} »)`);
        }
        console.log(`     ${await statusOf(page)}`);
        if (titledIn(base, ATTENTION).length !== 0) throw new Error('le dépôt a importé sans « Importer »');
        const button = await page.centre('.publication-dialog button.import', 'Importer');
        await page.click(button.x, button.y);
        if (!(await until(() => titledIn(base, ATTENTION).length === 1, 8000))) throw new Error(`le nœud n’est pas dans la base (le dialogue dit « ${await statusOf(page)} »)`);
        const n = titledIn(base, ATTENTION)[0];
        if (JSON.stringify(n.files.map((f) => f.name)) !== '["attention.pdf","vaswani2017.bib"]') throw new Error(`le nœud ne garde pas le PDF déposé : ${JSON.stringify(n.files)}`);
        if (!blob(data, n.files[0].hash).equals(readFileSync(dropped))) throw new Error('le PDF déposé n’est pas au magasin');
        await openImport(page, SKY2);
        await page.dropFiles(await page.centre('.publication-dialog .status', ''), [plain]);
        if (!(await page.until(`!!document.querySelector('.publication-dialog button.create')`, 8000))) throw new Error(`« Créer le nœud » n’est pas proposé (le dialogue dit « ${await statusOf(page)} »)`);
        console.log(`     ${await statusOf(page)}`);
        const create = await page.centre('.publication-dialog button.create', 'Créer le nœud');
        await page.click(create.x, create.y);
        if (!(await until(() => titledIn(base, 'Li_Vitányi_extrait').length === 1))) throw new Error('le nœud du PDF sans identifiant n’est pas dans la base');
        const m = titledIn(base, 'Li_Vitányi_extrait')[0];
        if (m.tags.length !== 0 || JSON.stringify(m.files.map((f) => f.name)) !== '["Li_Vitányi_extrait.pdf"]') throw new Error(`nœud inattendu : ${JSON.stringify(m)}`);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  },
  {
    // Review Focus 5: hors ligne (a request nothing recorded answers, as without a network), then an identifier not
    // recognised — said in French in the dialog, which stays open and blocks nothing (a node's pop-up opens meanwhile);
    // nothing is created; « Fermer ».
    name: 'importer une publication hors ligne : dit en français, rien n’est créé, rien n’est bloqué',
    ...IMPORT,
    async run(page, base) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n;
      const before = count();
      await openImport(page);
      await page.type('10.1234/jamais-enregistre');
      await page.press('Enter', 'Enter', 13);
      if (!(await page.until(`document.querySelector('.publication-dialog .status')?.textContent === 'Pas de connexion.'`, 8000))) throw new Error(`le dialogue dit « ${await statusOf(page)} »`);
      await page.click(792, 461);
      if (!(await page.until(`!!document.querySelector('.node-popup') && !!document.querySelector('.publication-dialog')`))) throw new Error('le graphe ne répond pas pendant que le dialogue est ouvert');
      const input = await page.centre('.publication-dialog input', '');
      await page.click(input.x, input.y);
      await page.press('a', 'KeyA', 65, 2);
      await page.type('bonjour');
      await page.press('Enter', 'Enter', 13);
      if (!(await page.until(`document.querySelector('.publication-dialog .status')?.textContent === 'Identifiant non reconnu.'`))) throw new Error(`le dialogue dit « ${await statusOf(page)} »`);
      const close = await page.centre('.publication-dialog button.cancel', 'Fermer');
      await page.click(close.x, close.y);
      if (await dialogOpen(page)) throw new Error('« Fermer » ne ferme pas le dialogue');
      if (count() !== before) throw new Error('un import refusé a créé un nœud');
    },
  },
  {
    // D7 and the controller's ruling: the test base's book again by its DOI — no `doi` tag there, another key — is a
    // duplicate by its title and year, notified naming the node; arXiv's article imported twice, the second refused
    // before the network, by its identifier.
    name: 'importer une publication en double : refusé, le nœud existant nommé',
    ...IMPORT,
    async run(page, base) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n;
      const before = count();
      await openImport(page);
      await page.type('https://doi.org/10.1007/978-0-387-49820-1');
      await page.press('Enter', 'Enter', 13);
      if (!(await said(page, `Déjà dans la base (même titre et même année) : « ${LI} ».`))) throw new Error(`pas de notification du doublon (le dialogue dit « ${await statusOf(page)} »)`);
      if (await dialogOpen(page) || count() !== before) throw new Error('le doublon a créé un nœud, ou le dialogue reste ouvert');
      await openImport(page);
      await page.type('arXiv:1706.03762');
      await page.press('Enter', 'Enter', 13);
      if (!(await until(() => titledIn(base, ATTENTION).length === 1, 8000))) throw new Error('le premier import d’arXiv ne s’est pas fait');
      await openImport(page, SKY2);
      await page.type('https://arxiv.org/abs/1706.03762v7');
      await page.press('Enter', 'Enter', 13);
      if (!(await said(page, `Déjà dans la base (même identifiant arXiv) : « ${ATTENTION} ».`))) throw new Error(`pas de notification du second import (le dialogue dit « ${await statusOf(page)} »)`);
      if (titledIn(base, ATTENTION).length !== 1) throw new Error('le second import a créé un nœud');
    },
  },
  {
    // Plan 5b, task 4 (D5): one PDF let go on the sky opens the import dialog at the drop point, with it, as if it had been
    // dropped on the dialog — its arXiv identifier found, « Importer » puts the node down where the PDF was let go; a PDF
    // without identifier, « Créer le nœud ». Nothing is made before. Two PDFs, or a PDF with a .bib: a notice, no dialog.
    name: 'importer une publication : un PDF lâché sur le fond ouvre le dialogue au point du dépôt, avec ce PDF ; plusieurs fichiers, une notification',
    ...IMPORT,
    async run(page, base, data) {
      const dir = mkdtempSync(join(tmpdir(), 'cirrus-depot-'));
      try {
        const attention = join(dir, 'attention.pdf'), plain = join(dir, 'Li_Vitányi_extrait.pdf'), other = join(dir, 'autre.pdf');
        copyFileSync(join(appDir, 'tests', 'data', 'publications', 'arxiv-1706.03762.pdf'), attention);
        copyFileSync(join(appDir, '..', 'fixtures', 'assets', 'Li_Vitányi_extrait.pdf'), plain);
        copyFileSync(plain, other);
        const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count();
        // Several files: the notice names the two cases allowed, and no dialog opens.
        await page.dropFiles(SKY, [attention, other]);
        if (!(await said(page, 'Dépose un seul .bib ou un seul PDF sur le fond, ou un fichier sur un nœud pour l’y ajouter.'))) throw new Error(`pas de notification (${await toastsText(page)})`);
        await page.dropFiles(SKY, [attention, BIB]);
        if (!(await said(page, 'Dépose un seul fichier .bib ou un seul PDF à la fois sur le fond du graphe pour l’importer ; un autre fichier se dépose sur un nœud.'))) throw new Error(`pas de notification (${await toastsText(page)})`);
        if (await dialogOpen(page) || count() !== before) throw new Error('un dépôt de plusieurs fichiers a ouvert le dialogue ou créé un nœud');
        // One PDF with an identifier: the dialog opens at once with it, the field filled, nothing made.
        const at = await worldAt(page, SKY);
        await page.dropFiles(SKY, [attention]);
        if (!(await page.until(`document.querySelector('.publication-dialog input')?.value === 'arXiv:1706.03762'`, 8000))) {
          throw new Error(`le dialogue n’a pas lu le PDF lâché sur le fond (il dit « ${await statusOf(page)} »)`);
        }
        console.log(`     ${await statusOf(page)}`);
        if (titledIn(base, ATTENTION).length !== 0) throw new Error('le dépôt a importé sans « Importer »');
        const button = await page.centre('.publication-dialog button.import', 'Importer');
        await page.click(button.x, button.y);
        if (!(await until(() => titledIn(base, ATTENTION).length === 1, 8000))) throw new Error(`le nœud n’est pas dans la base (le dialogue dit « ${await statusOf(page)} »)`);
        const n = titledIn(base, ATTENTION)[0];
        if (JSON.stringify(n.files.map((f) => f.name)) !== '["attention.pdf","vaswani2017.bib"]') throw new Error(`le nœud ne garde pas le PDF lâché : ${JSON.stringify(n.files)}`);
        if (!blob(data, n.files[0].hash).equals(readFileSync(attention))) throw new Error('le PDF lâché n’est pas au magasin');
        const p = placementOf(base, idsOf(base).lobby, n.id);
        if (!p || Math.abs(p.x - at.x) > 1 || Math.abs(p.y - at.y) > 1) throw new Error(`le nœud n’est pas posé au point du dépôt : ${JSON.stringify(p)} au lieu de ${JSON.stringify(at)}`);
        console.log(`     posé en ${p.x.toFixed(1)}, ${p.y.toFixed(1)}`);
        // One PDF without identifier, let go elsewhere: « Créer le nœud », its title from its file's name.
        const at2 = await worldAt(page, SKY2);
        await page.dropFiles(SKY2, [plain]);
        if (!(await page.until(`!!document.querySelector('.publication-dialog button.create')`, 8000))) throw new Error(`« Créer le nœud » n’est pas proposé (le dialogue dit « ${await statusOf(page)} »)`);
        const create = await page.centre('.publication-dialog button.create', 'Créer le nœud');
        await page.click(create.x, create.y);
        if (!(await until(() => titledIn(base, 'Li_Vitányi_extrait').length === 1))) throw new Error('le nœud du PDF sans identifiant n’est pas dans la base');
        const m = titledIn(base, 'Li_Vitányi_extrait')[0], q = placementOf(base, idsOf(base).lobby, m.id);
        if (!q || Math.abs(q.x - at2.x) > 1 || Math.abs(q.y - at2.y) > 1) throw new Error(`le nœud n’est pas posé au point du dépôt : ${JSON.stringify(q)} au lieu de ${JSON.stringify(at2)}`);
        if (await dialogOpen(page)) throw new Error('le dialogue reste ouvert après « Créer le nœud »');
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  },
  {
    // Plan 5b, task 4 (D5): « Choisir un PDF… » takes the PDF the test names (CIRRUS_PDF_PICK, never the system's dialog)
    // as a PDF dropped on the dialog: stored, read, its identifier found; « Importer » keeps it.
    name: 'importer une publication : « Choisir un PDF… » (entrée de test, sans sélecteur) lit le PDF comme un PDF déposé',
    env: { ...IMPORT.env, CIRRUS_PDF_PICK: ARXIV_PDF },
    async run(page, base, data) {
      const at = await worldAt(page, SKY);
      await openImport(page);
      const pick = await page.centre('.publication-dialog button.pick', 'Choisir un PDF');
      await page.click(pick.x, pick.y);
      if (!(await page.until(`document.querySelector('.publication-dialog input')?.value === 'arXiv:1706.03762'`, 8000))) {
        throw new Error(`l’identifiant n’est pas trouvé dans le PDF choisi (le dialogue dit « ${await statusOf(page)} »)`);
      }
      if (titledIn(base, ATTENTION).length !== 0) throw new Error('le choix a importé sans « Importer »');
      const button = await page.centre('.publication-dialog button.import', 'Importer');
      await page.click(button.x, button.y);
      if (!(await until(() => titledIn(base, ATTENTION).length === 1, 8000))) throw new Error(`le nœud n’est pas dans la base (le dialogue dit « ${await statusOf(page)} »)`);
      const n = titledIn(base, ATTENTION)[0];
      if (JSON.stringify(n.files.map((f) => f.name)) !== '["arxiv-1706.03762.pdf","vaswani2017.bib"]') throw new Error(`le nœud ne garde pas le PDF choisi : ${JSON.stringify(n.files)}`);
      if (!blob(data, n.files[0].hash).equals(readFileSync(ARXIV_PDF))) throw new Error('le PDF choisi n’est pas au magasin');
      const p = placementOf(base, idsOf(base).lobby, n.id);
      if (!p || Math.abs(p.x - at.x) > 1 || Math.abs(p.y - at.y) > 1) throw new Error(`le nœud n’est pas posé où le menu s’est ouvert : ${JSON.stringify(p)} au lieu de ${JSON.stringify(at)}`);
    },
  },
  {
    // Plan 5b, task 4 (D5): without CIRRUS_PDF_PICK a test's window opens no dialog of the system — the pick is as
    // cancelled: nothing is read, nothing said, the dialog as it was, still usable.
    name: 'importer une publication : « Choisir un PDF… » sans choix ne fait rien',
    ...IMPORT,
    async run(page, base, data) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count(), stored = blobCount(data);
      await openImport(page);
      const hint = await statusOf(page);
      const pick = await page.centre('.publication-dialog button.pick', 'Choisir un PDF');
      await page.click(pick.x, pick.y);
      await sleep(1500);
      if ((await statusOf(page)) !== hint || !(await dialogOpen(page))) throw new Error(`le dialogue a changé : « ${await statusOf(page)} »`);
      if (await page.evaluate(`document.querySelector('.publication-dialog button.pick').disabled || !!document.querySelector('.publication-dialog .pdf')`)) throw new Error('le dialogue attend un PDF qui ne vient pas');
      if (count() !== before || blobCount(data) !== stored) throw new Error('un choix annulé a créé un nœud ou stocké un fichier');
      // Still usable: an identifier typed is imported.
      await page.type('arXiv:1706.03762');
      await page.press('Enter', 'Enter', 13);
      if (!(await until(() => titledIn(base, ATTENTION).length === 1, 8000))) throw new Error(`l’import ne se fait pas ensuite (le dialogue dit « ${await statusOf(page)} »)`);
    },
  },
  {
    // Plan 5b, task 4 (D3, D5): the address of a forum page of OpenReview, replayed (no DOI; its PDF at /pdf?id=…): the
    // PDF it leads to is read as a PDF dropped on the dialog — its title from its metadata, « Créer le nœud », the PDF
    // attached. An address refused (not https, a local machine, a text that is none) is said in the dialog, and nothing
    // is stored.
    name: 'importer une publication par l’adresse d’une page d’OpenReview : son PDF est lu comme un PDF déposé ; les adresses refusées ne stockent rien',
    ...IMPORT,
    async run(page, base, data) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count(), stored = blobCount(data);
      const title = 'An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale';
      const field = async () => {
        const input = await page.centre('.publication-dialog input', '');
        await page.click(input.x, input.y);
        await page.press('a', 'KeyA', 65, 2);
      };
      const local = 'Adresse refusée : elle mène à une machine du réseau local.';
      await openImport(page);
      for (const [text, message] of [
        ['http://openreview.net/forum?id=YicbFdNTTy', 'Seules les adresses https sont acceptées.'], ['https://interne.example/a.pdf', local], ['https://127.0.0.1/', local],
        ['openreview.net/forum?id=YicbFdNTTy', 'Identifiant non reconnu.'],
      ]) {
        await field();
        await page.type(text);
        await page.press('Enter', 'Enter', 13);
        if (!(await page.until(`document.querySelector('.publication-dialog .status')?.textContent === ${JSON.stringify(message)}`, 8000))) throw new Error(`« ${text} » : le dialogue dit « ${await statusOf(page)} »`);
        if (blobCount(data) !== stored || count() !== before) throw new Error(`« ${text} » refusée, mais quelque chose est stocké ou créé`);
      }
      await field();
      await page.type('https://openreview.net/forum?id=YicbFdNTTy');
      await page.press('Enter', 'Enter', 13);
      if (!(await page.until(`!!document.querySelector('.publication-dialog button.create')`, 8000))) throw new Error(`« Créer le nœud » n’est pas proposé (le dialogue dit « ${await statusOf(page)} »)`);
      console.log(`     ${await statusOf(page)}`);
      if (!(await page.evaluate(`document.querySelector('.publication-dialog .pdf')?.textContent === 'PDF : publication.pdf'`))) throw new Error('le dialogue ne nomme pas le PDF de la page');
      if (count() !== before) throw new Error('la lecture du PDF de la page a créé un nœud');
      const create = await page.centre('.publication-dialog button.create', 'Créer le nœud');
      await page.click(create.x, create.y);
      if (!(await until(() => titledIn(base, title).length === 1))) throw new Error('le nœud du PDF de la page n’est pas dans la base');
      const n = titledIn(base, title)[0];
      if (n.tags.length !== 0 || JSON.stringify(n.files.map((f) => f.name)) !== '["publication.pdf"]') throw new Error(`nœud inattendu : ${JSON.stringify(n)}`);
      if (!blob(data, n.files[0].hash).equals(readFileSync(join(appDir, 'tests', 'data', 'publications', 'openreview-vit.pdf')))) throw new Error('le PDF du nœud n’est pas celui de la page (rejoué)');
    },
  },
  {
    // Plan 5b, task 4 (D4, D3): the address of an article of the ACM is read as its DOI, with no request to the publisher
    // (dl.acm.org is not even written in the replay's names): the metadata come through doi.org (replayed: composed on
    // Crossref's model), as for a DOI typed; no PDF, the .bib alone.
    name: 'importer une publication par l’adresse d’un article de l’ACM, lue comme un DOI',
    ...IMPORT,
    async run(page, base, data) {
      await openImport(page);
      await page.type('https://dl.acm.org/doi/10.1145/3292500.3330701');
      await page.press('Enter', 'Enter', 13);
      const title = 'Optuna: A Next-generation Hyperparameter Optimization Framework';
      if (!(await until(() => titledIn(base, title).length === 1, 8000))) throw new Error(`le nœud n’est pas dans la base (le dialogue dit « ${await statusOf(page)} »)`);
      const n = titledIn(base, title)[0];
      const authors = ['Takuya Akiba', 'Shotaro Sano', 'Toshihiko Yanase', 'Takeru Ohta', 'Masanori Koyama'];
      const tags = [...authors.map((a) => `auteur: ${a}`), 'date_de_publication: 2019', 'clé_bibtex: Akiba_2019', 'doi: 10.1145/3292500.3330701'];
      if (JSON.stringify(tagsOf(n)) !== JSON.stringify(tags)) throw new Error(`tags inattendus : ${JSON.stringify(tagsOf(n))}`);
      if (JSON.stringify(n.files.map((f) => f.name)) !== '["Akiba_2019.bib"]') throw new Error(`fichiers inattendus : ${JSON.stringify(n.files)}`);
      const bib = blob(data, n.files[0].hash).toString('utf8');
      if (!bib.startsWith('@inproceedings{Akiba_2019,\n')) throw new Error(`.bib inattendu : ${bib.slice(0, 120)}`);
      if (await dialogOpen(page)) throw new Error('le dialogue reste ouvert après l’import');
    },
  },
  {
    // Plan 4c, D9: the test base's .bib dropped on the sky; its block follows the cursor, a click puts the seven
    // publications down, one action; the base's book a duplicate, named; the broken entry said by its line; Ctrl+Z.
    name: 'importer un .bib déposé sur le fond : le bloc suit le curseur, un clic le pose en une action ; doublon et entrée abîmée nommés ; un Ctrl+Z retire tout',
    ...PUBLICATION,
    async run(page, base, data) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count();
      await page.move(SKY2.x, SKY2.y);
      await page.dropFiles(SKY2, [BIB]);
      if (!(await bibGhost(page, '^Importer 7 publications'))) throw new Error(`pas de fantôme du bloc (« ${await ghostText(page)} » ; ${await toastsText(page)})`);
      if (count() !== before) throw new Error('le dépôt a créé des nœuds avant le clic');
      // It follows the cursor, its outline the block's size at the readable step: three boxes of 210 and two gaps of 24.
      await page.move(SKY.x, SKY.y);
      const g = await page.evaluate(`(() => {
        const a = document.querySelector('.ghost').getBoundingClientRect(), b = document.querySelector('.ghost-block').getBoundingClientRect();
        return { x: a.x + a.width / 2, y: a.y + a.height / 2, bx: b.x + b.width / 2, by: b.y + b.height / 2, w: b.width, h: b.height };
      })()`);
      if ([g.x - SKY.x, g.y - SKY.y, g.bx - SKY.x, g.by - SKY.y].some((d) => Math.abs(d) > 2)) throw new Error(`le fantôme ne suit pas le curseur : ${JSON.stringify(g)}`);
      if (Math.abs(g.w - (3 * 210 + 2 * 24)) > 2) throw new Error(`contour du bloc inattendu : ${JSON.stringify(g)}`);
      if (!(await bibGhost(page, '^Importer 7 publications$'))) throw new Error(`les .bib ne sont pas enregistrés (« ${await ghostText(page)} »)`);
      console.log(`     fantôme « ${await ghostText(page)} », contour ${g.w.toFixed(0)} × ${g.h.toFixed(0)} px`);
      const at = await worldAt(page, SKY);
      await page.click(SKY.x, SKY.y);
      if (!(await until(() => bibNodes(base).length === 7, 8000))) throw new Error(`${bibNodes(base).length} publications dans la base au lieu de 7 ; ${await toastsText(page)}`);
      if (count() !== before + 7) throw new Error(`${count() - before} nœuds créés au lieu de 7`);
      if (await page.evaluate(`!!document.querySelector('.ghost')`)) throw new Error('le fantôme reste après la pose');
      // Their tags and their own <key>.bib, a block of three columns and three rows around the click, at step 0.
      const lobby = idsOf(base).lobby, nodes = BIB_TITLES.map((t) => titledIn(base, t)[0]);
      const shannon = ['auteur: Claude E. Shannon', 'date_de_publication: 1948', 'clé_bibtex: shannon1948', 'doi: 10.1002/j.1538-7305.1948.tb01338.x'];
      if (JSON.stringify(tagsOf(nodes[0])) !== JSON.stringify(shannon)) throw new Error(`tags inattendus : ${JSON.stringify(tagsOf(nodes[0]))}`);
      if (!tagsOf(nodes[5]).includes('arxiv: 1706.03762') || !tagsOf(nodes[4]).includes('auteur: Peter D. Grünwald')) throw new Error(`tags inattendus : ${JSON.stringify(nodes.map(tagsOf))}`);
      nodes.forEach((n, i) => {
        if (JSON.stringify(n.files.map((f) => f.name)) !== JSON.stringify([bibFileName(BIB_KEYS[i])])) throw new Error(`fichiers inattendus : ${JSON.stringify(n.files)}`);
        const bib = blob(data, n.files[0].hash).toString('utf8');
        if (!bib.startsWith(`@`) || !bib.includes(`{${BIB_KEYS[i]},\n`) || !tagsOf(n).includes(`clé_bibtex: ${BIB_KEYS[i]}`)) throw new Error(`.bib inattendu : ${bib.slice(0, 80)}`);
      });
      const places = nodes.map((n) => placementOf(base, lobby, n.id));
      if (places.some((p) => !p || p.k !== 0 || Math.abs(p.x - at.x) > g.w / 2 || Math.abs(p.y - at.y) > g.h / 2)) throw new Error(`le bloc n’est pas posé autour du clic : ${JSON.stringify(places)} ; ${JSON.stringify(at)}`);
      if (new Set(places.map((p) => p.x.toFixed(3))).size !== 3 || new Set(places.map((p) => p.y.toFixed(3))).size !== 3) throw new Error(`pas une grille de trois colonnes : ${JSON.stringify(places)}`);
      const notice = await toastsText(page);
      for (const part of ['7 publications importées de « bibliographie.bib ».', `déjà dans la base (même clé BibTeX) : « ${LI} ».`, ': Entrée « casse2020 » abîmée : « , » ou « } » est attendu après le champ « title »']) {
        if (!notice.includes(part)) throw new Error(`la notification ne dit pas « ${part} » : ${notice}`);
      }
      console.log(`     ${notice.replaceAll('\n', ' / ')}`);
      console.log(`     ${places.map((p) => `${p.x.toFixed(0)},${p.y.toFixed(0)}`).join(' ; ')}`);
      // Its notification stays (bibNoticeMs, review of task 6, I1): there after 5 s, when another one is gone; a click closes it.
      await sleep(5500);
      const at7 = await page.evaluate(`(() => {
        const t = [...document.querySelectorAll('.toast.closable')].find((x) => x.textContent.startsWith('7 publications importées'));
        if (!t) return null;
        const b = t.getBoundingClientRect();
        return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      })()`);
      if (!at7) throw new Error(`la notification de l’import n’est plus là après 5 s : ${await toastsText(page)}`);
      await page.click(at7.x, at7.y);
      if (!(await page.until(`![...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('7 publications importées'))`, 2000))) throw new Error('un clic ne ferme pas la notification');
      // One action: one Ctrl+Z removes the seven; the base's book stays.
      await page.press('z', 'KeyZ', 90, 2);
      if (!(await until(() => bibNodes(base).length === 0))) throw new Error('un Ctrl+Z ne retire pas tout l’import');
      if (count() !== before || titledIn(base, LI).length !== 1) throw new Error('le Ctrl+Z a retiré autre chose');
    },
  },
  {
    // « Importer un fichier .bib… » by the test's entry (CIRRUS_BIB_PICK), never the system's dialog: Escape gives the
    // block up, nothing made; chosen again, a click puts it down.
    name: 'importer un .bib par le menu du fond (entrée de test, sans sélecteur) : Échap annule la pose, rien n’est créé ; un clic pose le bloc',
    env: { ...PUBLICATION.env, CIRRUS_BIB_PICK: BIB },
    async run(page, base) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count();
      await pickBibByMenu(page);
      if (!(await bibGhost(page, '^Importer 7 publications'))) throw new Error(`pas de fantôme du bloc (« ${await ghostText(page)} » ; ${await toastsText(page)})`);
      await page.move(SKY2.x, SKY2.y);
      await page.press('Escape', 'Escape', 27);
      if (!(await page.until(`!document.querySelector('.ghost')`))) throw new Error('Échap ne retire pas le fantôme');
      await page.click(SKY2.x, SKY2.y);
      await sleep(500);
      if (count() !== before) throw new Error('Échap, puis un clic, ont créé des nœuds');
      await pickBibByMenu(page);
      if (!(await bibGhost(page, '^Importer 7 publications$'))) throw new Error(`pas de fantôme du bloc (« ${await ghostText(page)} »)`);
      await page.move(SKY.x, SKY.y);
      await page.click(SKY.x, SKY.y);
      if (!(await until(() => bibNodes(base).length === 7, 8000))) throw new Error(`${bibNodes(base).length} publications dans la base au lieu de 7 ; ${await toastsText(page)}`);
      if (count() !== before + 7) throw new Error(`${count() - before} nœuds créés au lieu de 7`);
      // Escape, which nothing else takes, closes its notification (review of task 6, I1).
      if (!(await page.until(`!!document.querySelector('.toast.closable')`, 2000))) throw new Error('pas de notification de l’import');
      await page.press('Escape', 'Escape', 27);
      if (!(await page.until(`!document.querySelector('.toast.closable')`, 2000))) throw new Error('Échap ne ferme pas la notification');
    },
  },
  {
    // Review of task 6, M4: put down, the block waits for its .bib; meanwhile nothing that puts something down begins
    // — Ctrl+V, the background's menu —, the reason said, and the ghost stays the block's.
    name: 'pendant l’attente d’un .bib posé, Ctrl+V et le menu du fond sont refusés, et le fantôme reste celui du bloc',
    ...PUBLICATION,
    async run(page, base) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count();
      // A node copied first (Ctrl+click selects it without its pop-up): Ctrl+V has something to paste.
      await page.ctrlClick(ON_PUBLICATION.x, ON_PUBLICATION.y);
      await page.press('c', 'KeyC', 67, 2);
      if (!(await page.until(`[...document.querySelectorAll('.toast')].some((t) => / copiés?\\.$/.test(t.textContent))`, 3000))) throw new Error(`rien n’est copié : ${await toastsText(page)}`);
      const dir = mkdtempSync(join(tmpdir(), 'cirrus-bib-'));
      try {
        const path = join(dir, 'attente.bib');
        writeFileSync(path, Array.from({ length: 2000 }, (_, i) => `@article{attente${i}, author = {Nom${i}, A.}, title = {Attente ${i}}, year = 2001, doi = {10.5555/attente.${i}}}`).join('\n'), 'utf8');
        await page.move(SKY2.x, SKY2.y);
        await page.dropFiles(SKY2, [path]);
        if (!(await bibGhost(page, '^Importer 2.000 publications', 30000))) throw new Error(`pas de fantôme du bloc (« ${await ghostText(page)} »)`);
        await page.move(SKY.x, SKY.y);
        await page.click(SKY.x, SKY.y);
        if (!(await page.until(`/^Enregistrement des fichiers \\.bib/.test(document.querySelector('.ghost')?.textContent ?? '')`, 3000))) throw new Error(`pas d’attente après le clic (« ${await ghostText(page)} »)`);
        await page.press('v', 'KeyV', 86, 2);
        if (!(await page.until(`[...document.querySelectorAll('.toast')].some((t) => t.textContent.startsWith('Import du .bib en cours'))`, 2000))) throw new Error(`Ctrl+V n’est pas refusé : ${await toastsText(page)}`);
        if (!/^Enregistrement des fichiers \.bib/.test((await ghostText(page)) ?? '')) throw new Error(`le fantôme est écrasé : « ${await ghostText(page)} »`);
        await page.click(SKY2.x, SKY2.y, 'right');
        if (await page.evaluate(`!!document.querySelector('.context-menu')`)) throw new Error('le menu du fond s’ouvre pendant l’attente');
        console.log(`     pendant l’attente : « ${await ghostText(page)} » ; ${(await toastsText(page)).replaceAll('\n', ' / ')}`);
        if (!(await until(() => count() === before + 2000, 60000))) throw new Error(`${count() - before} nœuds créés au lieu de 2 000`);
        if (!(await page.until(`!document.querySelector('.ghost')`, 5000))) throw new Error('un fantôme reste après la pose');
        await sleep(500);
        if (count() !== before + 2000) throw new Error(`${count() - before} nœuds au lieu de 2 000 : quelque chose a été collé`);
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  },
  {
    // The routes of a .bib let go elsewhere (D9): on a node, one of its files, as any file; on the import dialog, which
    // takes a PDF only, refused — and in neither case an import.
    name: 'un .bib déposé sur un nœud en devient un fichier ; sur le dialogue d’import, il est refusé ; aucun import',
    ...IMPORT,
    async run(page, base) {
      await page.dropFiles(ON_PUBLICATION, [BIB]);
      if (!(await until(() => titledIn(base, LI)[0]?.files.some((f) => f.name === 'bibliographie.bib'), 8000))) throw new Error(`le .bib n’est pas un fichier du nœud ; ${await toastsText(page)}`);
      if (await ghostText(page)) throw new Error('le dépôt sur un nœud a lancé l’import');
      await openImport(page);
      await page.dropFiles(await page.centre('.publication-dialog .status', ''), [BIB]);
      if (!(await page.until(`document.querySelector('.publication-dialog .status')?.textContent === '« bibliographie.bib » n’est pas un PDF.'`))) throw new Error(`le dialogue dit « ${await statusOf(page)} »`);
      await sleep(500);
      if ((await ghostText(page)) || bibNodes(base).length !== 0) throw new Error('le dépôt sur le dialogue a lancé l’import');
    },
  },
  {
    // The measures of task 6 (three times each): 2 000 entries, from the drop to the ghost, their .bib stored in the
    // background, and from the click to the action applied — the click once the .bib are stored, then at once.
    name: 'un .bib de 2 000 entrées : du dépôt au fantôme, l’enregistrement des .bib, du clic à la pose',
    ...PUBLICATION,
    async run(page, base) {
      const count = () => base('SELECT count(*) AS n FROM nodes')[0].n, before = count();
      const dir = mkdtempSync(join(tmpdir(), 'cirrus-bib-'));
      const ms = (a, b) => (b - a).toFixed(0);
      try {
        for (let run = 1; run <= 6; run++) {
          const path = join(dir, `bibliotheque-${run}.bib`), wait = run <= 3;
          writeFileSync(path, Array.from({ length: 2000 }, (_, i) => [
            `@article{auteur${run}x${i},`, `  author = {Nom${i}, Prénom and Autre, Jean},`, `  title = {Titre ${run}.${i} d’un article -- avec {\\'e}},`,
            `  journal = {Revue}, year = ${1950 + (i % 70)},`, `  doi = {10.5555/run${run}.${i}}`, '}',
          ].join('\n')).join('\n'), 'utf8');
          await page.move(SKY2.x, SKY2.y);
          await page.dropFiles(SKY2, [path]);
          if (!(await bibGhost(page, '^Importer 2.000 publications', 30000))) throw new Error(`pas de fantôme du bloc (« ${await ghostText(page)} » ; ${await toastsText(page)})`);
          if (wait && !(await bibGhost(page, '^Importer 2.000 publications$', 60000))) throw new Error(`les .bib ne sont pas enregistrés (« ${await ghostText(page)} »)`);
          await page.move(SKY.x, SKY.y);
          await page.click(SKY.x, SKY.y);
          if (!(await until(() => count() === before + 2000, 90000))) throw new Error(`${count() - before} nœuds créés au lieu de 2 000 ; ${await toastsText(page)}`);
          if (!(await page.until(`performance.getEntriesByName('cirrus:bib:placed').length > 0 && !document.querySelector('.ghost')`, 10000))) throw new Error('pas de marque de la pose');
          // The frame drawn after the action: two frames of the page's loop.
          const drawn = await page.evaluate(`new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(performance.now()))))`);
          const [drop, ghost, stored, click, placed] = await Promise.all(['drop', 'ghost', 'stored', 'click', 'placed'].map((m) => markAt(page, m)));
          console.log(`     ${wait ? 'clic après l’enregistrement' : 'clic aussitôt'}, passe ${run} : dépôt → fantôme ${ms(drop, ghost)} ms ; fantôme → .bib enregistrés ${ms(ghost, stored)} ms ; clic → action ${ms(click, placed)} ms, → image ${ms(click, drawn)} ms`);
          const notice = await toastsText(page);
          if (!new RegExp(`2.000 publications importées de « bibliotheque-${run}\\.bib »\\.`).test(notice)) throw new Error(`notification inattendue : ${notice}`);
          await page.press('z', 'KeyZ', 90, 2);
          if (!(await until(() => count() === before, 30000))) throw new Error('un Ctrl+Z ne retire pas tout l’import');
          await sleep(500);
          for (let i = 0; i < 20 && (await page.evaluate(`document.querySelectorAll('.toast').length`)) > 0; i++) await sleep(250);
        }
      } finally {
        rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  },
  {
    // Plan 5a, task 4: a new base (empty: its lobby only) paired, by the block « Serveur » of the settings, with a
    // server of this machine: Electron's network (net.fetch: the event stream, the writes, a file's upload) and the
    // token kept by Windows (safeStorage). The lobby is the server's first write; a node made by the menu, then a file
    // dropped on it, reach it; the chip says « À jour »; « Dissocier ce PC » takes it all away.
    name: 'jumeler une base neuve à un serveur local, synchroniser, dissocier (plan 5a)',
    empty: true,
    async run(page, base, data) {
      const server = await localServer();
      const dropDir = mkdtempSync(join(tmpdir(), 'cirrus-interface-depot-'));
      try {
        const gear = await page.centre('.tabs .gear', '⚙');
        await page.click(gear.x, gear.y);
        const rubric = await page.centre('.settings .rubric-title', 'Serveur');
        await page.click(rubric.x, rubric.y);
        if (!(await page.until(`document.querySelectorAll('.server-block input').length === 3`))) throw new Error('le bloc « Serveur » ne montre pas ses trois champs');
        const values = await page.evaluate(`[...document.querySelectorAll('.server-block input')].map((i) => i.value)`);
        if (values[0] !== 'http://127.0.0.1:7310' || values[1] !== '' || values[2] === '') throw new Error(`champs proposés : ${JSON.stringify(values)}`);
        if (await chipText(page)) throw new Error('une pastille sans serveur jumelé');
        // The server's address, typed over the one proposed; the code `jumeler` shows.
        const url = await serverField(page, 0);
        await page.click(url.x, url.y);
        await page.press('a', 'KeyA', 65, 2);
        await page.type(server.url);
        const code = await serverField(page, 1);
        await page.click(code.x, code.y);
        await page.type(server.code('Interface'));
        const pair = await page.centre('.server-block button', '^Jumeler$');
        await page.click(pair.x, pair.y);
        if (!(await page.until(`[...document.querySelectorAll('.server-block button')].some((b) => b.textContent === 'Dissocier ce PC')`, 10000))) {
          throw new Error(`pas jumelé : ${await page.evaluate(`document.querySelector('.server-error')?.textContent ?? '(aucun message)'`)}`);
        }
        if (!(await page.until(`document.querySelector('.tabs .sync-chip')?.textContent === 'À jour'`, 10000))) throw new Error(`la pastille dit « ${await chipText(page)} »`);
        const stored = JSON.parse(readFileSync(join(data, 'serveur.json'), 'utf8'));
        // The token as safeStorage keeps it: bytes encrypted for this user (a version, a nonce, the text, a tag), never the text.
        const sealed = Buffer.from(stored.token, 'base64');
        if (stored.url !== server.url || sealed.length <= 43 || /^[ -~]*$/.test(sealed.toString('latin1'))) {
          throw new Error(`serveur.json ne garde pas l’adresse, ou pas un jeton chiffré par Windows (${stored.url}, ${sealed.length} octets)`);
        }
        const first = server.journal();
        if (first.length !== 1 || first[0].t !== 'plan' || first[0].after?.type !== 'lobby') throw new Error(`le journal du serveur : ${JSON.stringify(first.map((op) => op.t))}`);
        // Task 6, the shared settings: one changed on another PC reaches settings.json and the page (cirrus:settings:changed);
        // one typed here reaches the server.
        const observer = await server.observer();
        await observer.put({ toastMs: { value: 9000, at: Date.now() + 60_000 } });
        const local = () => { try { return JSON.parse(readFileSync(join(data, 'settings.json'), 'utf8')); } catch { return {}; } };
        if (!(await until(() => local().toastMs === 9000, 8000))) throw new Error(`le réglage reçu n’est pas dans settings.json : ${JSON.stringify(local())}`);
        const search = await page.centre('.settings input.search', '');
        await page.click(search.x, search.y);
        await page.type('Durée d’affichage des notifications');
        const toastField = `[...document.querySelectorAll('.settings .param')].find((p) => p.querySelector('.label')?.textContent.startsWith('Durée d’affichage des notifications'))?.querySelector('input.num')`;
        if (!(await page.until(`${toastField}?.value === '9000'`, 8000))) throw new Error(`la page montre ${await page.evaluate(`${toastField}?.value`)} au lieu du réglage reçu`);
        const toastAt = await page.evaluate(`(() => { const b = ${toastField}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        await page.click(toastAt.x, toastAt.y);
        await page.press('a', 'KeyA', 65, 2);
        await page.type('7000');
        // Sent, then nothing waits in settings-pending.json.
        const waiting = () => { try { return Object.keys(JSON.parse(readFileSync(join(data, 'settings-pending.json'), 'utf8'))).length; } catch { return 0; } };
        let shared = null;
        for (const end = Date.now() + 8000; Date.now() < end && (shared?.toastMs?.value !== 7000 || waiting() > 0); await sleep(100)) shared = await observer.settings();
        if (shared?.toastMs?.value !== 7000 || waiting() > 0) throw new Error(`le réglage changé ici n’arrive pas au serveur : ${JSON.stringify(shared)}, ${waiting()} en attente`);
        await page.click(search.x, search.y);
        await page.press('a', 'KeyA', 65, 2);
        await page.press('Backspace', 'Backspace', 8);
        // A node by the menu of the background, as the first scenario does it.
        await closeSettings(page);
        for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(250, 850, 'right');
        const item = await page.centre('.context-menu button', 'Nouveau nœud');
        await page.click(item.x, item.y);
        await page.move(400, 800);
        await page.click(400, 800);
        await page.type('Nœud synchronisé');
        await page.press('Enter', 'Enter', 13);
        if (!(await until(() => server.journal().some((op) => op.t === 'node' && op.after?.title === 'Nœud synchronisé'), 8000))) throw new Error('le nœud n’arrive pas au serveur');
        // A file dropped on it: uploaded (PUT, the file read from the disk), then the write that refers to it.
        const file = join(dropDir, 'notes_synchro.txt'), text = 'Envoyé au serveur par Electron.\n';
        writeFileSync(file, text, 'utf8');
        await page.dropFiles({ x: 400, y: 800 }, [file]);
        const hash = createHash('sha256').update(text).digest('hex');
        if (!(await until(() => server.hasBlob(hash) && server.journal().some((op) => op.t === 'node' && op.after?.files.some((f) => f.hash === hash)), 8000))) {
          throw new Error(`le fichier n’arrive pas au serveur ; ${await toastsText(page)}`);
        }
        if (!(await page.until(`document.querySelector('.tabs .sync-chip')?.textContent === 'À jour'`, 8000))) throw new Error(`la pastille dit « ${await chipText(page)} »`);
        // « Dissocier ce PC »: no chip, no serveur.json, nothing sent any more.
        await page.click(gear.x, gear.y);
        const again = await page.centre('.settings .rubric-title', 'Serveur');
        if (!(await page.evaluate(`!!document.querySelector('.server-block')`))) await page.click(again.x, again.y);
        const unpair = await page.centre('.server-block button', 'Dissocier ce PC');
        await page.click(unpair.x, unpair.y);
        if (!(await page.until(`!document.querySelector('.tabs .sync-chip') && document.querySelectorAll('.server-block input').length === 3`, 8000))) throw new Error('toujours jumelé après « Dissocier ce PC »');
        if (existsSync(join(data, 'serveur.json'))) throw new Error('serveur.json reste après la dissociation');
        if (existsSync(join(data, 'settings-pending.json'))) throw new Error('settings-pending.json reste après la dissociation');
        if (local().toastMs !== 7000) throw new Error(`les réglages de ce PC ne restent pas après la dissociation : ${JSON.stringify(local())}`);
        // A real action after it (task 7, deferred minor of task 4): a node made by the menu, written here and left
        // pending, never sent — the server's journal does not move.
        const lines = server.journal().length, after = 'Nœud fait après la dissociation';
        await closeSettings(page);
        await newNode(page, { x: 400, y: 600 }, after);
        const pending = () => base(`SELECT count(*) AS n FROM changes WHERE server_seq IS NULL`)[0].n;
        if (!(await until(() => titledIn(base, after).length === 1 && pending() > 0))) throw new Error('le nœud fait après la dissociation n’est pas dans la base, en attente');
        await sleep(2000);
        if (server.journal().length !== lines || server.journal().some((op) => op.after?.title === after)) throw new Error('le serveur reçoit encore après la dissociation');
        if (base(`SELECT count(*) AS n FROM nodes`)[0].n !== 2) throw new Error('la base locale a perdu son nœud');
      } finally {
        await server.close();
        rmSync(dropDir, { recursive: true, force: true, maxRetries: 5 });
      }
    },
  },
  {
    // Plan 5a, task 5 (D7): the full test base paired with an empty server, by the block « Serveur »: the offer to send
    // it, its counts; sent (every file of its store, its snapshot, its journal), its lines numbered, then the sync live.
    name: 'envoyer la base de test à un serveur local vide, au premier jumelage (plan 5a, tâche 5)',
    async run(page, base, data) {
      const server = await localServer();
      try {
        const gear = await page.centre('.tabs .gear', '⚙');
        await page.click(gear.x, gear.y);
        const rubric = await page.centre('.settings .rubric-title', 'Serveur');
        await page.click(rubric.x, rubric.y);
        if (!(await page.until(`document.querySelectorAll('.server-block input').length === 3`))) throw new Error('le bloc « Serveur » ne montre pas ses trois champs');
        const url = await serverField(page, 0);
        await page.click(url.x, url.y);
        await page.press('a', 'KeyA', 65, 2);
        await page.type(server.url);
        const code = await serverField(page, 1);
        await page.click(code.x, code.y);
        await page.type(server.code('Base de test'));
        const pair = await page.centre('.server-block button', '^Jumeler$');
        await page.click(pair.x, pair.y);
        // The offer, with the base's counts: its nodes, the blobs of its store.
        const nodes = base(`SELECT count(*) AS n FROM nodes`)[0].n, store = join(data, 'files');
        const blobs = readdirSync(store).filter((d) => /^[0-9a-f]{2}$/.test(d)).reduce((n, d) => n + readdirSync(join(store, d)).filter((f) => /^[0-9a-f]{64}$/.test(f)).length, 0);
        const plural = (n, noun) => `${n} ${noun}${n > 1 ? 's' : ''}`;
        const label = `Envoyer la base de ce PC au serveur (${plural(nodes, 'nœud')}, ${plural(blobs, 'fichier')})`;
        if (!(await page.until(`[...document.querySelectorAll('.server-offer button')].some((b) => b.textContent === ${JSON.stringify(label)})`, 10000))) {
          throw new Error(`pas d’offre « ${label} » : ${await page.evaluate(`document.querySelector('.server-block')?.textContent ?? '(pas de bloc)'`)}`);
        }
        if (existsSync(join(data, 'serveur.json')) || server.journal().length !== 0) throw new Error('jumelé, ou la base envoyée, avant la réponse');
        const send = await page.centre('.server-offer button', '^Envoyer la base');
        await page.click(send.x, send.y);
        if (!(await page.until(`[...document.querySelectorAll('.server-block button')].some((b) => b.textContent === 'Dissocier ce PC')`, 30000))) {
          throw new Error(`pas jumelé : ${await page.evaluate(`document.querySelector('.server-error')?.textContent ?? document.querySelector('.server-block')?.textContent ?? '(aucun message)'`)}`);
        }
        if (!(await page.until(`document.querySelector('.tabs .sync-chip')?.textContent === 'À jour'`, 10000))) throw new Error(`la pastille dit « ${await chipText(page)} »`);
        // The server holds its journal, line for line, and every file of its store; nothing of it is pending here.
        const lines = base(`SELECT count(*) AS n FROM changes`)[0].n, pending = base(`SELECT count(*) AS n FROM changes WHERE server_seq IS NULL`)[0].n;
        if (server.journal().length !== lines || pending !== 0) throw new Error(`journal du serveur : ${server.journal().length} lignes, ${lines} ici, ${pending} en attente`);
        const missing = base(`SELECT DISTINCT json_extract(f.value, '$.hash') AS h FROM nodes, json_each(json_extract(nodes.json, '$.files')) AS f`).filter((r) => !server.hasBlob(r.h));
        if (missing.length > 0) throw new Error(`${missing.length} fichiers manquent au serveur`);
      } finally {
        await server.close();
      }
    },
  },
  TWO_PCS,
];

const reason = (e) => (e instanceof Error ? e.message : String(e));
/**
 * A suite (plan 5a, task 7): scenarios that follow one another on the same bases, apps and server, each launching the
 * app itself, one at a time. Each step counts as a scenario; once one fails, the next ones are not played, and fail
 * with it. The number of failures.
 */
async function runSuite(s) {
  let failed = 0, broken = null, ctx = null;
  try {
    ctx = await s.setup();
  } catch (e) {
    broken = `la mise en place (${reason(e)})`;
  }
  try {
    for (const [i, step] of s.steps.entries()) {
      if (broken) {
        failed++;
        console.error(`ÉCHEC ${step.name} : non joué, après l’échec de ${broken}`);
        continue;
      }
      try {
        await step.run(ctx);
        console.log(`ok   ${step.name}`);
      } catch (e) {
        failed++;
        broken = `l’étape ${i + 1}`;
        console.error(`ÉCHEC ${step.name} : ${reason(e)}`);
      }
    }
  } finally {
    if (ctx) await s.teardown(ctx);
  }
  return failed;
}

// `node scripts/interface.mjs <texte>`: only the scenarios whose name holds that text (a suite whole, for one of its steps).
const only = process.argv[2];
const chosen = only ? SCENARIOS.filter((s) => s.name.includes(only) || s.steps?.some((t) => t.name.includes(only))) : SCENARIOS;
let failed = 0, total = 0;
for (const s of chosen) {
  if (s.steps) {
    total += s.steps.length;
    failed += await runSuite(s);
    continue;
  }
  total++;
  const data = mkdtempSync(join(tmpdir(), 'cirrus-interface-'));
  const profile = mkdtempSync(join(tmpdir(), 'cirrus-interface-profil-'));
  let app = null;
  try {
    // `empty`: a new base, its lobby only (the app makes it), instead of the test base.
    if (!s.empty) execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    if (s.settings) writeFileSync(join(data, 'settings.json'), JSON.stringify(s.settings), 'utf8');
    app = await launch(data, profile, s.env);
    await s.run(app.page, reader(data), data, app);
    console.log(`ok   ${s.name}`);
  } catch (e) {
    failed++;
    console.error(`ÉCHEC ${s.name} : ${reason(e)}`);
  } finally {
    await app?.close();
    rmSync(data, { recursive: true, force: true, maxRetries: 5 });
    rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  }
}
console.log(`${total - failed} scénarios sur ${total} réussis`);
process.exit(failed > 0 ? 1 : 0);
