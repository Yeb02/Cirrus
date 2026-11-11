// The reference captures (plan 3c): npm run captures -w packages/app -- <dossier> [--replace] [--only=<scène>,<scène>]
// Every scene below is captured on a fresh artificial test base, in a window of a fixed size, into <dossier>.
// compare-captures.mjs then compares such a folder with a reference: after each task that touches the rendering, a new
// suite (in a new folder) against docs/captures/reference-3c (the plan 3c scenes), docs/captures/plan4a,
// docs/captures/plan4b, docs/captures/plan4c, docs/captures/plan5a, docs/captures/plan5b and docs/captures/plan6a (those
// new in plans 4a, 4b, 4c, 5a, 5b and 6a, or changed by them; the last ones of plans 5a, 5b and 6a go through DevTools:
// serverCaptures, plan5bCaptures, plan6aCaptures; plan 6a changed two more: a connection's pop-up gained its « Tags »),
// and docs/captures/plan9 (plan 9, task 2: four images of the block « Serveur », its address field empty and four more
// settings in its group; task 3: the same four, the app's name and version under the block), each compared on its own
// images. A
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
  // A double click on « Analogue bayésien », between MDL and Solomonoff (a single click only selects, since 2026-11-11).
  { name: 'fenetre-connexion', view: '0,140,1', pointer: 'down 792 461; up 792 461; dbl' },
  { name: 'survol-connexion', view: '0,140,1', hover: '792,461' },
  // The fixture's stubs are in « Thèse » (Entropie's branch), its phantoms in the lobby (Universality's split arm).
  { name: 'amorces-these', plan: 'Thèse' },
  { name: 'fantomes-lobby', view: '480,420,1' },
  { name: 'fond-grille', settings: { background: 'grid' } },
  { name: 'plan-document', plan: 'Article MDL' },
  // Plan 4a: a double click on MDL opens its pop-up, to the right of and below the click.
  { name: 'popup-noeud', view: '0,140,1', pointer: 'down 967 461; up 967 461; dbl' },
  // A file written in a temporary folder, dropped on MDL (CIRRUS_IMPORT, by the graph's drop); its pop-up, opened by the
  // click, is tall enough to show its files: the new one last, the notice above.
  {
    name: 'import-noeud', view: '0,140,1', pointer: 'down 967 461; up 967 461; dbl', settings: { popupHeightPx: 720 },
    import: { at: '967,461', name: 'données_importées.txt', text: 'Longueur de description : 42 bits.\n' },
  },
  // Plan 4a, task 5: a click on a file of the pop-up (CIRRUS_CLICK) opens its preview beside it, its ⤢ the full screen.
  // MDL's script, coloured as Python; its CSV, in Windows-1252 with semicolons; the image of « Compression sans perte »
  // (175, −140 in the world: 967, 181 on screen).
  { name: 'plein-ecran-code', view: '0,140,1', pointer: 'down 967 461; up 967 461; dbl', click: fileThenFull('calcul_mdl_séquence_aléatoire.py') },
  { name: 'plein-ecran-tableau', view: '0,140,1', pointer: 'down 967 461; up 967 461; dbl', click: fileThenFull('mesures_compression.csv') },
  { name: 'plein-ecran-image', view: '0,140,1', pointer: 'down 967 181; up 967 181; dbl', click: fileThenFull('schéma_compression.png') },
  // The pop-up tall enough to show its files, the preview of the Markdown notes beside it (on its left: no room on its right).
  { name: 'apercu-fichier', view: '0,140,1', pointer: 'down 967 461; up 967 461; dbl', settings: { popupHeightPx: 720 }, click: '.file[data-name="notes_lecture.md"]' },
  // Plan 4a, task 6: the publication (−420, −300 in the world, at the view's centre) carries the two PDFs. Its
  // three-page chapter in full screen, zoomed out by nine steps of « − » from the fit (165 % to 47 % since plan 4c,
  // task 2: the margin of its annotations beside it, their highlights on pages 1 and 2), so that its first page and
  // the top of the second show; then its pop-up, tall enough to show both PDFs' first-page thumbnails.
  {
    name: 'plein-ecran-pdf', view: '-420,-300,1', pointer: 'down 792 461; up 792 461; dbl',
    click: [fileThenFull('Li_Vitányi_chapitre_1.pdf'), ...Array(9).fill('.full-screen .pdf-tools .zoom-out')].join(','),
  },
  { name: 'popup-vignettes', view: '-420,-300,1', pointer: 'down 792 461; up 792 461; dbl', settings: { popupHeightPx: 720 } },
  // Plan 4b: Entropie's pop-up (−420, −140 in the world: 372, 181 on screen), its summary compiled; the window of
  // « Déduction jointe », by a click on its marker, its relation compiled.
  { name: 'popup-resume-compile', view: '0,140,1', pointer: 'down 372 181; up 372 181; dbl' },
  { name: 'relation-compilee', view: '0,140,1', pointer: 'down 1122 399; up 1122 399; dbl' },
  // Kolmogorov's complexité.tex (Kolmogorov: −175, −140, at 617, 181) in its workbench: the broken \ref{absent:label} in
  // red in the editor and in the preview. Then a keystroke at the start of the text that breaks the compilation: the
  // last good PDF stays, the error line in the banner and on its line, the log open.
  { name: 'plein-ecran-tex', view: '0,140,1', pointer: 'down 617 181; up 617 181; dbl', click: fileThenFull('complexité.tex') },
  {
    name: 'tex-erreur', view: '0,140,1', pointer: 'down 617 181; up 617 181; dbl',
    click: [fileThenFull('complexité.tex'), 'type:\\oups ', '.full-screen .tex-status .log'].join(','),
  },
  // The preamble's editor, from « Modifier le préambule… » in the settings' LaTeX rubric (opened first), its sample compiled.
  { name: 'preambule', panel: true, click: '.settings .rubric[data-rubric="LaTeX"] .rubric-title,.settings .latex-actions button:last-child' },
  // Plan 4c: the publication's chapter in its preview beside its pop-up, wide enough to read it at the fit beside its
  // margin: page 1's passage highlighted, the margin's three annotations (one in « Lecture », one in no plan, one on
  // the version before the re-import).
  {
    name: 'pdf-surlignages', view: '-420,-300,1', pointer: 'down 792 461; up 792 461; dbl', settings: { previewWidthPx: 1000, previewHeightPx: 820 },
    click: '.file[data-name="Li_Vitányi_chapitre_1.pdf"],.node-popup .close',
  },
  // The publication's pop-up, tall enough to show its section « Annotations » under its files.
  { name: 'popup-annotations', view: '-420,-300,1', pointer: 'down 792 461; up 792 461; dbl', settings: { popupHeightPx: 940 } },
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
];

