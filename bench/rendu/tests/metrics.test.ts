import { test, expect } from 'vitest';
import { CRITERIA, evaluate, summarize, type RunResult } from '../src/bench/metrics';
import { toMarkdown } from '../src/bench/report';

test('percentiles', () => {
  const s = summarize(Array.from({ length: 100 }, (_, i) => i + 1));
  expect(s.p50).toBe(50);
  expect(s.p95).toBe(95);
  expect(s.max).toBe(100);
});

const ok: RunResult[] = [
  { label: 'uncapped', gpuName: 'ANGLE (NVIDIA GeForce RTX 4070 Laptop GPU ...)', canvasPx: [2560, 1600], frameIntervalMs: { p50: 1.2, p95: 1.8, max: 6, n: 9000 }, cpuMs: { p50: 0.6, p95: 1.1, max: 9, n: 9000 }, rebuilds: 40, loadMs: 900, memoryMb: 600 },
  { label: 'throttled-x4', gpuName: 'ANGLE (NVIDIA ...)', canvasPx: [2560, 1600], frameIntervalMs: { p50: 4, p95: 9, max: 30, n: 5000 }, cpuMs: { p50: 2.5, p95: 12, max: 40, n: 5000 }, rebuilds: 40, loadMs: 900, memoryMb: 600 },
];

test('critères tenus', () => {
  expect(evaluate(ok, CRITERIA).pass).toBe(true);
});

test('processeur trop lent sous ×4', () => {
  const bad = structuredClone(ok);
  bad[1].cpuMs.p95 = 17;
  expect(evaluate(bad, CRITERIA).pass).toBe(false);
});

test('mesure plafonnée détectée (Review Focus 1)', () => {
  const capped = structuredClone(ok);
  capped[0].frameIntervalMs.p50 = 1000 / 165;
  const v = evaluate(capped, CRITERIA);
  expect(v.pass).toBe('invalide');
  expect(v.lines.join(' ')).toMatch(/plafonn/);
});

test('carte graphique autre que la NVIDIA refusée (Review Focus 2)', () => {
  const sw = structuredClone(ok);
  sw[0].gpuName = 'ANGLE (Google SwiftShader)';
  expect(evaluate(sw, CRITERIA).pass).toBe('invalide');
});

test('critère carte graphique calculé hors des images de reconstruction', () => {
  const runs = structuredClone(ok);
  runs[0].frameIntervalMs.p95 = 5.7; // tiré par les reconstructions, limitées par le processeur
  runs[0].steadyIntervalMs = { p50: 0.3, p95: 1.5, max: 3, n: 8000 };
  const v = evaluate(runs, CRITERIA);
  expect(v.pass).toBe(true);
  expect(v.lines.join(' ')).toMatch(/hors reconstructions/);
});

test('critère carte graphique sur le temps GPU mesuré quand il existe', () => {
  const runs: RunResult[] = [
    { ...structuredClone(ok[0]), label: 'vsync', frameIntervalMs: { p50: 10, p95: 10.2, max: 40, n: 4000 }, gpuMs: { p50: 0.4, p95: 1.6, max: 9, n: 3990 } },
    structuredClone(ok[1]),
  ];
  const v = evaluate(runs, CRITERIA);
  expect(v.pass).toBe(true);
  expect(v.lines.join(' ')).toMatch(/temps GPU mesuré/);
  runs[0].gpuMs!.p95 = 2.5;
  expect(evaluate(runs, CRITERIA).pass).toBe(false);
});

test('le rapport montre p95 et maximum (Review Focus 3)', () => {
  const md = toMarkdown(ok, evaluate(ok, CRITERIA), '2026-11-02');
  expect(md).toMatch(/p95/);
  expect(md).toMatch(/max/);
});
