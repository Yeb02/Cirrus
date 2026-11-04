import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, deleteEverywhere, type FileRef, invertAction, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { afterAll, afterEach, beforeAll, expect, test, vi } from 'vitest';
import { filesBuild, removeFileBuild, renameFileBuild } from '../src/renderer/actions.ts';
import { fileClick, fileDoubleClick, fileMenu, thumbFor } from '../src/renderer/files/nodeFiles.ts';
import { rangeHeader, ReadError, readHead } from '../src/renderer/files/read.ts';
import { ClickGuard } from '../src/renderer/ui/clickGuard.ts';
import { tabTarget } from '../src/renderer/ui/FullScreen.tsx';
import { placeBeside, type Rect } from '../src/renderer/ui/panels/geometry.ts';
import { type Panel, type PanelTarget, previewRect, resolveTarget, withFile } from '../src/renderer/ui/panels/Panels.tsx';
import { languageFor } from '../src/renderer/ui/viewers/language.ts';
import {
  clampView, columnOffsets, columnWidths, columnWindow, fitView, type ImageFrame, isFit, panBy, rowsNotice, rowWindow, toggleFit, truncationNotice, viewOf,
  zoomAt,
} from '../src/renderer/ui/viewers/views.ts';

// One test base for the whole file, never the user's: each test reads its state from the store again.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-viewers-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => { vi.unstubAllGlobals(); });

const MB = 2 ** 20;
const ref = (name: string, size: number, hash = 'a'.repeat(64)): FileRef => ({ name, hash, size });

test('rangeHeader : rien sous le plafond, les premiers octets au-delà (bytes=0-1048575 pour 1 Mo)', () => {
  expect(rangeHeader(0, MB)).toBeNull();
  expect(rangeHeader(812, MB)).toBeNull();
  expect(rangeHeader(MB, MB)).toBeNull();
  expect(rangeHeader(MB + 1, MB)).toBe('bytes=0-1048575');
  expect(rangeHeader(200 * MB, 32 * MB)).toBe(`bytes=0-${32 * MB - 1}`);
});

/** A fetch that answers `body` in chunks of `chunk` bytes, whatever the Range asked; records what it was asked. */
function fakeFetch(body: Uint8Array, chunk: number, status = 200) {
  const asked: { url: string; range: string | null }[] = [];
  let sent = 0;
  const fetch = vi.fn(async (url: string, init?: RequestInit) => {
    asked.push({ url, range: new Headers(init?.headers).get('range') });
    let at = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(c) {
        if (at >= body.length) { c.close(); return; }
        const part = body.subarray(at, at + chunk);
        at += part.length;
        sent += part.length;
        c.enqueue(part);
      },
    });
    return new Response(stream, { status });
  });
  return { fetch, asked, sent: () => sent };
}

test('readHead : la plage du plafond quand le fichier le dépasse, jamais plus que le plafond lu, même servi en entier', async () => {
  const bytes = new Uint8Array(10_000).map((_, i) => i % 251);
  const small = fakeFetch(bytes.subarray(0, 300), 64);
  vi.stubGlobal('fetch', small.fetch);
  const whole = await readHead(ref('a.txt', 300), 1000);
  expect(small.asked[0].range).toBeNull();
  expect(small.asked[0].url).toBe(`cirrus-file://blob/${'a'.repeat(64)}/a.txt`);
  expect(whole).toEqual({ bytes: bytes.subarray(0, 300), truncated: false });
  // A server that ignores the range (200, the whole file): the reading stops at the ceiling.
  const big = fakeFetch(bytes, 256);
  vi.stubGlobal('fetch', big.fetch);
  const head = await readHead(ref('a.txt', 10_000), 1000);
  expect(big.asked[0].range).toBe('bytes=0-999');
  expect(head.truncated).toBe(true);
  expect(head.bytes).toEqual(bytes.subarray(0, 1000));
  // At most a chunk read past the ceiling, and one the stream had queued.
  expect(big.sent()).toBeLessThanOrEqual(1000 + 2 * 256);
  // A blob missing from the store: refused, in French.
  vi.stubGlobal('fetch', fakeFetch(new Uint8Array(0), 1, 404).fetch);
  const missing = readHead(ref('a.txt', 3), 1000);
  await expect(missing).rejects.toBeInstanceOf(ReadError);
  await expect(missing).rejects.toThrow('« a.txt » est introuvable dans la base.');
});

