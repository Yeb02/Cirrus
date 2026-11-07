// The app on a copy of the artificial test base, to try it: npm run essai -w packages/app [-- --neuve]
// The trial has its own folder, beside the user's (%APPDATA%\@cirrus\essai, the user's being %APPDATA%\@cirrus\app):
// its base (base\), built from the fixture on the first launch and kept from one trial to the next, and its own
// Chromium profile (profil\: the open tabs, the panels' places), so that nothing of it mixes with the user's. --neuve
// starts again from a new copy of the fixture. LaTeX is the user's own TinyTeX (%LOCALAPPDATA%\Cirrus\TinyTeX), which
// the app offers to install if it is not there.
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some((a) => a !== '--neuve')) {
  console.error('Usage : npm run essai -w packages/app [-- --neuve]');
  process.exit(2);
}
if (!process.env.APPDATA) {
  console.error('APPDATA n’est pas défini : le dossier de l’essai ne peut pas être placé.');
  process.exit(2);
}
const root = join(process.env.APPDATA, '@cirrus', 'essai');
const base = join(root, 'base'), profile = join(root, 'profil');
if (args.includes('--neuve')) {
  rmSync(base, { recursive: true, force: true, maxRetries: 5 });
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
}
if (!existsSync(join(base, 'cirrus.db'))) {
  mkdirSync(base, { recursive: true });
  execFileSync(process.execPath, [join(appDir, '..', 'fixtures', 'scripts', 'make-fixture.ts'), base], { stdio: 'inherit' });
} else console.log(`Base d’essai reprise : ${base} (--neuve pour repartir de la base de test).`);
const env = { ...process.env, CIRRUS_DATA: base };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(createRequire(import.meta.url)('electron'), [appDir, `--user-data-dir=${profile}`], { env, stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 0));
