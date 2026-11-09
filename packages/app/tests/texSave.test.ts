import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deleteEverywhere, type FileRef, type Id, isCopyOf, moveNodes, type State } from '@cirrus/core';
import { buildFixture } from '@cirrus/fixtures';
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
import { focusedChoice } from '../src/renderer/ui/Dialogs.tsx';
import { filesBuild } from '../src/renderer/actions.ts';
import {
  changedElsewhere, FollowedText, keptNotice, openedElsewhere, reloadedNotice, saveTex, type SaveAnswer, SaveScheduler, type SaveState, texMergeKey, unsavedQuestion,
  versionFromElsewhere,
} from '../src/renderer/ui/latex/saveScheduler.ts';
import { Reconciliation } from '../src/renderer/ui/latex/compare.ts';
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
  expect(states.at(-1)).toEqual({ dirty: false, saving: false, saved: true, failure: null, elsewhere: false });
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
  expect(last).toEqual({ dirty: true, saving: false, saved: false, failure: 'Ce nœud n’existe plus.', elsewhere: false });
  // No retry on its own: the next save does.
  await vi.advanceTimersByTimeAsync(60_000);
  expect(saves).toHaveLength(1);
  await s.flush();
  expect(saves).toEqual(['v1', 'v1']);
  expect(last).toEqual({ dirty: false, saving: false, saved: true, failure: null, elsewhere: false });
});

// --- A .tex changed elsewhere while its full screen is open (plan 5b, task 5, D6)

const ref = (hash: string, name = 'x.tex'): FileRef => ({ name, hash, size: 1 });

/** A scheduler over `v0` of hash h0, its saves recorded with the base they were made from, answered by `answer`. */
function following(answer: (text: string, base: string | null) => SaveAnswer = (text) => ({ ok: true, hash: `h:${text}` })) {
  const saves: { text: string; base: string | null }[] = [];
  let release: (() => void) | null = null;
  let hold = false;
  const timers = { set: (fn: () => void, ms: number) => setTimeout(fn, ms), clear: (h: unknown) => clearTimeout(h as ReturnType<typeof setTimeout>) };
  const s = new SaveScheduler('v0', async (text, base) => {
    saves.push({ text, base });
    if (hold) await new Promise<void>((r) => { release = r; });
    return answer(text, base);
  }, timers, () => 10_000, 'h0');
  let state: SaveState | null = null;
  s.onState((st) => { state = st; });
  return { s, saves, state: () => state!, hold: (on: boolean) => { hold = on; }, release: () => release?.() };
}

test('D6, SaveScheduler : rien de non enregistré, une autre version dans l’état se recharge ; la même, ou la sienne, ne fait rien', () => {
  const { s, state } = following();
  expect(s.arrived(ref('h0'))).toBeNull();
  expect(s.arrived(ref('h1'))).toBe('reload');
  // Read: the text replaced, nothing unsaved, that version the base now.
  expect(s.reloaded('v1', 'h1')).toBe(true);
  expect([s.dirty, state().elsewhere]).toEqual([false, false]);
  expect(s.arrived(ref('h1'))).toBeNull();
  // Typed while it was read: not replaced, and told so (the caller asks again, and the version is kept on save).
  expect(s.arrived(ref('h2'))).toBe('reload');
  s.edit('v1 tapé');
  expect(s.reloaded('v2', 'h2')).toBe(false);
  expect(s.dirty).toBe(true);
  expect(s.arrived(ref('h2'))).toBeNull();
  expect(state().elsewhere).toBe(true);
});

test('D6, SaveScheduler : avec du texte non enregistré, le texte reste et `elsewhere` le dit ; l’enregistrement part de l’ancienne base, puis la sienne la remplace', async () => {
  const { s, saves, state } = following((text) => ({ ok: true, hash: `h:${text}`, kept: 'x (conflit du 2026-11-09 14h32).tex' }));
  s.edit('v0 tapé');
  expect(s.arrived(ref('h1'))).toBeNull();
  expect([s.dirty, state().elsewhere]).toEqual([true, true]);
  await s.flush();
  expect(saves).toEqual([{ text: 'v0 tapé', base: 'h0' }]);
  expect([s.dirty, state().elsewhere]).toEqual([false, false]);
  // Its own version in the state: nothing to do; the next save starts from it.
  expect(s.arrived(ref('h:v0 tapé'))).toBeNull();
  s.edit('v0 tapé encore');
  await s.flush();
  expect(saves.at(-1)).toEqual({ text: 'v0 tapé encore', base: 'h:v0 tapé' });
  // Typed back to the text saved, a version from elsewhere known: nothing unsaved any more, so it is loaded.
  s.edit('autre');
  expect(s.arrived(ref('h3'))).toBeNull();
  s.edit('v0 tapé encore');
  expect(s.arrived(ref('h3'))).toBe('reload');
});

