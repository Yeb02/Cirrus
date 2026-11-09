import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteEverywhere, type FileRef, isCopyOf, type State } from '@cirrus/core';
import { buildFixture } from '@cirrus/fixtures';
import { filePath, LocalStore } from '@cirrus/store';
import { afterEach, expect, test, vi } from 'vitest';
import { historySummary, storeText } from '../src/main/files.ts';
import { filesBuild, reconcileTexBuild, removeFileBuild } from '../src/renderer/actions.ts';
import { conflictOriginal } from '../src/renderer/files/merge.ts';
import { MB } from '../src/renderer/files/read.ts';
import { EditSession } from '../src/renderer/session.ts';
import { focusedChoice } from '../src/renderer/ui/Dialogs.tsx';
import {
  abandonQuestion, closingSave, compareTitle, copyKeptNotice, copyNotLoaded, copyReloadedNotice, originalNotLoaded, Reconciliation, readCompared,
  readNewVersion, reconcileTex, TOO_BIG, tooBigToCompare,
} from '../src/renderer/ui/latex/compare.ts';
import { changedElsewhere } from '../src/renderer/ui/latex/saveScheduler.ts';
import { texTextOf } from '../src/renderer/ui/latex/texText.ts';
import { resolveFull } from '../src/renderer/ui/screens.ts';

afterEach(() => { vi.unstubAllGlobals(); });

const MAX = 200 * MB;
const TEX = 'complexité.tex';
const COPY = 'complexité (conflit du 2026-11-09 14h32).tex';
const ref = (name: string, hash: string, size = 10): FileRef => ({ name, hash: hash.repeat(64).slice(0, 64), size });

// --- conflictOriginal: the original of a conflict copy, in the same node

test('conflictOriginal : l’original d’une copie de conflit, trouvé dans les fichiers du nœud', () => {
  const note = ref('note.tex', 'a'), copy = ref('note (conflit du 2026-11-09 14h32).tex', 'b'), png = ref('fig.png', 'c');
  expect(conflictOriginal([note, png, copy], copy)).toBe(note);
  // Not a copy of anything: no original.
  expect(conflictOriginal([note, png, copy], note)).toBeNull();
  expect(conflictOriginal([note, png, copy], png)).toBeNull();
  // The case and the Unicode form are the file names' own (fileNameKey): « Complexité.TEX », decomposed.
  const accented = ref('Complexité.TEX', 'a'), accentedCopy = ref('Complexité (conflit du 2026-11-09 14h32).TEX', 'b');
  expect(conflictOriginal([accented, accentedCopy], accentedCopy)).toBe(accented);
});

test('conflictOriginal : une copie « (2) », dont le nom était pris, a le même original ; un original que la copie d’avant n’est pas', () => {
  const note = ref('note.tex', 'a'), first = ref('note (conflit du 2026-11-09 14h32).tex', 'b'), second = ref('note (conflit du 2026-11-09 14h32) (2).tex', 'c');
  expect(conflictOriginal([note, first, second], second)).toBe(note);
  expect(conflictOriginal([note, first, second], first)).toBe(note);
});

test('conflictOriginal : l’original renommé ou retiré, la copie d’un autre fichier, un nom qui n’est pas celui d’une copie : aucun', () => {
  const copy = ref('note (conflit du 2026-11-09 14h32).tex', 'b');
  expect(conflictOriginal([copy], copy)).toBeNull();
  expect(conflictOriginal([ref('note v2.tex', 'a'), copy], copy)).toBeNull();
  expect(conflictOriginal([ref('autre.tex', 'a'), copy], copy)).toBeNull();
  // Only a .tex is compared: the copy of a CSV is not offered.
  const csv = ref('données.csv', 'a'), csvCopy = ref('données (conflit du 2026-11-09 14h32).csv', 'b');
  expect(conflictOriginal([csv, csvCopy], csvCopy)).toBeNull();
  // A name that only looks like one.
  const almost = ref('note (conflit du hier).tex', 'b');
  expect(conflictOriginal([ref('note.tex', 'a'), almost], almost)).toBeNull();
});

// --- reconcileTexBuild and reconcileTex, on a test base

