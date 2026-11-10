import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MAX_ID_CHARS } from '@cirrus/core';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { openBase } from '../src/main/base.ts';
import { CONSULTATIONS_FILE, Consultations, parseConsultations } from '../src/main/consultations.ts';
import { READY_FILE, stagedDir } from '../src/main/sync/firstSync.ts';
import { swapStaged } from '../src/main/sync/swap.ts';
import {
  CONSULTATION_KINDS, configureConsultations, type Consultation, ConsultationQueue, consultations, consultationSettings, connectionDrafts, FocusTracker, jumpDraft,
  MAX_CONSULTATION_BATCH, MAX_DETAIL_CHARS, planShownDraft, searchDraft,
} from '../src/renderer/consultations.ts';
import { type JumpHost, Jumps } from '../src/renderer/ui/graph/jumps.ts';
import { openedPanels, type Panel, withFile, withLinked, withNode, withoutLoose } from '../src/renderer/ui/panels/Panels.tsx';
import { fullDraft } from '../src/renderer/ui/screens.ts';

// The recording of consultations (plan 6a, D6, task 5): the file and its batches (main), the queue that feeds it
// (interface), and the decisions at each emission point, on files of their own and never the user's base.

const dirs: string[] = [];
const folder = () => {
  const d = mkdtempSync(join(tmpdir(), 'cirrus-consultations-'));
  dirs.push(d);
  return d;
};
let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** The rows of the file, read by a connection of the test's own. */
function rows(dir: string): { at: number; pc: string; kind: string; subject: string | null; plan: string | null; detail: string | null }[] {
  const db = new DatabaseSync(join(dir, CONSULTATIONS_FILE));
  try {
    return db.prepare('SELECT at, pc, kind, subject, plan, detail FROM events ORDER BY rowid').all() as ReturnType<typeof rows>;
  } finally {
    db.close();
  }
}
const ev = (kind: Consultation['kind'], at: number, rest: Partial<Consultation> = {}): Consultation => ({ at, kind, ...rest });

// ---------------------------------------------------------------------------------------------------------------------
// The file.

test('le fichier consultations.db naît à la première écriture : une table events (at, pc, kind, subject, plan, detail), un index sur at, le mode WAL ; chaque ligne porte ce PC', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  expect(existsSync(join(dir, CONSULTATIONS_FILE))).toBe(false);
  c.write([ev('app_open', 1000), ev('search', 1500, { subject: 'n1', plan: 'p1', detail: 'tenseur' })]);
  c.close();
  expect(rows(dir)).toEqual([
    { at: 1000, pc: 'pc-1', kind: 'app_open', subject: null, plan: null, detail: null },
    { at: 1500, pc: 'pc-1', kind: 'search', subject: 'n1', plan: 'p1', detail: 'tenseur' },
  ]);
  const db = new DatabaseSync(join(dir, CONSULTATIONS_FILE));
  try {
    expect((db.prepare('PRAGMA table_info(events)').all() as { name: string }[]).map((x) => x.name)).toEqual(['at', 'pc', 'kind', 'subject', 'plan', 'detail']);
    expect((db.prepare('PRAGMA index_list(events)').all() as { name: string }[]).map((x) => (db.prepare(`PRAGMA index_info(${JSON.stringify(x.name)})`).all() as { name: string }[]).map((i) => i.name))).toEqual([['at']]);
    expect((db.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode).toBe('wal');
  } finally {
    db.close();
  }
  // It is no part of the base: the base's own file is not created by it.
  expect(existsSync(join(dir, 'cirrus.db'))).toBe(false);
  expect(warn).not.toHaveBeenCalled();
});

test('un lot s’écrit en une transaction : un événement refusé en cours de route, et aucun du lot ne reste ; le lot suivant passe', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write([ev('app_open', 1)]);
  const db = new DatabaseSync(join(dir, CONSULTATIONS_FILE));
  db.exec("CREATE TRIGGER sans_blur BEFORE INSERT ON events WHEN NEW.kind = 'blur' BEGIN SELECT RAISE(ABORT, 'refusé'); END;");
  db.close();
  c.write([ev('focus', 2), ev('blur', 3), ev('focus', 4)]);
  expect(rows(dir).map((r) => r.at)).toEqual([1]);
  expect(warn).toHaveBeenCalledTimes(1);
  c.write([ev('focus', 5), ev('jump', 6)]);
  expect(rows(dir).map((r) => r.at)).toEqual([1, 5, 6]);
  c.close();
});