test('D6, SaveScheduler : pendant un enregistrement, la version qui arrive est la sienne, ou l’enregistrement l’a gardée : rien avant sa fin', async () => {
  const f = following();
  f.s.edit('v1');
  f.hold(true);
  const saving = f.s.saveNow();
  await new Promise((r) => setTimeout(r, 0));
  expect(f.s.arrived(ref('h:v1'))).toBeNull();
  expect(f.s.arrived(ref('h9'))).toBeNull();
  expect(f.state().elsewhere).toBe(false);
  f.release();
  await saving;
  expect(f.s.arrived(ref('h:v1'))).toBeNull();
  // A refused save keeps the base it had: the next one starts from it still.
  const r = following(() => ({ ok: false, message: 'Ce nœud n’existe plus.' }));
  r.s.edit('v1');
  await r.s.flush();
  r.s.edit('v2');
  await r.s.flush();
  expect(r.saves.map((x) => x.base)).toEqual(['h0', 'h0']);
  // Without a base (a scheduler of before plan 5b), nothing arrives.
  expect(scheduling().s.arrived(ref('h1'))).toBeNull();
});

test('D6, revue de la tâche 5 : un seul suivi de la base pour le plein écran et la comparaison (FollowedText), une seule règle de la version venue d’ailleurs (versionFromElsewhere)', async () => {
  // The comparison's original is followed by the very class the scheduler holds.
  expect(new Reconciliation('v0', 'h0')).toBeInstanceOf(FollowedText);
  const f = new FollowedText('v0', 'h0');
  f.edit('v0 tapé');
  expect([f.arrived('h1'), f.elsewhere, f.base]).toEqual([null, true, 'h0']);
  // Written: the file holds that text now, its hash the base, nothing from elsewhere pending.
  f.wrote('v0 tapé', 'h2');
  expect([f.dirty, f.elsewhere, f.base, f.saved]).toEqual([false, false, 'h2', 'v0 tapé']);
  // Not followed (no base): nothing arrives, and a write keeps no base.
  const free = new FollowedText('v0', null);
  free.wrote('v1', 'h1');
  expect([free.arrived('h9'), free.base]).toEqual([null, null]);
  // The version from elsewhere: neither the base nor the saved text's own; none without a base.
  const b = opened();
  try {
    const st = b.session.state, node = b.ids.nodes.kolmogorov, held = b.fileOf();
    expect(versionFromElsewhere(st, node, TEX, 'autre', 'nôtre')).toEqual(held);
    expect(versionFromElsewhere(st, node, TEX.toUpperCase(), 'autre', 'nôtre')).toEqual(held);
    expect(versionFromElsewhere(st, node, TEX, held.hash, 'nôtre')).toBeUndefined();
    expect(versionFromElsewhere(st, node, TEX, 'autre', held.hash)).toBeUndefined();
    expect(versionFromElsewhere(st, node, TEX, null, 'nôtre')).toBeUndefined();
    expect(versionFromElsewhere(st, node, 'absent.tex', 'autre', 'nôtre')).toBeUndefined();
  } finally {
    b.close();
  }
});

