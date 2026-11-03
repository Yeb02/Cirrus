import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { SNAPSHOT_VERSION } from '@cirrus/core';
import { buildLargeState, LARGE_GENERATOR_VERSION, type LargeSpec } from '@cirrus/fixtures';
import { SCHEMA_VERSION, writeBenchBase } from '@cirrus/store';
import type { BenchRun, ProcessMb, Stats } from '../renderer/bench.ts';

/** The load phases, in order, with their names in the report: the first two are the main process's, the rest the interface's. */
export const PHASES = [
  ['baseOpened', 'base ouverte'], ['dataSent', 'données envoyées'], ['dataReceived', 'données reçues'], ['stateReady', 'état prêt'],
  ['sceneReady', 'scène prête'], ['engineReady', 'moteur prêt'], ['firstFrame', 'première image'],
] as const;
export type Phase = (typeof PHASES)[number][0];

/** A pass as the main process records it: the interface's measures, plus its load phases and the processes' memory. */
export interface PassRecord extends BenchRun {
  /** Ms since the main process started. */
  phases: Partial<Record<Phase, number>>;
  /** Private memory of the processes at the end of the pass, after the collections. */
  processMb: ProcessMb;
}

/** The stamp next to the bench's base: the generator, the schema and the snapshot format it was written with. */
export const BENCH_STAMP = 'bench-base.json';

/**
 * Builds the bench's base in `dir` (buildLargeState written by writeBenchBase), unless its stamp shows it is already
 * this generator's at this scale. The stamp is written last: a base interrupted halfway is rebuilt. Returns whether it
 * was built.
 */
export function ensureBenchBase(dir: string, spec: LargeSpec): boolean {
  const stamp = JSON.stringify({
    generator: LARGE_GENERATOR_VERSION, schema: SCHEMA_VERSION, snapshot: SNAPSHOT_VERSION, seed: spec.seed, nodes: spec.nodes, connections: spec.connections,
  });
  try {
    if (readFileSync(join(dir, BENCH_STAMP), 'utf8') === stamp) return false;
  } catch {
    // no stamp: built below
  }
  rmSync(dir, { recursive: true, force: true });
  writeBenchBase(dir, buildLargeState(spec).state);
  writeFileSync(join(dir, BENCH_STAMP), stamp, 'utf8');
  return true;
}

/** Absolute marks (ms since the epoch) as ms since the main process started (`origin`, its performance.timeOrigin). */
export function loadPhases(marks: Partial<Record<Phase, number>>, origin: number): Partial<Record<Phase, number>> {
  return Object.fromEntries(Object.entries(marks).map(([k, v]) => [k, v - origin]));
}

/** Private memory per process type, in Mo, from app.getAppMetrics() (kilobytes; private bytes exist on Windows only). */
export function processMemoryMb(metrics: { type: string; memory: { privateBytes?: number } }[]): PassRecord['processMb'] {
  const sum = (type: string) => {
    const of = metrics.filter((m) => m.type === type);
    return of.length === 0 || of.some((m) => m.memory.privateBytes === undefined) ? Number.NaN : of.reduce((a, m) => a + m.memory.privateBytes!, 0) * 1024 / 1e6;
  };
  return { browser: sum('Browser'), tab: sum('Tab'), gpu: sum('GPU') };
}

/** The report's name: CIRRUS_BENCH_NAME, else app-rendu-<date>. */
export function benchName(env: Record<string, string | undefined> = process.env): string {
  return env.CIRRUS_BENCH_NAME || `app-rendu-${new Date().toISOString().slice(0, 10)}`;
}

/** Spec 21 criteria: GPU under 2 ms per frame at p95, CPU under 16 ms at p95 with a ×4 slowdown. */
const GPU_P95_MS = 2;
const CPU_P95_THROTTLED_MS = 16;

const f = (v: number | undefined, d = 2) => (v !== undefined && Number.isFinite(v) ? v.toFixed(d) : '—');
const trio = (s: Stats | undefined, hi: 'p95' | 'p99', d = 2) => (s ? `${f(s.p50, d)} / ${f(s[hi], d)} / ${f(s.max, d)}` : '—');

