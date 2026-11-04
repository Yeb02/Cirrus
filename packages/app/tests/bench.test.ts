import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { BENCH_STAMP, benchName, ensureBenchBase, type PassRecord, recordRun } from '../src/main/bench.ts';

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
