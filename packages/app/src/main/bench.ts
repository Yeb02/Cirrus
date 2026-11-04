import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyOps, decodeState, encodeState, moveNodes, SNAPSHOT_VERSION } from '@cirrus/core';
import { buildLargeState, LARGE_GENERATOR_VERSION, type LargeSpec } from '@cirrus/fixtures';
import { SCHEMA_VERSION, writeBenchBase } from '@cirrus/store';
import type { BenchRun, ProcessMb, Stats } from '../renderer/bench.ts';
import { openBase } from './base.ts';

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
 * this generator's at this scale. A provisional stamp is written before the base and the real one last: a base
 * interrupted halfway keeps a stamp that does not match, and is rebuilt. Returns whether it was built.
 * The folder is emptied first, so it must be a cirrus-bench-* folder inside the temporary folder `temp`, and a base
 * without the bench's stamp (the user's own, a copy of it) is never deleted (M5 of the final review).
 */
export function ensureBenchBase(dir: string, spec: LargeSpec, temp = tmpdir()): boolean {
  const at = resolve(dir), inTemp = relative(resolve(temp), at);
  if (!basename(at).startsWith('cirrus-bench-') || inTemp === '' || inTemp.startsWith('..') || isAbsolute(inTemp)) {
    throw new Error(`Dossier du banc refusé : ${at} n’est pas un dossier cirrus-bench-* du dossier temporaire (${resolve(temp)}).`);
  }
  const stamp = JSON.stringify({
    generator: LARGE_GENERATOR_VERSION, schema: SCHEMA_VERSION, snapshot: SNAPSHOT_VERSION, seed: spec.seed, nodes: spec.nodes, connections: spec.connections,
  });
  const stampFile = join(at, BENCH_STAMP);
  if (existsSync(stampFile)) {
    if (readFileSync(stampFile, 'utf8') === stamp) return false;
  } else if (existsSync(join(at, 'cirrus.db'))) {
    throw new Error(`Dossier du banc refusé : ${at} tient une base (cirrus.db) sans le tampon du banc ; elle n’est pas effacée.`);
  }
  rmSync(at, { recursive: true, force: true });
  mkdirSync(at, { recursive: true });
  writeFileSync(stampFile, JSON.stringify({ building: true }), 'utf8');
  writeBenchBase(at, buildLargeState(spec).state);
  writeFileSync(stampFile, stamp, 'utf8');
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

const f = (v: number | undefined, d = 2) => (v !== undefined && Number.isFinite(v) ? v.toFixed(d) : '—');
const trio = (s: Stats | undefined, hi: 'p95' | 'p99', d = 2) => (s ? `${f(s.p50, d)} / ${f(s[hi], d)} / ${f(s.max, d)}` : '—');

/**
 * A criterion of plan 3c (task 10): its target, the measure, whether it is met (null: no verdict, either not measured by
 * these passes, its measure then « — », or only to be reported, as the fallback path).
 */
export interface Criterion { key: string; name: string; target: string; measure: string; met: boolean | null }

/**
 * The criteria of plan 3c (task 10), on the reference base, from the passes recorded. The memory criteria read the
 * figures after the load (R8 of the plan: before the edit pass); each edit of the script counts, its worst named.
 */
export function criteria(runs: PassRecord[]): Criterion[] {
  const at = (label: string) => runs.find((r) => r.label === label);
  const vsync = at('vsync'), slow = at('throttled-x4'), secours = at('secours'), vide = at('vide'), e = vsync?.edits ?? null;
  const known = (v: number | undefined): v is number => v !== undefined && Number.isFinite(v);
  const row = (key: string, name: string, target: string, v: number | undefined, limit: number, text: (v: number) => string): Criterion =>
    ({ key, name, target, measure: known(v) ? text(v) : '—', met: known(v) ? v <= limit : null });
  const ms = (v: number) => `${f(v, 0)} ms`;
  const steps: [string, number | undefined][] = e
    ? [['dépôt', e.dropMs], ['renommage', e.renameMs], ['création', e.createMs], ['connexion', e.connectMs], ...e.undoMs.map((x, i): [string, number] => [`Ctrl+Z n° ${i + 1}`, x]),
      ['dépôt dans un autre groupe', e.groupDropMs]]
    : [];
  const measured = steps.filter((x): x is [string, number] => x[1] !== undefined), late = measured.filter(([, x]) => !Number.isFinite(x)).map(([n]) => n);
  const worst = measured.filter(([, x]) => Number.isFinite(x)).reduce<[string, number] | null>((w, x) => (w === null || x[1] > w[1] ? x : w), null);
  const gpu = gpuSummary(runs), content = gpu.raw && gpu.floor ? gpu.content : null;
  const interval = vsync?.intervalMs, main = vsync?.beforeEdits?.processMb.browser, empty = vide?.processMb.browser;
  return [
    row('load', 'Chargement, du démarrage du principal à la première image, avec instantané', '≤ 1,5 s', vsync?.phases.firstFrame, 1500, ms),
    { ...row('fallback', 'Chemin de secours (sans instantané)', 'mesuré et rapporté', secours?.phases.firstFrame, Infinity, ms), met: null },
    row('tab', 'Changement d’onglet vers un plan en cache', '≤ 50 ms', e?.tabBackMs, 50, ms),
    row('lobby', 'Ouverture du lobby sans cache', '≤ 500 ms', e?.lobbyColdMs, 500, ms),
    {
      key: 'edits', name: 'Chaque édition du script, jusqu’à l’image', target: '≤ 30 ms',
      measure: worst ? `${ms(worst[1])} au pire (${worst[0]})${late.length > 0 ? ` ; sans mesure : ${late.join(', ')}` : ''}` : '—',
      met: e ? late.length === 0 && worst !== null && worst[1] <= 30 : null,
    },
    row('drag', 'Image de glissement, fil principal', '≤ 1 ms au p95', e?.dragFrameMs.p95, 1, (v) => `${f(v)} ms au p95`),
    row('rebuild', 'Reconstruction (visible et instances)', '≤ 4 ms au p95 sur le parcours', vsync?.rebuildMs?.p95, 4, (v) => `${f(v)} ms au p95`),
    {
      key: 'gpu', name: 'Carte graphique, contenu', target: '≤ 1 ms en médiane et ≤ 2 ms au p95',
      measure: content && known(content.p50) && known(content.p95) ? `${f(content.p50)} / ${f(content.p95)} ms` : '—',
      met: content && known(content.p50) && known(content.p95) ? content.p50 <= 1 && content.p95 <= 2 : null,
    },
    row('cpu4', 'Processeur ×4', '≤ 16 ms au p95', slow?.cpuMs.p95, 16, (v) => `${f(v)} ms au p95`),
    {
      key: 'interval', name: 'Intervalle entre images', target: 'p99 ≤ 1,5 fois la médiane',
      measure: interval && known(interval.p99) && known(interval.p50) ? `p99 ${f(interval.p99, 1)} ms, ${f(interval.p99 / interval.p50)} fois la médiane (${f(interval.p50, 1)} ms)` : '—',
      met: interval && known(interval.p99) && known(interval.p50) ? interval.p99 <= 1.5 * interval.p50 : null,
    },
    row('heap', 'Mémoire de l’interface, après ramasse-miettes', '≤ 150 Mo', vsync?.beforeEdits?.heapMb, 150, (v) => `${f(v, 0)} Mo`),
    {
      key: 'main', name: 'Mémoire privée du principal', target: '≤ celle de la base vide + 50 Mo',
      measure: known(main) && known(empty) ? `${f(main, 0)} Mo (vide : ${f(empty, 0)} Mo)` : '—',
      met: known(main) && known(empty) ? main <= empty + 50 : null,
    },
  ];
}

/** The base's files over snapshot rewrites (plan 3c task 10, M3 of the final review), in Mo. */
export interface SnapshotGrowth {
  snapshotMb: number;
  /** cirrus.db and its WAL: before opening, opened, after each rewrite, closed. */
  sizes: { step: string; dbMb: number; walMb: number }[];
  /** The base's pages after the last rewrite: all of them, those on the free list, their size in bytes. */
  pages: number;
  freePages: number;
  pageBytes: number;
  /** Each rewrite: the state encoded, the snapshot written. */
  encodeMs: number[];
  writeMs: number[];
}

/** Where the snapshot rewrites wait for the report (scripts/bench.mjs removes it before a run). */
export const SNAPSHOTS_FILE = '.app-rendu-instantanes.json';

/**
 * The base file over `rounds` snapshot rewrites (plan 3c task 10, M3 of the final review), on the bench's copy of its
 * base: opened as the app opens it, its snapshot decoded and the journal after it replayed, then each round one action
 * (a node of the lobby moved) written by LocalStore.commit, and the state's snapshot encoded and written
 * (writeSnapshot), as the interface sends it at rest. The files' sizes are read before, after each round and closed.
 */
export function snapshotRewrites(dir: string, rounds: number): SnapshotGrowth {
  if (!Number.isSafeInteger(rounds) || rounds < 1) throw new Error(`Réécritures de l’instantané : ${rounds} n’est pas un nombre de tours.`);
  const db = join(dir, 'cirrus.db'), mb = (file: string) => (existsSync(file) ? statSync(file).size / 1e6 : 0);
  const sizes: SnapshotGrowth['sizes'] = [], encodeMs: number[] = [], writeMs: number[] = [];
  const size = (step: string) => sizes.push({ step, dbMb: mb(db), walMb: mb(`${db}-wal`) });
  size('avant');
  const store = openBase(dir);
  let snapshotMb = 0, pages = 0, freePages = 0, pageBytes = 0;
  try {
    const snap = store.readSnapshot();
    if (!snap) throw new Error('Réécritures de l’instantané : la base n’a pas d’instantané.');
    const s = decodeState(snap.data);
    applyOps(s, store.changesSince(snap.seq).map((r) => r.op));
    const lobby = [...s.plans.values()].find((q) => q.type === 'lobby')?.id;
    const moved = [...s.placements.values()].find((q) => q.plan === lobby);
    if (!lobby || !moved) throw new Error('Réécritures de l’instantané : pas de nœud dans le lobby.');
    size('ouverte');
    for (let i = 1; i <= rounds; i++) {
      const a = moveNodes(s, lobby, [{ node: moved.node, x: moved.x + i }]), seq = store.commit(a);
      applyOps(s, a.ops);
      let t = performance.now();
      const data = encodeState(s);
      encodeMs.push(performance.now() - t);
      t = performance.now();
      store.writeSnapshot(data, seq);
      writeMs.push(performance.now() - t);
      snapshotMb = data.byteLength / 1e6;
      size(`réécriture ${i}`);
    }
    // Read by a second connection, as SQLite counts them with the WAL.
    const q = new DatabaseSync(db, { readOnly: true });
    try {
      const pragma = (name: string) => Number((q.prepare(`PRAGMA ${name}`).get() as Record<string, number>)[name]);
      [pages, freePages, pageBytes] = [pragma('page_count'), pragma('freelist_count'), pragma('page_size')];
    } finally {
      q.close();
    }
  } finally {
    store.close();
  }
  size('fermée');
  return { snapshotMb, sizes, pages, freePages, pageBytes, encodeMs, writeMs };
}

/** Keeps the snapshot rewrites for the report the last pass writes. */
export function recordSnapshots(docsDir: string, growth: SnapshotGrowth): void {
  mkdirSync(docsDir, { recursive: true });
  writeFileSync(join(docsDir, SNAPSHOTS_FILE), JSON.stringify(growth, null, 2), 'utf8');
}

/** The GPU time of the drawing alone (frames without a rebuild): raw (vsync), floor (all layers hidden), content = raw − floor. */
export function gpuSummary(runs: PassRecord[]): { raw: Stats | null; floor: Stats | null; content: { p50: number; p95: number } } {
  const raw = runs.find((r) => r.label === 'vsync')?.gpuSteadyMs ?? null, floor = runs.find((r) => r.label === 'plancher')?.gpuSteadyMs ?? null;
  // A NaN read back from the runs file is null: still no number.
  const num = (v: number | null | undefined) => (typeof v === 'number' ? v : Number.NaN);
  return { raw, floor, content: { p50: num(raw?.p50) - num(floor?.p50), p95: num(raw?.p95) - num(floor?.p95) } };
}

/** The dense pass's section (plan 3c task 10): its plan, its titles, its frames, the GPU's content (its raw time less the floor's). */
function denseSection(r: PassRecord | undefined, floor: Stats | null): string[] {
  if (!r?.dense) return [];
  const d = r.dense, less = (a: number, b: number | undefined) => (b !== undefined ? a - b : Number.NaN);
  return [
    '## Vue dense au seuil de lisibilité (passe dense)',
    '',
    `Un plan neuf où les ${d.nodes} nœuds (${d.cols} × ${d.rows}) pris au lobby sont posés en grille, une boîte d'une ligne par cellule, sans connexion ; la caméra tenue au seuil de lisibilité des titres (zoom ${f(d.zoomLo, 3)}), déplacée d'un écran, rapprochée jusqu'aux titres entiers (zoom ${f(d.zoomHi, 3)}), ramenée (20 s, première seconde écartée).`,
    '',
    '| Mesure | Valeur |',
    '|---|---|',
    `| Glyphes construits au plus pour une image | ${f(r.glyphs?.max, 0)} glyphes, ${f(r.glyphs?.items, 0)} éléments visibles (à ${f(r.glyphs?.t, 1)} s) |`,
    `| Processeur par image (ms), p50 / p95 / max | ${trio(r.cpuMs, 'p95')} |`,
    `| Processeur des images reconstruites (ms), p50 / p95 / max (${r.rebuildMs?.n ?? 0} images) | ${trio(r.rebuildMs, 'p95')} |`,
    `| Carte, toutes images (ms), p50 / p95 / max | ${trio(r.gpuMs, 'p95')} |`,
    `| Carte hors reconstructions (ms), brut p50 / p95 ; contenu (brut moins plancher) p50 / p95 | ${f(r.gpuSteadyMs.p50)} / ${f(r.gpuSteadyMs.p95)} ; ${f(less(r.gpuSteadyMs.p50, floor?.p50))} / ${f(less(r.gpuSteadyMs.p95, floor?.p95))} |`,
    `| Intervalle entre images (ms), p50 / p99 / max | ${trio(r.intervalMs, 'p99', 1)} |`,
    `| Reconstructions (causes) | ${r.rebuilds} (${Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}) |`,
    '',
  ];
}

/** The snapshot rewrites' section (plan 3c task 10, M3 of the final review). */
function snapshotSection(g: SnapshotGrowth | null): string[] {
  if (!g) return [];
  const n = g.encodeMs.length, all = (xs: number[]) => xs.map((x) => f(x, 0)).join(', ');
  return [
    '## Réécritures de l\'instantané (copie de la base du banc)',
    '',
    `Sur une copie neuve de la base du banc, ${n} fois : une action (un nœud du lobby déplacé) écrite par \`LocalStore.commit\`, puis l'instantané de l'état (${f(g.snapshotMb, 1)} Mo) encodé et réécrit (\`writeSnapshot\`), comme l'interface l'envoie au repos.`,
    '',
    '| Étape | Base (cirrus.db, Mo) | Journal WAL (Mo) |',
    '|---|---|---|',
    ...g.sizes.map((x) => `| ${x.step} | ${f(x.dbMb, 1)} | ${f(x.walMb, 1)} |`),
    '',
    `Après la dernière réécriture : ${g.freePages} pages libres sur ${g.pages} (pages de ${g.pageBytes} octets : ${f((g.freePages * g.pageBytes) / 1e6, 1)} Mo libres). Encodage (ms) : ${all(g.encodeMs)} ; écriture (ms) : ${all(g.writeMs)}.`,
    '',
  ];
}

function report(name: string, scale: string, runs: PassRecord[], snapshots: SnapshotGrowth | null): string {
  const [nodes, connections] = scale.split(',');
  const gpu = gpuSummary(runs);
  const vsync = runs.find((r) => r.label === 'vsync');
  const notes: string[] = [];
  for (const r of runs) {
    if (!r.timer) notes.push(`Passe ${r.label} : chronomètre de la carte indisponible (EXT_disjoint_timer_query_webgl2), pas de temps de carte.`);
    if (r.disjoint > 0) notes.push(`Passe ${r.label} : ${r.disjoint} mesures de la carte écartées (disjointes).`);
    if (!r.gc) notes.push(`Passe ${r.label} : gc() absent de l'interface, tas mesuré sans ramasse-miettes forcé.`);
    for (const n of r.notes ?? []) notes.push(`Passe ${r.label} : ${n}`);
    for (const n of r.edits?.notes ?? []) notes.push(`Passe ${r.label}, édition : ${n}`);
  }
  const e = vsync?.edits;
  const pct = (s: Stats | undefined) => (s ? `${f(s.p50 * 100, 0)} % / ${f(s.p95 * 100, 0)} %` : '—');
  const lines = [
    `# Banc de rendu de l'application : ${name} (${new Date().toISOString().slice(0, 10)})`,
    '',
    `Base synthétique : ${nodes} nœuds, ${connections} connexions de connaissance, graine 1 (générateur du plan 1, version ${LARGE_GENERATOR_VERSION} : identifiants de 36 caractères), lue sur disque dans une copie neuve à chaque passe, par son instantané binaire et la fin du journal (la passe \`secours\` exceptée). Parcours : vue d'ensemble, descente à travers tous les niveaux de groupes, déplacement de trois écrans, retour (40 s) ; première seconde écartée.`,
    '',
    'Passes : `vsync` ; `plancher`, toutes couches masquées (une image vide) ; `throttled-x4`, processeur ralenti quatre fois ; `secours`, la même base sans son instantané (chargement depuis les tables) ; `dense`, un plan de titres en grille au seuil de lisibilité, à la place du parcours ; `vide`, une base vide (le plancher d\'Electron). Entre `dense` et `vide`, des réécritures de l\'instantané sur une copie de la base, sans fenêtre.',
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
    '| Passe | Carte (ms) p50 / p95 / max | Carte hors reconstructions (ms) p50 / p95 | Processeur (ms) p50 / p95 / max | Intervalle (ms) p50 / p99 / max | Reconstructions (causes) | Processeur des images reconstruites (ms) p50 / p95 / max | Pire image |',
    '|---|---|---|---|---|---|---|---|',
    ...runs.map((r) => `| ${r.label} | ${trio(r.gpuMs, 'p95')} | ${f(r.gpuSteadyMs.p50)} / ${f(r.gpuSteadyMs.p95)} | ${trio(r.cpuMs, 'p95')} | ${trio(r.intervalMs, 'p99', 1)} | ${r.rebuilds} (${Object.entries(r.reasons).map(([k, v]) => `${k} ${v}`).join(', ')}) | ${trio(r.rebuildMs, 'p95')} | ${f(r.worstFrame.cpuMs, 0)} ms à ${f(r.worstFrame.t, 1)} s${r.worstFrame.rebuilt ? ' (reconstruction)' : ''} |`),
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
      ...(e.dragBytes ? [
        `| Octets envoyés par image d'aperçu, p50 / p95 / max (dont la texture des éléments : ${trio(e.dragTextureBytes, 'p95', 0)}) | ${trio(e.dragBytes, 'p95', 0)} |`,
        `| Anneaux et marqueurs refaits par image d'aperçu (\`updateMarkers\`, \`updateOutline\`), ms p50 / p95 / max ; part de l'image p50 / p95 : ${pct(e.dragRingsShare)} | ${trio(e.dragRingsMs, 'p95', 3)} |`,
      ] : []),
      `| Dépôt | ${f(e.dropMs, 0)} |`,
      `| Renommage | ${f(e.renameMs, 0)} |`,
      `| Création d'un nœud au centre | ${f(e.createMs, 0)} |`,
      `| Connexion des deux | ${f(e.connectMs, 0)} |`,
      ...e.undoMs.map((ms, i) => `| Ctrl+Z n° ${i + 1} | ${f(ms, 0)} |`),
      ...(e.groupDropMs !== undefined ? [`| Dépôt dans un autre groupe (Alt, dans « ${e.groupDropInto ?? '?'} ») | ${f(e.groupDropMs, 0)} |`] : []),
      ...(e.tabNewMs !== undefined ? [`| Onglet d'un plan neuf (scène construite) | ${f(e.tabNewMs, 0)} |`, `| Retour à l'onglet du lobby (scène gardée) | ${f(e.tabBackMs, 0)} |`] : []),
      ...(e.lobbyColdMs !== undefined ? [`| Ouverture du lobby sans cache (scène et index construits) | ${f(e.lobbyColdMs, 0)} |`] : []),
      ...(e.dragBytesBy ? [
        '',
        `Octets envoyés par image d'aperçu, par maillage (p50 / max ; sur la taille du maillage entier à son dernier envoi complet) : ${Object.entries(e.dragBytesBy).map(([m, s]) => `${m} ${f(s.p50, 0)} / ${f(s.max, 0)}${e.meshBytes?.[m] ? ` sur ${f(e.meshBytes[m], 0)}` : ''}`).join(' ; ')}.`,
      ] : []),
    ] : ['Passe d\'édition absente.']),
    '',
    ...denseSection(runs.find((r) => r.label === 'dense'), gpu.floor),
    ...snapshotSection(snapshots),
    '## Critères (plan 3c, tâche 10)',
    '',
    '| Critère | Cible | Mesure | Tenu |',
    '|---|---|---|---|',
    ...criteria(runs).map((c) => `| ${c.name} | ${c.target} | ${c.measure} | ${c.met === null ? (c.measure === '—' ? '—' : 'rapporté') : c.met ? 'tenu' : '**non tenu**'} |`),
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
  const name = benchName(), snapsFile = join(docsDir, SNAPSHOTS_FILE);
  const snapshots: SnapshotGrowth | null = existsSync(snapsFile) ? JSON.parse(readFileSync(snapsFile, 'utf8')) : null;
  const path = join(docsDir, `${name}.md`);
  writeFileSync(path, report(name, scale, runs, snapshots), 'utf8');
  writeFileSync(join(docsDir, `${name}.json`), JSON.stringify({ name, scale, generator: LARGE_GENERATOR_VERSION, gpu: gpuSummary(runs), runs, ...(snapshots ? { snapshots } : {}) }, null, 2), 'utf8');
  return path;
}