test('un grand lot (10 000 événements) s’écrit d’un trait', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write(Array.from({ length: MAX_CONSULTATION_BATCH }, (_, i) => ev('focus', i)));
  c.close();
  expect(rows(dir)).toHaveLength(MAX_CONSULTATION_BATCH);
  expect(warn).not.toHaveBeenCalled();
});

const OK = { at: 1_700_000_000_000, kind: 'jump' };
const INVALID: [string, unknown][] = [
  ['autre chose qu’un tableau', OK],
  ['un texte', 'jump'],
  ['null', null],
  ['plus de 10 000 événements', Array.from({ length: MAX_CONSULTATION_BATCH + 1 }, () => OK)],
  ['un genre inconnu', [{ ...OK, kind: 'clic' }]],
  ['un genre absent', [{ at: 1 }]],
  ['un genre qui n’est pas un texte', [{ ...OK, kind: 3 }]],
  ['une heure fractionnaire', [{ ...OK, at: 1.5 }]],
  ['une heure négative', [{ ...OK, at: -1 }]],
  ['une heure NaN', [{ ...OK, at: Number.NaN }]],
  ['une heure en texte', [{ ...OK, at: '12' }]],
  ['une heure absente', [{ kind: 'jump' }]],
  ['un détail de 2 001 caractères', [{ ...OK, detail: 'x'.repeat(MAX_DETAIL_CHARS + 1) }]],
  ['un détail qui n’est pas un texte', [{ ...OK, detail: 5 }]],
  ['un sujet de plus de MAX_ID_CHARS caractères', [{ ...OK, subject: 'x'.repeat(MAX_ID_CHARS + 1) }]],
  ['un sujet vide', [{ ...OK, subject: '' }]],
  ['un plan qui n’est pas un texte', [{ ...OK, plan: 12 }]],
  ['un plan de plus de MAX_ID_CHARS caractères', [{ ...OK, plan: 'x'.repeat(MAX_ID_CHARS + 1) }]],
  ['un champ inconnu (le PC ne se choisit pas)', [{ ...OK, pc: 'autre' }]],
  ['un élément qui n’est pas un objet', [OK, 3]],
  ['un élément null', [OK, null]],
  ['un élément qui est un tableau', [OK, [OK]]],
];

test.each(INVALID)('un lot refusé strictement : %s — rien n’est écrit, pas même le fichier, un avertissement, aucune erreur', (_what, batch) => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  expect(() => c.write(batch)).not.toThrow();
  expect(existsSync(join(dir, CONSULTATIONS_FILE))).toBe(false);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(() => parseConsultations(batch)).toThrow();
  c.close();
});

test('les bornes exactes passent : 2 000 caractères de détail, MAX_ID_CHARS d’identifiant, des champs absents ou undefined, un lot vide', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  const id = 'é'.repeat(MAX_ID_CHARS), detail = 'ü'.repeat(MAX_DETAIL_CHARS);
  c.write([]);
  expect(existsSync(join(dir, CONSULTATIONS_FILE))).toBe(false);
  c.write([{ at: 0, kind: 'search', subject: id, plan: id, detail }, { at: 1, kind: 'blur', subject: undefined, plan: undefined, detail: undefined }, { at: 2, kind: 'search', detail: '' }]);
  c.close();
  expect(rows(dir)).toEqual([
    { at: 0, pc: 'pc-1', kind: 'search', subject: id, plan: id, detail },
    { at: 1, pc: 'pc-1', kind: 'blur', subject: null, plan: null, detail: null },
    { at: 2, pc: 'pc-1', kind: 'search', subject: null, plan: null, detail: '' },
  ]);
  expect(warn).not.toHaveBeenCalled();
});

test('chaque genre d’événement de la liste est accepté, et la liste est celle de D6', () => {
  expect([...CONSULTATION_KINDS]).toEqual([
    'app_open', 'app_close', 'plan_shown', 'node_popup', 'connection_popup', 'file_preview', 'file_fullscreen', 'search', 'jump', 'focus', 'blur',
  ]);
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write(CONSULTATION_KINDS.map((kind, i) => ev(kind, i)));
  c.close();
  expect(rows(dir).map((r) => r.kind)).toEqual([...CONSULTATION_KINDS]);
});

