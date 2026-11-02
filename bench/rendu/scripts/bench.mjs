// Runs the three measurement passes one after the other; the last one writes docs/bancs/rendu-<date>.{json,md}.
import { spawnSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// Optional: a report name suffix and diagnostic query parameters, e.g. `node scripts/bench.mjs sans-enveloppes hide=hull`.
const [suffix, extra] = process.argv.slice(2);
const benchDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const electron = createRequire(import.meta.url)('electron'); // path to the binary when required from Node
rmSync(join(benchDir, '..', '..', 'docs', 'bancs', '.rendu-runs.json'), { force: true });

// Both passes run with vsync: GPU time comes from timer queries, and an uncapped loop only piles up a GPU backlog
// that ends in multi-second stalls (ledger, Task 6).
const passes = [
  { label: 'throttled-x4', env: {} },
  { label: 'vsync', env: {} },
];
passes.forEach((p, i) => {
  const final = i === passes.length - 1 ? '1' : '0';
  console.log(`Passe ${p.label}…`);
  const r = spawnSync(electron, ['.'], {
    cwd: benchDir,
    env: { ...process.env, ...p.env, BENCH_QUERY: `bench=1&label=${p.label}&final=${final}${suffix ? `&name=${suffix}` : ''}${extra ? `&${extra}` : ''}` },
    stdio: 'inherit',
    timeout: 300_000,
  });
  if (r.status !== 0) throw new Error(`pass ${p.label} failed (${r.status ?? r.signal})`);
});
console.log('Rapport écrit dans docs/bancs.');
