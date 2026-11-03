import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
    marks: {}, heapMb: 400, gc: true, edits: null,
    phases: { baseOpened: 900, dataSent: 1500, dataReceived: 2100, stateReady: 3000, sceneReady: 6500, engineReady: 3400, firstFrame: 6800 },
    processMb: { browser: 700, tab: 900, gpu: 300 },
  };
}

test('rapport à trois passes : le contenu vaut brut moins plancher ; le nom suit CIRRUS_BENCH_NAME', () => {
  process.env.CIRRUS_BENCH_NAME = 'essai-banc';
  expect(recordRun(dir, pass('vsync', [2.42, 4.79]), false, '1000,10000')).toBeNull();
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
});

test('nom du rapport par défaut : app-rendu-<date>', () => {
  delete process.env.CIRRUS_BENCH_NAME;
  expect(benchName()).toBe(`app-rendu-${new Date().toISOString().slice(0, 10)}`);
  const report = recordRun(dir, pass('vsync', [2, 4]), true, '1000,10000');
  expect(report).toBe(join(dir, `${benchName()}.md`));
});

test('base du banc : construite une fois, reconstruite quand son tampon ne correspond plus', () => {
  const base = join(dir, 'base');
  const spec = { seed: 1, nodes: 200, connections: 1000 };
  expect(ensureBenchBase(base, spec)).toBe(true);
  expect(existsSync(join(base, 'cirrus.db'))).toBe(true);
  expect(ensureBenchBase(base, spec)).toBe(false);
  writeFileSync(join(base, BENCH_STAMP), '{"generator":0}', 'utf8');
  expect(ensureBenchBase(base, spec)).toBe(true);
  expect(ensureBenchBase(base, { ...spec, nodes: 300 })).toBe(true);
}, 60_000);