test('la vue par genre : image, PDF, texte (tex compris, retour à la ligne pour txt, md et log seulement), tableau ; aucune pour un autre', () => {
  expect(viewOf('schéma_compression.png')).toEqual({ view: 'image' });
  expect(viewOf('Li_Vitányi_extrait.pdf')).toEqual({ view: 'pdf' });
  expect(viewOf('Enoncé_détaillé.tex')).toEqual({ view: 'text', wrap: false });
  expect(viewOf('calcul_mdl_séquence_aléatoire.py')).toEqual({ view: 'text', wrap: false });
  for (const name of ['notes_lecture.md', 'LISEZ-MOI.TXT', 'run.log']) expect(viewOf(name), name).toEqual({ view: 'text', wrap: true });
  expect(viewOf('mesures_compression.csv')).toEqual({ view: 'table' });
  expect(viewOf('mesures.tsv')).toEqual({ view: 'table' });
  expect(viewOf('présentation.pptx')).toBeNull();
  expect(viewOf('sans_extension')).toBeNull();
});

test('le langage par l’extension : LaTeX pour un tex, Python, Markdown, JSON pour un carnet ; aucun pour un texte', () => {
  expect(languageFor('Enoncé_détaillé.tex')?.name).toBe('LaTeX');
  expect(languageFor('calcul_mdl_séquence_aléatoire.py')?.name).toBe('Python');
  expect(languageFor('notes_lecture.md')?.name).toBe('Markdown');
  expect(languageFor('analyse.ipynb')?.name).toBe('JSON');
  expect(languageFor('LISEZ-MOI.txt')).toBeNull();
  expect(languageFor('run.log')).toBeNull();
});

test('les bandeaux d’une lecture tronquée', () => {
  expect(truncationNotice(32)).toBe('Seuls les 32 premiers Mo sont affichés.');
  expect(truncationNotice(1)).toBe('Seul le premier Mo est affiché.');
  expect(rowsNotice(100_000)).toBe('Seules les 100 000 premières lignes sont affichées.');
});

test('plein écran (Review Focus 5) : le fichier trouvé par son nom seulement — fermé quand il est retiré, même si un jumeau de même contenu reste, renommé, son ajout annulé ou le nœud supprimé', () => {
  const s: State = store.loadState(), mdl = ids.nodes.mdl;
  const notes = s.nodes.get(mdl)!.files.find((f) => f.name === 'notes_lecture.md')!;
  const full: PanelTarget = { kind: 'file', node: mdl, name: 'notes_lecture.md' };
  expect(resolveTarget(s, full)?.file).toEqual(notes);
  // A twin: the same content under another name (ruling I1 of the review).
  applyOps(s, filesBuild(s, mdl, [{ ...notes, name: 'copie_des_notes.md' }])!(s).ops);
  const twin: PanelTarget = { kind: 'file', node: mdl, name: 'copie_des_notes.md' };
  expect(resolveTarget(s, twin)?.file?.hash).toBe(notes.hash);
  // A new version in another case: found by its name, with its new content.
  const version = filesBuild(s, mdl, [{ name: 'Notes_Lecture.md', hash: 'b'.repeat(64), size: 9 }])!(s);
  applyOps(s, version.ops);
  expect(resolveTarget(s, full)?.file).toEqual({ name: 'Notes_Lecture.md', hash: 'b'.repeat(64), size: 9 });
  applyOps(s, invertAction(version).ops);
  expect(resolveTarget(s, full)?.file).toEqual(notes);
  // Taken out of the node: closed, though its twin holds the same content.
  const removal = removeFileBuild(mdl, 'notes_lecture.md')!(s);
  applyOps(s, removal.ops);
  expect(resolveTarget(s, full)).toBeNull();
  expect(resolveTarget(s, twin)?.file?.name).toBe('copie_des_notes.md');
  applyOps(s, invertAction(removal).ops);
  // Renamed: no longer the file opened under that name, closed too (ruling I1: the cost accepted).
  applyOps(s, renameFileBuild(mdl, 'notes_lecture.md', 'notes.md')!(s).ops);
  expect(resolveTarget(s, full)).toBeNull();
  // A file added, then the addition undone: closed.
  const added = filesBuild(s, mdl, [{ name: 'nouveau.txt', hash: 'c'.repeat(64), size: 3 }])!(s);
  applyOps(s, added.ops);
  const nouveau: PanelTarget = { kind: 'file', node: mdl, name: 'nouveau.txt' };
  expect(resolveTarget(s, nouveau)?.file?.size).toBe(3);
  applyOps(s, invertAction(added).ops);
  expect(resolveTarget(s, nouveau)).toBeNull();
  // The node deleted everywhere: every file of it closes.
  applyOps(s, deleteEverywhere(s, mdl).ops);
  expect(resolveTarget(s, { kind: 'file', node: mdl, name: 'Enoncé_détaillé.tex' })).toBeNull();
  expect(resolveTarget(s, twin)).toBeNull();
});