test('un fichier abîmé : un seul avertissement, le lot est perdu, rien ne se lève ; réparé, l’écriture reprend, et le fichier abîmé n’est ni effacé ni renommé tant qu’on n’y touche pas', () => {
  const dir = folder();
  const file = join(dir, CONSULTATIONS_FILE);
  writeFileSync(file, 'ceci n’est pas une base de données SQLite, mais un long texte qui la remplace '.repeat(40));
  const c = Consultations.open(dir, 'pc-1');
  expect(() => c.write([ev('app_open', 1)])).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('Consultations non enregistrées');
  // The file keeps failing: the next batches are dropped too, and the console is not flooded.
  expect(() => c.write([ev('app_open', 2)])).not.toThrow();
  expect(() => c.write([ev('app_open', 3)])).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(1);
  expect(readFileSync(file, 'utf8').startsWith('ceci n’est pas')).toBe(true);
  // Replaced by the user (or the file mended): the next batch is written, and a later failure is said again.
  rmSync(file);
  c.write([ev('app_open', 4)]);
  expect(rows(dir).map((r) => r.at)).toEqual([4]);
  expect(warn).toHaveBeenCalledTimes(1);
  c.close();
  writeFileSync(file, 'abîmé de nouveau '.repeat(100));
  c.write([ev('app_open', 5)]);
  expect(warn).toHaveBeenCalledTimes(2);
  c.close();
});

test('un fichier verrouillé par un autre : le lot est perdu avec un avertissement, sans attendre ni lever ; le verrou levé, le lot suivant passe', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write([ev('app_open', 1)]);
  const other = new DatabaseSync(join(dir, CONSULTATIONS_FILE));
  other.exec('BEGIN IMMEDIATE');
  const t0 = performance.now();
  expect(() => c.write([ev('focus', 2)])).not.toThrow();
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(warn).toHaveBeenCalledTimes(1);
  other.exec('ROLLBACK');
  other.close();
  c.write([ev('focus', 3)]);
  expect(rows(dir).map((r) => r.at)).toEqual([1, 3]);
  c.close();
});

test('un lot refusé par la validation ne lâche pas la connexion ni ne couvre l’avertissement d’un fichier : les deux avertissements sont séparés', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write([ev('app_open', 1)]);
  // A bad batch: said once (the validation's own flag), the file still open and in use.
  c.write('pas un lot');
  c.write('pas un lot non plus');
  expect(warn).toHaveBeenCalledTimes(1);
  // A damaged file's failure is said though the validation was, and a bad batch after it is not said again.
  const other = new DatabaseSync(join(dir, CONSULTATIONS_FILE));
  other.exec('BEGIN IMMEDIATE');
  c.write([ev('focus', 2)]);
  expect(warn).toHaveBeenCalledTimes(2);
  c.write([ev('focus', 3)]);
  c.write('encore un mauvais lot');
  expect(warn).toHaveBeenCalledTimes(2);
  other.exec('ROLLBACK');
  other.close();
  c.write([ev('focus', 4)]);
  expect(rows(dir).map((r) => r.at)).toEqual([1, 4]);
  // Each flag is reset by a write that succeeded: the next bad batch is said again, and so is the next I/O failure.
  c.write('un dernier mauvais lot');
  expect(warn).toHaveBeenCalledTimes(3);
  c.close();
});

test('un lot refusé par la validation laisse la connexion ouverte : le lot suivant s’écrit dans la même, et seul close() la lâche', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write([ev('app_open', 1)]);
  const spy = vi.spyOn(DatabaseSync.prototype, 'close');
  c.write([{ at: 2, kind: 'inconnu' }]);
  expect(spy).not.toHaveBeenCalled();
  c.write([ev('focus', 3)]);
  expect(spy).not.toHaveBeenCalled();
  c.close();
  expect(spy).toHaveBeenCalledTimes(1);
  spy.mockRestore();
  expect(rows(dir).map((r) => r.at)).toEqual([1, 3]);
});

test('un dossier absent : le lot est perdu avec un avertissement, sans lever', () => {
  const c = Consultations.open(join(folder(), 'absent'), 'pc-1');
  expect(() => c.write([ev('app_open', 1)])).not.toThrow();
  expect(warn).toHaveBeenCalledTimes(1);
});

test('close libère le fichier (le dossier peut être effacé), et une écriture ensuite le rouvre', () => {
  const dir = folder();
  const c = Consultations.open(dir, 'pc-1');
  c.write([ev('app_open', 1)]);
  c.close();
  rmSync(join(dir, CONSULTATIONS_FILE));
  expect(existsSync(join(dir, `${CONSULTATIONS_FILE}-wal`))).toBe(false);
  c.write([ev('app_close', 2)]);
  c.close();
  expect(rows(dir).map((r) => r.kind)).toEqual(['app_close']);
});