/** The GPU time of the drawing alone (frames without a rebuild): raw (vsync), floor (all layers hidden), content = raw − floor. */
export function gpuSummary(runs: PassRecord[]): { raw: Stats | null; floor: Stats | null; content: { p50: number; p95: number } } {
  const raw = runs.find((r) => r.label === 'vsync')?.gpuSteadyMs ?? null, floor = runs.find((r) => r.label === 'plancher')?.gpuSteadyMs ?? null;
  // A NaN read back from the runs file is null: still no number.
  const num = (v: number | null | undefined) => (typeof v === 'number' ? v : Number.NaN);
  return { raw, floor, content: { p50: num(raw?.p50) - num(floor?.p50), p95: num(raw?.p95) - num(floor?.p95) } };
}

function report(name: string, scale: string, runs: PassRecord[]): string {
  const [nodes, connections] = scale.split(',');
  const gpu = gpuSummary(runs);
  const vsync = runs.find((r) => r.label === 'vsync'), slow = runs.find((r) => r.label === 'throttled-x4');
  const notes: string[] = [];
  for (const r of runs) {
    if (!r.timer) notes.push(`Passe ${r.label} : chronomètre de la carte indisponible (EXT_disjoint_timer_query_webgl2), pas de temps de carte.`);
    if (r.disjoint > 0) notes.push(`Passe ${r.label} : ${r.disjoint} mesures de la carte écartées (disjointes).`);
    if (!r.gc) notes.push(`Passe ${r.label} : gc() absent de l'interface, tas mesuré sans ramasse-miettes forcé.`);
    for (const n of r.edits?.notes ?? []) notes.push(`Passe ${r.label}, édition : ${n}`);
  }
  const e = vsync?.edits;
  const lines = [
    `# Banc de rendu de l'application : ${name} (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Base synthétique : ${nodes} nœuds, ${connections} connexions de connaissance, graine 1 (générateur du plan 1, version ${LARGE_GENERATOR_VERSION} : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe \`secours\` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.`,
    '',
    'Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `vide`, une base vide (le plancher d\'Electron).',
    '',
    `Carte : ${runs[0]?.gpuName ?? '?'} ; canevas ${runs[0]?.canvasPx.join('×') ?? '?'} px.`,
    '',
    '## Carte graphique, hors reconstructions (ms)',
    '',
    '| | p50 | p95 |',
    '|---|---|---|',
    `| Brut (vsync) | ${f(gpu.raw?.p50)} | ${f(gpu.raw?.p95)} |`,
    `| Plancher (couches masquées) | ${f(gpu.floor?.p50)} | ${f(gpu.floor?.p95)} |`,
    `| **Contenu** (brut moins plancher) | **${f(gpu.content.p50)}** | **${f(gpu.content.p95)}** |`,
    '',
    'Le contenu soustrait les quantiles du plancher à ceux du brut : c\'est le coût du dessin lui-même, sans le plancher du chronomètre.',
    '',
    '## Passes',
    '',
    '| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Pire image |',
    '|---|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${trio(r.gpuMs, 'p95')} | ${f(r.gpuSteadyMs.p50)} / ${f(r.gpuSteadyMs.p95)} | ${trio(r.cpuMs, 'p95')} | ${trio(r.intervalMs, 'p99', 1)} | ${r.rebuilds} (${Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}) | ${f(r.worstFrame.cpuMs, 0)} ms à ${f(r.worstFrame.t, 1)} s${r.worstFrame.rebuilt ? ' (reconstruction)' : ''} |`),
    '',
    '## Phases du chargement (ms depuis le démarrage du processus principal)',
    '',
    `| Passe | ${PHASES.map(([, label]) => label).join(' | ')} |`,
    `|---|${PHASES.map(() => '---').join('|')}|`,
    ...runs.map((r) => `| ${r.label} | ${PHASES.map(([k]) => f(r.phases[k], 0)).join(' | ')} |`),
    '',
    '## Mémoire (Mo, après deux ramasse-miettes)',
    '',
    '| Passe | Tas JS de l\'interface | Principal (Browser, privée) | Interface (Tab, privée) | Carte (GPU, privée) |',
    '|---|---|---|---|---|',
    ...runs.flatMap((r) => {
      const row = (label: string, heap: number, p: ProcessMb) => `| ${label} | ${f(heap, 0)} | ${f(p.browser, 0)} | ${f(p.tab, 0)} | ${f(p.gpu, 0)} |`;
      const b = r.beforeEdits;
      return b ? [row(`${r.label}, après chargement`, b.heapMb, b.processMb), row(`${r.label}, après éditions`, r.heapMb, r.processMb)] : [row(r.label, r.heapMb, r.processMb)];
    }),
    '',
    'Le tas JS est `performance.memory.usedJSHeapSize` (mémoire précise) après deux `gc()` dans l\'interface ; la mémoire privée vient de `app.getAppMetrics()`, le principal ayant aussi forcé ses collections. Relevés en fin de passe ; pour la passe d\'édition, aussi avant elle (« après chargement » : le chargement et le parcours de 40 s faits, avant la première édition).',
    '',
    '## Édition (fin de la passe vsync)',
    '',
    ...(e ? [
      `Sur « ${e.node} », le nœud le plus proche du centre de la caméra profonde. Latence : de l'appel (session, annulation, dépôt) à la fin du rendu de la première image de la nouvelle scène.`,
      '',
      '| Étape | ms |',
      '|---|---|',
      `| Glissement de 300 px en 60 images : fil principal par image d'aperçu, p50 / p95 / max (${e.dragFrameMs.n} images) | ${trio(e.dragFrameMs, 'p95', 1)} |`,
      `| Dépôt | ${f(e.dropMs, 0)} |`,
      `| Renommage | ${f(e.renameMs, 0)} |`,
      `| Création d'un nœud au centre | ${f(e.createMs, 0)} |`,
      `| Connexion des deux | ${f(e.connectMs, 0)} |`,
      ...e.undoMs.map((ms, i) => `| Ctrl+Z n° ${i + 1} | ${f(ms, 0)} |`),
      ...(e.tabNewMs !== undefined ? [`| Onglet d'un plan neuf (scène construite) | ${f(e.tabNewMs, 0)} |`, `| Retour à l'onglet du lobby (scène gardée) | ${f(e.tabBackMs, 0)} |`] : []),
    ] : ['Passe d\'édition absente.']),
    '',
    '## Critères (spec 21)',
    '',
    vsync ? `- **Carte graphique :** ${f(vsync.gpuMs.p95)} ms au p95 sur toutes les images, pour un critère de ${GPU_P95_MS} ms : **${vsync.gpuMs.p95 <= GPU_P95_MS ? 'tenu' : 'non tenu'}**. Hors reconstructions : ${f(vsync.gpuSteadyMs.p95)} ms ; contenu seul : ${f(gpu.content.p95)} ms : **${gpu.content.p95 <= GPU_P95_MS ? 'tenu' : 'non tenu'}**.` : '- Carte graphique : passe absente.',
    slow ? `- **Processeur sous ×4 :** ${f(slow.cpuMs.p95)} ms au p95, pour un critère de ${CPU_P95_THROTTLED_MS} ms : **${slow.cpuMs.p95 <= CPU_P95_THROTTLED_MS ? 'tenu' : 'non tenu'}**.` : '- Processeur sous ×4 : passe absente.',
    '',
    ...(notes.length > 0 ? ['## Remarques', '', ...notes.map((n) => `- ${n}`), ''] : []),
  ];
  return lines.join('\n');
}

/** Appends a pass to docs/bancs/.app-rendu-runs.json; the final pass writes the report, named by benchName(). Returns its path. */
export function recordRun(docsDir: string, run: PassRecord, final: boolean, scale: string): string | null {
  mkdirSync(docsDir, { recursive: true });
  const runsFile = join(docsDir, '.app-rendu-runs.json');
  const runs: PassRecord[] = existsSync(runsFile) ? JSON.parse(readFileSync(runsFile, 'utf8')) : [];
  runs.push(run);
  writeFileSync(runsFile, JSON.stringify(runs, null, 2), 'utf8');
  if (!final) return null;
  const name = benchName();
  const path = join(docsDir, `${name}.md`);
  writeFileSync(path, report(name, scale, runs), 'utf8');
  writeFileSync(join(docsDir, `${name}.json`), JSON.stringify({ name, scale, generator: LARGE_GENERATOR_VERSION, gpu: gpuSummary(runs), runs }, null, 2), 'utf8');
  return path;
}
