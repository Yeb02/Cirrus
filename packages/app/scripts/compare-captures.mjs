// Compares two folders of captures (plan 3c): node scripts/compare-captures.mjs <dossierA> <dossierB> [--max=0.5]
// For each PNG of either folder, the share of its pixels where a channel differs by more than 16 levels. Exits with 1
// when one exceeds --max percent (0.5 by default, the plan's tolerance), differs in size or is missing on one side;
// with 2 when a folder holds no capture.
// The images are decoded by Electron's nativeImage: run with Node, the script starts itself again under Electron.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEVELS = 16;
const args = process.argv.slice(2);
const dirs = args.filter((a) => !a.startsWith('--'));
const max = Number(args.find((a) => a.startsWith('--max='))?.slice(6) ?? 0.5);
if (dirs.length !== 2) {
  console.error('Usage : node scripts/compare-captures.mjs <dossierA> <dossierB> [--max=0.5]');
  process.exit(2);
}
const [a, b] = dirs.map((d) => resolve(process.env.INIT_CWD ?? process.cwd(), d));
for (const d of [a, b]) {
  if (!existsSync(d) || !readdirSync(d).some((f) => f.toLowerCase().endsWith('.png'))) {
    console.error(`Aucune capture dans ${d}.`);
    process.exit(2);
  }
}

if (!process.versions.electron) {
  const electron = createRequire(import.meta.url)('electron');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(electron, [fileURLToPath(import.meta.url), a, b, `--max=${max}`], { env, stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const { app, nativeImage } = await import('electron');
// Not awaited at the top level: an ES module entry that waits for "ready" keeps Electron from ever emitting it.
void app.whenReady().then(() => {
  const names = [...new Set([a, b].flatMap((d) => readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png'))))].sort();
  let bad = 0;
  for (const name of names) {
    const [pa, pb] = [join(a, name), join(b, name)];
    if (!existsSync(pa) || !existsSync(pb)) { bad++; console.log(`${name} : absente de ${existsSync(pa) ? b : a}`); continue; }
    const [ia, ib] = [nativeImage.createFromPath(pa), nativeImage.createFromPath(pb)];
    const [sa, sb] = [ia.getSize(), ib.getSize()];
    if (sa.width !== sb.width || sa.height !== sb.height) { bad++; console.log(`${name} : tailles différentes (${sa.width}×${sa.height}, ${sb.width}×${sb.height})`); continue; }
    const [da, db] = [ia.toBitmap(), ib.toBitmap()];
    let differ = 0;
    for (let i = 0; i < da.length; i += 4) {
      if (Math.abs(da[i] - db[i]) > LEVELS || Math.abs(da[i + 1] - db[i + 1]) > LEVELS || Math.abs(da[i + 2] - db[i + 2]) > LEVELS || Math.abs(da[i + 3] - db[i + 3]) > LEVELS) differ++;
    }
    const share = (100 * differ) / (sa.width * sa.height);
    if (share > max) bad++;
    console.log(`${name} : ${share.toFixed(3)} % des pixels diffèrent de plus de ${LEVELS} niveaux (${differ} pixels)${share > max ? ` : au-delà de ${max} %` : ''}`);
  }
  console.log(`${names.length} images comparées, ${bad} hors tolérance.`);
  app.exit(bad > 0 ? 1 : 0);
});