test('clic sur un fichier : l’aperçu, ou le système pour un autre genre, une fois ; le double-clic, le plein écran', () => {
  expect(fileClick('notes_lecture.md', 1)).toBe('preview');
  // HTMLElement.click(), as the captures click: no count.
  expect(fileClick('notes_lecture.md', 0)).toBe('preview');
  // A double-click's second click: the preview is open already.
  expect(fileClick('notes_lecture.md', 2)).toBeNull();
  expect(fileClick('présentation.pptx', 1)).toBe('system');
  expect(fileClick('présentation.pptx', 2)).toBeNull();
  expect(fileDoubleClick('schéma_compression.png')).toBe('full');
  expect(fileDoubleClick('mesures_compression.csv')).toBe('full');
  expect(fileDoubleClick('présentation.pptx')).toBeNull();
});

test('le clic qui ferme un menu est avalé partout, son double-clic aussi ; le clic suivant, un clic au clavier et le clic d’un autre appui passent (ruling I2)', () => {
  const g = new ClickGuard();
  const press = () => ({});
  // No menu: every click passes, a double-click too.
  let p = press();
  g.press(p);
  expect(g.click(1)).toBe(false);
  g.press(press());
  expect([g.click(2), g.dblclick()]).toEqual([false, false]);
  // A press closes a menu (in whatever pop-up or panel it lands): its click is swallowed, once.
  p = press();
  g.press(p);
  g.dismissedBy(p);
  expect(g.click(1)).toBe(true);
  expect(g.click(1)).toBe(false);
  // The same, followed by a second click: the double-click whose first click closed the menu is swallowed too.
  p = press();
  g.press(p);
  g.dismissedBy(p);
  expect(g.click(1)).toBe(true);
  g.press(press());
  expect([g.click(2), g.dblclick()]).toEqual([false, true]);
  // The next double-click passes.
  g.press(press());
  expect(g.click(1)).toBe(false);
  g.press(press());
  expect([g.click(2), g.dblclick()]).toEqual([false, false]);
  // A press that closed a menu then dragged away (no click): the next press's click passes, and a click of the keyboard
  // (detail 0) is never one that closed a menu.
  p = press();
  g.press(p);
  g.dismissedBy(p);
  expect(g.click(0)).toBe(false);
  g.press(press());
  expect(g.click(1)).toBe(false);
});

test('plein écran modal : Tab tourne en rond dans ses éléments, sans jamais en sortir', () => {
  // Three focusable elements: past the last back to the first, before the first to the last, inside left to the browser.
  expect(tabTarget(3, 2, false)).toBe(0);
  expect(tabTarget(3, 0, true)).toBe(2);
  expect(tabTarget(3, 0, false)).toBeNull();
  expect(tabTarget(3, 1, true)).toBeNull();
  // The focus on the full screen itself (or nowhere in it): to the first, or the last backwards.
  expect(tabTarget(3, -1, false)).toBe(0);
  expect(tabTarget(3, -1, true)).toBe(2);
  expect(tabTarget(1, 0, false)).toBe(0);
  expect(tabTarget(0, -1, false)).toBeNull();
});

