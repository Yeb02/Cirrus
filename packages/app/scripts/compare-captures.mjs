// Compares a folder of captures with a reference (plan 3c): node scripts/compare-captures.mjs <référence> <captures> [--max=0.5]
// For each PNG of the reference, the share of its pixels where a channel differs by more than 16 levels. Exits with 1
// when one exceeds --max percent (0.5 by default, the plan's tolerance), differs in size or is missing from the
// captures; with 2 on a usage error or when a folder holds no capture. The captures may hold more images than the
// reference (a run holds every scene, a reference only its own: reference-3c, plan4a): those are listed, not compared.
// An image that differs at all, within the tolerance, is listed « à regarder »: a lost selection ring, hover light, stub
// or phantom stays under 0.5 %, and the suite repeats to the pixel from one run to the next, so it is looked at.
// The images are decoded by Electron's nativeImage: run with Node, the script starts itself again under Electron.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const LEVELS = 16;
const USAGE = 'Usage : node scripts/compare-captures.mjs <référence> <captures> [--max=0.5] (--max : un pourcentage positif ou nul)';
const args = process.argv.slice(2);
const dirs = args.filter((a) => !a.startsWith('--'));
const maxArg = args.find((a) => a.startsWith('--max='))?.slice(6);
const max = maxArg === undefined ? 0.5 : maxArg.trim() === '' ? Number.NaN : Number(maxArg);
if (dirs.length !== 2 || !Number.isFinite(max) || max < 0 || args.some((a) => a.startsWith('--') && !a.startsWith('--max='))) {
  console.error(USAGE);
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
  const pngs = (d) => readdirSync(d).filter((f) => f.toLowerCase().endsWith('.png')).sort();
  const names = pngs(a), extra = pngs(b).filter((f) => !names.includes(f));
  let bad = 0;
  const toLook = [];
  for (const name of names) {
    const [pa, pb] = [join(a, name), join(b, name)];
    if (!existsSync(pb)) { bad++; console.log(`${name} : absente de ${b}`); continue; }
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
    else if (differ > 0) toLook.push(`${name} : ${share.toFixed(3)} % (${differ} pixels)`);
    console.log(`${name} : ${share.toFixed(3)} % des pixels diffèrent de plus de ${LEVELS} niveaux (${differ} pixels)${share > max ? ` : au-delà de ${max} %` : ''}`);
  }
  console.log(`${names.length} images comparées, ${bad} hors tolérance, ${toLook.length} à regarder.`);
  if (extra.length > 0) console.log(`Hors de cette référence, non comparées : ${extra.join(', ')}.`);
  for (const line of toLook) console.log(`À regarder : ${line}`);
  app.exit(bad > 0 ? 1 : 0);
});
