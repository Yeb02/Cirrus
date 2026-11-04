import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical, decodeState, type State, toSnapshot } from '@cirrus/core';
import { LocalStore } from '@cirrus/store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import {
  BENCH_STAMP, benchName, criteria, ensureBenchBase, type PassRecord, recordRun, recordSnapshots, type SnapshotGrowth, snapshotRewrites,
} from '../src/main/bench.ts';
import type { EditMeasures } from '../src/renderer/bench.ts';

let dir: string;
let savedName: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-app-bench-'));
  savedName = process.env.CIRRUS_BENCH_NAME;
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (savedName === undefined) delete process.env.CIRRUS_BENCH_NAME; else process.env.CIRRUS_BENCH_NAME = savedName;
});

const stats = (p50: number, p95: number) => ({ p50, p95, p99: p95, max: p95, n: 100 });
function pass(label: string, steady: [number, number]): PassRecord {
  return {
    label, gpuName: 'carte d’essai', timer: true, disjoint: 0, canvasPx: [1600, 1000], gpuMs: stats(steady[0] + 0.1, steady[1] + 1), gpuSteadyMs: stats(...steady),
    cpuMs: stats(0.5, 2), intervalMs: stats(16.6, 17), rebuilds: 3, worstFrame: { t: 2, cpuMs: 12, rebuilt: true }, reasons: { rect: 3 },
    marks: {}, heapMb: 400, gc: true, edits: null, beforeEdits: null,
    phases: { baseOpened: 900, dataSent: 1500, dataReceived: 2100, stateReady: 3000, sceneReady: 6500, engineReady: 3400, firstFrame: 6800 },
    processMb: { browser: 700, tab: 900, gpu: 300 },
  };
}

test('rapport à trois passes : le contenu vaut brut moins plancher ; le nom suit CIRRUS_BENCH_NAME', () => {
  process.env.CIRRUS_BENCH_NAME = 'essai-banc';
  const vsync = { ...pass('vsync', [2.42, 4.79]), heapMb: 1672, beforeEdits: { heapMb: 557, processMb: { browser: 460, tab: 1300, gpu: 210 } }, rebuildMs: stats(1.25, 3.5) };
  expect(recordRun(dir, vsync, false, '1000,10000')).toBeNull();
  expect(recordRun(dir, pass('plancher', [0.78, 1.58]), false, '1000,10000')).toBeNull();
  const report = recordRun(dir, pass('throttled-x4', [2.5, 5]), true, '1000,10000');
  expect(report).toBe(join(dir, 'essai-banc.md'));
  const json = JSON.parse(readFileSync(join(dir, 'essai-banc.json'), 'utf8'));
  expect(json.runs.map((r: PassRecord) => r.label)).toEqual(['vsync', 'plancher', 'throttled-x4']);
  expect(json.gpu.raw).toMatchObject({ p50: 2.42, p95: 4.79 });
  expect(json.gpu.floor).toMatchObject({ p50: 0.78, p95: 1.58 });
  expect(json.gpu.content.p50).toBeCloseTo(1.64, 9);
  expect(json.gpu.content.p95).toBeCloseTo(3.21, 9);
  const md = readFileSync(report!, 'utf8');
  for (const s of ['1.64', '3.21', 'plancher', 'première image', 'Mémoire', 'Intervalle']) expect(md).toContain(s);
  // The edit pass's memory, before and after it; the other passes once.
  expect(md).toContain('| vsync, après chargement | 557 | 460 | 1300 | 210 |');
  expect(md).toContain('| vsync, après éditions | 1672 | 700 | 900 | 300 |');
  expect(md).toContain('| plancher | 400 | 700 | 900 | 300 |');
  // The frames that rebuilt, their main-thread time (plan 3c task 8); a pass recorded without it shows a dash.
  expect(md).toContain('| 3 (rect 3) | 1.25 / 3.50 / 3.50 |');
  expect(md).toContain('| 3 (rect 3) | — |');
});

test('nom du rapport par défaut : app-rendu-<date>', () => {
  delete process.env.CIRRUS_BENCH_NAME;
  expect(benchName()).toBe(`app-rendu-${new Date().toISOString().slice(0, 10)}`);
  const report = recordRun(dir, pass('vsync', [2, 4]), true, '1000,10000');
  expect(report).toBe(join(dir, `${benchName()}.md`));
});

test('base du banc : construite une fois, reconstruite quand son tampon ne correspond plus', () => {
  const base = join(dir, 'cirrus-bench-essai');
  const spec = { seed: 1, nodes: 200, connections: 1000 };
  expect(ensureBenchBase(base, spec)).toBe(true);
  expect(existsSync(join(base, 'cirrus.db'))).toBe(true);
  expect(ensureBenchBase(base, spec)).toBe(false);
  writeFileSync(join(base, BENCH_STAMP), '{"generator":0}', 'utf8');
  expect(ensureBenchBase(base, spec)).toBe(true);
  expect(ensureBenchBase(base, { ...spec, nodes: 300 })).toBe(true);
}, 60_000);

