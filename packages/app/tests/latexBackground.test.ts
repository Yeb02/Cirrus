import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Action, applyOps, CITE_KEY_TAG, type CompileAnswer, type CompileRequest, DEFAULT_PREAMBLE, editConnection, editNode, type FileRef, LABEL_TAG,
  setPreamble, type State, type TagValue, uuidv7,
} from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { DEFAULT_PARAMS, type RenderParams } from '@cirrus/view';
import { afterAll, afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { PdfCache } from '../src/main/latex/cache.ts';
import { LatexService } from '../src/main/latex/compiler.ts';
import { findBinaries, type TexBinaries } from '../src/main/latex/tinytex.ts';
import { backgroundOrigins, changedBySync, SyncedChanges } from '../src/renderer/latex/background.ts';
import { LatexRegistry, type Origin, slotOf } from '../src/renderer/latex/registry.ts';
import { EditSession } from '../src/renderer/session.ts';
import { texTexts, until } from './support/latex.ts';

// Plan 5b, D1: what a synchronisation changed is compiled in the background. The interface's side (what changed, the
// sources it touches), then the main process's queue.

/** Every process the service starts, and its folder: a background request found in the cache starts none. */
const spawned = vi.hoisted(() => [] as ChildProcess[]);
const cwdOf = vi.hoisted(() => new Map<ChildProcess, string>());
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>();
  const spawn = ((...args: unknown[]) => {
    const p = (cp.spawn as (...a: unknown[]) => ChildProcess)(...args);
    spawned.push(p);
    cwdOf.set(p, (args[2] as { cwd: string }).cwd);
    return p;
  }) as typeof cp.spawn;
  return { ...cp, spawn, default: { ...cp, spawn } };
});

// One test base for the interface's tests, never the user's: each test reads its state from the store again.
let dir: string, store: LocalStore, ids: FixtureIds;
// The bench's TinyTeX (or CIRRUS_TINYTEX), read only: the tests never download anything.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEX = process.env.CIRRUS_TINYTEX || join(repo, 'bench', 'latex', 'vendor', 'TinyTeX');
const hasTex = existsSync(join(TEX, 'bin', 'windows', 'pdflatex.exe'));
const texTest = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  test.skipIf(!hasTex)(hasTex ? name : `${name} (sauté : pas de TinyTeX dans ${TEX})`, fn, timeout);
let bins: TexBinaries | null = null;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-latexbackground-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  if (hasTex) bins = await findBinaries(TEX);
}, 30_000);
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const kv = (key: string, value: string | number): TagValue => ({ key, value });
/** Applies an action computed on `s` to `s`, as the session does once it is written. */
const run = (s: State, a: Action): Action => {
  applyOps(s, a.ops);
  return a;
};
/** One action of several, as a reconciliation reports it: their operations in order. */
const joined = (...actions: Action[]): Action => ({ id: uuidv7(), label: 'Synchronisation', ops: actions.flatMap((a) => a.ops) });
const slots = (origins: Origin[]) => origins.map(slotOf);
const summaries = (...nodes: string[]) => nodes.map((n) => `summary:${n}`).sort();
const NONE = { nodes: new Set(), connections: new Set(), preamble: false };

/** Occam's title defines the label occam:rasoir, and it has a summary; three summaries cite it. */
function citedByThree(s: State) {
  const { occam, universalite, monde, biais } = ids.nodes;
  run(s, editNode(s, occam, { summary: 'Le rasoir.', tags: [...s.nodes.get(occam)!.tags, kv(LABEL_TAG, 'occam:rasoir')] }));
  for (const n of [universalite, monde, biais]) run(s, editNode(s, n, { summary: 'Voir \\ref{occam:rasoir}.' }));
  return [universalite, monde, biais];
}

/**
 * A session without a server's list, whose changes go to `changes` as App's do; `receive` applies another PC's action
 * as the synchronisation does (EditSession.reconcile).
 */
function synced(s: State) {
  const changes = new SyncedChanges();
  let seq = 0;
  const session = new EditSession(s, async (a) => ({ seq: (seq += a.ops.length), at: 0 }), (_st, a) => changes.note(a));
  const receive = (a: Action) =>
    session.reconcile([{ unit: uuidv7(), action: a.id, label: a.label, at: 1, pc: 'pc-b', ops: a.ops, seq: seq + 1 }], [], async () => (seq += a.ops.length));
  return { changes, session, receive };
}

// --- what a synchronisation changed (changedBySync) ---

test('changedBySync : un résumé changé', () => {
  const s = store.loadState();
  expect(changedBySync(editNode(s, ids.nodes.entropie, { summary: 'Autre.' }))).toEqual({ ...NONE, nodes: new Set([ids.nodes.entropie]) });
  // A tag that LaTeX does not read changes nothing for it.
  expect(changedBySync(editNode(s, ids.nodes.entropie, { tags: [kv('statut_epistémique', 'plausible')] }))).toEqual(NONE);
});

