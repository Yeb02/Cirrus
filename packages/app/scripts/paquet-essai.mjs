// The packaged app's check (plan 9, task 3): node scripts/paquet-essai.mjs [--dev], after `npm run paquet` (or
// `paquet:dev`), which leaves the app as its installer installs it in dist/win-unpacked. Its executable is launched out
// of the user's way (CIRRUS_BACKGROUND) on a new test base (CIRRUS_DATA) and a profile of its own (--user-data-dir,
// which the app keeps: identity.ts), both temporary — never the user's base, folder nor TinyTeX —, driven by DevTools
// (cdp.mjs): the graph drawn, the rubric « Serveur » saying the app's name and version, the base made where it was
// told; then closed, its folders removed. Nothing is installed.
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appDir, launch } from './cdp.mjs';

const args = process.argv.slice(2);
if (args.some((a) => a !== '--dev')) {
  console.error('Usage : node scripts/paquet-essai.mjs [--dev]');
  process.exit(2);
}
const name = args.includes('--dev') ? 'Cirrus Dev' : 'Cirrus';
const exe = join(appDir, 'dist', 'win-unpacked', `${name}.exe`);
if (!existsSync(exe)) {
  console.error(`${exe} absent : lancer d’abord npm run ${name === 'Cirrus' ? 'paquet' : 'paquet:dev'}.`);
  process.exit(2);
}
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
const data = mkdtempSync(join(tmpdir(), 'cirrus-paquet-')), profile = mkdtempSync(join(tmpdir(), 'cirrus-paquet-profil-'));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'ÉCHEC'} : ${what}`); if (!ok) failures.push(what); };
let app = null;
try {
  // A TinyTeX that is not there: the check never touches the user's (%LOCALAPPDATA%\Cirrus\TinyTeX) nor the network.
  app = await launch(data, profile, { CIRRUS_TINYTEX: join(data, 'sans-tinytex') }, { exe });
  const { page } = app;
  check(await page.evaluate(`!!document.querySelector('.graph canvas')`), 'le graphe est dessiné');
  check(existsSync(join(data, 'cirrus.db')), 'la base est faite dans le dossier de test (CIRRUS_DATA)');
  check(existsSync(join(profile, 'DevToolsActivePort')), 'le profil est celui donné par --user-data-dir');
  const gear = await page.centre('.tabs .gear', '⚙');
  await page.click(gear.x, gear.y);
  const rubric = await page.centre('.settings .rubric-title', 'Serveur');
  await page.click(rubric.x, rubric.y);
  await page.until(`!!document.querySelector('.settings .app-version')`);
  const said = await page.evaluate(`document.querySelector('.settings .app-version')?.textContent ?? null`);
  check(said === `${name} ${version}`, `la rubrique « Serveur » dit « ${said} » (attendu : « ${name} ${version} »)`);
  check(await app.quit(), 'l’app se ferme d’elle-même');
  app = null;
} catch (e) {
  check(false, e instanceof Error ? e.message : String(e));
} finally {
  if (app) await app.close();
  for (const d of [data, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures.length === 0 ? `${name} ${version} : l’app empaquetée s’ouvre et montre le graphe.` : `${failures.length} échec(s).`);
process.exit(failures.length === 0 ? 0 : 1);
