// LaTeX bench (plan 1, task 8): cold vs warm compilation of typical fragments; writes docs/bancs/latex-<date>.{json,md}.
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WarmCompiler, type CompileJob } from './warmCompiler.ts';

interface Stats { p50: number; p95: number; max: number; n: number }
/** Nearest-rank percentiles (copied from bench/rendu: the benches share no code). */
function summarize(samples: number[]): Stats {
  if (samples.length === 0) return { p50: NaN, p95: NaN, max: NaN, n: 0 };
  const s = [...samples].sort((a, b) => a - b);
  const rank = (q: number) => s[Math.min(s.length - 1, Math.max(0, Math.ceil(q * s.length) - 1))];
  return { p50: rank(0.5), p95: rank(0.95), max: s[s.length - 1], n: s.length };
}

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const fragDir = join(root, 'tex', 'fragments');
const pdflatex = join(root, 'vendor', 'TinyTeX', 'bin', 'windows', 'pdflatex.exe');
const COLD_RUNS = 10, WARM_RUNS = 20, TARGET_MS = 300;

const fragments: { name: string; job: CompileJob; gated: boolean }[] = [
  { name: 'court', job: { texPath: join(fragDir, 'court.tex') }, gated: true },
  { name: 'equations', job: { texPath: join(fragDir, 'equations.tex') }, gated: true },
  { name: 'references', job: { texPath: join(fragDir, 'references.tex'), refs: [{ label: 'ext:mdl', title: 'Minimum Description Length' }] }, gated: true },
  { name: 'tikz', job: { texPath: join(fragDir, 'tikz.tex') }, gated: false },
  { name: 'accents', job: { texPath: join(fragDir, 'accents.tex'), resourceDir: fragDir }, gated: false },
];

const rows: { name: string; gated: boolean; cold: Stats; warm: Stats; ok: boolean; error?: string }[] = [];
for (const f of fragments) {
  const workDir = mkdtempSync(join(tmpdir(), 'cirrus-bench-tex-'));
  const compiler = new WarmCompiler({ pdflatex, workDir, preamblePath: join(root, 'tex', 'preamble.tex'), timeoutMs: 20_000 });
  const cold: number[] = [], warm: number[] = [];
  let ok = true, error: string | undefined;
  for (let i = 0; i < COLD_RUNS; i++) {
    const r = await compiler.compileCold(f.job);
    cold.push(r.ms);
    if (!r.ok) { ok = false; error = r.error; }
  }
  for (let i = 0; i < WARM_RUNS; i++) {
    await compiler.prepare(); // measured from the moment the node is handed over
    const r = await compiler.compile(f.job);
    warm.push(r.ms);
    if (!r.ok) { ok = false; error = r.error; }
  }
  await compiler.dispose();
  rmSync(workDir, { recursive: true, force: true });
  rows.push({ name: f.name, gated: f.gated, cold: summarize(cold), warm: summarize(warm), ok, error });
  console.log(`${f.name}: froid p50 ${summarize(cold).p50.toFixed(0)} ms, préchauffé p50 ${summarize(warm).p50.toFixed(0)} ms${ok ? '' : ` — échec : ${error}`}`);
}

const gated = rows.filter((r) => r.gated);
const pass = gated.every((r) => r.ok && r.warm.p50 <= TARGET_MS);
const d = new Date();
const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const version = execFileSync(pdflatex, ['--version']).toString().split('\n')[0];
const f0 = (v: number) => (Number.isFinite(v) ? v.toFixed(0) : '—');
const accents = rows.find((r) => r.name === 'accents')!;
const md = [
  `# Banc LaTeX — ${date}`,
  '',
  `**Verdict : ${pass ? 'RÉUSSI' : 'ÉCHOUÉ'}** (médiane préchauffée ≤ ${TARGET_MS} ms pour court, equations et references)`,
  '',
  `- Moteur : ${version}, processeur ${cpus()[0].model.trim()}.`,
  `- Protocole : ${COLD_RUNS} compilations à froid puis ${WARM_RUNS} préchauffées par fragment ; le temps préchauffé part de la remise du nœud au processus déjà prêt.`,
  `- Nom de fichier accentué (\`courbes_été.png\`) : ${accents.ok ? 'compile correctement' : `échec — ${accents.error}`}.`,
  '',
  '| Fragment | Critère | À froid p50 | p95 | max | Préchauffé p50 | p95 | max | Résultat |',
  '|---|---|---|---|---|---|---|---|---|',
  ...rows.map((r) => `| ${r.name} | ${r.gated ? 'oui' : 'consigné'} | ${f0(r.cold.p50)} | ${f0(r.cold.p95)} | ${f0(r.cold.max)} | ${f0(r.warm.p50)} | ${f0(r.warm.p95)} | ${f0(r.warm.max)} | ${r.ok ? 'ok' : 'échec'} |`),
  '',
  'Temps en millisecondes.',
  '',
].join('\n');
const out = join(root, '..', '..', 'docs', 'bancs');
mkdirSync(out, { recursive: true });
writeFileSync(join(out, `latex-${date}.json`), JSON.stringify({ date, version, pass, rows }, null, 2), 'utf8');
writeFileSync(join(out, `latex-${date}.md`), md, 'utf8');
console.log(`Rapport écrit : docs/bancs/latex-${date}.md (${pass ? 'réussi' : 'échoué'})`);
