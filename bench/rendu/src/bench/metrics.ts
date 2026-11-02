export interface Stats { p50: number; p95: number; max: number; n: number }

/** Nearest-rank percentiles. */
export function summarize(samples: number[]): Stats {
  if (samples.length === 0) return { p50: NaN, p95: NaN, max: NaN, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), max: s[s.length - 1], n: s.length };
}

export interface RunResult {
  label: 'uncapped' | 'throttled-x4' | 'vsync';
  gpuName: string;
  canvasPx: [number, number];
  frameIntervalMs: Stats;
  /** Intervals excluding rebuild frames and the frame after: the GPU proxy (rebuilds are CPU-bound). */
  steadyIntervalMs?: Stats;
  /** GPU time per frame measured with EXT_disjoint_timer_query_webgl2 (disjoint samples dropped). */
  gpuMs?: Stats;
  cpuMs: Stats;
  /** Largest ribbon mesh drawn during the pass. */
  ribbonVerticesMax?: number;
  rebuilds: number;
  loadMs: number;
  memoryMb: number;
  /** Display the window ran on, e.g. "2560x1600 @165 Hz". */
  display?: string;
}

export interface Criteria { maxIntervalP95Uncapped: number; maxCpuP95Throttled: number; targetHz: number }
export const CRITERIA: Criteria = { maxIntervalP95Uncapped: 2, maxCpuP95Throttled: 16, targetHz: 165 };

export interface Verdict { pass: boolean | 'invalide'; lines: string[] }

/** Refresh rates whose frame interval betrays a capped measurement. */
const COMMON_HZ = [60, 75, 90, 100, 120, 144, 165, 240];

export function evaluate(runs: RunResult[], c: Criteria): Verdict {
  const lines: string[] = [];
  let invalid = false;
  for (const r of runs) {
    if (!/NVIDIA/i.test(r.gpuName)) {
      invalid = true;
      lines.push(`Passe ${r.label} : carte graphique « ${r.gpuName} » au lieu de la NVIDIA, mesure invalide.`);
    }
  }
  const uncapped = runs.find((r) => r.label === 'uncapped');
  const throttled = runs.find((r) => r.label === 'throttled-x4');
  if (uncapped) {
    const hz = COMMON_HZ.find((h) => Math.abs(uncapped.frameIntervalMs.p50 - 1000 / h) / (1000 / h) < 0.03);
    if (hz) {
      invalid = true;
      lines.push(`Passe uncapped plafonnée à ${hz} Hz (médiane ${uncapped.frameIntervalMs.p50.toFixed(2)} ms) : la synchronisation verticale est restée active, mesure invalide.`);
    }
  }
  // GPU criterion: the measured GPU time (timer queries) when available, else the uncapped-interval proxy.
  const measured = runs.find((r) => r.label !== 'throttled-x4' && r.gpuMs && r.gpuMs.n > 0);
  let gpuOk = false;
  if (measured) {
    gpuOk = measured.gpuMs!.p95 <= c.maxIntervalP95Uncapped;
    lines.push(`Carte graphique : p95 du temps GPU mesuré (passe ${measured.label}) = ${measured.gpuMs!.p95.toFixed(2)} ms (critère ≤ ${c.maxIntervalP95Uncapped} ms) → ${gpuOk ? 'tenu' : 'non tenu'} ; pire image ${measured.gpuMs!.max.toFixed(1)} ms.`);
  } else if (uncapped) {
    const gpuStats = uncapped.steadyIntervalMs ?? uncapped.frameIntervalMs;
    gpuOk = gpuStats.p95 <= c.maxIntervalP95Uncapped;
    const scope = uncapped.steadyIntervalMs ? 'hors reconstructions' : 'toutes images';
    lines.push(`Carte graphique : p95 de l'intervalle sans limite (${scope}) = ${gpuStats.p95.toFixed(2)} ms (critère ≤ ${c.maxIntervalP95Uncapped} ms) → ${gpuOk ? 'tenu' : 'non tenu'}.`);
    lines.push(`Toutes images comprises : p95 = ${uncapped.frameIntervalMs.p95.toFixed(2)} ms, maximum = ${uncapped.frameIntervalMs.max.toFixed(1)} ms.`);
  } else lines.push('Carte graphique : aucune mesure.');
  const cpuOk = throttled ? throttled.cpuMs.p95 <= c.maxCpuP95Throttled : false;
  if (throttled) lines.push(`Processeur : p95 du temps par image sous ×4 = ${throttled.cpuMs.p95.toFixed(2)} ms (critère ≤ ${c.maxCpuP95Throttled} ms) → ${cpuOk ? 'tenu' : 'non tenu'} ; pire image ${throttled.cpuMs.max.toFixed(0)} ms.`);
  else lines.push('Processeur : passe throttled-x4 absente.');
  const vsync = runs.find((r) => r.label === 'vsync');
  if (vsync) {
    const budget = 1000 / c.targetHz;
    lines.push(`Avec synchronisation : p95 = ${vsync.frameIntervalMs.p95.toFixed(2)} ms pour un budget de ${budget.toFixed(2)} ms à ${c.targetHz} Hz (informatif).`);
  }
  return { pass: invalid ? 'invalide' : gpuOk && cpuOk, lines };
}