/**
 * Plan 5a, task 7: the block « Serveur » and the states of a paired PC. The block not paired (its fields: the address
 * proposed, the code, this PC's name) is taken with « Portable » typed over the machine's name, so that the reference
 * does not depend on the PC that takes it (R30): the capture mode can neither focus a field nor select its text, so these
 * scenes go through DevTools. The block paired, the chip « Hors ligne » and the veil « Synchronisation… » need a server
 * (R28): one of this machine is started (serveur-local.mjs: 127.0.0.1, a free port, a temporary folder), and the test
 * base sent to it through the block, as the user pairs: no hook writes a token. The app is driven by DevTools (cdp.mjs),
 * in its window out of the user's way, and each image taken by DevTools (Page.captureScreenshot) once the class of
 * capture mode is set (`.capture`: the server's address, whose port changes, is not drawn), the focus taken from the
 * field typed in and the pointer on the tabs' bar. Its base and profile (which holds the key of its token) are kept from
 * one state to the next: not paired; paired; its server stopped; the app quit, then started again with its server still
 * stopped, the veil's wait at its longest (syncConnectTimeoutMs, 60 s, in its settings), once its chip says « Hors
 * ligne ». The names of the images taken go to `taken`: a failure on the way counts only the ones missing.
 */
const SERVER_SCENES = ['serveur-non-jumele', 'serveur-jumele', 'pastille-hors-ligne', 'voile-synchronisation'];
async function serverCaptures(names, taken) {
  const { launch, sleep } = await import('./cdp.mjs');
  const { chipSays, closeSettings, localServer, openServerBlock, pairThrough, typeInBlock } = await import('./serveur-local.mjs');
  const data = mkdtempSync(join(tmpdir(), 'cirrus-captures-')), profile = mkdtempSync(join(tmpdir(), 'cirrus-captures-profil-'));
  const server = await localServer(), env = { CIRRUS_TINYTEX: tinyTex };
  let app = null;
  const shoot = async (name) => {
    if (!names.includes(name)) return;
    await app.page.evaluate(`document.documentElement.classList.add('capture'); document.activeElement?.blur()`);
    await app.page.move(1000, 18);
    await sleep(1000);
    writeFileSync(join(out, `${name}.png`), await app.page.screenshot());
    console.log(`${name}.png`);
    taken.push(name);
  };
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    fixHistoryTimes(data);
    app = await launch(data, profile, env);
    let page = app.page;
    await openServerBlock(page);
    await typeInBlock(page, 2, 'Portable');
    await shoot('serveur-non-jumele');
    await pairThrough(page, server.url, server.code('Captures'), 'Portable');
    if (!(await page.until(`!!document.querySelector('.server-offer button')`, 10_000))) throw new Error('pas d’offre d’envoyer la base de test');
    const send = await page.centre('.server-offer button', '^Envoyer la base');
    await page.click(send.x, send.y);
    const paired = `[...document.querySelectorAll('.server-block button')].some((b) => b.textContent === 'Dissocier ce PC')`;
    if (!(await page.until(paired, 30_000)) || !(await chipSays(page, 'À jour'))) throw new Error('la base de test n’est pas envoyée au serveur');
    await shoot('serveur-jumele');
    await closeSettings(page);
    await server.stop();
    if (!(await chipSays(page, 'Hors ligne'))) throw new Error('pas de pastille « Hors ligne » une fois le serveur arrêté');
    await shoot('pastille-hors-ligne');
    if (!(await app.quit())) throw new Error('l’app ne se ferme pas');
    app = null;
    const file = join(data, 'settings.json');
    const settings = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    writeFileSync(file, JSON.stringify({ ...settings, syncConnectTimeoutMs: 60_000 }), 'utf8');
    app = await launch(data, profile, env);
    page = app.page;
    if (!(await page.until(`!!document.querySelector('.sync-veil')`))) throw new Error('pas de voile au démarrage d’une base jumelée dont le serveur est arrêté');
    // Under the veil, the chip says « Connexion… » until the first attempt fails, then « Hors ligne ».
    if (!(await chipSays(page, 'Hors ligne'))) throw new Error('pas de pastille « Hors ligne » sous le voile, le serveur arrêté');
    await shoot('voile-synchronisation');
  } finally {
    await app?.close();
    await server.close();
    for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Plan 5b, task 8: the import dialog's new entries, then the states of a paired PC that plan 5b added, through DevTools
 * as serverCaptures (cdp.mjs, its window out of the user's way; each image once `.capture` is set, the focus taken, the
 * pointer on the tabs' bar), each state awaited before it is taken. Two sessions, each a fresh test base and profile:
 * - the dialog of « Importer une publication… » on the replayed answers (CIRRUS_PUBLICATIONS_REPLAY), opened on the sky
 *   as `import-publication`: the address of a page of OpenReview imported, its PDF read as a PDF dropped (« Créer le
 *   nœud »); then, opened again, « Choisir un PDF… » taking the arXiv PDF of the tests (CIRRUS_PDF_PICK), its identifier
 *   found;
 * - a PC paired with a server of this machine (serveur-local.mjs) by sending the test base, as serverCaptures, under
 *   the name « Bureau ». « Tout télécharger »'s question once the base's PDFs are taken out of its store (the server
 *   keeps them), the free space of its disk fixed (CIRRUS_FREE_BYTES: 48 Gio); the block once they are downloaded, the
 *   server's state under the synchronisation's (its values live, not drawn: `volatile`). Then a virtual PC paired as
 *   « Portable » (tests/support/virtualPc.ts, in this process) adds to MDL a note.tex and a conflict copy of it, of a
 *   fixed name: their comparison; note.tex open on « Portable », since 14h32 by the server's clock (serveur.db fixed:
 *   the banner reads the same at every capture), opened in full screen here; and, « Portable » having closed it, note.tex
 *   typed in here while « Portable » writes another version: the banner of D6. The .tex compiled by the bench's TinyTeX;
 *   texSaveIdleMs at its longest, so that nothing typed is saved before the image.
 * The names of the images taken go to `taken`.
 */
const PLAN5B_DIALOG_SCENES = ['import-adresse', 'choisir-pdf'];
const PLAN5B_SERVER_SCENES = ['tout-telecharger', 'serveur-etat', 'comparaison', 'tex-ouvert-ailleurs', 'tex-version-ailleurs'];
const PLAN5B_SCENES = [...PLAN5B_DIALOG_SCENES, ...PLAN5B_SERVER_SCENES];
const ARXIV_PDF = join(appDir, 'tests', 'data', 'publications', 'arxiv-1706.03762.pdf');
const MDL = 'Minimum Description Length Principle (MDL)';
const TEX = 'note.tex', COPY = 'note (conflit du 2026-01-05 14h32).tex';
const texLines = (last) => [
  '\\section{Longueur de description}', 'Pour un modèle $M$ et des données $D$, on cherche', '\\begin{equation}',
  '  L(M) + L(D \\mid M)', '\\end{equation}', 'le plus court des deux codes.', '', 'La première partie mesure le modèle,',
  'la seconde ce qu’il laisse inexpliqué.', '', 'Un modèle trop riche paie sa propre longueur ;', 'un modèle trop pauvre paie les données.',
  '', last, '',
].join('\n');

/** A capture taken in `app` (cdp.mjs) once the capture's class is set, the focus taken, the pointer on the tabs' bar. */
function shooter(names, taken, appOf) {
  return async (name) => {
    if (!names.includes(name)) return;
    const { page } = appOf();
    const { sleep } = await import('./cdp.mjs');
    await page.evaluate(`document.documentElement.classList.add('capture'); document.activeElement?.blur()`);
    await page.move(1000, 18);
    await sleep(1000);
    writeFileSync(join(out, `${name}.png`), await page.screenshot());
    console.log(`${name}.png`);
    taken.push(name);
  };
}

async function plan5bCaptures(names, taken) {
  const { launch, sleep } = await import('./cdp.mjs');
  const { chipSays, closeSettings, localServer, openServerBlock, pairThrough, virtualPc } = await import('./serveur-local.mjs');
  const fresh = (settings) => {
    const data = mkdtempSync(join(tmpdir(), 'cirrus-captures-')), profile = mkdtempSync(join(tmpdir(), 'cirrus-captures-profil-'));
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    fixHistoryTimes(data);
    if (settings) writeFileSync(join(data, 'settings.json'), JSON.stringify(settings), 'utf8');
    return { data, profile, done: () => { for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 }); } };
  };
  /** No notification left over the window, within `ms`. */
  const quiet = async (page, ms = 15_000) => {
    if (!(await page.until(`!document.querySelector('.toast')`, ms))) throw new Error(`une notification reste : ${await page.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`)}`);
  };
  let app = null;
  const shoot = shooter(names, taken, () => app);

  if (PLAN5B_DIALOG_SCENES.some((n) => names.includes(n))) {
    const base = fresh();
    try {
      app = await launch(base.data, base.profile, {
        CIRRUS_TINYTEX: tinyTex, CIRRUS_VIEW: '-420,-300,1', CIRRUS_PUBLICATIONS_REPLAY: join(appDir, 'tests', 'data', 'publications'), CIRRUS_PDF_PICK: ARXIV_PDF,
      });
      const { page } = app;
      /** The dialog opened from the sky's menu, as import-publication (1530, 72 in the graph, under the tabs). */
      const openDialog = async () => {
        for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(1530, 110, 'right');
        const item = await page.centre('.context-menu button', 'Importer une publication');
        await page.click(item.x, item.y);
        if (!(await page.until(`document.activeElement?.matches('.publication-dialog input') === true`))) throw new Error('le dialogue d’import ne s’ouvre pas');
      };
      const status = () => page.evaluate(`document.querySelector('.publication-dialog .status')?.textContent ?? null`);
      await openDialog();
      await page.type('https://openreview.net/forum?id=YicbFdNTTy');
      await page.press('Enter', 'Enter', 13);
      if (!(await page.until(`!!document.querySelector('.publication-dialog button.create') && !document.querySelector('.publication-dialog button.pick').disabled`, 15_000))) {
        throw new Error(`l’adresse d’OpenReview ne mène pas à « Créer le nœud » : « ${await status()} »`);
      }
      await quiet(page);
      await shoot('import-adresse');
      const close = await page.centre('.publication-dialog button.cancel', 'Fermer');
      await page.click(close.x, close.y);
      if (!(await page.until(`!document.querySelector('.publication-dialog')`))) throw new Error('le dialogue ne se ferme pas');
      await openDialog();
      const pick = await page.centre('.publication-dialog button.pick', 'Choisir un PDF');
      await page.click(pick.x, pick.y);
      if (!(await page.until(`document.querySelector('.publication-dialog input')?.value === 'arXiv:1706.03762' && !document.querySelector('.publication-dialog button.pick').disabled`, 15_000))) {
        throw new Error(`l’identifiant n’est pas trouvé dans le PDF choisi : « ${await status()} »`);
      }
      await quiet(page);
      await shoot('choisir-pdf');
    } finally {
      await app?.close();
      app = null;
      base.done();
    }
  }

  if (PLAN5B_SERVER_SCENES.some((n) => names.includes(n))) {
    const base = fresh({ texSaveIdleMs: 600_000 });
    const server = await localServer();
    let virtual = null;
    try {
      app = await launch(base.data, base.profile, { CIRRUS_TINYTEX: tinyTex, CIRRUS_VIEW: '0,140,1', CIRRUS_FREE_BYTES: String(48 * 2 ** 30) });
      const { page } = app;
      await pairThrough(page, server.url, server.code('Bureau'), 'Bureau');
      if (!(await page.until(`!!document.querySelector('.server-offer button')`, 10_000))) throw new Error('pas d’offre d’envoyer la base de test');
      const send = await page.centre('.server-offer button', '^Envoyer la base');
      await page.click(send.x, send.y);
      const paired = `[...document.querySelectorAll('.server-block button')].some((b) => b.textContent === 'Dissocier ce PC')`;
      if (!(await page.until(paired, 30_000)) || !(await chipSays(page, 'À jour'))) throw new Error('la base de test n’est pas envoyée au serveur');
      // « Tout télécharger »: the PDFs the base refers to (the nodes' folders, the anchors of the annotations) taken out of
      // this PC's store, the server keeping them.
      const db = new DatabaseSync(join(base.data, 'cirrus.db'), { readOnly: true });
      let hashes;
      try {
        const nodes = db.prepare('SELECT json FROM nodes WHERE trashed = 0').all().map((r) => JSON.parse(r.json));
        hashes = new Set([...nodes.flatMap((n) => n.files.filter((f) => /\.pdf$/i.test(f.name)).map((f) => f.hash)), ...nodes.filter((n) => n.anchor).map((n) => n.anchor.hash)]);
      } finally {
        db.close();
      }
      for (const h of hashes) {
        if (!server.hasBlob(h)) throw new Error(`le serveur n’a pas le PDF ${h}`);
        rmSync(join(base.data, 'files', h.slice(0, 2), h), { force: true });
      }
      await openServerBlock(page);
      const all = await page.centre('.server-block .server-download button', 'Télécharger tous les PDF');
      await page.click(all.x, all.y);
      const said = (re) => `[...document.querySelectorAll('.server-block .server-state')].some((p) => ${re}.test(p.textContent))`;
      if (!(await page.until(said(/^\d+ PDF à télécharger, .+ ; 48,0\sGo libres sur ce disque\.$/), 10_000))) {
        throw new Error(`pas de question de « Tout télécharger » : « ${await page.evaluate(`document.querySelector('.server-block')?.textContent`)} »`);
      }
      await quiet(page);
      await shoot('tout-telecharger');
      const go = await page.centre('.server-block .server-download button', '^Télécharger$');
      await page.click(go.x, go.y);
      if (!(await page.until(said(/^\d+ PDF téléchargés?\.$/), 30_000))) throw new Error(`« Tout télécharger » ne finit pas : « ${await page.evaluate(`document.querySelector('.server-block')?.textContent`)} »`);
      // The server's state known: its latency measured, its store counted.
      if (!(await page.until(`[...document.querySelectorAll('.server-block .server-state')].some((p) => /^Latence : \\d/.test(p.textContent))`, 15_000))) throw new Error('la latence du serveur n’est pas dite');
      await quiet(page);
      await shoot('serveur-etat');
      await closeSettings(page);
      // « Portable »: a virtual PC that receives the base, then adds note.tex and a conflict copy of it to MDL.
      virtual = await virtualPc(server, 'portable', { presence: true, name: 'Portable' });
      const pc = virtual.pc;
      const mdlOf = () => [...pc.s.nodes.values()].find((n) => n.title === MDL && n.trashedAt === undefined);
      for (let i = 0; i < 100 && !(mdlOf() && pc.status?.state === 'live'); i++) await sleep(100);
      const mdl = mdlOf()?.id;
      if (!mdl) throw new Error('le PC virtuel ne reçoit pas la base de test');
      const { editNode } = await import('@cirrus/core');
      const { storeBytes } = await import('@cirrus/store');
      const write = (name, text) => {
        const ref = storeBytes(pc.dir, name, Buffer.from(text, 'utf8'));
        pc.act((s) => {
          const files = s.nodes.get(mdl).files;
          return editNode(s, mdl, { files: files.some((f) => f.name === name) ? files.map((f) => (f.name === name ? ref : f)) : [...files, ref] });
        });
      };
      write(TEX, texLines('Le meilleur modèle minimise la somme.'));
      write(COPY, texLines('Le meilleur modèle minimise la somme des deux longueurs.'));
      // MDL's pop-up (175, 140 in the world: 967, 499 in the page), the copy's row, « Comparer ».
      const shown = `document.querySelector('.node-popup input.title')?.value === ${JSON.stringify(MDL)}`;
      for (let i = 0; i < 10 && !(await page.until(shown, 1000)); i++) await page.dblclick(967, 499);
      const copyRow = `.node-popup .file[data-name="${COPY}"]`;
      if (!(await page.until(`!!document.querySelector('${copyRow} .compare')`, 15_000))) throw new Error('le pop-up de MDL ne propose pas « Comparer » sur la copie');
      await page.evaluate(`document.querySelector('${copyRow}').scrollIntoView({ block: 'center' })`);
      const compare = await page.centre(`${copyRow} .compare`, 'Comparer');
      await page.click(compare.x, compare.y);
      const side = (s) => `[...document.querySelectorAll('.compare-view .cm-merge-${s} .cm-line')].map((l) => l.textContent).join('\\n')`;
      if (!(await page.until(`(${side('a')}).includes('minimise la somme.') && (${side('b')}).includes('des deux longueurs') && !!document.querySelector('.compare-view .cm-merge-revert button')`, 15_000))) {
        throw new Error(`la comparaison ne s’ouvre pas : « ${await page.evaluate(`document.querySelector('.compare-view')?.textContent ?? '(pas de plein écran)'`)} »`);
      }
      await quiet(page);
      await shoot('comparaison');
      await page.press('Escape', 'Escape', 27);
      if (!(await page.until(`!document.querySelector('.compare-view')`))) throw new Error('Échap ne ferme pas la comparaison');
      /** note.tex in full screen from MDL's pop-up (its preview, then ⤢), its text in the editor and its PDF drawn. */
      const editor = `[...document.querySelectorAll('.full-screen .tex-source .cm-line')].map((l) => l.textContent).join('\\n')`;
      const settled = `!!document.querySelector('.full-screen .tex-preview .pdf-page canvas') && document.querySelector('.full-screen .tex-status .compile')?.textContent === ''`;
      const openTex = async () => {
        const row = `.node-popup .file[data-name="${TEX}"]`;
        const expand = `[...document.querySelectorAll('.file-preview')].find((p) => p.querySelector('.title')?.textContent === '${TEX}')?.querySelector('.expand')`;
        if (!(await page.evaluate(`!!${expand}`))) {
          await page.evaluate(`document.querySelector('${row}').scrollIntoView({ block: 'center' })`);
          const at = await page.centre(row, '');
          await page.click(at.x, at.y);
          if (!(await page.until(`!!${expand}`, 10_000))) throw new Error('pas d’aperçu de note.tex');
        }
        const at = await page.evaluate(`(() => { const b = ${expand}.getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; })()`);
        await page.click(at.x, at.y);
        if (!(await page.until(`(${editor}).includes('Longueur de description') && ${settled}`, 20_000))) throw new Error('note.tex ne s’ouvre pas en plein écran, ou ne se compile pas');
      };
      const banner = `document.querySelector('.full-screen .tex-workbench .viewer-banner')?.textContent ?? ''`;
      // note.tex open on « Portable », since 14h32 today by the server's clock; then opened here.
      pc.openTex.push({ node: mdl, name: TEX });
      await pc.client.presence();
      const at1432 = new Date();
      at1432.setHours(14, 32, 30, 0);
      if (server.fixPresenceSince(at1432.getTime()) < 1) throw new Error('la présence de « Portable » n’est pas au serveur');
      await openTex();
      if (!(await page.until(`(${banner}) === 'Ce .tex est ouvert sur « Portable » depuis 14h32 : sa dernière version y est peut-être restée.'`, 10_000))) {
        throw new Error(`le bandeau dit « ${await page.evaluate(banner)} »`);
      }
      await quiet(page);
      await shoot('tex-ouvert-ailleurs');
      await page.press('Escape', 'Escape', 27);
      if (!(await page.until(`!document.querySelector('.full-screen')`))) throw new Error('Échap ne ferme pas le plein écran');
      // « Portable » closes it; here, a line typed, then « Portable » writes another version: the banner of D6.
      pc.openTex.length = 0;
      await pc.client.presence();
      await openTex();
      if ((await page.evaluate(banner)) !== '') throw new Error(`un bandeau reste : « ${await page.evaluate(banner)} »`);
      const line = await page.centre('.full-screen .tex-source .cm-line', 'minimise la somme');
      await page.click(line.x, line.y);
      await page.press('End', 'End', 35);
      await page.type(' Ici, la somme est le critère.');
      write(TEX, texLines('Le meilleur modèle minimise la somme, écrit sur « Portable ».'));
      if (!(await page.until(`(${banner}).startsWith('« note.tex » a aussi été modifié sur un autre PC')`, 10_000))) throw new Error(`le bandeau dit « ${await page.evaluate(banner)} »`);
      // Past the typing pause (latexTypingPauseMs), the text typed compiled and drawn.
      await sleep(800);
      if (!(await page.until(`(${editor}).includes('Ici, la somme est le critère.') && ${settled}`, 10_000))) throw new Error('le texte tapé ne se compile pas');
      await quiet(page);
      await shoot('tex-version-ailleurs');
    } finally {
      await app?.close();
      app = null;
      await virtual?.close();
      await server.close();
      base.done();
    }
  }
}

/**
 * Plan 6a, task 6: its box, question and panels, through DevTools as plan5bCaptures (cdp.mjs: the window out of the user's
 * way; each image once `.capture` is set, the focus taken, the pointer on the tabs' bar), in one session on a fresh test
 * base whose trash holds, besides its note, the connection « Même mesure » and the annotation of page 2, thrown away
 * beforehand by the core's commands as the app would (throwAway), every date of the trash its history's (fixTrashTimes):
 * - recherche: Ctrl+K, « induction » typed: the results and their places, the ring around those of the lobby;
 * - voir-ailleurs: MDL's menu, « Voir dans un autre plan »: the question naming « Article MDL » and « Thèse »;
 * - registre-tags: « Registre des tags… » from the background's menu: the keys declared, then those only carried;
 * - enumeration: « statut_epistémique » opened, a value added and named, not saved;
 * - corbeille: « Corbeille… »: an annotation, a connection and a node, the most recent first, with their dates.
 * A connection's tags, its pop-up's section, are already in plan6a/fenetre-connexion (task 3b). The names of the images
 * taken go to `taken`.
 */
const PLAN6A_SCENES = ['recherche', 'voir-ailleurs', 'registre-tags', 'enumeration', 'corbeille'];
async function plan6aCaptures(names, taken) {
  const { launch } = await import('./cdp.mjs');
  const data = mkdtempSync(join(tmpdir(), 'cirrus-captures-')), profile = mkdtempSync(join(tmpdir(), 'cirrus-captures-profil-'));
  let app = null;
  const shoot = shooter(names, taken, () => app);
  try {
    execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), data], { stdio: 'ignore' });
    await throwAway(data);
    fixHistoryTimes(data);
    fixTrashTimes(data);
    app = await launch(data, profile, { CIRRUS_TINYTEX: tinyTex, CIRRUS_VIEW: '0,140,1' });
    const { page } = app;
    const click = async (selector, text = '') => { const at = await page.centre(selector, text); await page.click(at.x, at.y); };
    const menuAt = async (x, y) => {
      for (let i = 0; i < 10 && !(await page.until(`!!document.querySelector('.context-menu')`, 1000)); i++) await page.click(x, y, 'right');
      if (!(await page.evaluate(`!!document.querySelector('.context-menu')`))) throw new Error(`pas de menu en (${x}, ${y})`);
    };
    const quiet = async () => {
      if (!(await page.until(`!document.querySelector('.toast')`, 15_000))) throw new Error(`une notification reste : ${await page.evaluate(`[...document.querySelectorAll('.toast')].map((t) => t.textContent).join(' | ')`)}`);
    };
    const rows = (selector) => page.evaluate(`[...document.querySelectorAll(${JSON.stringify(selector)})].map((e) => e.textContent)`);

    // The search: the box, its results and their places; the lobby's ringed in the graph.
    const field = `document.activeElement?.matches('.search-box .search-field') === true`;
    for (let i = 0; i < 10 && !(await page.until(field, 1000)); i++) await page.press('k', 'KeyK', 75, 2);
    if (!(await page.evaluate(field))) throw new Error('Ctrl+K n’ouvre pas la recherche');
    await page.type('induction');
    if (!(await page.until(`document.querySelectorAll('.search-box .search-results li').length >= 3 && !document.querySelector('.search-box .search-status')`, 10_000))) {
      throw new Error(`la recherche de « induction » montre ${JSON.stringify(await rows('.search-box .search-results li'))}`);
    }
    await quiet();
    await shoot('recherche');
    await page.evaluate(`document.querySelector('.search-box .search-field').focus()`);
    await page.press('Escape', 'Escape', 27);
    if (!(await page.until(`!document.querySelector('.search-box')`))) throw new Error('Échap ne ferme pas la recherche');

    // « Voir dans un autre plan » for MDL (175, 140 in the world: 967, 499 in the page), in two other plans: the question.
    await menuAt(967, 499);
    await click('.context-menu button', '^Voir dans un autre plan$');
    if (!(await page.until(`!!document.querySelector('.ask')`))) throw new Error('pas de question pour les autres plans de MDL');
    const choices = await rows('.ask .choices button');
    if (JSON.stringify(choices) !== JSON.stringify(['Article MDL', 'Thèse', 'Annuler'])) throw new Error(`la question montre ${JSON.stringify(choices)}`);
    await quiet();
    await shoot('voir-ailleurs');
    await click('.ask .choices button', '^Annuler$');
    if (!(await page.until(`!document.querySelector('.ask')`))) throw new Error('la question reste ouverte');

    // The tag registry, from the background's menu (the sky at the bottom left), then an enumeration being edited.
    await menuAt(250, 850);
    await click('.context-menu button', '^Registre des tags');
    if (!(await page.until(`!!document.querySelector('aside.registry .key')`))) throw new Error('le registre des tags ne s’ouvre pas');
    await quiet();
    await shoot('registre-tags');
    await click('.registry .key[data-key="statut_epistémique"]');
    if (!(await page.until(`document.querySelector('.registry .key-title')?.textContent === 'statut_epistémique'`))) throw new Error('le formulaire de statut_epistémique ne s’ouvre pas');
    await click('.registry button.add');
    if (!(await page.until(`document.activeElement?.matches('.registry .value-name') === true`))) throw new Error('la valeur ajoutée n’a pas le focus');
    await page.type('réfuté');
    await quiet();
    await shoot('enumeration');

    // The trash, which takes the registry's place (its draft let go, as at its cross).
    await menuAt(250, 850);
    await click('.context-menu button', '^Corbeille…$');
    if (!(await page.until(`document.querySelectorAll('aside.trash .item').length === 3`))) throw new Error(`la corbeille montre ${JSON.stringify(await rows('aside.trash .item'))}`);
    await quiet();
    await shoot('corbeille');
  } finally {
    await app?.close();
    for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
  }
}

/**
 * Plan 6a's captures: the connection « Même mesure » and the annotation of page 2 (« Un code est préfixe… », in no plan)
 * thrown away in the test base in `dir`, by the core's commands (deleteConnection, deleteEverywhere), each one action of
 * the journal as the app writes it; its lock is not taken: no Cirrus has the base open yet.
 */
async function throwAway(dir) {
  const { LocalStore } = await import('@cirrus/store');
  const { applyOps, deleteConnection, deleteEverywhere } = await import('@cirrus/core');
  const store = LocalStore.open(dir, { pc: 'fixture' });
  try {
    const s = store.loadState();
    const run = (a) => { store.commit(a); applyOps(s, a.ops); };
    const measure = [...s.connections.values()].find((c) => c.title === 'Même mesure');
    const annotation = [...s.nodes.values()].find((n) => n.anchor !== undefined && n.title.startsWith('Un code est préfixe'));
    if (!measure || !annotation) throw new Error('la base de test n’a pas « Même mesure » ou l’annotation de la page 2');
    run(deleteConnection(s, measure.id));
    run(deleteEverywhere(s, annotation.id));
  } finally {
    store.close();
  }
}

/**
 * Every date of the trash its history's (after fixHistoryTimes): the moment each node or connection went there is its
 * journal's, in its record and in the line that wrote it, so that the trash's panel reads the same at every capture.
 */
function fixTrashTimes(dir) {
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  try {
    db.exec(`UPDATE changes SET op = json_set(op, '$.after.trashedAt', at) WHERE json_extract(op, '$.after.trashedAt') IS NOT NULL;
      UPDATE nodes SET json = json_set(json, '$.trashedAt', (SELECT MAX(at) FROM changes WHERE subject = nodes.id AND json_extract(op, '$.after.trashedAt') IS NOT NULL)) WHERE trashed = 1;
      UPDATE connections SET json = json_set(json, '$.trashedAt', (SELECT MAX(at) FROM changes WHERE subject = connections.id AND json_extract(op, '$.after.trashedAt') IS NOT NULL)) WHERE trashed = 1;`);
  } finally {
    db.close();
  }
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
const serverChosen = only ? SERVER_SCENES.filter((n) => only.includes(n)) : SERVER_SCENES;
const plan5bChosen = only ? PLAN5B_SCENES.filter((n) => only.includes(n)) : PLAN5B_SCENES;
const plan6aChosen = only ? PLAN6A_SCENES.filter((n) => only.includes(n)) : PLAN6A_SCENES;
if (only && chosen.length + serverChosen.length + plan5bChosen.length + plan6aChosen.length !== only.length) {
  const known = (n) => SCENES.some((s) => s.name === n) || SERVER_SCENES.includes(n) || PLAN5B_SCENES.includes(n) || PLAN6A_SCENES.includes(n);
  console.error(`Scènes inconnues : ${only.filter((n) => !known(n)).join(', ')}.`);
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
if (serverChosen.length > 0) {
  const taken = [];
  try {
    await serverCaptures(serverChosen, taken);
  } catch (e) {
    console.error(`captures du bloc « Serveur » et d’un PC jumelé : échec après ${taken.length} image(s) (${e instanceof Error ? e.message : String(e)})`);
  }
  failed += serverChosen.length - taken.length;
}
if (plan5bChosen.length > 0) {
  const taken = [];
  try {
    await plan5bCaptures(plan5bChosen, taken);
  } catch (e) {
    console.error(`captures du plan 5b : échec après ${taken.length} image(s) (${e instanceof Error ? e.message : String(e)})`);
  }
  failed += plan5bChosen.length - taken.length;
}
if (plan6aChosen.length > 0) {
  const taken = [];
  try {
    await plan6aCaptures(plan6aChosen, taken);
  } catch (e) {
    console.error(`captures du plan 6a : échec après ${taken.length} image(s) (${e instanceof Error ? e.message : String(e)})`);
  }
  failed += plan6aChosen.length - taken.length;
}
const total = chosen.length + serverChosen.length + plan5bChosen.length + plan6aChosen.length;
console.log(`${total - failed} captures sur ${total} dans ${out}`);
process.exit(failed > 0 ? 1 : 0);