/** A fixture base of its own, a session over it, and a conflict copy of complexité.tex in the node. */
async function prepared() {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-compare-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  const ids = buildFixture(store, dir);
  const s = store.loadState();
  const session = new EditSession(s, async (a, unit) => ({ seq: store.commit(a, { unit }), at: 0 }), () => {}, store.lastSeq());
  const node = ids.nodes.kolmogorov;
  const put = async (name: string, text: string) => storeText(dir, name, text, MAX);
  const copy = storeText(dir, COPY, 'leur version', MAX);
  expect((await session.run(filesBuild(session.state, node, [copy])!)).ok).toBe(true);
  const files = () => session.state.nodes.get(node)!.files;
  const original = () => files().find((f) => f.name === TEX)!;
  const textOf = (f: FileRef) => readFileSync(filePath(dir, f), 'utf8');
  const reconcile = (text: string | null, opts: { removeCopy?: { name: string; hash: string }; base?: string | null } = {}) => reconcileTex(session, put, node, TEX, text, opts);
  /** The distinct actions of the journal lines written since `seq` labelled `label`. */
  const actionsSince = (seq: number, label = `Réconcilier « ${TEX} »`) => new Set(store.changesSince(seq).filter((r) => r.label === label).map((r) => r.actionId));
  return { dir, store, ids, node, session, put, copy, files, original, textOf, reconcile, actionsSince, close: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

test('reconcileTex sans retrait : l’original porte le texte repris, la copie reste, en une action « Réconcilier « x.tex » » ; un Ctrl+Z rend les deux fichiers', async () => {
  const b = await prepared();
  try {
    const before = b.files(), first = b.original(), seq = b.store.lastSeq();
    const r = await b.reconcile('texte repris\n', { base: first.hash });
    expect(r).toEqual({ ok: true, hash: expect.any(String) });
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png', COPY]);
    expect(b.textOf(b.original())).toBe('texte repris\n');
    expect(b.files().at(-1)).toEqual(b.copy);
    expect(b.actionsSince(seq).size).toBe(1);
    expect(b.store.changesSince(seq)).toHaveLength(1);
    // One Ctrl+Z: the original as it was, the copy still there.
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.files()).toEqual(before);
    expect(b.original()).toEqual(first);
    // The text stays in the store, as every version does.
    expect(existsSync(filePath(b.dir, { ...first, name: TEX }))).toBe(true);
  } finally {
    b.close();
  }
});

test('reconcileTex avec retrait de la copie : l’original porte le texte repris et la copie n’est plus dans le nœud, en une action ; le blob reste dans le magasin ; un Ctrl+Z rend les deux fichiers', async () => {
  const b = await prepared();
  try {
    const before = b.files(), first = b.original(), seq = b.store.lastSeq(), changes = historySummary(b.store.historyOf(b.node)).changes;
    const r = await b.reconcile('texte repris\n', { removeCopy: b.copy, base: first.hash });
    expect(r).toEqual({ ok: true, hash: expect.any(String) });
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png']);
    expect(b.textOf(b.original())).toBe('texte repris\n');
    expect(b.actionsSince(seq).size).toBe(1);
    expect(b.store.changesSince(seq)).toHaveLength(1);
    expect(historySummary(b.store.historyOf(b.node)).changes).toBe(changes + 1);
    // Never deleted: the copy's blob is in the store, where the history refers to it.
    expect(existsSync(filePath(b.dir, b.copy))).toBe(true);
    expect(b.textOf(b.copy)).toBe('leur version');
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.files()).toEqual(before);
    expect(b.textOf(b.files().at(-1)!)).toBe('leur version');
    // And redone: the copy is gone again.
    expect((await b.session.redo()).ok).toBe(true);
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png']);
  } finally {
    b.close();
  }
});