test('une base prise du serveur prend la place de celle-ci : les consultations de ce PC la suivent, elles ne partent pas avec l’ancienne base', () => {
  const root = folder();
  const dir = join(root, 'base'), staged = stagedDir(dir);
  mkdirSync(dir);
  writeFileSync(join(dir, 'cirrus.db'), 'ancienne');
  const c = Consultations.open(dir, 'pc-1');
  c.write([ev('app_open', 1), ev('app_close', 2)]);
  c.close();
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'prise');
  writeFileSync(join(staged, READY_FILE), '{}');
  expect(swapStaged(dir, new Date(2026, 10, 8))).toBe('swapped');
  expect(readFileSync(join(dir, 'cirrus.db'), 'utf8')).toBe('prise');
  expect(rows(dir).map((r) => r.kind)).toEqual(['app_open', 'app_close']);
  expect(existsSync(join(root, 'base-avant-jumelage-2026-11-08', CONSULTATIONS_FILE))).toBe(false);
  // And it goes on there.
  const again = Consultations.open(dir, 'pc-1');
  again.write([ev('app_open', 3)]);
  again.close();
  expect(rows(dir).map((r) => r.at)).toEqual([1, 2, 3]);
});

// The swap's care of the file (fix round 1, Important 2). The old base is `ancienne` (a file no store opens: not blank) or a
// base as its first opening made it (blank); the staged one is `prise`.
const DAY = new Date(2026, 10, 8);
const SWAP = { tries: 1, pauseMs: 0 };
const MOVED = ['', '-wal', '-shm'].map((x) => CONSULTATIONS_FILE + x);
/** The swap's rename, refusing the files whose name ends with `what`, as a program holding them would (EPERM). */
const refusing = (what: string) => (from: string, to: string) => {
  if (from.endsWith(what)) throw Object.assign(new Error(`EPERM: operation not permitted, rename '${from}'`), { code: 'EPERM' });
  renameSync(from, to);
};
/** A base folder with its consultations (and, `leftover`, the -wal and -shm of a file never closed) and a staged base beside it. */
function swapSetup(blank: boolean, leftover = false) {
  const root = folder();
  const dir = join(root, 'base'), staged = stagedDir(dir), archive = join(root, 'base-avant-jumelage-2026-11-08');
  if (blank) openBase(dir).close();
  else {
    mkdirSync(dir);
    writeFileSync(join(dir, 'cirrus.db'), 'ancienne');
  }
  writeFileSync(join(dir, CONSULTATIONS_FILE), 'événements');
  if (leftover) for (const x of ['-wal', '-shm']) writeFileSync(join(dir, CONSULTATIONS_FILE + x), `reste${x}`);
  mkdirSync(staged);
  writeFileSync(join(staged, 'cirrus.db'), 'prise');
  writeFileSync(join(staged, READY_FILE), '{}');
  return { root, dir, archive };
}
const texts = (dir: string) => MOVED.map((f) => (existsSync(join(dir, f)) ? readFileSync(join(dir, f), 'utf8') : null));

test.each([['non vierge', false], ['vierge', true]])('l’échange emmène le fichier avec ses -wal et -shm, qu’une fermeture par app.quit() a pu laisser (base %s) ; une base vierge est alors effacée', (_what, blank) => {
  const { dir, archive } = swapSetup(blank, true);
  expect(swapStaged(dir, DAY, SWAP)).toBe('swapped');
  expect(texts(dir)).toEqual(['événements', 'reste-wal', 'reste-shm']);
  expect(texts(archive)).toEqual([null, null, null]);
  expect(existsSync(archive)).toBe(!blank);
  expect(warn).not.toHaveBeenCalled();
});

test.each([['non vierge', false], ['vierge', true]])('un fichier de consultations dont le renommage est refusé : l’échange se fait, un avertissement, et l’ancien dossier est gardé avec lui, même d’une base vierge (base %s)', (_what, blank) => {
  const { dir, archive } = swapSetup(blank);
  expect(swapStaged(dir, DAY, { ...SWAP, rename: refusing(CONSULTATIONS_FILE) })).toBe('swapped');
  expect(readFileSync(join(dir, 'cirrus.db'), 'utf8')).toBe('prise');
  expect(texts(dir)).toEqual([null, null, null]);
  expect(texts(archive)).toEqual(['événements', null, null]);
  expect(warn).toHaveBeenCalledTimes(1);
  expect(String(warn.mock.calls[0][0])).toContain('Consultations de ce PC non reprises');
  expect(String(warn.mock.calls[0][0])).toContain(archive);
});

test('un -wal refusé après le fichier : l’ancien dossier est gardé aussi (il tient encore ce -wal), un avertissement', () => {
  const { dir, archive } = swapSetup(true, true);
  expect(swapStaged(dir, DAY, { ...SWAP, rename: refusing('-wal') })).toBe('swapped');
  expect(texts(archive)).toEqual([null, 'reste-wal', 'reste-shm']);
  expect(warn).toHaveBeenCalledTimes(1);
});