test('vignette : l’image elle-même jusqu’à thumbMaxMb, au-delà l’icône de son genre ; rien pour un autre genre (ruling I3)', () => {
  const MB = 2 ** 20;
  expect(thumbFor({ name: 'schéma.png', hash: 'a'.repeat(64), size: 517 }, 4)).toBe('image');
  expect(thumbFor({ name: 'photo.JPG', hash: 'a'.repeat(64), size: 4 * MB }, 4)).toBe('image');
  expect(thumbFor({ name: 'photo.jpg', hash: 'a'.repeat(64), size: 4 * MB + 1 }, 4)).toBe('icon');
  // 0: no image is read for its thumbnail.
  expect(thumbFor({ name: 'schéma.png', hash: 'a'.repeat(64), size: 517 }, 0)).toBe('icon');
  expect(thumbFor({ name: 'notes.md', hash: 'a'.repeat(64), size: 517 }, 4)).toBeNull();
  expect(thumbFor({ name: 'article.pdf', hash: 'a'.repeat(64), size: 517 }, 4)).toBeNull();
});

test('le menu d’un fichier gagne « Ouvrir en plein écran » pour les genres que Cirrus affiche', () => {
  const labels = (name: string) => fileMenu(name).map((i) => i.label);
  expect(labels('schéma_compression.png')).toEqual(['Ouvrir en plein écran', 'Ouvrir avec l’application du système', 'Renommer', 'Retirer du nœud']);
  expect(labels('calcul_mdl_séquence_aléatoire.py')).toEqual(['Ouvrir en plein écran', 'Renommer', 'Retirer du nœud']);
  expect(labels('présentation.pptx')).toEqual(['Ouvrir avec l’application du système', 'Renommer', 'Retirer du nœud']);
});

test('aperçus : un fichier ouvert ferme l’autre aperçu non épinglé, garde les pop-ups et les épinglés, n’ouvre pas deux fois le même', () => {
  const at = (x: number): Rect => ({ x, y: 100, w: 560, h: 460 });
  const popup: Panel = { id: 1, target: { kind: 'node', node: 'n' }, rect: at(0), pinned: false, z: 1 };
  let ps = withFile([popup], 'n', 'a.md', at(400), 2);
  expect(ps.map((p) => [p.id, p.target, p.z])).toEqual([[1, popup.target, 1], [2, { kind: 'file', node: 'n', name: 'a.md' }, 2]]);
  // Another file: its preview replaces the loose one; the pop-up stays.
  ps = withFile(ps, 'n', 'b.py', at(400), 3);
  expect(ps.map((p) => p.id)).toEqual([1, 3]);
  // Pinned, a preview stays when another opens.
  ps = withFile(ps.map((p) => (p.id === 3 ? { ...p, pinned: true } : p)), 'n', 'c.csv', at(400), 4);
  expect(ps.map((p) => p.id)).toEqual([1, 3, 4]);
  // The same file again (in another case): no second preview, it comes in front where it was; the loose one closes.
  const again = withFile(ps, 'n', 'B.PY', at(999), 5);
  expect(again.map((p) => [p.id, p.rect.x, p.z])).toEqual([[1, 0, 1], [3, 400, 5]]);
});

test('placeBeside : l’aperçu à droite du pop-up, à gauche faute de place, aligné sur son haut et entier dans la fenêtre', () => {
  const bounds: Rect = { x: 0, y: 38, w: 1584, h: 923 };
  const size = { w: 560, h: 460 };
  expect(placeBeside({ x: 100, y: 200, w: 380, h: 460 }, size, bounds, 12)).toEqual({ x: 492, y: 200, w: 560, h: 460 });
  // No room on the right: on the left of the pop-up.
  expect(placeBeside({ x: 979, y: 473, w: 380, h: 460 }, size, bounds, 12)).toEqual({ x: 407, y: 473, w: 560, h: 460 });
  // Room on neither side: against the window's edge on the roomier side, over the pop-up.
  expect(placeBeside({ x: 500, y: 100, w: 700, h: 460 }, { w: 900, h: 460 }, bounds, 12).x).toBe(0);
  // previewRect: at its settings' size, never under panelMinPx.
  const r = previewRect({ x: 100, y: 200, w: 380, h: 460 }, { ...DEFAULT_PARAMS, previewWidthPx: 50 }, bounds);
  expect([r.x, r.w, r.h]).toEqual([492, DEFAULT_PARAMS.panelMinPx, DEFAULT_PARAMS.previewHeightPx]);
});