test('reconcileTex : rien repris (texte null), la copie retirée seule, une action ; un texte déjà celui de l’original, sans retrait : rien d’écrit', async () => {
  const b = await prepared();
  try {
    const before = b.files(), first = b.original();
    // No text: the original untouched (its bytes are not written again as the editor read them), the copy taken out.
    const seq = b.store.lastSeq();
    expect(await b.reconcile(null, { removeCopy: b.copy, base: first.hash })).toEqual({ ok: true, hash: first.hash });
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png']);
    expect(b.original()).toEqual(first);
    expect(b.actionsSince(seq).size).toBe(1);
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.files()).toEqual(before);
    // The text the file holds, nothing to remove: nothing written, no action.
    const now = b.store.lastSeq();
    expect(await b.reconcile(b.textOf(first), { base: first.hash })).toEqual({ ok: true, hash: first.hash });
    expect(b.store.lastSeq()).toBe(now);
    // The copy gone meanwhile: the removal is done already, the text is saved.
    expect((await b.session.run(removeFileBuild(b.node, COPY)!)).ok).toBe(true);
    expect((await b.reconcile('autre\n', { removeCopy: b.copy, base: first.hash })).ok).toBe(true);
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png']);
    expect(b.textOf(b.original())).toBe('autre\n');
  } finally {
    b.close();
  }
});

test('reconcileTex, D6 : l’original changé ailleurs pendant la comparaison est gardé sous son nom de conflit, la copie retirée, en une action ; un Ctrl+Z rend tout', async () => {
  const b = await prepared();
  try {
    const first = b.original();
    // Another PC's version of the original arrives while the comparison is open (here, an action standing for the synchronisation's).
    const elsewhere = storeText(b.dir, TEX, 'version arrivée', MAX);
    expect((await b.session.run(filesBuild(b.session.state, b.node, [elsewhere])!)).ok).toBe(true);
    const before = b.files(), seq = b.store.lastSeq();
    const r = await b.reconcile('texte repris\n', { removeCopy: b.copy, base: first.hash });
    expect(r).toEqual({ ok: true, hash: expect.any(String), kept: expect.stringMatching(/^complexité \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex$/) });
    expect(isCopyOf(r.kept!, TEX)).toBe(true);
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png', r.kept]);
    expect(b.textOf(b.original())).toBe('texte repris\n');
    expect(b.files().at(-1)).toEqual({ ...elsewhere, name: r.kept });
    expect(b.actionsSince(seq).size).toBe(1);
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.files()).toEqual(before);
    expect(b.textOf(b.original())).toBe('version arrivée');
    // Made from the version the state holds: no copy of it.
    expect((await b.reconcile('texte repris\n', { base: elsewhere.hash })).kept).toBeUndefined();
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png', COPY]);
  } finally {
    b.close();
  }
});

test('reconcileTex : le nœud ou l’original disparu est refusé avant d’écrire quoi que ce soit, et dit pourquoi', async () => {
  const b = await prepared();
  try {
    const put = vi.fn(b.put);
    const run = (text: string | null) => reconcileTex(b.session, put, b.node, TEX, text, { removeCopy: b.copy });
    expect((await b.session.run(removeFileBuild(b.node, TEX)!)).ok).toBe(true);
    expect(await run('x')).toEqual({ ok: false, message: '« complexité.tex » n’est plus dans ce nœud.' });
    expect(await run(null)).toEqual({ ok: false, message: '« complexité.tex » n’est plus dans ce nœud.' });
    expect((await b.session.undo()).ok).toBe(true);
    expect((await b.session.run((st: State) => deleteEverywhere(st, b.node))).ok).toBe(true);
    expect(await run('x')).toEqual({ ok: false, message: 'Ce nœud n’existe plus.' });
    expect(put).not.toHaveBeenCalled();
  } finally {
    b.close();
  }
});

