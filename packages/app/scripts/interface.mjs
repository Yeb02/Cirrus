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
import { chipSays, localServer, pairThrough, serverField, TITLE_PROBE, virtualPc } from './serveur-local.mjs';

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
const closeSettings = async (page) => {
  const close = await page.centre('.settings .close', '×');
  await page.click(close.x, close.y);
};
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
/** The node's pop-up, by a click on it, showing `title`. */
async function openPopup(page, at, title) {
  for (let i = 0; i < 10 && !(await page.until(`document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(title)}`, 1000)); i++) {
    await page.click(at.x, at.y);
  }
  if (!(await page.evaluate(`document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(title)}`))) {
    throw new Error(`pas de pop-up « ${title} » au clic sur le nœud`);
  }
}
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
    // B's base taken from the server leaves its old one beside it (« …-avant-jumelage-… »), and a staged one if it failed.
    const b = basename(ctx.b.data);
    for (const name of readdirSync(tmpdir())) if (name.startsWith(`${b}-`)) ctx.dirs.push(join(tmpdir(), name));
    for (const d of ctx.dirs) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  },
  steps: [
    {
      name: '1. A crée un nœud avec un .txt et quitte ; B, neuve, prend la base du serveur, redémarre sur elle, puis montre le nœud et son fichier (plan 5a)',
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
        ctx.app = null;
        // B: a new base; the server holds A's, so the pairing offers to take it (D7, R7).
        const env = { ...SYNC_VIEW, CIRRUS_NO_RELAUNCH: '1' };
        ctx.app = await launch(b.data, b.profile, env);
        page = ctx.app.page;
        await pairThrough(page, server.url, server.code('B'));
        const label = 'Prendre la base du serveur (1 nœud)';
        if (!(await page.until(`[...document.querySelectorAll('.server-offer button')].some((x) => x.textContent === ${JSON.stringify(label)})`, 10_000))) {
          throw new Error(`pas d’offre « ${label} » : ${await blockText(page)}`);
        }
        const take = await page.centre('.server-offer button', '^Prendre la base du serveur');
        await page.click(take.x, take.y);
        // Taken, staged beside B's base; B quits instead of starting again (R27: the relaunch stays this script's).
        const code = await Promise.race([ctx.app.exited, sleep(30_000).then(() => null)]);
        if (code === null) throw new Error(`B ne quitte pas après la prise : ${await blockText(page)}`);
        await ctx.app.close();
        ctx.app = null;
        const staged = `${b.data}-nouvelle`;
        if (!existsSync(join(staged, 'complete.json'))) throw new Error('pas de base prise complète à côté de celle de B');
        // B started again as the relaunch would (its profile, which holds the key of its token): the base taken swapped
        // in before it opens, the old one kept beside it.
        rmSync(join(b.profile, 'DevToolsActivePort'), { force: true });
        ctx.app = await launch(b.data, b.profile, env);
        page = ctx.app.page;
        const kept = readdirSync(tmpdir()).filter((n) => n.startsWith(`${basename(b.data)}-avant-jumelage-`));
        if (existsSync(staged) || kept.length !== 1 || !existsSync(join(tmpdir(), kept[0], 'cirrus.db'))) {
          throw new Error(`l’échange n’a pas eu lieu : base prise ${existsSync(staged) ? 'encore à côté' : 'en place'}, ancienne gardée sous ${JSON.stringify(kept)}`);
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
        ctx.virtual = await virtualPc(ctx.server, 'pc-virtuel');
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
        const settingsClose = await page.centre('.settings .close', '×');
        await page.click(settingsClose.x, settingsClose.y);
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
    await s.run(app.page, reader(data), data);
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