test('changedBySync : une relation changée', () => {
  const s = store.loadState();
  const c = ids.connections.mdlSolomonoff;
  expect(changedBySync(editConnection(s, c, { relation: 'Un analogue.' }))).toEqual({ ...NONE, connections: new Set([c]) });
});

test('changedBySync : un fichier ajouté à un nœud', () => {
  const s = store.loadState();
  const { occam, mdl } = ids.nodes;
  const png = s.nodes.get(mdl)!.files[0];
  expect(changedBySync(editNode(s, occam, { files: [...s.nodes.get(occam)!.files, png] }))).toEqual({ ...NONE, nodes: new Set([occam]) });
});

test('changedBySync : un résumé changé puis rendu à son texte dans la même réconciliation ne change rien', () => {
  // The rewind of this PC's pending write, then its replay: the first « before » and the last « after » are the same.
  const s = store.loadState();
  const { entropie } = ids.nodes;
  const text = s.nodes.get(entropie)!.summary;
  const there = run(s, editNode(s, entropie, { summary: 'Brouillon.' }));
  const back = run(s, editNode(s, entropie, { summary: text }));
  expect(changedBySync(joined(there, back))).toEqual(NONE);
});

test('changedBySync : le préambule', () => {
  const s = store.loadState();
  const there = run(s, setPreamble(s, `${DEFAULT_PREAMBLE}\\usepackage{xcolor}\n`));
  expect(changedBySync(there)).toEqual({ ...NONE, preamble: true });
  // Changed, then written back as the default one, which a base without any has: nothing.
  const back = run(s, setPreamble(s, DEFAULT_PREAMBLE));
  expect(changedBySync(joined(there, back)).preamble).toBe(false);
});

// --- the sources it touches (backgroundOrigins) ---

test('backgroundOrigins : un nœud renommé dont le label est cité par trois résumés : ces trois-là, et le sien seulement si son texte a changé', () => {
  const s = store.loadState();
  const { occam } = ids.nodes;
  const citers = citedByThree(s);
  const texts = texTexts(s, dir), before = LatexRegistry.build(s, texts);
  const rename = run(s, editNode(s, occam, { title: 'Rasoir d’Occam' }));
  const after = LatexRegistry.build(s, texts, before);
  expect(slots(backgroundOrigins(changedBySync(rename), before, after, s, texts)).sort()).toEqual(summaries(...citers));
  // Renamed, and its summary changed too: its own as well.
  const both = run(s, editNode(s, occam, { title: 'Le rasoir d’Occam', summary: 'Le rasoir, formalisé.' }));
  const third = LatexRegistry.build(s, texts, after);
  expect(slots(backgroundOrigins(changedBySync(both), after, third, s, texts)).sort()).toEqual(summaries(occam, ...citers));
});

test('backgroundOrigins : une clé clé_bibtex déplacée d’un nœud à l’autre : ses citeurs, les résumés d’abord', () => {
  const s = store.loadState();
  const { occam, monde, publication, mdl, kolmogorov } = ids.nodes;
  for (const n of [occam, monde]) run(s, editNode(s, n, { summary: 'Voir \\cite{li2008}.' }));
  const texts = texTexts(s, dir), before = LatexRegistry.build(s, texts);
  const from = run(s, editNode(s, publication, { tags: s.nodes.get(publication)!.tags.filter((t) => t.key !== CITE_KEY_TAG) }));
  const to = run(s, editNode(s, mdl, { tags: [...s.nodes.get(mdl)!.tags, kv(CITE_KEY_TAG, 'li2008')] }));
  const after = LatexRegistry.build(s, texts, before);
  const origins = slots(backgroundOrigins(changedBySync(joined(from, to)), before, after, s, texts));
  // complexité.tex cites it too; neither node's own sources changed.
  expect(origins.slice(0, 2).sort()).toEqual(summaries(occam, monde));
  expect(origins.slice(2)).toEqual([`file:${kolmogorov}:complexité.tex`]);
});

test('backgroundOrigins : le préambule : toutes les sources, résumés et relations d’abord', () => {
  const s = store.loadState();
  const { mdl, entropie, kolmogorov } = ids.nodes, { mdlSolomonoff, twoToOne } = ids.connections;
  const texts = texTexts(s, dir), before = LatexRegistry.build(s, texts);
  const a = run(s, setPreamble(s, `${DEFAULT_PREAMBLE}\\usepackage{xcolor}\n`));
  const origins = backgroundOrigins(changedBySync(a), before, LatexRegistry.build(s, texts, before), s, texts);
  // Two summaries (MDL, Entropie), three relations (Analogue bayésien, Déduction jointe, Source hors plan), two .tex.
  expect(origins.map((o) => o.kind)).toEqual(['summary', 'summary', 'relation', 'relation', 'relation', 'file', 'file']);
  expect(slots(origins)).toEqual(expect.arrayContaining([
    `summary:${mdl}`, `summary:${entropie}`, `relation:${mdlSolomonoff}`, `relation:${twoToOne}`, `file:${mdl}:Enoncé_détaillé.tex`,
    `file:${kolmogorov}:complexité.tex`,
  ]));
});

