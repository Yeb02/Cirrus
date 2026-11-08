// The reference captures (plan 3c): npm run captures -w packages/app -- <dossier> [--replace] [--only=<scène>,<scène>]
// Every scene below is captured on a fresh artificial test base, in a window of a fixed size, into <dossier>.
// compare-captures.mjs then compares such a folder with a reference: after each task that touches the rendering, a new
// suite (in a new folder) against docs/captures/reference-3c (the plan 3c scenes), docs/captures/plan4a,
// docs/captures/plan4b, docs/captures/plan4c and docs/captures/plan5a (those new in plans 4a, 4b, 4c and 5a; the last
// ones of plan 5a need a server: pairedCaptures), each compared on its own images. A
// folder that already holds files is refused, so a reference is never replaced by mistake; --replace removes its
// captures first (to remake a reference on purpose). --only captures those scenes alone (while one is worked on; a
// reference is checked against a whole suite). LaTeX is compiled by the bench's TinyTeX (CIRRUS_TINYTEX), which must be
// there; the app takes each image once its compilations are done. Plan 4c's scenes never reach the network: an import
// replays recorded answers (CIRRUS_PUBLICATIONS_REPLAY, tests/data/publications), a .bib is dropped by CIRRUS_IMPORT.
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const targets = args.filter((a) => !a.startsWith('--'));
const replace = args.includes('--replace');
const only = args.find((a) => a.startsWith('--only='))?.slice(7).split(',').filter(Boolean);
if (targets.length !== 1 || args.some((a) => a.startsWith('--') && a !== '--replace' && !a.startsWith('--only='))) {
  console.error('Usage : npm run captures -w packages/app -- <dossier> [--replace] [--only=<scène>,<scène>]');
  process.exit(2);
}
const out = resolve(process.env.INIT_CWD ?? process.cwd(), targets[0]);
// Plan 4b: summaries and relations are compiled, by the bench's TinyTeX (never the user's, never a download). Without
// it, a capture would show the sources instead: refused.
const tinyTex = join(appDir, '..', '..', 'bench', 'latex', 'vendor', 'TinyTeX');
if (!existsSync(join(tinyTex, 'bin', 'windows', 'pdflatex.exe'))) {
  console.error(`Pas de TinyTeX dans ${tinyTex} : les captures compilent les résumés avec la TinyTeX du banc (bench/latex).`);
  process.exit(2);
}
if (existsSync(out) && readdirSync(out).length > 0) {
  if (!replace) {
    console.error(`${out} n’est pas vide : choisis un dossier neuf, ou --replace pour remplacer ses captures.`);
    process.exit(2);
  }
  for (const f of readdirSync(out)) if (f.toLowerCase().endsWith('.png')) rmSync(join(out, f));
}
const electron = createRequire(import.meta.url)('electron');

