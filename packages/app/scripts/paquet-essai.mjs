// The packaged app's check (plan 9, task 3): node scripts/paquet-essai.mjs [--dev [--sans-profil]], after `npm run
// paquet` (or `paquet:dev`; `-- --dir` is enough), which leaves the app as its installer installs it in dist/win-unpacked.
// The archive's package name is read first: it makes the variant (identity.ts), and must be the one asked for. The
// executable is then launched out of the user's way (CIRRUS_BACKGROUND) on a new test base (CIRRUS_DATA), a profile of
// its own (--user-data-dir, which the app keeps) and a LOCALAPPDATA of its own (the packaged app hears no CIRRUS_TINYTEX:
// it finds no TinyTeX there, and never touches the user's), all temporary, driven by DevTools (cdp.mjs): the graph drawn,
// the rubric « Serveur » saying the app's name and version, the base made where it was told; then closed, its folders
// removed. Nothing is installed.
// --sans-profil (« Cirrus Dev » only: never the official app, whose folder is the user's base): no --user-data-dir, so
// that the app takes the profile its identity gives, %APPDATA%\@cirrus\app-dev, which must not exist before and is
// removed after: it is checked to appear there (fix round 1 of task 3, M2).
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractFile } from '@electron/asar';
import { appDir, launch } from './cdp.mjs';

const args = process.argv.slice(2);
const dev = args.includes('--dev'), ownProfile = args.includes('--sans-profil');
if (args.some((a) => a !== '--dev' && a !== '--sans-profil') || (ownProfile && !dev)) {
  console.error('Usage : node scripts/paquet-essai.mjs [--dev [--sans-profil]] (--sans-profil : « Cirrus Dev » seulement)');
  process.exit(2);
}
const name = dev ? 'Cirrus Dev' : 'Cirrus';
const unpacked = join(appDir, 'dist', 'win-unpacked'), exe = join(unpacked, `${name}.exe`);
if (!existsSync(exe)) {
  console.error(`${exe} absent : lancer d’abord npm run ${dev ? 'paquet:dev' : 'paquet'} (-- --dir suffit).`);
  process.exit(2);
}
const packaged = JSON.parse(extractFile(join(unpacked, 'resources', 'app.asar'), 'package.json').toString('utf8'));
const expected = dev ? '@cirrus/app-dev' : 'cirrus';
if (packaged.name !== expected) {
  console.error(`Le paquet de ${exe} s’appelle « ${packaged.name} », non « ${expected} » : il n’est pas lancé.`);
  process.exit(2);
}
const version = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8')).version;
const appDevProfile = process.env.APPDATA ? join(process.env.APPDATA, '@cirrus', 'app-dev') : '';
if (ownProfile && (!appDevProfile || existsSync(appDevProfile))) {
  console.error(`${appDevProfile || 'APPDATA'} existe déjà (ou APPDATA n’est pas défini) : ses données ne sont pas touchées, l’essai n’est pas lancé.`);
  process.exit(2);
}
const data = mkdtempSync(join(tmpdir(), 'cirrus-paquet-')), local = mkdtempSync(join(tmpdir(), 'cirrus-paquet-local-'));
const profile = ownProfile ? appDevProfile : mkdtempSync(join(tmpdir(), 'cirrus-paquet-profil-'));
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'ÉCHEC'} : ${what}`); if (!ok) failures.push(what); };
let app = null;
try {
  app = await launch(data, profile, { LOCALAPPDATA: local }, { exe, ownProfile });
  const { page } = app;
  check(await page.evaluate(`!!document.querySelector('.graph canvas')`), 'le graphe est dessiné');
  check(existsSync(join(data, 'cirrus.db')), 'la base est faite dans le dossier de test (CIRRUS_DATA)');
  check(existsSync(join(profile, 'DevToolsActivePort')), ownProfile
    ? `le profil est celui de l’identité de « Cirrus Dev » : ${profile}`
    : 'le profil est celui donné par --user-data-dir');
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
  for (const d of [data, local, profile]) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
}
if (ownProfile) check(!existsSync(profile), `${profile} ôté après l’essai`);
console.log(failures.length === 0 ? `${name} ${version} : l’app empaquetée s’ouvre et montre le graphe.` : `${failures.length} échec(s).`);
process.exit(failures.length === 0 ? 0 : 1);