test('reconcileTexBuild : nul quand rien ne change, son libellé, refusée quand l’original n’est plus là', async () => {
  const b = await prepared();
  try {
    const original = b.original();
    expect(reconcileTexBuild(b.session.state, b.node, TEX, original, {})).toBeNull();
    expect(reconcileTexBuild(b.session.state, b.node, TEX, original, { removeCopy: { ...b.copy, name: 'inconnu.tex' } })).toBeNull();
    expect(reconcileTexBuild(b.session.state, b.node, TEX, original, { removeCopy: b.copy })).not.toBeNull();
    // The copy by its name but another version than the one compared: it stays, nothing else to do.
    expect(reconcileTexBuild(b.session.state, b.node, TEX, original, { removeCopy: { ...b.copy, hash: 'f'.repeat(64) } })).toBeNull();
    const other = storeText(b.dir, TEX, 'autre', MAX);
    expect(reconcileTexBuild(b.session.state, b.node, TEX, other, {})!(b.session.state).label).toBe('Réconcilier « complexité.tex »');
    // Computed on a state where the original is gone: refused, and why.
    expect(() => reconcileTexBuild(b.session.state, b.node, 'absent.tex', other, {})!(b.session.state)).toThrow('« absent.tex » n’est plus dans ce nœud.');
  } finally {
    b.close();
  }
});

test('reconcileTex, la copie changée sur un autre PC pendant la comparaison : « Enregistrer et retirer la copie » la garde, et le dit (copyKept) ; la version comparée seule est retirée', async () => {
  const b = await prepared();
  try {
    const first = b.original();
    // Another PC's version of the copy arrives while the comparison shows the first one (b.copy).
    const newer = storeText(b.dir, COPY, 'leur version, reprise là-bas', MAX);
    expect((await b.session.run(filesBuild(b.session.state, b.node, [newer])!)).ok).toBe(true);
    const before = b.files(), seq = b.store.lastSeq();
    const r = await b.reconcile('texte repris\n', { removeCopy: b.copy, base: first.hash });
    expect(r).toEqual({ ok: true, hash: expect.any(String), copyKept: COPY });
    // The original saved, the copy's new version left in the node, in one action that Ctrl+Z undoes.
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png', COPY]);
    expect(b.files().at(-1)).toEqual(newer);
    expect(b.textOf(b.original())).toBe('texte repris\n');
    expect(b.actionsSince(seq).size).toBe(1);
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.files()).toEqual(before);
    // Nothing taken: nothing to write, the copy kept all the same, and said.
    const now = b.store.lastSeq();
    expect(await b.reconcile(null, { removeCopy: b.copy, base: first.hash })).toEqual({ ok: true, hash: first.hash, copyKept: COPY });
    expect(b.store.lastSeq()).toBe(now);
    expect(b.files()).toEqual(before);
    // The version compared is the one the node holds: removed, nothing said.
    const gone = await b.reconcile(null, { removeCopy: newer, base: first.hash });
    expect(gone).toEqual({ ok: true, hash: first.hash });
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png']);
    // The notification.
    expect(copyKeptNotice(COPY)).toBe('La copie « complexité (conflit du 2026-11-09 14h32).tex » a changé sur un autre PC : elle est gardée.');
  } finally {
    b.close();
  }
});

test('closingSave : la fenêtre fermée pendant une comparaison enregistre ce qui est repris comme « Enregistrer » — D6 garde la version venue d’ailleurs, la copie reste —, en une action qu’un Ctrl+Z défait ; rien repris, rien d’écrit', async () => {
  const b = await prepared();
  try {
    const first = b.original();
    const asked: unknown[][] = [];
    const save = (text: string, base: string | null, removeCopy: null) => {
      asked.push([text, base, removeCopy]);
      return reconcileTex(b.session, b.put, b.node, TEX, text, { base });
    };
    const m = new Reconciliation(b.textOf(first), first.hash);
    // Nothing taken: nothing asked, nothing written.
    const seq0 = b.store.lastSeq();
    expect(await closingSave(m, save)).toBeNull();
    expect([asked, b.store.lastSeq()]).toEqual([[], seq0]);
    // A block taken, then the original changed on another PC (the banner's case).
    m.edit('texte repris\n');
    const elsewhere = storeText(b.dir, TEX, 'version arrivée', MAX);
    expect((await b.session.run(filesBuild(b.session.state, b.node, [elsewhere])!)).ok).toBe(true);
    expect(m.arrived(elsewhere.hash)).toBeNull();
    expect(m.elsewhere).toBe(true);
    const before = b.files(), seq = b.store.lastSeq();
    const r = await closingSave(m, save);
    expect(asked).toEqual([['texte repris\n', first.hash, null]]);
    expect(r).toEqual({ ok: true, hash: expect.any(String), kept: expect.stringMatching(/^complexité \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex$/) });
    // The original saved, the version from elsewhere kept beside it, the copy still there: one action.
    expect(b.files().map((f) => f.name)).toEqual([TEX, 'schéma_compression.png', COPY, r!.kept]);
    expect(b.textOf(b.original())).toBe('texte repris\n');
    expect(b.files().at(-1)).toEqual({ ...elsewhere, name: r!.kept });
    expect(b.actionsSince(seq).size).toBe(1);
    // Saved: nothing left to save, and nothing written again.
    expect(m.dirty).toBe(false);
    expect(await closingSave(m, save)).toBeNull();
    expect(asked).toHaveLength(1);
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.files()).toEqual(before);
  } finally {
    b.close();
  }
});

