// The app's rendering bench (spec 21): npm run bench -w packages/app [-- <nodes>,<connections>]
// Two passes on a synthetic base (default 50 000 nodes, 500 000 connections): with vsync for the GPU time, then
// with a ×4 CPU slowdown. The last pass writes docs/bancs/app-rendu-<date>.md.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const scale = process.argv[2] ?? '50000,500000';
const electron = createRequire(import.meta.url)('electron');
rmSync(join(appDir, '..', '..', 'docs', 'bancs', '.app-rendu-runs.json'), { force: true });
const passes = [{ label: 'vsync', env: {} }, { label: 'throttled-x4', env: { CIRRUS_BENCH_THROTTLE: '4' } }];
passes.forEach((p, i) => {
  console.log(`Passe ${p.label}…`);
  const env = { ...process.env, ...p.env, CIRRUS_BENCH: scale, CIRRUS_BENCH_LABEL: p.label, CIRRUS_BENCH_FINAL: i === passes.length - 1 ? '1' : '0' };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [appDir], { env, stdio: 'inherit', timeout: 600_000 });
  if (r.status !== 0) throw new Error(`passe ${p.label} : échec (${r.status ?? r.signal})`);
});
