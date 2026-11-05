import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteEverywhere, type FileRef, type Id, moveNodes, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { filePath, LocalStore } from '@cirrus/store';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { afterEach, expect, test, vi } from 'vitest';
import { historySummary, storeText } from '../src/main/files.ts';
import { PdfCache } from '../src/main/latex/cache.ts';
import { LatexService } from '../src/main/latex/compiler.ts';
import { findBinaries } from '../src/main/latex/tinytex.ts';
import { fileKind } from '../src/renderer/files/kind.ts';
import { LatexRegistry } from '../src/renderer/latex/registry.ts';
import { buildRequest } from '../src/renderer/latex/request.ts';
import { EditSession } from '../src/renderer/session.ts';
import { saveTex, SaveScheduler, texMergeKey } from '../src/renderer/ui/latex/saveScheduler.ts';
import { readPdf } from './latexPdf.ts';

const MAX = 200 * 2 ** 20;
const TEX = 'complexité.tex';
const MDL = 'Minimum Description Length Principle (MDL)';

// --- SaveScheduler, its clock vitest's (Review Focus 4)

/** A scheduler over `saved`, its saves recorded and answered from `answers` (accepted once they run out). */
function scheduling(saved = 'v0', answers: boolean[] = []) {
  const saves: string[] = [];
  const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const s = new SaveScheduler(saved, async (text) => {
    saves.push(text);
    const ok = answers.shift() ?? true;
    return ok ? { ok } : { ok, message: 'Ce nœud n’existe plus.' };
  }, timers, () => 10_000);
  return { s, saves };
}

// The scheduler's tests run on vitest's clock; the others on the real one.
afterEach(() => { vi.useRealTimers(); });

test('SaveScheduler : des frappes puis 10 s de pause, un seul enregistrement, aucun avant la fin de la pause', async () => {
  vi.useFakeTimers();
  const { s, saves } = scheduling();
  for (const text of ['v0 a', 'v0 ab', 'v0 abc']) {
    s.edit(text);
    await vi.advanceTimersByTimeAsync(3000);
  }
  expect(saves).toEqual([]);
  expect(s.dirty).toBe(true);
  await vi.advanceTimersByTimeAsync(6999);
  expect(saves).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(saves).toEqual(['v0 abc']);
  expect(s.dirty).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(saves).toHaveLength(1);
});

test('SaveScheduler : taper puis revenir au texte enregistré n’enregistre rien, ni à la pause ni à flush', async () => {
  vi.useFakeTimers();
  const { s, saves } = scheduling();
  s.edit('v0 x');
  s.edit('v0');
  expect(s.dirty).toBe(false);
  await vi.advanceTimersByTimeAsync(20_000);
  await s.flush();
  await s.saveNow();
  expect(saves).toEqual([]);
});

test('SaveScheduler : Ctrl+S enregistre aussitôt, flush enregistre ce qui reste ; l’état suit', async () => {
  vi.useFakeTimers();
  const { s, saves } = scheduling();
  const states: unknown[] = [];
  s.onState((st) => states.push(st));
  s.edit('v1');
  await s.saveNow();
  expect(saves).toEqual(['v1']);
  // The pause armed by the edit is dropped: no second save.
  await vi.advanceTimersByTimeAsync(20_000);
  expect(saves).toEqual(['v1']);
  s.edit('v2');
  await vi.advanceTimersByTimeAsync(2000);
  await s.flush();
  expect(saves).toEqual(['v1', 'v2']);
  expect(s.dirty).toBe(false);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(saves).toHaveLength(2);
  expect(states.at(-1)).toEqual({ dirty: false, saving: false, saved: true, failure: null });
});

test('SaveScheduler : un refus garde dirty et le dit ; le suivant réessaie', async () => {
  vi.useFakeTimers();
  const { s, saves } = scheduling('v0', [false]);
  let last: unknown = null;
  s.onState((st) => { last = st; });
  s.edit('v1');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(saves).toEqual(['v1']);
  expect(s.dirty).toBe(true);
  expect(last).toEqual({ dirty: true, saving: false, saved: false, failure: 'Ce nœud n’existe plus.' });
  // No retry on its own: the next save does.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(saves).toHaveLength(1);
  await s.flush();
  expect(saves).toEqual(['v1', 'v1']);
  expect(last).toEqual({ dirty: false, saving: false, saved: true, failure: null });
});