test('D6 : les textes du bandeau et des notifications', () => {
  const at = new Date(2026, 10, 9, 14, 32).getTime(), morning = new Date(2026, 10, 9, 9, 5).getTime();
  expect(openedElsewhere('Portable', at, new Date(2026, 10, 9, 18, 0).getTime())).toBe('Ce .tex est ouvert sur « Portable » depuis 14h32 : sa dernière version y est peut-être restée.');
  expect(openedElsewhere('Portable', morning, at)).toBe('Ce .tex est ouvert sur « Portable » depuis 09h05 : sa dernière version y est peut-être restée.');
  expect(openedElsewhere('Bureau', new Date(2026, 10, 8, 14, 32).getTime(), at)).toBe('Ce .tex est ouvert sur « Bureau » depuis le 2026-11-08 à 14h32 : sa dernière version y est peut-être restée.');
  expect(changedElsewhere('x.tex')).toBe('« x.tex » a aussi été modifié sur un autre PC : à l’enregistrement, cette version-là sera gardée sous « x (conflit du … ).tex ».');
  expect(changedElsewhere('complexité.tex')).toBe('« complexité.tex » a aussi été modifié sur un autre PC : à l’enregistrement, cette version-là sera gardée sous « complexité (conflit du … ).tex ».');
  expect(reloadedNotice('x.tex')).toBe('« x.tex » a été modifié sur un autre PC : sa nouvelle version est chargée.');
  expect(keptNotice('x.tex', 'x (conflit du 2026-11-09 14h32).tex')).toBe('« x.tex » a été modifié sur deux PC : l’autre version est gardée sous « x (conflit du 2026-11-09 14h32).tex ».');
});