test('base du banc : un autre dossier qu’un cirrus-bench-* du dossier temporaire est refusé, une base sans tampon du banc jamais effacée (M5)', () => {
  const spec = { seed: 1, nodes: 20, connections: 20 }, temp = join(dir, 'temp');
  mkdirSync(temp);
  // Not named cirrus-bench-*, or outside the temporary folder: refused, nothing written.
  for (const other of [join(temp, 'base'), join(dir, 'cirrus-bench-hors-temp')]) {
    expect(() => ensureBenchBase(other, spec, temp), other).toThrow(/Dossier du banc refusé/);
    expect(existsSync(other), other).toBe(false);
  }
  // A base without the bench's stamp (the user's, a copy of it): kept as it is.
  const user = join(temp, 'cirrus-bench-utilisateur');
  mkdirSync(user);
  writeFileSync(join(user, 'cirrus.db'), 'base de l’utilisateur', 'utf8');
  expect(() => ensureBenchBase(user, spec, temp)).toThrow(/sans le tampon du banc/);
  expect(readFileSync(join(user, 'cirrus.db'), 'utf8')).toBe('base de l’utilisateur');
  // A build interrupted halfway keeps a stamp (the provisional one): it is built again.
  const bench = join(temp, 'cirrus-bench-1-20-20');
  expect(ensureBenchBase(bench, spec, temp)).toBe(true);
  writeFileSync(join(bench, BENCH_STAMP), JSON.stringify({ building: true }), 'utf8');
  expect(ensureBenchBase(bench, spec, temp)).toBe(true);
  expect(ensureBenchBase(bench, spec, temp)).toBe(false);
}, 60_000);

// ———— Plan 3c, task 10: the criteria, the base file over snapshot rewrites, the report's new sections (R46)

const edits = (over: Partial<EditMeasures> = {}): EditMeasures => ({
  node: 'Nœud 44 ∑', dragFrameMs: stats(0.4, 0.9), dropMs: 12, renameMs: 8, createMs: 9, connectMs: 10, undoMs: [7, 8, 9], tabNewMs: 18, tabBackMs: 15,
  groupDropMs: 20, groupDropInto: 'Groupe 7', lobbyColdMs: 450, dragBytes: stats(30_000, 90_000), dragTextureBytes: stats(16_384, 32_768),
  dragBytesBy: { curve: stats(20_000, 60_000), sky: stats(72, 72) }, meshBytes: { curve: 500_000, sky: 80 }, dragRingsMs: stats(0.05, 0.2),
  dragRingsShare: stats(0.1, 0.3), notes: [], ...over,
});
/** The five passes of a bench run, the edit pass and the memory as given. */
function benchRuns(e: EditMeasures, o: { firstFrame?: number; heapMb?: number; browser?: number; content?: [number, number] } = {}): PassRecord[] {
  const content = o.content ?? [0.9, 1.9];
  const vsync: PassRecord = {
    ...pass('vsync', [content[0] + 0.02, content[1] + 0.02]), edits: e, rebuildMs: stats(1.7, 3.9), intervalMs: { p50: 10.5, p95: 10.7, p99: 10.8, max: 41, n: 3000 },
    beforeEdits: { heapMb: o.heapMb ?? 140, processMb: { browser: o.browser ?? 42, tab: 335, gpu: 169 } },
  };
  vsync.phases = { ...vsync.phases, firstFrame: o.firstFrame ?? 1400 };
  const secours = pass('secours', [1.5, 2.1]);
  secours.phases = { ...secours.phases, firstFrame: 9249 };
  const vide = { ...pass('vide', [0.2, 0.4]), processMb: { browser: 38, tab: 42, gpu: 229 } };
  return [vsync, pass('plancher', [0.02, 0.02]), { ...pass('throttled-x4', [1.6, 2.1]), cpuMs: stats(0.7, 8.2) }, secours, vide];
}