test('SaveScheduler : une frappe pendant un enregistrement est enregistrée ensuite, jamais deux à la fois', async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const saves: string[] = [];
  let running = 0, most = 0;
  const s = new SaveScheduler('v0', async (text) => {
    saves.push(text);
    most = Math.max(most, ++running);
    await new Promise<void>((r) => { release = r; });
    running--;
    return { ok: true };
  }, { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, () => 10_000);
  s.edit('v1');
  const first = s.saveNow();
  await vi.advanceTimersByTimeAsync(0);
  // Typed while v1 is being saved: still dirty, saved once v1 is.
  s.edit('v2');
  expect(s.dirty).toBe(true);
  const second = s.flush();
  await vi.advanceTimersByTimeAsync(0);
  expect(saves).toEqual(['v1']);
  release();
  await first;
  await vi.advanceTimersByTimeAsync(0);
  release();
  await second;
  expect([saves, most, s.dirty]).toEqual([['v1', 'v2'], 1, false]);
});

// --- Saving a .tex through the session, on a test base

/** A fixture base of its own, and a session over it as the app has one (its commits written by the store). */
function opened() {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-texsave-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  const ids = buildFixture(store, dir);
  const s = store.loadState();
  const session = new EditSession(s, async (a) => store.commit(a), () => {}, store.lastSeq());
  const put = async (name: string, text: string) => storeText(dir, name, text, MAX);
  const save = (text: string, node: Id = ids.nodes.kolmogorov, name = TEX) => saveTex(session, put, node, name, text);
  const fileOf = (node: Id = ids.nodes.kolmogorov, name = TEX) => session.state.nodes.get(node)!.files.find((f) => f.name === name)!;
  const textOf = (f: FileRef) => readFileSync(filePath(dir, f), 'utf8');
  const changes = (node: Id = ids.nodes.kolmogorov) => historySummary(store.historyOf(node)).changes;
  /** The distinct actions of the journal lines written since `seq` labelled `label`. */
  const actionsSince = (seq: number, label = `Modifier « ${TEX} »`) => new Set(store.changesSince(seq).filter((r) => r.label === label).map((r) => r.actionId));
  return { dir, store, ids, s, session, save, fileOf, textOf, changes, actionsSince, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('trois enregistrements successifs de complexité.tex : un seul action_id, une seule modification, un seul Ctrl+Z qui revient au texte d’avant', async () => {
  const b = opened();
  try {
    const original = b.fileOf(), before = b.changes(), seq = b.store.lastSeq();
    for (const v of ['v1', 'v2', 'v3']) expect(await b.save(`${b.textOf(original)}% ${v}\n`)).toEqual({ ok: true });
    const v3 = b.fileOf();
    expect(b.textOf(v3)).toBe(`${b.textOf(original)}% v3\n`);
    // Kept in its place, under its name.
    expect(b.session.state.nodes.get(b.ids.nodes.kolmogorov)!.files.map((f) => f.name)).toEqual([TEX, 'schéma_compression.png']);
    const lines = b.store.changesSince(seq);
    expect(lines).toHaveLength(3);
    expect(new Set(lines.map((r) => r.actionId)).size).toBe(1);
    expect(lines.every((r) => r.label === `Modifier « ${TEX} »`)).toBe(true);
    expect(b.changes()).toBe(before + 1);
    // One undo step: back to the text before the first save; nothing else is undone.
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.fileOf()).toEqual(original);
    expect(b.textOf(b.fileOf())).toBe(b.textOf(original));
    expect(b.store.changesSince(seq).filter((r) => r.label.startsWith('Annuler')).map((r) => r.actionId)).toHaveLength(3);
    expect(new Set(b.store.changesSince(seq).filter((r) => r.label.startsWith('Annuler')).map((r) => r.actionId)).size).toBe(1);
    expect(await b.session.undo()).toEqual({ ok: false, message: 'Rien à annuler.' });
    // Every version stays in the store, as in the journal.
    expect(existsSync(filePath(b.dir, v3))).toBe(true);
  } finally {
    b.close();
  }
});

test('un déplacement de nœud entre deux enregistrements les sépare : deux modifications', async () => {
  const b = opened();
  try {
    const before = b.changes(), seq = b.store.lastSeq();
    await b.save('v1');
    expect((await b.session.run((st: State) => moveNodes(st, b.ids.plans.lobby, [{ node: b.ids.nodes.kolmogorov, x: -180, y: -150 }]))).ok).toBe(true);
    await b.save('v2');
    expect(b.actionsSince(seq).size).toBe(2);
    expect(b.changes()).toBe(before + 3);
    // Two steps to undo the two saves, the move between them.
    await b.session.undo();
    expect(b.textOf(b.fileOf())).toBe('v1');
  } finally {
    b.close();
  }
});

test('une annulation, ou l’enregistrement d’un autre .tex, entre deux enregistrements les sépare', async () => {
  const b = opened();
  try {
    const seq = b.store.lastSeq();
    await b.save('v1');
    expect((await b.session.undo()).ok).toBe(true);
    await b.save('v2');
    expect(b.actionsSince(seq).size).toBe(2);
    const other = b.store.lastSeq();
    await b.save('v3');
    expect(await b.save('Autre énoncé.', b.ids.nodes.mdl, 'Enoncé_détaillé.tex')).toEqual({ ok: true });
    await b.save('v4');
    expect(b.actionsSince(other).size).toBe(2);
    expect(b.actionsSince(other, 'Modifier « Enoncé_détaillé.tex »').size).toBe(1);
    // v3 joined v2 (nothing written between them); v4 is a step of its own.
    await b.session.undo();
    expect(b.textOf(b.fileOf())).toBe('v3');
  } finally {
    b.close();
  }
});

test('deux ouvertures successives du plein écran, sans rien entre elles, se regroupent', async () => {
  const b = opened();
  try {
    const original = b.textOf(b.fileOf()), before = b.changes(), seq = b.store.lastSeq();
    const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    for (const v of ['première ouverture', 'seconde ouverture']) {
      // Each opening has its scheduler, over the file's text as it is then; closing flushes it.
      const s = new SaveScheduler(b.textOf(b.fileOf()), (text) => b.save(text), timers, () => 10_000);
      s.edit(`${original}% ${v}\n`);
      await s.flush();
      expect(s.dirty).toBe(false);
    }
    expect(b.actionsSince(seq).size).toBe(1);
    expect(b.changes()).toBe(before + 1);
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.textOf(b.fileOf())).toBe(original);
  } finally {
    b.close();
  }
});

