// The app's rendering bench (spec 21): npm run bench -w packages/app [-- <nodes>,<connections>]
// The synthetic base (default 50 000 nodes, 500 000 connections, seed 1) is built once on disk, in
// %TEMP%/cirrus-bench-<seed>-<nodes>-<connections>/, and rebuilt when its generator's version stamp changes; each pass
// opens a fresh copy of it. Passes: vsync (GPU time, then the edit pass), plancher (every layer hidden: the floor of
// an empty frame), throttled-x4 (×4 CPU slowdown), vide (an empty base: Electron's own floor). The last pass writes
// docs/bancs/<CIRRUS_BENCH_NAME, by default app-rendu-<date>>.md.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const scale = process.argv[2] ?? '50000,500000';
const [nodes, connections] = scale.split(',');
const SEED = 1;
const electron = createRequire(import.meta.url)('electron');
const base = join(tmpdir(), `cirrus-bench-${SEED}-${nodes}-${connections}`);

const run = (what, env, timeout = 900_000) => {
  const full = { ...process.env, ...env, CIRRUS_BENCH: scale };
  delete full.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [appDir], { env: full, stdio: 'inherit', timeout });
  if (r.status !== 0) throw new Error(`${what} : échec (${r.status ?? r.signal})`);
};

console.log('Base du banc…');
run('base du banc', { CIRRUS_BENCH_BUILD: base });

rmSync(join(appDir, '..', '..', 'docs', 'bancs', '.app-rendu-runs.json'), { force: true });
const passes = [
  { label: 'vsync', env: {} },
  { label: 'plancher', env: { CIRRUS_BENCH_HIDE: 'all' } },
  { label: 'throttled-x4', env: { CIRRUS_BENCH_THROTTLE: '4' } },
  { label: 'vide', env: {}, empty: true },
];
passes.forEach((p, i) => {
  console.log(`Passe ${p.label}…`);
  const data = mkdtempSync(join(tmpdir(), 'cirrus-bench-pass-'));
  try {
    if (!p.empty) cpSync(base, data, { recursive: true });
    run(`passe ${p.label}`, { ...p.env, CIRRUS_DATA: data, CIRRUS_BENCH_LABEL: p.label, CIRRUS_BENCH_FINAL: i === passes.length - 1 ? '1' : '0' });
  } finally {
    rmSync(data, { recursive: true, force: true, maxRetries: 5 });
  }
});
