import type { RunResult, Stats, Verdict } from './metrics';

const f = (v: number) => (Number.isFinite(v) ? v.toFixed(2) : '—');
const row = (s: Stats) => `${f(s.p50)} | ${f(s.p95)} | ${f(s.max)} | ${s.n}`;

export function toMarkdown(runs: RunResult[], v: Verdict, date: string): string {
  const verdict = v.pass === 'invalide' ? 'INVALIDE' : v.pass ? 'RÉUSSI' : 'ÉCHOUÉ';
  const out = [
    `# Banc de rendu — ${date}`,
    '',
    `**Verdict : ${verdict}**`,
    '',
    ...v.lines.map((l) => `- ${l}`),
    '',
    '## Passes',
    '',
    '| Passe | Carte graphique | Rendu | Écran | Reconstructions | Sommets de rubans (max) | Chargement (ms) | Mémoire JS (Mo) |',
    '|---|---|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${r.gpuName} | ${r.canvasPx[0]}×${r.canvasPx[1]} | ${r.display ?? '—'} | ${r.rebuilds} | ${r.ribbonVerticesMax ?? '—'} | ${r.loadMs.toFixed(0)} | ${r.memoryMb.toFixed(0)} |`),
    '',
    '## Intervalle entre images (ms)',
    '',
    '| Passe | p50 | p95 | max | images |',
    '|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${row(r.frameIntervalMs)} |`),
    '',
    '## Intervalle hors reconstructions (ms)',
    '',
    '| Passe | p50 | p95 | max | images |',
    '|---|---|---|---|---|',
    ...runs.filter((r) => r.steadyIntervalMs).map((r) => `| ${r.label} | ${row(r.steadyIntervalMs!)} |`),
    '',
    '## Temps GPU par image, mesuré (ms)',
    '',
    '| Passe | p50 | p95 | max | images |',
    '|---|---|---|---|---|',
    ...runs.filter((r) => r.gpuMs).map((r) => `| ${r.label} | ${row(r.gpuMs!)} |`),
    '',
    '## Temps processeur par image (ms)',
    '',
    '| Passe | p50 | p95 | max | images |',
    '|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${row(r.cpuMs)} |`),
    '',
    '## Pires images',
    '',
    ...runs.flatMap((r) => {
      const out: string[] = [];
      if (r.worstFrame) {
        const w = r.worstFrame;
        out.push(`- **${r.label}** — Pire image à t = ${w.t.toFixed(1)} s : intervalle ${w.intervalMs.toFixed(0)} ms, processeur ${w.cpuMs.toFixed(0)} ms${w.rebuilt ? ', reconstruction' : ''}.`);
      }
      if (r.worstRebuild) {
        const d = r.worstRebuild;
        out.push(`  Pire reconstruction : ${Object.entries(d).map(([k, v]) => `${k} ${Math.round(v)}`).join(', ')}.`);
      }
      return out;
    }),
    '',
  ];
  return out.join('\n');
}
