// The signed updates, end to end (plan 9, task 4): node scripts/maj-essai.mjs. Long (two installers built), and never
// run against anything of the user's:
// - « Cirrus Dev » 0.1.1 and 0.1.2 are built into a temporary folder (electron-vite build, then electron-builder with
//   electron-builder.dev.yml and the version given by -c.extraMetadata.version): their data folder is never the user's
//   base, and the official app is never run;
// - a test key pair is made here, in memory: 0.1.2's manifest signed with it (signer-version.mjs, the key passed by its
//   environment), never written;
// - a local server (port 0, temporary data), a new one with an empty base for each run, serves 0.1.2 from its versions/;
// - the unpacked 0.1.1 runs out of the user's way (CIRRUS_BACKGROUND) on a test base and profile, the test key and
//   CIRRUS_UPDATE_DEV=1 given (key.ts: devUpdatesOf — which also makes its updater arm and never install), with a
//   LOCALAPPDATA of its own (electron-updater's cache), paired with the server through the block « Serveur »;
//   CIRRUS_NO_RELAUNCH=1, so that it never starts again out of the script's hands, and any instance of it left after a
//   run is stopped and counted as a failure.
// Three runs: the update found, verified, downloaded and armed (the chip says so); a signature of another key: refused;
// an installer that is not the signed one (latest.yml rewritten to its hash): downloaded, then refused. Each app is ended
// by a kill, never quit. All along, no installer nor uninstaller process may appear; afterwards, nothing is installed
// (%LOCALAPPDATA%\Programs\@cirrusapp-dev, …\cirrus, and the former …\Cirrus Dev: their existence only, nothing listed).
// Everything temporary removed.
import { execFile, spawnSync } from 'node:child_process';
import { createHash, generateKeyPairSync, sign } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { startServer } from '@cirrus/server';
import { appDir, launch, sleep } from './cdp.mjs';
import { chipSays, pairingCode, pairThrough } from './serveur-local.mjs';

const READY = 'Mise à jour prête : elle s’installera à la fermeture.';
const REFUSED = 'Mise à jour refusée : sa signature ne correspond pas.';
const root = join(appDir, '..', '..');
const failures = [];
const check = (ok, what) => { console.log(`${ok ? 'ok' : 'ÉCHEC'} : ${what}`); if (!ok) failures.push(what); return ok; };
const sha512 = (path) => createHash('sha512').update(readFileSync(path)).digest('base64');