test('un enregistrement refusé — le nœud supprimé entre-temps — ne ressuscite rien, et le dit ; le texte reste à enregistrer', async () => {
  const b = opened();
  try {
    const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
    const s = new SaveScheduler(b.textOf(b.fileOf()), (text) => b.save(text), timers, () => 10_000);
    let failure: string | null = null;
    s.onState((st) => { failure = st.failure; });
    s.edit('texte tapé');
    expect((await b.session.run((st: State) => deleteEverywhere(st, b.ids.nodes.kolmogorov))).ok).toBe(true);
    const seq = b.store.lastSeq();
    await s.flush();
    expect([s.dirty, failure]).toEqual([true, 'Ce nœud n’existe plus.']);
    expect(b.store.lastSeq()).toBe(seq);
    // A file gone from a node still there: refused as well, not added again.
    expect(await b.save('x', b.ids.nodes.mdl, 'absent.tex')).toEqual({ ok: false, message: '« absent.tex » n’est plus dans ce nœud.' });
    // The same text as the file's: nothing to write, and saved.
    const mdlTex = b.fileOf(b.ids.nodes.mdl, 'Enoncé_détaillé.tex');
    expect(await b.save(b.textOf(mdlTex), b.ids.nodes.mdl, 'Enoncé_détaillé.tex')).toEqual({ ok: true });
    expect(b.store.lastSeq()).toBe(seq);
  } finally {
    b.close();
  }
});

