import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** One pass of the renderer bench, as measured by the interface (src/renderer/bench.ts). */
interface Stats { p50: number; p95: number; max: number; n: number }
interface BenchRun {
  label: string; gpuName: string; canvasPx: [number, number]; gpuMs: Stats; gpuSteadyMs: Stats; cpuMs: Stats; intervalMs: Stats; rebuilds: number;
  worstFrame: { t: number; cpuMs: number; rebuilt: boolean }; loadMs: number; memoryMb: number; reasons: Record<string, number>;
}

/** Spec 21 criteria: GPU under 2 ms per frame at p95, CPU under 16 ms at p95 with a ×4 slowdown. */
const GPU_P95_MS = 2;
const CPU_P95_THROTTLED_MS = 16;

const f = (v: number, d = 2) => (Number.isFinite(v) ? v.toFixed(d) : '—');
const today = () => new Date().toISOString().slice(0, 10);

/** Appends a pass to docs/bancs/.app-rendu-runs.json; the final pass writes the report. Returns the report path. */
export function recordRun(docsDir: string, run: BenchRun, final: boolean, scale: string): string | null {
  mkdirSync(docsDir, { recursive: true });
  const runsFile = join(docsDir, '.app-rendu-runs.json');
  const runs: BenchRun[] = existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, 'utf8')) : [];
  runs.push(run);
  writeFileSync(runsFile, JSON.stringify(runs, null, 2), 'utf8');
  if (!final) return null;
  const vsync = runs.find((r) => r.label === 'vsync'), slow = runs.find((r) => r.label === 'throttled-x4');
  const lines = [
    `# Banc de rendu de l'application (${today()})`,
    '',
    `Base synthétique : ${scale.replace(',', ' nœuds, ')} connexions (générateur du plan 1). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s). Première seconde écartée.`,
    '',
    '| Passe | Carte graphique (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p95 | Reconstructions (causes) | Pire image | Chargement | Mémoire JS |',
    '|---|---|---|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${f(r.gpuMs.p50)} / ${f(r.gpuMs.p95)} / ${f(r.gpuMs.max)} | ${f(r.gpuSteadyMs?.p50 ?? NaN)} / ${f(r.gpuSteadyMs?.p95 ?? NaN)} | ${f(r.cpuMs.p50)} / ${f(r.cpuMs.p95)} / ${f(r.cpuMs.max, 0)} | ${f(r.intervalMs.p50)} / ${f(r.intervalMs.p95)} | ${r.rebuilds} (${Object.entries(r.reasons ?? {}).map(([k, v]) => `${k} ${v}`).join(', ')}) | ${f(r.worstFrame.cpuMs, 0)} ms à ${f(r.worstFrame.t, 1)} s${r.worstFrame.rebuilt ? ' (reconstruction)' : ''} | ${f(r.loadMs / 1000, 1)} s | ${f(r.memoryMb, 0)} Mo |`),
    '',
    `Carte : ${runs[0]?.gpuName ?? '?'} ; canevas ${runs[0]?.canvasPx.join('×')} px.`,
    '',
    '## Critères (spec 21)',
    '',
    vsync ? `- **Carte graphique :** ${f(vsync.gpuMs.p95)} ms au p95 sur toutes les images, pour un critère de ${GPU_P95_MS} ms : **${vsync.gpuMs.p95 <= GPU_P95_MS ? 'tenu' : 'non tenu'}**. Hors reconstructions (le dessin seul) : ${f(vsync.gpuSteadyMs.p95)} ms : **${vsync.gpuSteadyMs.p95 <= GPU_P95_MS ? 'tenu' : 'non tenu'}**. Le chronomètre de la carte compte aussi l'attente entre deux envois du processeur : une reconstruction (envoi des tampons) le gonfle.` : '- Carte graphique : passe absente.',
    slow ? `- **Processeur sous ×4 :** ${f(slow.cpuMs.p95)} ms au p95, pour un critère de ${CPU_P95_THROTTLED_MS} ms : **${slow.cpuMs.p95 <= CPU_P95_THROTTLED_MS ? 'tenu' : 'non tenu'}**.` : '- Processeur sous ×4 : passe absente.',
    '',
  ];
  const report = join(docsDir, `app-rendu-${today()}.md`);
  writeFileSync(report, lines.join('\n'), 'utf8');
  writeFileSync(join(docsDir, `app-rendu-${today()}.json`), JSON.stringify({ scale, runs }, null, 2), 'utf8');
  return report;
}