// --- Reading and decoding the two texts

const bytesOf = (s: string) => new TextEncoder().encode(s);
/** « café à la carte » in Windows-1252. */
const WIN1252 = Uint8Array.from([0x63, 0x61, 0x66, 0xe9, 0x20, 0xe0, 0x20, 0x6c, 0x61, 0x20, 0x63, 0x61, 0x72, 0x74, 0x65]);

test('texTextOf : décodé comme dans le plein écran d’un .tex — CRLF et CR devenus « \\n », Windows-1252, UTF-16, BOM UTF-8 ; un binaire, un fichier coupé', () => {
  expect(texTextOf(bytesOf('a\r\nb\rc\n'), false)).toEqual({ text: 'a\nb\nc\n' });
  expect(texTextOf(WIN1252, false)).toEqual({ text: 'café à la carte' });
  expect(texTextOf(Uint8Array.from([...WIN1252, 0x0d, 0x0a, 0x78]), false)).toEqual({ text: 'café à la carte\nx' });
  expect(texTextOf(new Uint8Array(Buffer.from('﻿é\r\nb', 'utf16le')), false)).toEqual({ text: 'é\nb' });
  expect(texTextOf(new Uint8Array([0xef, 0xbb, 0xbf, ...bytesOf('énoncé')]), false)).toEqual({ text: 'énoncé' });
  expect(texTextOf(Uint8Array.from([0x61, 0x00, 0x62]), false)).toEqual({ binary: true });
  expect(texTextOf(bytesOf('début'), true)).toEqual({ tooLong: true });
});

/** A fetch that serves each file by the hash in its address. */
function serving(files: Record<string, Uint8Array<ArrayBuffer>>) {
  const asked: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    asked.push(url);
    const bytes = files[url.split('/')[3]];
    return bytes ? new Response(bytes, { status: 200 }) : new Response(null, { status: 404 });
  });
  return asked;
}

test('readCompared : les deux textes lus et décodés — l’original en CRLF, la copie en Windows-1252 —, sans lire un fichier trop grand', async () => {
  const original = { name: 'a.tex', hash: '1'.repeat(64), size: bytesOf('ligne 1\r\nligne 2').length }, copy = { name: 'a (conflit du 2026-11-09 14h32).tex', hash: '2'.repeat(64), size: WIN1252.length };
  const asked = serving({ ['1'.repeat(64)]: bytesOf('ligne 1\r\nligne 2'), ['2'.repeat(64)]: WIN1252 });
  expect(await readCompared(original, copy, 5)).toEqual({ a: 'ligne 1\nligne 2', b: 'café à la carte' });
  expect(asked).toHaveLength(2);
  // Either one above textViewMaxMb: said so, neither read.
  asked.length = 0;
  expect(await readCompared({ ...original, size: 5 * MB + 1 }, copy, 5)).toEqual({ message: TOO_BIG });
  expect(await readCompared(original, { ...copy, size: 5 * MB + 1 }, 5)).toEqual({ message: TOO_BIG });
  expect(asked).toEqual([]);
  // A binary is said as the views say it.
  serving({ ['1'.repeat(64)]: Uint8Array.from([1, 0, 2]), ['2'.repeat(64)]: WIN1252 });
  expect(await readCompared(original, copy, 5)).toEqual({ message: 'Fichier binaire : Cirrus ne peut pas l’afficher.' });
  // A file the store does not hold rejects, as readHead's: the view says it.
  serving({ ['1'.repeat(64)]: bytesOf('x') });
  await expect(readCompared(original, copy, 5)).rejects.toThrow('introuvable dans la base');
});