// ——— Nothing installed before, and an eye on the processes all along ———
const programs = (name) => join(process.env.LOCALAPPDATA ?? '', 'Programs', name);
const installedBefore = ['cirrus', '@cirrusapp-dev', 'Cirrus Dev'].filter((n) => existsSync(programs(n)));
check(installedBefore.length === 0, `rien d’installé avant l’essai (%LOCALAPPDATA%\\Programs : ${installedBefore.join(', ') || 'ni Cirrus ni Cirrus Dev'})`);
const seen = new Set();
const watch = setInterval(() => {
  execFile('tasklist', ['/FO', 'CSV', '/NH'], (e, out) => {
    if (e) return;
    for (const line of out.split('\n')) {
      const image = line.split('","')[0]?.replace(/^"/, '') ?? '';
      if (/setup|uninstall|old-uninstaller|elevate/i.test(image) && /cirrus|uninstall|elevate/i.test(image)) seen.add(image);
    }
  });
}, 400);

const tmp = mkdtempSync(join(tmpdir(), 'cirrus-maj-essai-'));
/** Any « Cirrus Dev » of this check's builds still running (an instance started again by itself): stopped, and counted. */
const strays = () => {
  const ps = `$p = Get-CimInstance Win32_Process -Filter "Name='Cirrus Dev.exe'" | Where-Object { $_.CommandLine -like '*${tmp.replaceAll("'", "''")}*' }; $p | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; ($p | Measure-Object).Count`;
  return Number(spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], { encoding: 'utf8' }).stdout.trim() || 0);
};
let server = null, app = null;
try {
  // ——— Two « Cirrus Dev » installers ———
  const run = (what, file, args, env = {}) => {
    console.log(`… ${what}`);
    const r = spawnSync(process.execPath, [file, ...args], { cwd: appDir, stdio: 'inherit', env: { ...process.env, ...env } });
    if (r.status !== 0) throw new Error(`${what} : code ${r.status}`);
  };
  run('electron-vite build', join(root, 'node_modules', 'electron-vite', 'bin', 'electron-vite.js'), ['build']);
  const built = {};
  for (const version of ['0.1.1', '0.1.2']) {
    const out = join(tmp, `v${version}`);
    run(`electron-builder, Cirrus Dev ${version}`, join(root, 'node_modules', 'electron-builder', 'cli.js'), [
      '--win', 'nsis', '--publish', 'never', '--config', 'electron-builder.dev.yml', `-c.extraMetadata.version=${version}`, `-c.directories.output=${out}`,
    ]);
    built[version] = out;
    const { extractFile } = await import('@electron/asar');
    const pkg = JSON.parse(extractFile(join(out, 'win-unpacked', 'resources', 'app.asar'), 'package.json').toString('utf8'));
    check(pkg.name === '@cirrus/app-dev' && pkg.version === version, `${version} : le paquet est « ${pkg.name} » ${pkg.version} (attendu : @cirrus/app-dev ${version})`);
    check(existsSync(join(out, `Cirrus Dev Setup ${version}.exe`)) && existsSync(join(out, 'latest.yml')), `${version} : l’installateur et latest.yml sont écrits`);
    const config = readFileSync(join(out, 'win-unpacked', 'resources', 'app-update.yml'), 'utf8');
    check(/provider: generic/.test(config) && /updaterCacheDirName:/.test(config), `${version} : resources/app-update.yml (${config.replace(/\s+/g, ' ').trim()})`);
  }

  // ——— 0.1.2 signed with a test key ———
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const pub = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  run('signer-version.mjs (clé d’essai)', join(appDir, 'scripts', 'signer-version.mjs'), [built['0.1.2']], { CIRRUS_SIGNING_KEY: pem });
  const file = 'Cirrus Dev Setup 0.1.2.exe', signedSha = sha512(join(built['0.1.2'], file));

  /**
   * A new server for each run, its base empty — a new test PC then sends its own, rather than taking the server's and
   * starting again (D7), out of this script's hands —, 0.1.2 in its versions/, `alter`ed there.
   */
  async function serve(name, alter = () => {}) {
    const data = join(tmp, `${name}-serveur`), versions = join(data, 'versions');
    mkdirSync(versions, { recursive: true });
    for (const f of [file, 'latest.yml', 'version.json', 'version.json.sig']) copyFileSync(join(built['0.1.2'], f), join(versions, f));
    alter(versions);
    server = await startServer({ dataDir: data, port: 0 });
    return data;
  }

  /**
   * One run of 0.1.1: launched on a new test base, profile and LOCALAPPDATA, paired with a new server, then `until`
   * waited for; its log kept; killed — never quit —, and any instance of it left stopped. The pending downloads
   * electron-updater left, as [name, sha512].
   */
  const exe = join(built['0.1.1'], 'win-unpacked', 'Cirrus Dev.exe');
  async function once(name, until, alter) {
    const data = await serve(name, alter);
    const base = join(tmp, `${name}-base`), profile = join(tmp, `${name}-profil`), local = join(tmp, `${name}-local`), logFile = join(tmp, `${name}.log`);
    for (const d of [base, profile, local]) mkdirSync(d);
    const log = openSync(logFile, 'w');
    try {
      // CIRRUS_NO_RELAUNCH: were the app to take a base from the server, it would quit rather than start again unseen.
      app = await launch(base, profile, {
        CIRRUS_TINYTEX: join(base, 'sans-tinytex'), CIRRUS_UPDATE_PUBLIC_KEY: pub, CIRRUS_UPDATE_DEV: '1', LOCALAPPDATA: local, CIRRUS_NO_RELAUNCH: '1',
      }, { exe, log });
      await pairThrough(app.page, server.url, pairingCode(data, `Essai ${name}`));
      const result = await until(app.page);
      const chip = await app.page.evaluate(`document.querySelector('.tabs .sync-chip')?.textContent ?? null`);
      // Ended by a kill: never quit, whatever is armed.
      await app.close();
      app = null;
      check(strays() === 0, `${name} : aucune autre instance de l’app laissée`);
      const pending = [];
      const walk = (d) => { for (const f of readdirSync(d)) { const p = join(d, f); if (statSync(p).isDirectory()) walk(p); else if (/\.exe$/i.test(f)) pending.push([p.slice(local.length + 1), sha512(p)]); } };
      walk(local);
      return { result, chip, pending, log: readFileSync(logFile, 'utf8') };
    } finally {
      closeSync(log);
      await server?.close();
      server = null;
    }
  }
  await serve('sans-jeton');
  const tokenless = (await fetch(`${server.url}/versions/version.json`)).status;
  await server.close();
  server = null;
  check(tokenless === 401, `le serveur refuse /versions/version.json sans jeton (${tokenless})`);
  const updaterLines = (log) => log.split(/\r?\n/).filter((l) => /update|version|Mise à jour|Executing|Install/i.test(l)).slice(0, 30).join('\n    ');

  // ——— 1. Found, verified, downloaded, armed ———
  const a = await once('acceptee', (page) => chipSays(page, READY, 240_000));
  console.log(`  journal :\n    ${updaterLines(a.log)}`);
  check(a.result && a.chip === READY, `0.1.1 trouve 0.1.2, la vérifie, la télécharge et l’arme : la pastille dit « ${a.chip} »`);
  check(a.pending.some(([, h]) => h === signedSha), `l’installateur téléchargé par electron-updater est celui que le manifeste signe (${a.pending.map(([p]) => p).join(', ') || 'aucun'})`);
  check(/New version 0\.1\.2 has been downloaded/.test(a.log), 'electron-updater dit l’avoir téléchargé');
  check(!/Executing:|Install: isSilent|Auto install update on quit/.test(a.log), 'aucun installateur lancé (ni « Executing: », ni « Install: »)');

  // ——— 2. A signature of another key: refused, nothing downloaded ———
  const refusal = (page, ms) => page.until(`document.querySelector('.toasts')?.textContent.includes(${JSON.stringify(REFUSED)}) ?? false`, ms);
  const other = generateKeyPairSync('ed25519').privateKey;
  const b = await once('signature', (page) => refusal(page, 120_000), (versions) => {
    writeFileSync(join(versions, 'version.json.sig'), sign(null, readFileSync(join(versions, 'version.json')), other).toString('base64'));
  });
  console.log(`  journal :\n    ${updaterLines(b.log)}`);
  check(b.result, `une signature d’une autre clé : la notification « ${REFUSED} »`);
  check(b.chip !== READY && b.pending.length === 0, `rien d’armé ni de téléchargé (pastille « ${b.chip} », ${b.pending.length} fichier(s))`);

  // ——— 3. Another installer, latest.yml rewritten to its hash: downloaded, then refused ———
  let forged = '';
  const c = await once('empreinte', (page) => refusal(page, 240_000), (versions) => {
    const bytes = readFileSync(join(versions, file));
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(join(versions, file), bytes);
    forged = createHash('sha512').update(bytes).digest('base64');
    writeFileSync(join(versions, 'latest.yml'), readFileSync(join(versions, 'latest.yml'), 'utf8').replaceAll(signedSha, forged));
  });
  console.log(`  journal :\n    ${updaterLines(c.log)}`);
  check(c.result, `un installateur qui n’est pas celui du manifeste signé : la notification « ${REFUSED} »`);
  check(/New version 0\.1\.2 has been downloaded/.test(c.log) && c.pending.some(([, h]) => h === forged), 'electron-updater l’a téléchargé (sa propre vérification, sur latest.yml, passe)');
  check(c.chip !== READY && !/Executing:|Install: isSilent/.test(c.log), `rien d’armé ni lancé (pastille « ${c.chip} »)`);
} catch (e) {
  check(false, e instanceof Error ? e.stack ?? e.message : String(e));
} finally {
  if (app) await app.close();
  await server?.close();
  check(strays() === 0, 'aucune instance de l’app laissée à la fin');
  await sleep(1500);
  clearInterval(watch);
  check(seen.size === 0, `aucun processus d’installation ni de désinstallation vu pendant l’essai (${[...seen].join(', ') || 'aucun'})`);
  const installedAfter = ['cirrus', '@cirrusapp-dev', 'Cirrus Dev'].filter((n) => existsSync(programs(n)));
  check(installedAfter.length === installedBefore.length, `rien d’installé après l’essai (%LOCALAPPDATA%\\Programs : ${installedAfter.join(', ') || 'ni Cirrus ni Cirrus Dev'})`);
  rmSync(tmp, { recursive: true, force: true, maxRetries: 5 });
}
console.log(failures.length === 0 ? 'Mises à jour signées : l’essai de bout en bout passe.' : `${failures.length} échec(s).`);
process.exit(failures.length === 0 ? 0 : 1);