test('texMergeKey : le nœud et le nom normalisé par sameName', () => {
  expect(texMergeKey('n1', 'Complexité.TEX')).toBe(texMergeKey('n1', 'complexite\u0301.tex'));
  expect(texMergeKey('n1', 'a.tex')).not.toBe(texMergeKey('n2', 'a.tex'));
  expect(texMergeKey('n1', 'a.tex')).toBe('tex:n1:a.tex');
});

// --- storeText: the main process's side

test('storeText : UTF-8 sans BOM, l’empreinte et la taille justes, un doublon reconnu ; un nom refusé, un texte trop long', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-storetext-'));
  try {
    const text = 'Énoncé : $x \\le y$.\n';
    const ref = storeText(dir, 'note.tex', `\uFEFF${text}`, MAX);
    const bytes = Buffer.from(text, 'utf8');
    expect(ref).toEqual({ name: 'note.tex', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length });
    expect(readFileSync(filePath(dir, ref))).toEqual(bytes);
    expect(storeText(dir, 'autre nom.tex', text, MAX)).toEqual({ ...ref, name: 'autre nom.tex' });
    expect(readdirSync(join(dir, 'files'), { recursive: true, withFileTypes: true }).filter((e) => e.isFile())).toHaveLength(1);
    for (const name of ['a/b.tex', '..', 'nul.tex', 'a\\b.tex', '', 'x.tex ']) expect(() => storeText(dir, name, text, MAX), name).toThrow();
    expect(() => storeText(dir, 'a/b.tex', text, MAX)).toThrow('Le caractère « / » n’est pas permis dans un nom de fichier.');
    expect(() => storeText(dir, 'nul.tex', text, MAX)).toThrow('« nul.tex » est un nom réservé par Windows.');
    expect(() => storeText(dir, 'gros.tex', 'é'.repeat(600), 1000)).toThrow(/plus de/);
    expect(() => storeText(dir, 3, text, MAX)).toThrow();
    expect(() => storeText(dir, 'a.tex', null, MAX)).toThrow();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- With pdfLaTeX (skipped without it)

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TINYTEX = process.env.CIRRUS_TINYTEX || join(repo, 'bench', 'latex', 'vendor', 'TinyTeX');
const hasTex = existsSync(join(TINYTEX, 'bin', 'windows', 'pdflatex.exe'));

test.skipIf(!hasTex)(hasTex ? 'pdfLaTeX : la requête de complexité.tex compile, et le PDF montre le titre de MDL' : `pdfLaTeX (sauté : pas de TinyTeX dans ${TINYTEX})`, async () => {
  const b = opened();
  const bins = await findBinaries(TINYTEX);
  const svc = new LatexService({
    binaries: async () => bins, root: join(b.dir, 'latex'), store: b.dir, params: () => DEFAULT_PARAMS, status: () => {},
    cache: new PdfCache(join(b.dir, 'latex', 'cache'), () => DEFAULT_PARAMS.latexCacheMb * 2 ** 20),
  });
  try {
    const s = b.session.state, texts = new Map<string, string>();
    for (const n of s.nodes.values()) for (const f of n.files) if (fileKind(f.name) === 'tex') texts.set(f.hash, b.textOf(f));
    const tex = b.fileOf();
    const req = buildRequest({
      origin: { kind: 'file', node: b.ids.nodes.kolmogorov, name: TEX }, source: texts.get(tex.hash)!, s, registry: LatexRegistry.build(s, texts), known: [],
    });
    const a = await svc.compile({ ...req, slot: `draft:${req.slot}` });
    if (a.status !== 'ok') throw new Error(JSON.stringify(a).slice(0, 2000));
    const pages = await readPdf(join(b.dir, 'latex', 'cache', `${a.pdf.key}.pdf`));
    expect(pages.map((p) => p.text).join(' ')).toContain(MDL);
  } finally {
    await svc.dispose();
    b.close();
  }
}, 60_000);