// The window's content is 1584×961 px at this size, its graph 1584×923 (under the tabs): the view's centre is at
// (792, 461), and a world point (x, y) at zoom z is drawn at (792 + (x − cx)·z, 461 + (y − cy)·z).
const SIZE = '1600,1000';
/** One scene: launch options of the app (src/main/index.ts), and settings written next to the base. */
const SCENES = [
  { name: 'lobby-vue-ensemble' },
  { name: 'zoom-profond', view: '175,140,4' },
  { name: 'groupe-mi-repli', view: '0,0,0.3' },
  // MDL, then Solomonoff with Ctrl.
  { name: 'selection', view: '0,140,1', pointer: 'down 967 461; up 967 461; down 617 461 ctrl; up 617 461 ctrl' },
  { name: 'apercu-glissement', view: '0,140,1', pointer: 'down 967 461; move 990 470 | move 1060 520' },
  // A click on « Analogue bayésien », between MDL and Solomonoff.
  { name: 'fenetre-connexion', view: '0,140,1', pointer: 'down 792 461; up 792 461' },
  { name: 'survol-connexion', view: '0,140,1', hover: '792,461' },
  // The fixture's stubs are in « Thèse » (Entropie's branch), its phantoms in the lobby (Universality's split arm).
  { name: 'amorces-these', plan: 'Thèse' },
  { name: 'fantomes-lobby', view: '480,420,1' },
  { name: 'fond-grille', settings: { background: 'grid' } },
  { name: 'plan-document', plan: 'Article MDL' },
  // Plan 4a: a click on MDL opens its pop-up, to the right of and below the click.
  { name: 'popup-noeud', view: '0,140,1', pointer: 'down 967 461; up 967 461' },
  // A file written in a temporary folder, dropped on MDL (CIRRUS_IMPORT, by the graph's drop); its pop-up, opened by the
  // click, is tall enough to show its files: the new one last, the notice above.
  {
    name: 'import-noeud', view: '0,140,1', pointer: 'down 967 461; up 967 461', settings: { popupHeightPx: 720 },
    import: { at: '967,461', name: 'données_importées.txt', text: 'Longueur de description : 42 bits.\n' },
  },
  // Plan 4a, task 5: a click on a file of the pop-up (CIRRUS_CLICK) opens its preview beside it, its ⤢ the full screen.
  // MDL's script, coloured as Python; its CSV, in Windows-1252 with semicolons; the image of « Compression sans perte »
  // (175, −140 in the world: 967, 181 on screen).
  { name: 'plein-ecran-code', view: '0,140,1', pointer: 'down 967 461; up 967 461', click: fileThenFull('calcul_mdl_séquence_aléatoire.py') },
  { name: 'plein-ecran-tableau', view: '0,140,1', pointer: 'down 967 461; up 967 461', click: fileThenFull('mesures_compression.csv') },
  { name: 'plein-ecran-image', view: '0,140,1', pointer: 'down 967 181; up 967 181', click: fileThenFull('schéma_compression.png') },
  // The pop-up tall enough to show its files, the preview of the Markdown notes beside it (on its left: no room on its right).
  { name: 'apercu-fichier', view: '0,140,1', pointer: 'down 967 461; up 967 461', settings: { popupHeightPx: 720 }, click: '.file[data-name="notes_lecture.md"]' },
  // Plan 4a, task 6: the publication (−420, −300 in the world, at the view's centre) carries the two PDFs. Its
  // three-page chapter in full screen, zoomed out by nine steps of « − » from the fit (165 % to 47 % since plan 4c,
  // task 2: the margin of its annotations beside it, their highlights on pages 1 and 2), so that its first page and
  // the top of the second show; then its pop-up, tall enough to show both PDFs' first-page thumbnails.
  {
    name: 'plein-ecran-pdf', view: '-420,-300,1', pointer: 'down 792 461; up 792 461',
    click: [fileThenFull('Li_Vitányi_chapitre_1.pdf'), ...Array(9).fill('.full-screen .pdf-tools .zoom-out')].join(','),
  },
  { name: 'popup-vignettes', view: '-420,-300,1', pointer: 'down 792 461; up 792 461', settings: { popupHeightPx: 720 } },
  // Plan 4b: Entropie's pop-up (−420, −140 in the world: 372, 181 on screen), its summary compiled; the window of
  // « Déduction jointe », by a click on its marker, its relation compiled.
  { name: 'popup-resume-compile', view: '0,140,1', pointer: 'down 372 181; up 372 181' },
  { name: 'relation-compilee', view: '0,140,1', pointer: 'down 1122 399; up 1122 399' },
  // Kolmogorov's complexité.tex (Kolmogorov: −175, −140, at 617, 181) in its workbench: the broken \ref{absent:label} in
  // red in the editor and in the preview. Then a keystroke at the start of the text that breaks the compilation: the
  // last good PDF stays, the error line in the banner and on its line, the log open.
  { name: 'plein-ecran-tex', view: '0,140,1', pointer: 'down 617 181; up 617 181', click: fileThenFull('complexité.tex') },
  {
    name: 'tex-erreur', view: '0,140,1', pointer: 'down 617 181; up 617 181',
    click: [fileThenFull('complexité.tex'), 'type:\\oups ', '.full-screen .tex-status .log'].join(','),
  },
  // The preamble's editor, from « Modifier le préambule… » in the settings' LaTeX rubric (opened first), its sample compiled.
  { name: 'preambule', panel: true, click: '.settings .rubric[data-rubric="LaTeX"] .rubric-title,.settings .latex-actions button:last-child' },
  // Plan 4c: the publication's chapter in its preview beside its pop-up, wide enough to read it at the fit beside its
  // margin: page 1's passage highlighted, the margin's three annotations (one in « Lecture », one in no plan, one on
  // the version before the re-import).
  {
    name: 'pdf-surlignages', view: '-420,-300,1', pointer: 'down 792 461; up 792 461', settings: { previewWidthPx: 1000, previewHeightPx: 820 },
    click: '.file[data-name="Li_Vitányi_chapitre_1.pdf"],.node-popup .close',
  },
  // The publication's pop-up, tall enough to show its section « Annotations » under its files.
  { name: 'popup-annotations', view: '-420,-300,1', pointer: 'down 792 461; up 792 461', settings: { popupHeightPx: 940 } },
  // « Lecture »: the publication's node a group there, its page 1 annotation its member.
  { name: 'plan-lecture', plan: 'Lecture', view: '0,-20,1.6' },
  // « Importer une publication… » from the menu of the sky's background (1530, 72 under the tabs), an arXiv identifier
  // typed in its field, before « Importer »: nothing asked of the network, and the replay stands in for it anyway.
  {
    name: 'import-publication', view: '-420,-300,1', pointer: 'down 1530 72 right; up 1530 72 right | click .context-menu button:nth-child(2)',
    click: 'type:arXiv:1706.03762', publications: true,
  },
  // The test base's .bib (fixtures/assets) dropped on the sky (CIRRUS_IMPORT): its block's ghost, « Importer 7
  // publications » and its outline at the readable step, once its .bib are stored; nothing made before a click.
  { name: 'bloc-bib', view: '-420,-300,1', import: { at: '350,250', name: 'bibliographie.bib', from: join(appDir, '..', 'fixtures', 'assets', 'bibliographie.bib') } },
  // Plan 5a: the block « Serveur » at the head of its rubric, not paired: the address proposed, the code, this PC's name.
  { name: 'serveur-non-jumele', panel: true, click: '.settings .rubric[data-rubric="Serveur"] .rubric-title' },
];