test('critères du plan 3c : chacun avec sa mesure, tenu ou non, sur les passes du banc', () => {
  const all = (rows: ReturnType<typeof criteria>) => Object.fromEntries(rows.map((r) => [r.key, r]));
  const ok = all(criteria(benchRuns(edits())));
  expect(Object.keys(ok)).toEqual(['load', 'fallback', 'tab', 'lobby', 'edits', 'drag', 'rebuild', 'gpu', 'cpu4', 'interval', 'heap', 'main']);
  for (const r of Object.values(ok)) expect(r.met, r.key).toBe(true);
  expect(ok.load.measure).toBe('1400 ms');
  expect(ok.fallback.measure).toBe('9249 ms');
  expect(ok.edits.measure).toContain('20 ms au pire');
  expect(ok.interval.measure).toContain('1.03');
  expect(ok.main.measure).toBe('42 Mo (vide : 38 Mo)');

  // Each target missed by a hair, or a measure absent (an edit refused: NaN): not met.
  const missed = all(criteria(benchRuns(edits({ connectMs: 31, tabBackMs: 51, lobbyColdMs: 501, dragFrameMs: stats(0.4, 1.01) }), { firstFrame: 1501, heapMb: 151, browser: 89, content: [1.01, 1.9] })));
  for (const key of ['load', 'tab', 'lobby', 'edits', 'drag', 'gpu', 'heap', 'main']) expect(missed[key].met, key).toBe(false);
  expect(missed.edits.measure).toContain('31 ms au pire (connexion)');
  expect(all(criteria(benchRuns(edits({ renameMs: Number.NaN }))))).toMatchObject({ edits: { met: false } });
  // Without the edit pass nor the empty base: not measured.
  const bare = all(criteria([pass('vsync', [1, 2])]));
  expect([bare.tab.met, bare.main.met, bare.cpu4.met]).toEqual([null, null, null]);
});

/** Every list of the state sorted: the tables come back in their own order. */
const sorted = (s: State) => Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, (v as unknown[]).map((x) => canonical(x)).sort()]));

test('réécritures de l’instantané : la taille de la base avant, après chacune et fermée ; l’instantané couvre la dernière action et égale les tables', () => {
  const base = join(dir, 'cirrus-bench-instantanes');
  ensureBenchBase(base, { seed: 1, nodes: 200, connections: 1000 }, dir);
  const g = snapshotRewrites(base, 3);
  expect(g.sizes.map((x) => x.step)).toEqual(['avant', 'ouverte', 'réécriture 1', 'réécriture 2', 'réécriture 3', 'fermée']);
  expect([g.encodeMs.length, g.writeMs.length]).toEqual([3, 3]);
  expect(g.snapshotMb).toBeGreaterThan(0);
  expect(g.sizes.every((x) => x.dbMb > 0)).toBe(true);
  expect(g.pageBytes).toBeGreaterThan(0);
  expect(g.pages).toBeGreaterThan(g.freePages);
  const store = LocalStore.open(base, { pc: 'test' });
  try {
    const snap = store.readSnapshot()!;
    expect([snap.seq, store.lastSeq()]).toEqual([3, 3]);
    expect(canonical(sorted(decodeState(snap.data)))).toBe(canonical(sorted(store.loadState())));
  } finally {
    store.close();
  }
}, 60_000);

test('rapport : la vue dense, le glissement (octets, anneaux), le dépôt dans un autre groupe, le lobby sans cache, les réécritures et les critères', () => {
  process.env.CIRRUS_BENCH_NAME = 'essai-sections';
  const growth: SnapshotGrowth = {
    snapshotMb: 61, encodeMs: [250, 260], writeMs: [400, 380], pages: 40_000, freePages: 15_000, pageBytes: 4096,
    sizes: [{ step: 'avant', dbMb: 587, walMb: 0 }, { step: 'ouverte', dbMb: 587, walMb: 0 }, { step: 'réécriture 1', dbMb: 650, walMb: 62 }, { step: 'fermée', dbMb: 650, walMb: 0 }],
  };
  recordSnapshots(dir, growth);
  const [vsync, plancher, slow, secours, vide] = benchRuns(edits());
  const dense: PassRecord = { ...pass('dense', [3.1, 4.2]), glyphs: { max: 30_000, t: 3, items: 3100 }, dense: { nodes: 6052, cols: 68, rows: 89, zoomLo: 0.375, zoomHi: 0.5 } };
  for (const r of [vsync, plancher, slow, secours, dense]) recordRun(dir, r, false, '1000,10000');
  const md = readFileSync(recordRun(dir, vide, true, '1000,10000')!, 'utf8');
  for (const s of [
    '## Vue dense au seuil de lisibilité', '6052 nœuds (68 × 89)', '30000 glyphes', '3100 éléments',
    'Octets envoyés par image d\'aperçu', '30000 / 90000', 'dont la texture des éléments', 'Anneaux et marqueurs', 'curve 20000 / 60000 sur 500000 ; sky 72 / 72 sur 80',
    'Dépôt dans un autre groupe (Alt, dans « Groupe 7 »)', '| 20 |', 'Ouverture du lobby sans cache', '| 450 |',
    '## Réécritures de l\'instantané', '| réécriture 1 | 650.0 | 62.0 |', '15000 pages libres sur 40000',
    '## Critères (plan 3c, tâche 10)', '| Ouverture du lobby sans cache | ≤ 500 ms | 450 ms | tenu |',
  ]) expect(md, s).toContain(s);
  expect(JSON.parse(readFileSync(join(dir, 'essai-sections.json'), 'utf8')).snapshots).toEqual(growth);
  // The next run starts without them (scripts/bench.mjs removes both files first).
  expect(existsSync(join(dir, '.app-rendu-instantanes.json'))).toBe(true);
});