test.each([['non vierge', false], ['vierge', true]])('la nouvelle base a déjà un fichier de consultations : le sien est gardé, tout l’ensemble de l’ancienne reste dans son dossier, qui n’est pas effacé (base %s)', (_what, blank) => {
  const { dir, archive } = swapSetup(blank, true);
  // The base taken from the server would hold one already (it should not).
  const staged = stagedDir(dir);
  writeFileSync(join(staged, CONSULTATIONS_FILE), 'neuf');
  expect(swapStaged(dir, DAY, SWAP)).toBe('swapped');
  expect(texts(dir)).toEqual(['neuf', null, null]);
  expect(texts(archive)).toEqual(['événements', 'reste-wal', 'reste-shm']);
  expect(warn).toHaveBeenCalledTimes(1);
});

test('une base vierge sans consultations est effacée comme avant, sans avertissement', () => {
  const { dir, archive } = swapSetup(true);
  rmSync(join(dir, CONSULTATIONS_FILE));
  expect(swapStaged(dir, DAY, SWAP)).toBe('swapped');
  expect([existsSync(archive), texts(dir)]).toEqual([false, [null, null, null]]);
  expect(warn).not.toHaveBeenCalled();
});

// ---------------------------------------------------------------------------------------------------------------------
// The queue of the interface.

/** A queue on a fake clock, whose sends are kept. */
function queue(over: Partial<ConstructorParameters<typeof ConsultationQueue>[0]> = {}, bound?: number) {
  const sent: Consultation[][] = [];
  const state = { on: true, flushMs: 10_000, plan: 'p1' as string | undefined, clock: 1000, failing: false };
  const q = new ConsultationQueue({
    send: (events) => { if (state.failing) throw new Error('principal cassé'); sent.push(events); },
    enabled: () => state.on, flushMs: () => state.flushMs, plan: () => state.plan, now: () => state.clock++, ...over,
  }, bound);
  return { q, sent, state };
}

test('la file garde les événements en mémoire et les envoie d’un coup toutes les consultationsFlushMs, dans l’ordre, datés, avec le plan où l’on est', () => {
  vi.useFakeTimers();
  const { q, sent, state } = queue();
  q.record({ kind: 'app_open' });
  q.record({ kind: 'node_popup', subject: 'n1' });
  q.record({ kind: 'jump', subject: 'n2', plan: 'p2' });
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(9_999);
  expect(sent).toEqual([]);
  vi.advanceTimersByTime(1);
  expect(sent).toEqual([[
    { at: 1000, kind: 'app_open', plan: 'p1' },
    { at: 1001, kind: 'node_popup', subject: 'n1', plan: 'p1' },
    { at: 1002, kind: 'jump', subject: 'n2', plan: 'p2' },
  ]]);
  expect(q.size).toBe(0);
  // Nothing left: no timer keeps the window awake, and nothing more is sent.
  expect(vi.getTimerCount()).toBe(0);
  vi.advanceTimersByTime(60_000);
  expect(sent).toHaveLength(1);
  // The next event starts the next wait, at the setting's value of that moment.
  state.flushMs = 2000;
  state.plan = undefined;
  q.record({ kind: 'focus' });
  vi.advanceTimersByTime(2000);
  expect(sent[1]).toEqual([{ at: 1003, kind: 'focus' }]);
});