test('backgroundOrigins : une action de ce PC ne compile rien en fond ; la même, reçue par la synchronisation, compile ses citeurs', async () => {
  const s = store.loadState();
  const { occam } = ids.nodes;
  const citers = citedByThree(s);
  const texts = texTexts(s, dir);
  const { changes, session, receive } = synced(s);
  let registry = LatexRegistry.build(s, texts);
  /** The registry built again, as useLatexRegistry does, and what it compiles in the background. */
  const rebuild = () => {
    const next = LatexRegistry.build(s, texts, registry);
    const out = changes.take(registry, next, s, texts);
    registry = next;
    return slots(out).sort();
  };
  // This PC renames it: its open views compile it, as they always did.
  expect((await session.run((st) => editNode(st, occam, { title: 'Rasoir' }))).ok).toBe(true);
  expect(rebuild()).toEqual([]);
  // Another PC renames it: the three citers, once.
  await receive(editNode(s, occam, { title: 'Rasoir d’Occam' }));
  expect(rebuild()).toEqual(summaries(...citers));
  expect(rebuild()).toEqual([]);
});

test('SyncedChanges : un .tex reçu attend que son texte soit lu, comparé au registre d’avant la synchronisation', async () => {
  const s = store.loadState();
  const { monde } = ids.nodes;
  run(s, editNode(s, monde, { summary: 'Un monde.' }));
  const texts = texTexts(s, dir);
  const { changes, receive } = synced(s);
  const before = LatexRegistry.build(s, texts);
  const tex: FileRef = { name: 'note.tex', hash: 'e'.repeat(64), size: 30 };
  await receive(editNode(s, monde, { files: [...s.nodes.get(monde)!.files, tex] }));
  // Built again before the .tex is read: nothing yet.
  const middle = LatexRegistry.build(s, texts, before);
  expect(changes.take(before, middle, s, texts)).toEqual([]);
  // Read: the node's summary (its files changed, which it may include) and the .tex.
  const read = new Map(texts).set(tex.hash, 'Voir \\ref{solomonoff}.');
  const last = LatexRegistry.build(s, read, middle);
  expect(slots(changes.take(middle, last, s, read))).toEqual([`summary:${monde}`, `file:${monde}:note.tex`]);
  expect(changes.take(last, LatexRegistry.build(s, read, last), s, read)).toEqual([]);
});

// --- the main process's queue (LatexService.background) ---

let base: string;
let svc: LatexService | null = null;
let cache: PdfCache;
/** The settings of the service started last: a test may change them while it runs. */
let params: RenderParams = DEFAULT_PARAMS;
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cirrus-é-fond-'));
  spawned.length = 0;
  cwdOf.clear();
});
afterEach(async () => {
  await svc?.dispose();
  svc = null;
  rmSync(base, { recursive: true, force: true, maxRetries: 10 });
  vi.restoreAllMocks();
});

function start(over: Partial<RenderParams> = {}, binaries: () => Promise<TexBinaries | null> = async () => bins): LatexService {
  params = { ...DEFAULT_PARAMS, ...over };
  cache = new PdfCache(join(base, 'latex', 'cache'), () => params.latexCacheMb * 2 ** 20);
  svc = new LatexService({ binaries, root: join(base, 'latex'), store: base, params: () => params, cache });
  return svc;
}

const req = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  slot: 'summary:n1', mode: 'snippet', source: 'Fond.', preamble: DEFAULT_PREAMBLE, refs: [], broken: [], doubled: [], cites: [],
  doubledCites: [], unknownCites: [], known: [], resources: [], widthCm: DEFAULT_PARAMS.latexSnippetWidthCm, ...over,
});
/** Whether the request's PDF is in the cache's folder. */
const inCache = (r: CompileRequest) => existsSync(join(base, 'latex', 'cache', `${cache.key(r, bins!.version)}.pdf`));
const alive = (p: ChildProcess) => p.exitCode === null && p.signalCode === null;
function ok(a: CompileAnswer): Extract<CompileAnswer, { status: 'ok' }> {
  if (a.status !== 'ok') throw new Error(`compilation : ${JSON.stringify(a).slice(0, 3000)}`);
  return a;
}
/** TeX waiting, in a loop, until `file`.tex is in its folder. */
const waitFor = (name: string, file: string) =>
  `\\newread\\${name}\\def\\${name}w{\\openin\\${name}=${file} \\ifeof\\${name}\\expandafter\\${name}w\\fi}\\${name}w\\closein\\${name} `;