/**
 * Plan 5a, task 7 (R28): the states of a paired PC — the block « Serveur » paired, the chip « Hors ligne », the veil
 * « Synchronisation… » — need a server. One of this machine is started (serveur-local.mjs: 127.0.0.1, a free port, a
 * temporary folder), and the test base sent to it through the block, as the user pairs: no hook writes a token. The app
 * is driven by DevTools (cdp.mjs), in its window out of the user's way, and each image taken by DevTools
 * (Page.captureScreenshot) once the class of capture mode is set (`.capture`: the server's address, whose port changes,
 * is not drawn) and the pointer is on the tabs' bar. Its base and profile (which holds the key of its token) are kept
 * from one state to the next: paired; its server stopped; the app quit, then started again with its server still
 * stopped, the veil's wait at its longest (syncConnectTimeoutMs, 60 s, in its settings).
 */
const PAIRED = ['serveur-jumele', 'pastille-hors-ligne', 'voile-synchronisation'];
async function pairedCaptures(names) {
  const { launch, sleep } = await import('./cdp.mjs');
  const { chipSays, localServer, pairThrough } = await import('./serveur-local.mjs');
  const data = mkdtempSync(join(tmpdir(), 'cirrus-captures-')), profile = mkdtempSync(join(tmpdir(), 'cirrus-captures-profil-'));
  const server = await localServer(), env = { CIRRUS_TINYTEX: tinyTex };
  let app = null, done = 0;
  const shoot = async (name) => {
    if (!names.includes(name)) return;
    await app.page.evaluate(`document.documentElement.classList.add('capture')`);
    await app.page.move(1000, 18);
    await sleep(1000);
    writeFileSync(join(out, `${name}.png`), await app.page.screenshot());
    console.log(`${name}.png`);
    done++;
  };
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    fixHistoryTimes(data);
    app = await launch(data, profile, env);
    let page = app.page;
    await pairThrough(page, server.url, server.code('Captures'), 'Portable');
    if (!(await page.until(`!!document.querySelector('.server-offer button')`, 10_000))) throw new Error('pas d’offre d’envoyer la base de test');
    const send = await page.centre('.server-offer button', '^Envoyer la base');
    await page.click(send.x, send.y);
    const paired = `[...document.querySelectorAll('.server-block button')].some((b) => b.textContent === 'Dissocier ce PC')`;
    if (!(await page.until(paired, 30_000)) || !(await chipSays(page, 'À jour'))) throw new Error('la base de test n’est pas envoyée au serveur');
    await shoot('serveur-jumele');
    const close = await page.centre('.settings .close', '×');
    await page.click(close.x, close.y);
    await server.stop();
    if (!(await chipSays(page, 'Hors ligne'))) throw new Error('pas de pastille « Hors ligne » une fois le serveur arrêté');
    await shoot('pastille-hors-ligne');
    if (!(await app.quit())) throw new Error('l’app ne se ferme pas');
    app = null;
    const file = join(data, 'settings.json');
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...settings, syncConnectTimeoutMs: 60_000 }), 'utf8');
    rmSync(join(profile, 'DevToolsActivePort'), { force: true });
    app = await launch(data, profile, env);
    page = app.page;
    if (!(await page.until(`!!document.querySelector('.sync-veil')`))) throw new Error('pas de voile au démarrage d’une base jumelée dont le serveur est arrêté');
    await shoot('voile-synchronisation');
  } finally {
    await app?.close();
    await server.close();
    for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
  return done;
}