test('l’interrupteur : éteint, rien n’est mis en file, rien n’est envoyé, aucun minuteur ; éteint avec des événements en attente, ils ne sont pas écrits', () => {
  vi.useFakeTimers();
  const { q, sent, state } = queue();
  state.on = false;
  q.record({ kind: 'app_open' });
  q.record({ kind: 'plan_shown', plan: 'p1' });
  expect(q.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  q.finish();
  vi.advanceTimersByTime(600_000);
  expect(sent).toEqual([]);
  state.on = true;
  q.record({ kind: 'app_open' });
  expect(q.size).toBe(1);
  state.on = false;
  vi.advanceTimersByTime(10_000);
  expect(sent).toEqual([]);
  expect(q.size).toBe(0);
  state.on = true;
  q.record({ kind: 'focus' });
  q.finish();
  expect(sent).toHaveLength(1);
  expect(sent[0].map((e) => e.kind)).toEqual(['focus']);
});

test('configureConsultations : éteindre l’interrupteur vide la file tout de suite (ce qui attendait n’est jamais écrit, même rallumé), le rallumer n’y remet rien', () => {
  vi.useFakeTimers();
  const sent: Consultation[][] = [];
  configureConsultations({ record: true, flushMs: 10_000 }, () => 'p1');
  const window = globalThis as unknown as { window?: unknown };
  const had = window.window;
  window.window = { cirrus: { recordConsultations: (events: Consultation[]) => sent.push(events) } };
  try {
    consultations.record({ kind: 'app_open' });
    consultations.record({ kind: 'focus' });
    expect(consultations.size).toBe(2);
    configureConsultations({ record: false, flushMs: 10_000 });
    expect(consultations.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    configureConsultations({ record: true, flushMs: 10_000 });
    expect(consultations.size).toBe(0);
    vi.advanceTimersByTime(60_000);
    consultations.finish();
    expect(sent).toEqual([]);
    // A later change of the interval alone keeps what waits.
    consultations.record({ kind: 'blur' });
    configureConsultations({ record: true, flushMs: 2000 });
    expect(consultations.size).toBe(1);
    consultations.finish();
    expect(sent.map((b) => b.map((e) => e.kind))).toEqual([['blur']]);
  } finally {
    window.window = had;
    configureConsultations({ record: false, flushMs: 10_000 });
  }
});

test('à la fermeture, finish envoie tout de suite ce qui attend et arrête le minuteur ; rien à envoyer, rien n’est envoyé', () => {
  vi.useFakeTimers();
  const { q, sent } = queue();
  q.finish();
  expect(sent).toEqual([]);
  q.record({ kind: 'search', detail: 'tenseur' });
  q.record({ kind: 'app_close' });
  q.finish();
  expect(sent.map((b) => b.map((e) => e.kind))).toEqual([['search', 'app_close']]);
  expect(q.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});

test('un envoi qui échoue : en route, les événements restent pour le prochain envoi ; à la fermeture, ils sont abandonnés sans bruit et sans lever', () => {
  vi.useFakeTimers();
  const { q, sent, state } = queue();
  state.failing = true;
  q.record({ kind: 'app_open' });
  vi.advanceTimersByTime(10_000);
  expect(q.size).toBe(1);
  // It tries again at the next interval, with what came since, in order.
  q.record({ kind: 'focus' });
  state.failing = false;
  vi.advanceTimersByTime(10_000);
  expect(sent.map((b) => b.map((e) => e.kind))).toEqual([['app_open', 'focus']]);
  // At closing, one attempt: a failure is dropped, nothing is said, nothing is thrown.
  state.failing = true;
  q.record({ kind: 'app_close' });
  expect(() => q.finish()).not.toThrow();
  expect(q.size).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
  expect(warn).not.toHaveBeenCalled();
});

test('la file est bornée à 10 000 événements : au-delà, les plus anciens sont abandonnés, la mémoire ne grandit pas', () => {
  vi.useFakeTimers();
  expect(MAX_CONSULTATION_BATCH).toBe(10_000);
  const { q, sent, state } = queue();
  state.failing = true;
  for (let i = 0; i < 10_005; i++) q.record({ kind: 'focus', detail: String(i) });
  expect(q.size).toBe(10_000);
  // A principal that stays broken through many intervals does not make it grow.
  vi.advanceTimersByTime(10_000 * 5);
  for (let i = 0; i < 100; i++) q.record({ kind: 'blur', detail: String(i) });
  expect(q.size).toBe(10_000);
  state.failing = false;
  vi.advanceTimersByTime(10_000);
  expect(sent).toHaveLength(1);
  expect(sent[0]).toHaveLength(10_000);
  // The oldest went: 105 of them; the newest stayed, in order.
  expect(sent[0][0]).toMatchObject({ kind: 'focus', detail: '105' });
  expect(sent[0].at(-1)).toMatchObject({ kind: 'blur', detail: '99' });
});

test('la borne est un paramètre de la file : trois événements au plus, les plus récents', () => {
  const { q, sent } = queue({}, 3);
  for (let i = 0; i < 5; i++) q.record({ kind: 'focus', detail: String(i) });
  q.finish();
  expect(sent[0].map((e) => e.detail)).toEqual(['2', '3', '4']);
});

test('un détail trop long est coupé à 2 000 caractères, sans couper une paire de substitution ; un lot de la file passe la validation du principal', () => {
  const { q, sent } = queue();
  q.record({ kind: 'search', detail: 'a'.repeat(5000) });
  q.record({ kind: 'search', detail: `${'a'.repeat(MAX_DETAIL_CHARS - 1)}😀 et la suite` });
  q.record({ kind: 'search', detail: 'court' });
  q.finish();
  const [long, pair, short] = sent[0];
  expect(long.detail).toHaveLength(MAX_DETAIL_CHARS);
  expect(pair.detail).toBe('a'.repeat(MAX_DETAIL_CHARS - 1));
  expect(short.detail).toBe('court');
  expect(() => parseConsultations(sent[0])).not.toThrow();
});

test('les champs absents ne sont pas écrits dans l’événement, le plan du brouillon l’emporte sur celui où l’on est', () => {
  const { q, sent, state } = queue();
  state.plan = undefined;
  q.record({ kind: 'app_open' });
  state.plan = 'p9';
  q.record({ kind: 'plan_shown', plan: 'p2', subject: 'p2' });
  q.finish();
  expect(sent[0]).toEqual([{ at: 1000, kind: 'app_open' }, { at: 1001, kind: 'plan_shown', plan: 'p2', subject: 'p2' }]);
  expect(Object.keys(sent[0][0])).toEqual(['at', 'kind']);
});

// ---------------------------------------------------------------------------------------------------------------------
// The emission points: what each decides, without a window.

test('le réglage : enregistrer si l’interrupteur vaut « yes » et que ce n’est ni le banc ni une capture ; toute autre valeur, abîmée comprise, éteint ; l’intervalle est celui du réglage', () => {
  expect(consultationSettings(DEFAULT_PARAMS, false)).toEqual({ record: true, flushMs: 10_000 });
  expect(consultationSettings({ ...DEFAULT_PARAMS, consultationsRecord: 'no' }, false)).toEqual({ record: false, flushMs: 10_000 });
  // A privacy switch fails closed: a value that is neither (a settings file edited by hand, a shared setting of another version).
  for (const corrupt of ['YES', 'oui', 'true', '', 1, true, null, undefined, ['yes']]) {
    expect(consultationSettings({ ...DEFAULT_PARAMS, consultationsRecord: corrupt as never }, false).record, String(corrupt)).toBe(false);
  }
  expect(consultationSettings({ ...DEFAULT_PARAMS, consultationsFlushMs: 3000 }, false).flushMs).toBe(3000);
  expect(consultationSettings(DEFAULT_PARAMS, true).record).toBe(false);
});

test('plan_shown : un plan montré, aucun avant que l’état soit là', () => {
  expect(planShownDraft('p1')).toEqual({ kind: 'plan_shown', plan: 'p1' });
  expect(planShownDraft(null)).toBeNull();
});

const rect = { x: 0, y: 0, w: 100, h: 100 };

test('node_popup et file_preview : un pop-up ou un aperçu qui s’ouvre est un événement (un clic, un lien, un aperçu depuis un pop-up) ; remis devant, rouvert ou fermé, non', () => {
  const none: Panel[] = [];
  const a = withNode(none, 'n1', rect, 1);
  expect(openedPanels(none, a)).toEqual([{ kind: 'node_popup', subject: 'n1' }]);
  // A link opens a pop-up beside the one it was clicked in.
  const b = withLinked(a, 'n2', rect, 2);
  expect(openedPanels(a, b)).toEqual([{ kind: 'node_popup', subject: 'n2' }]);
  // The node already open: brought forward, not opened.
  expect(openedPanels(b, withNode(b, 'n2', rect, 3))).toEqual([]);
  expect(openedPanels(b, withLinked(b, 'n1', rect, 4))).toEqual([]);
  // A file's preview, by its name; another node's pop-up closes the loose ones — what stays is not new.
  const c = withFile(b, 'n1', 'article.pdf', rect, 5);
  expect(openedPanels(b, c)).toEqual([{ kind: 'file_preview', subject: 'n1', detail: 'article.pdf' }]);
  expect(openedPanels(c, withFile(c, 'n1', 'ARTICLE.pdf', rect, 6))).toEqual([]);
  const d = withNode(c, 'n3', rect, 7);
  expect(openedPanels(c, d)).toEqual([{ kind: 'node_popup', subject: 'n3' }]);
  // Closing opens nothing.
  expect(openedPanels(d, withoutLoose(d))).toEqual([]);
  expect(openedPanels(d, d)).toEqual([]);
});

test('file_fullscreen : le plein écran d’un fichier est un événement, sa fermeture et la comparaison d’un .tex avec sa copie non', () => {
  expect(fullDraft({ kind: 'file', node: 'n1', name: 'notes.tex' })).toEqual({ kind: 'file_fullscreen', subject: 'n1', detail: 'notes.tex' });
  expect(fullDraft({ kind: 'node', node: 'n1' })).toBeNull();
  expect(fullDraft({ kind: 'compare', node: 'n1', original: 'a.tex', copy: 'a (copie).tex' })).toBeNull();
  expect(fullDraft(null)).toBeNull();
});

test('connection_popup : un événement par connexion que la ligne cliquée représente', () => {
  expect(connectionDrafts(['c1'])).toEqual([{ kind: 'connection_popup', subject: 'c1' }]);
  expect(connectionDrafts(['c1', 'c2'])).toEqual([{ kind: 'connection_popup', subject: 'c1' }, { kind: 'connection_popup', subject: 'c2' }]);
  expect(connectionDrafts([])).toEqual([]);
});

test('search : le texte cherché et le résultat choisi ; un texte tapé puis fermé sans choix, sans sujet ; un champ vide, rien', () => {
  expect(searchDraft('  tenseur ', { id: 'n1' })).toEqual({ kind: 'search', detail: 'tenseur', subject: 'n1' });
  expect(searchDraft('tenseur')).toEqual({ kind: 'search', detail: 'tenseur' });
  expect(searchDraft('   ')).toBeNull();
  expect(searchDraft('', { id: 'n1' })).toBeNull();
  expect(searchDraft('a'.repeat(5000))!.detail).toHaveLength(MAX_DETAIL_CHARS);
});

test('focus et blur : le focus pris ou perdu, une fois ; l’état déjà connu ne fait rien (la fenêtre cachée, puis sans focus, ne compte qu’un blur)', () => {
  const t = new FocusTracker(true);
  expect(t.set(true)).toBeNull();
  expect(t.set(false)).toEqual({ kind: 'blur' });
  expect(t.set(false)).toBeNull();
  expect(t.set(true)).toEqual({ kind: 'focus' });
  expect(new FocusTracker(false).set(false)).toBeNull();
});

/** Jumps on a stand-in view: the places and the moves are recorded as the jumps make them, and what they report is kept. */
function jumper(reveals = true) {
  const jumped: unknown[] = [];
  let shown = 'p1', stack = 0;
  const host: JumpHost = {
    state: () => ({ plans: new Map([['p1', {}], ['p2', {}]]) }) as never, place: () => ({ plan: shown, camera: { x: stack, y: 0, zoom: 1, widthPx: 10, heightPx: 10 } }),
    max: () => 100, busy: () => false, stopFlash: () => {}, remember: () => {}, openPlan: (p) => { shown = p; }, moveCamera: () => { stack++; },
    jumped: (j) => jumped.push(j),
  };
  const jumps = new Jumps(host, { reveal: (t) => { if (reveals) shown = t.plan; return reveals; } });
  return { jumps, jumped };
}

test('jump : un saut réussi (la recherche, un lien, « voir dans un autre plan », un bouton de plan) ; la téléportation, et le retour ou l’avance ; un objet disparu ne fait rien', () => {
  const { jumps, jumped } = jumper();
  expect(jumps.reveal({ plan: 'p2', id: 'n7', kind: 'node' })).toBe(true);
  expect(jumped).toEqual([{ kind: 'reveal', plan: 'p2', subject: 'n7' }]);
  jumps.moveTo({ x: 5, y: 5, zoom: 1, widthPx: 10, heightPx: 10 });
  expect(jumped.at(-1)).toEqual({ kind: 'teleport', plan: 'p2' });
  expect(jumps.back()).toBe(true);
  expect(jumped.at(-1)).toMatchObject({ kind: 'back' });
  expect(jumps.forward()).toBe(true);
  expect(jumped.at(-1)).toMatchObject({ kind: 'forward' });
  const gone = jumper(false);
  expect(gone.jumps.reveal({ plan: 'p2', id: 'n7', kind: 'node' })).toBe(false);
  expect(gone.jumps.back()).toBe(false);
  expect(gone.jumped).toEqual([]);
});

test('jump : le brouillon d’un saut — l’objet pour sujet, le plan d’arrivée, et comment (retour, avance, téléportation) en détail', () => {
  expect(jumpDraft({ kind: 'reveal', plan: 'p2', subject: 'n7' })).toEqual({ kind: 'jump', plan: 'p2', subject: 'n7' });
  expect(jumpDraft({ kind: 'teleport', plan: 'p2' })).toEqual({ kind: 'jump', plan: 'p2', detail: 'teleport' });
  expect(jumpDraft({ kind: 'back', plan: 'p1' })).toEqual({ kind: 'jump', plan: 'p1', detail: 'back' });
  expect(jumpDraft({ kind: 'forward', plan: 'p3' })).toEqual({ kind: 'jump', plan: 'p3', detail: 'forward' });
});