test('readNewVersion : la nouvelle version d’un fichier comparé, lue pour être montrée ; au-delà de textViewMaxMb, trop grande pour être comparée ici (et gardée), sans la lire ; illisible, dit', async () => {
  const file = { name: TEX, hash: '1'.repeat(64), size: bytesOf('v1\r\nfin').length };
  const asked = serving({ ['1'.repeat(64)]: bytesOf('v1\r\nfin') });
  expect(await readNewVersion(file, 5)).toEqual({ text: 'v1\nfin' });
  // Above the cap by the size the node holds: not read at all.
  asked.length = 0;
  expect(await readNewVersion({ ...file, size: 5 * MB + 1 }, 5)).toEqual({ not: 'tooBig' });
  expect(asked).toEqual([]);
  // At the cap exactly: read.
  serving({ ['1'.repeat(64)]: new Uint8Array(MB).fill(0x61) });
  expect(await readNewVersion({ ...file, size: MB }, 1)).toEqual({ text: 'a'.repeat(MB) });
  // A binary, bytes the store does not serve: unreadable, never a rejection.
  serving({ ['1'.repeat(64)]: Uint8Array.from([1, 0, 2]) });
  expect(await readNewVersion(file, 5)).toEqual({ not: 'unreadable' });
  serving({});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await readNewVersion(file, 5)).toEqual({ not: 'unreadable' });
  expect(error).toHaveBeenCalledOnce();
  // What the notifications say.
  expect(originalNotLoaded(TEX, 'tooBig')).toBe('« complexité.tex » a été modifié sur un autre PC, mais sa nouvelle version est trop grande pour être comparée ici : elle est gardée.');
  expect(originalNotLoaded(TEX, 'unreadable')).toBe('« complexité.tex » a été modifié sur un autre PC, mais sa nouvelle version n’a pas pu être lue.');
  expect(copyReloadedNotice(COPY)).toBe('La copie « complexité (conflit du 2026-11-09 14h32).tex » a changé sur un autre PC : sa nouvelle version est montrée.');
  expect(copyNotLoaded(COPY, 'tooBig')).toBe('La copie « complexité (conflit du 2026-11-09 14h32).tex » a changé sur un autre PC, mais sa nouvelle version est trop grande pour être comparée ici : elle est gardée.');
  expect(copyNotLoaded(COPY, 'unreadable')).toBe('La copie « complexité (conflit du 2026-11-09 14h32).tex » a changé sur un autre PC, mais sa nouvelle version n’a pas pu être lue : elle est gardée.');
});

test('tooBigToCompare : au-delà de textViewMaxMb, l’un ou l’autre ; pile au plafond, cela se compare', () => {
  const a = ref('a.tex', '1', 5 * MB), b = ref('b.tex', '2', 5 * MB + 1);
  expect(tooBigToCompare(a, a, 5)).toBe(false);
  expect(tooBigToCompare(a, b, 5)).toBe(true);
  expect(tooBigToCompare(b, a, 5)).toBe(true);
  expect(TOO_BIG).toBe('Trop grand pour être comparé ici.');
});

// --- The full screen's texts and questions

test('compareTitle : « Comparer « x.tex » et « x (conflit du … ).tex » »', () => {
  expect(compareTitle(TEX, COPY)).toBe('Comparer « complexité.tex » et « complexité (conflit du 2026-11-09 14h32).tex »');
});

test('abandonQuestion : « Abandonner la réconciliation ? », « Annuler » ayant le focus ; seul le choix ferme', () => {
  let closed = 0;
  const q = abandonQuestion(TEX, () => { closed++; });
  expect(q.text).toBe('Abandonner la réconciliation ?');
  expect(q.detail).toBe('Ce qui a été repris dans « complexité.tex » n’est pas enregistré.');
  expect(q.choices).toEqual([{ value: 'close', label: 'Abandonner' }]);
  expect(focusedChoice(q)).toBe(-1);
  q.answer(null);
  expect(closed).toBe(0);
  q.answer('close');
  expect(closed).toBe(1);
});