/** CIRRUS_CLICK for a file's full screen: the file in its node's pop-up (its preview), then the preview's ⤢. */
function fileThenFull(name) {
  return `.file[data-name="${name}"],.file-preview .expand`;
}

/**
 * The test base's history at fixed times, one action a minute from 2026-01-05 09:00 UTC in the order they were written,
 * instead of the moment it was built: a pop-up's dates then read the same at every capture (the identifiers, random,
 * are not drawn in captures: `.volatile`).
 */
const HISTORY_FROM = Date.UTC(2026, 0, 5, 9, 0);
function fixHistoryTimes(dir) {
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  try {
    db.exec(`WITH ranked AS (SELECT action_id, ROW_NUMBER() OVER (ORDER BY MIN(local_seq)) AS n FROM changes GROUP BY action_id)
      UPDATE changes SET at = ${HISTORY_FROM} + 60000 * (SELECT n FROM ranked WHERE ranked.action_id = changes.action_id)`);
  } finally {
    db.close();
  }
}

const chosen = only ? SCENES.filter((s) => only.includes(s.name)) : SCENES;
const pairedChosen = only ? PAIRED.filter((n) => only.includes(n)) : PAIRED;
if (only && chosen.length + pairedChosen.length !== only.length) {
  console.error(`Scènes inconnues : ${only.filter((n) => !SCENES.some((s) => s.name === n) && !PAIRED.includes(n)).join(', ')}.`);
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const env0 = { ...process.env };
delete env0.ELECTRON_RUN_AS_NODE;
let failed = 0;
for (const s of chosen) {
  const data = mkdtempSync(join(tmpdir(), 'cirrus-captures-'));
  // The folder of a file to drop, out of the base's: the store copies it in, as it would the user's.
  const dropDir = s.import ? mkdtempSync(join(tmpdir(), 'cirrus-depot-')) : null;
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    fixHistoryTimes(data);
    if (s.settings) writeFileSync(join(data, 'settings.json'), JSON.stringify(s.settings), 'utf8');
    const env = { ...env0, CIRRUS_DATA: data, CIRRUS_CAPTURE: join(out, `${s.name}.png`), CIRRUS_SIZE: SIZE, CIRRUS_TINYTEX: tinyTex };
    for (const [key, name] of [['plan', 'CIRRUS_PLAN'], ['view', 'CIRRUS_VIEW'], ['hover', 'CIRRUS_HOVER'], ['pointer', 'CIRRUS_POINTER'], ['keys', 'CIRRUS_KEYS'], ['click', 'CIRRUS_CLICK']]) {
      if (s[key]) env[name] = s[key];
    }
    if (s.panel) env.CIRRUS_PANEL = '1';
    // Plan 4c: a publication's import answered by the recorded answers (tests/data/publications), never the network.
    if (s.publications) env.CIRRUS_PUBLICATIONS_REPLAY = join(appDir, 'tests', 'data', 'publications');
    if (s.import) {
      const file = join(dropDir, s.import.name);
      if (s.import.from) copyFileSync(s.import.from, file);
      else writeFileSync(file, s.import.text, 'utf8');
      env.CIRRUS_IMPORT = `${s.import.at}|${file}`;
    }
    const r = spawnSync(electron, [appDir], { env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', timeout: 120_000 });
    if (r.status !== 0) {
      failed++;
      console.error(`${s.name} : échec (${r.status ?? r.signal})\n${r.stdout}${r.stderr}`);
    } else console.log(`${s.name}.png`);
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 5 });
    if (dropDir) rmSync(dropDir, { recursive: true, force: true, maxRetries: 5 });
  }
}
let pairedDone = 0;
if (pairedChosen.length > 0) {
  try {
    pairedDone = await pairedCaptures(pairedChosen);
  } catch (e) {
    console.error(`captures d’un PC jumelé : échec (${e instanceof Error ? e.message : String(e)})`);
  }
  failed += pairedChosen.length - pairedDone;
}
const total = chosen.length + pairedChosen.length;
console.log(`${total - failed} captures sur ${total} dans ${out}`);
process.exit(failed > 0 ? 1 : 0);