test('image : ajustée sans être agrandie (imageFitMaxZoom) ; la molette zoome autour du curseur ; le glissement reste dans l’image ; le double-clic passe au 1:1 et revient', () => {
  const f: ImageFrame = { image: { w: 2000, h: 1000 }, view: { w: 500, h: 500 }, maxZoom: 32, fitMaxZoom: 1 };
  const fit = fitView(f);
  expect(fit).toEqual({ zoom: 0.25, cx: 1000, cy: 500 });
  // Smaller than the view: shown at its size; enlarged only as far as the setting lets it.
  const icon = { ...f, image: { w: 32, h: 32 } };
  expect(fitView(icon)).toEqual({ zoom: 1, cx: 16, cy: 16 });
  expect(fitView({ ...icon, fitMaxZoom: 4 }).zoom).toBe(4);
  expect(fitView({ ...icon, fitMaxZoom: 100 }).zoom).toBe(500 / 32);
  // The image point under the cursor stays there.
  const at = { x: 100, y: 300 };
  const under = (v: { zoom: number; cx: number; cy: number }) => ({ x: v.cx + (at.x - 250) / v.zoom, y: v.cy + (at.y - 250) / v.zoom });
  const z = zoomAt(fit, f, at, 4);
  expect(z.zoom).toBe(1);
  expect(under(z).x).toBeCloseTo(under(fit).x);
  expect(under(z).y).toBeCloseTo(under(fit).y);
  // Never under the fit, never over the maximum.
  expect(zoomAt(fit, f, at, 0.5)).toEqual(fit);
  expect(zoomAt(z, f, at, 1e6).zoom).toBe(32);
  expect(isFit(fit, f) && !isFit(z, f)).toBe(true);
  // Dragged: the centre stays where the image still fills the view; an axis the view holds whole stays centred.
  const far = panBy(z, f, 1e5, 1e5);
  expect([far.cx, far.cy]).toEqual([250, 250]);
  expect(clampView({ zoom: 0.4, cx: 0, cy: 0 }, f)).toEqual({ zoom: 0.4, cx: 625, cy: 500 });
  // Double-click: fitted → 1:1 at the point; otherwise → fitted. An image shown at its size already stays so.
  const one = toggleFit(fit, f, at);
  expect(one).toEqual(z);
  expect(toggleFit(one, f, at)).toEqual(fit);
  expect(toggleFit(fitView(icon), icon, at)).toEqual(fitView(icon));
});

test('tableau : seules les lignes et les colonnes visibles, avec leur marge ; la largeur des colonnes par leur plus longue valeur, plafonnée', () => {
  // Rows of 24 px under a header of 24: a view of 240 px at the top shows rows 0 to 9.
  expect(rowWindow(0, 240, 24, 100_000, 0)).toEqual({ first: 0, last: 9 });
  expect(rowWindow(24 * 500, 240, 24, 100_000, 48)).toEqual({ first: 497, last: 511 });
  expect(rowWindow(24 * 99_995, 240, 24, 100_000, 0)).toEqual({ first: 99_994, last: 100_000 });
  expect(rowWindow(0, 240, 24, 0, 0)).toEqual({ first: 0, last: 0 });
  const offsets = columnOffsets([100, 50, 200, 80]);
  expect([...offsets]).toEqual([0, 100, 150, 350, 430]);
  expect(columnWindow(offsets, 0, 120, 0)).toEqual({ first: 0, last: 2 });
  expect(columnWindow(offsets, 160, 100, 0)).toEqual({ first: 2, last: 3 });
  expect(columnWindow(offsets, 0, 2000, 0)).toEqual({ first: 0, last: 4 });
  expect(columnWindow(offsets, 340, 10, 20)).toEqual({ first: 2, last: 4 });
  // A character is 7 px here; padding 16, at most 120.
  const rows = [['Éléments', 'Durée (s)', 'Remarque'], ['1000', '0,012', 'référence'], ['10', '1', 'fenêtre de 32 Ko; dictionnaire figé'], ['1', '2', '3', '4']];
  expect(columnWidths(rows, (s) => 7 * s.length, 120, 16)).toEqual([72, 79, 120, 23]);
});