// --- The original in the comparison, followed as the workbench's text is (D6)

test('Reconciliation : une version arrivée ailleurs est chargée quand rien n’est repris, gardée pour l’enregistrement sinon', () => {
  const r = new Reconciliation('v0', 'h0');
  expect([r.dirty, r.elsewhere, r.base]).toEqual([false, false, 'h0']);
  expect(r.arrived('h0')).toBeNull();
  // Nothing taken: the new version is to be read, then loaded.
  expect(r.arrived('h1')).toBe('reload');
  expect(r.reloaded('v1', 'h1')).toBe(true);
  expect([r.dirty, r.elsewhere, r.base]).toEqual([false, false, 'h1']);
  // A block taken: the text stays, and the next version arriving is kept for the save.
  r.edit('v1 repris');
  expect(r.dirty).toBe(true);
  expect(r.arrived('h2')).toBeNull();
  expect([r.elsewhere, r.base]).toEqual([true, 'h1']);
  // Typed meanwhile, a version read is not loaded.
  const late = new Reconciliation('v0', 'h0');
  expect(late.arrived('h1')).toBe('reload');
  late.edit('v0 repris');
  expect(late.reloaded('v1', 'h1')).toBe(false);
  expect([late.dirty, late.base]).toEqual([true, 'h0']);
  // Everything taken back out: the text is the one loaded, and nothing is unsaved.
  r.edit('v1');
  expect(r.dirty).toBe(false);
  // The file back to the version the text was made from: nothing from elsewhere any more.
  const back = new Reconciliation('v0', 'h0');
  back.edit('v0 repris');
  back.arrived('h1');
  expect(back.elsewhere).toBe(true);
  back.arrived('h0');
  expect(back.elsewhere).toBe(false);
  // The banner is the workbench's own.
  expect(changedElsewhere(TEX)).toContain('a aussi été modifié sur un autre PC');
});

// --- The full screen's target

test('resolveFull : une comparaison trouve le nœud, l’original et la copie ; l’un ou l’autre disparu, le nœud à la corbeille : plus rien', async () => {
  const b = await prepared();
  try {
    const target = { kind: 'compare' as const, node: b.node, original: TEX, copy: COPY };
    const found = resolveFull(b.session.state, target)!;
    expect([found.node.id, found.file.name, found.copy?.name]).toEqual([b.node, TEX, COPY]);
    // A file is found by its name, as sameName compares it.
    expect(resolveFull(b.session.state, { ...target, copy: COPY.toUpperCase().replace('CONFLIT', 'conflit') })?.copy?.name).toBe(COPY);
    // A file full screen is as resolveTarget has it, with no copy.
    const plain = resolveFull(b.session.state, { kind: 'file', node: b.node, name: TEX })!;
    expect([plain.file.name, plain.copy]).toEqual([TEX, undefined]);
    expect(resolveFull(b.session.state, { kind: 'node', node: b.node })).toBeNull();
    // The original new version: the target follows it by name.
    const newer = storeText(b.dir, TEX, 'nouvelle', MAX);
    expect((await b.session.run(filesBuild(b.session.state, b.node, [newer])!)).ok).toBe(true);
    expect(resolveFull(b.session.state, target)!.file.hash).toBe(newer.hash);
    expect((await b.session.run(removeFileBuild(b.node, COPY)!)).ok).toBe(true);
    expect(resolveFull(b.session.state, target)).toBeNull();
    expect((await b.session.undo()).ok).toBe(true);
    expect((await b.session.run(removeFileBuild(b.node, TEX)!)).ok).toBe(true);
    expect(resolveFull(b.session.state, target)).toBeNull();
    expect((await b.session.undo()).ok).toBe(true);
    expect(resolveFull(b.session.state, target)).not.toBeNull();
    expect((await b.session.run((st: State) => deleteEverywhere(st, b.node))).ok).toBe(true);
    expect(resolveFull(b.session.state, target)).toBeNull();
  } finally {
    b.close();
  }
});