test('SaveScheduler : revenu, pendant un enregistrement, au texte d’avant, ce texte s’enregistre à la pause qui suit la fin de l’enregistrement (revue finale)', async () => {
  vi.useFakeTimers();
  let release: () => void = () => {};
  const saves: string[] = [];
  const s = new SaveScheduler('v0', async (text) => {
    saves.push(text);
    await new Promise<void>((r) => { release = r; });
    return { ok: true };
  }, { set: (fn, ms) => setTimeout(fn, ms), clear: (h) => clearTimeout(h as ReturnType<typeof setTimeout>) }, () => 10_000);
  s.edit('v1');
  const first = s.saveNow();
  await vi.advanceTimersByTimeAsync(0);
  // Back to v0 while v1 is saved: no different from the text saved then, so no pause was armed.
  s.edit('v0');
  release();
  await first;
  // v1 saved: v0 now differs from it, and waits for a pause from the save's end.
  expect(s.dirty).toBe(true);
  await vi.advanceTimersByTimeAsync(9_999);
  expect(saves).toEqual(['v1']);
  await vi.advanceTimersByTimeAsync(1);
  expect(saves).toEqual(['v1', 'v0']);
  release();
  await vi.advanceTimersByTimeAsync(0);
  expect(s.dirty).toBe(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(saves).toHaveLength(2);
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
  const session = new EditSession(s, async (a, unit) => ({ seq: store.commit(a, { unit }), at: 0 }), () => {}, store.lastSeq());
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
    for (const v of ['v1', 'v2', 'v3']) expect(await b.save(`${b.textOf(original)}% ${v}\n`)).toEqual({ ok: true, hash: expect.any(String) });
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
    expect(await b.save('Autre énoncé.', b.ids.nodes.mdl, 'Enoncé_détaillé.tex')).toEqual({ ok: true, hash: expect.any(String) });
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
    expect(await b.save(b.textOf(mdlTex), b.ids.nodes.mdl, 'Enoncé_détaillé.tex')).toEqual({ ok: true, hash: mdlTex.hash });
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

test('« Fermer sans enregistrer ? » : Entrée ne jette jamais le texte, le focus est sur « Annuler » (revue de la tâche 5)', () => {
  let closed = 0;
  const q = unsavedQuestion('complexité.tex', 'Ce nœud n’existe plus.', () => { closed++; });
  expect(q.text).toBe('Fermer sans enregistrer ?');
  expect(q.detail).toBe('Le texte tapé dans « complexité.tex » n’est pas enregistré : Ce nœud n’existe plus.');
  expect(unsavedQuestion('a.tex', null, () => {}).detail).toBe('Le texte tapé dans « a.tex » n’est pas enregistré.');
  expect(q.choices).toEqual([{ value: 'close', label: 'Fermer sans enregistrer' }]);
  // « Annuler » (-1) has the focus: Enter keeps the full screen open; only the choice itself closes it.
  expect(focusedChoice(q)).toBe(-1);
  q.answer(null);
  expect(closed).toBe(0);
  q.answer('close');
  expect(closed).toBe(1);
  // Any other question keeps its first choice focused (« partout ou ici seulement »).
  expect(focusedChoice({ text: 'x', choices: [{ value: 'a', label: 'A' }, { value: 'b', label: 'B' }], answer: () => {} })).toBe(0);
});

test('D6 : un enregistrement fait d’une base que l’état n’a plus écrit le texte sous le nom et l’autre version sous son nom de conflit, en une action ; un Ctrl+Z rend les deux fichiers d’avant', async () => {
  const b = opened();
  try {
    const original = b.fileOf(), seq = b.store.lastSeq();
    const put = async (name: string, text: string) => storeText(b.dir, name, text, MAX);
    // A first save of this opening, from the file's version.
    const first = await saveTex(b.session, put, b.ids.nodes.kolmogorov, TEX, 'tapé ici 1', original.hash);
    expect(first).toEqual({ ok: true, hash: expect.any(String) });
    // Another version arrives (here, an action of the session standing for the synchronisation's).
    const theirs = storeText(b.dir, TEX, 'leur version', MAX);
    expect((await b.session.run(filesBuild(b.session.state, b.ids.nodes.kolmogorov, [theirs])!)).ok).toBe(true);
    const before = b.session.state.nodes.get(b.ids.nodes.kolmogorov)!.files;
    // Saved from the first save's version: ours under the name, theirs under its conflict name, in one action.
    const r = await saveTex(b.session, put, b.ids.nodes.kolmogorov, TEX, 'tapé ici 2', first.hash);
    expect(r).toEqual({ ok: true, hash: expect.any(String), kept: expect.stringMatching(/^complexité \(conflit du \d{4}-\d{2}-\d{2} \d{2}h\d{2}\)\.tex$/) });
    const files = b.session.state.nodes.get(b.ids.nodes.kolmogorov)!.files;
    expect(files.map((f) => f.name)).toEqual([TEX, 'schéma_compression.png', r.kept]);
    expect(b.textOf(b.fileOf())).toBe('tapé ici 2');
    expect(files[2]).toEqual({ ...theirs, name: r.kept });
    expect(isCopyOf(r.kept!, TEX)).toBe(true);
    // One action, merged with nothing: three since (the first save, theirs, this one), this one labelled as a save.
    const lines = b.store.changesSince(seq);
    expect(new Set(lines.map((x) => x.actionId)).size).toBe(3);
    expect(lines.at(-1)!.label).toBe(`Modifier « ${TEX} »`);
    // One Ctrl+Z: both files as before the save — theirs under the name, no copy.
    expect((await b.session.undo()).ok).toBe(true);
    expect(b.session.state.nodes.get(b.ids.nodes.kolmogorov)!.files).toEqual(before);
    expect(b.textOf(b.fileOf())).toBe('leur version');
    // Made from the version the state holds: no copy, as before plan 5b.
    expect(await saveTex(b.session, put, b.ids.nodes.kolmogorov, TEX, 'tapé ici 3', theirs.hash)).toEqual({ ok: true, hash: expect.any(String) });
    expect(b.session.state.nodes.get(b.ids.nodes.kolmogorov)!.files).toHaveLength(2);
    // Made from another version, but the same text as the one there: nothing written, no copy.
    const now = b.store.lastSeq();
    expect(await saveTex(b.session, put, b.ids.nodes.kolmogorov, TEX, 'tapé ici 3', theirs.hash)).toEqual({ ok: true, hash: b.fileOf().hash });
    expect(b.store.lastSeq()).toBe(now);
  } finally {
    b.close();
  }
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
    binaries: async () => bins, root: join(b.dir, 'latex'), store: b.dir, params: () => DEFAULT_PARAMS,
    cache: new PdfCache(join(b.dir, 'latex', 'cache'), () => DEFAULT_PARAMS.latexCacheMb * 2 ** 20),
  });
  try {
    const s = b.session.state, texts = new Map<string, string>();
    for (const n of s.nodes.values()) for (const f of n.files) if (fileKind(f.name) === 'tex') texts.set(f.hash, b.textOf(f));
    const tex = b.fileOf();
    const req = buildRequest({
      origin: { kind: 'file', node: b.ids.nodes.kolmogorov, name: TEX }, source: texts.get(tex.hash)!, s, registry: LatexRegistry.build(s, texts), known: [],
      widthCm: DEFAULT_PARAMS.latexSnippetWidthCm,
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