/** Writes `file` into the folder of every pdfLaTeX alive. */
const touch = (file: string) => { for (const p of spawned.filter(alive)) writeFileSync(join(cwdOf.get(p)!, file), ''); };
/** A request of the user waiting for pdfLaTeX, its search held until `open()`: the background waits behind it. */
function held() {
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  return { open, binaries: async () => { await gate; return bins; } };
}

test('une demande de fond déjà en cache ne lance aucun pdfLaTeX', async () => {
  const fake: TexBinaries = { root: base, pdflatex: join(base, 'absent', 'pdflatex.exe'), tlmgr: join(base, 'absent', 'tlmgr.bat'), version: 'pdfTeX factice' };
  const s = start({}, async () => fake);
  const r = req();
  writeFileSync(join(base, 'job.pdf'), 'pdf');
  cache.put(cache.key(r, fake.version), join(base, 'job.pdf'), { pages: 1, labels: [], log: '', passes: 1 });
  s.background([r]);
  await s.backgroundIdle();
  expect(spawned).toEqual([]);
  // One that is not starts one (which fails here: this pdfLaTeX does not exist).
  vi.spyOn(console, 'error').mockImplementation(() => {});
  s.background([req({ slot: 'summary:n2', source: 'Autre.' })]);
  await s.backgroundIdle();
  expect(spawned.length).toBeGreaterThan(0);
});

texTest('une demande de l’utilisateur arrivée pendant une compilation de fond passe d’abord ; la demande de fond reprend après', async () => {
  // One prepared pdfLaTeX, which loads its preamble only once gate.tex is in its folder: the test decides when one is
  // free. The background's source runs until go.tex is in its folder.
  const preamble = `${DEFAULT_PREAMBLE}${waitFor('cirrusgate', 'gate')}\n`;
  const s = start({ latexWarmProcesses: 1, latexTimeoutMs: 60_000 });
  s.warm(preamble);
  await until(() => spawned.length === 1);
  touch('gate.tex');
  const bg = req({ slot: 'summary:fond', preamble, source: `${waitFor('cirrusgo', 'go')}Fond.` });
  s.background([bg]);
  const running = (p: ChildProcess) => existsSync(join(cwdOf.get(p)!, `job-${basename(cwdOf.get(p)!).slice(1)}-src.tex`));
  await until(() => spawned.some(running));
  const first = spawned.find(running)!;
  // The user's request finds no free pdfLaTeX (the next one waits for its gate): the background's compilation stops.
  const user = s.compile(req({ slot: 'summary:utilisateur', preamble, source: 'Utilisateur.' }));
  await until(() => !alive(first));
  touch('gate.tex');
  ok(await user);
  expect(inCache(bg)).toBe(false);
  // Then the background's request starts again, and lands in the cache.
  let idle = false;
  void s.backgroundIdle().then(() => { idle = true; });
  await until(() => {
    touch('gate.tex');
    touch('go.tex');
    return idle;
  }, 30_000);
  expect(inCache(bg)).toBe(true);
});

texTest('la file de fond ne garde jamais plus de latexBackgroundMax demandes en attente, et 0 n’en garde aucune', async () => {
  const h = held();
  const s = start({ latexBackgroundMax: 2 }, h.binaries);
  const user = s.compile(req({ slot: 'summary:utilisateur', source: 'Utilisateur.' }));
  const [a, b, c] = ['A', 'B', 'C'].map((x) => req({ slot: `summary:${x}`, source: `${x}.` }));
  s.background([a, b]);
  s.background([c]);
  h.open();
  ok(await user);
  await s.backgroundIdle();
  expect([a, b, c].map(inCache)).toEqual([true, true, false]);
  params.latexBackgroundMax = 0;
  const d = req({ slot: 'summary:D', source: 'D.' });
  s.background([d]);
  await s.backgroundIdle();
  expect(inCache(d)).toBe(false);
});

texTest('une demande de fond nouvelle pour un même créneau remplace celle qui attend, même la file pleine', async () => {
  const h = held();
  const s = start({ latexBackgroundMax: 1 }, h.binaries);
  const user = s.compile(req({ slot: 'summary:utilisateur', source: 'Utilisateur.' }));
  const old = req({ slot: 'summary:n', source: 'Avant.' }), fresh = req({ slot: 'summary:n', source: 'Après.' });
  s.background([old]);
  s.background([fresh]);
  h.open();
  ok(await user);
  await s.backgroundIdle();
  expect([inCache(old), inCache(fresh)]).toEqual([false, true]);
});
