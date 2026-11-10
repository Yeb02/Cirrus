import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { appIdentity, DEV_PACKAGE, type Variant, variantOf } from '../src/main/identity.ts';

// The two packagings (plan 9, task 3, fix round 1): read by electron-builder's own loader, `extends` merged as the build
// merges it, and checked against the identity the app will take from them (identity.ts), the install folders against
// each other, the uninstaller against the user's base.
const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { getConfig } = require('app-builder-lib/out/util/config/config');
const { getWindowsInstallationDirName } = require('app-builder-lib/out/targets/targetUtil');
const { sanitizeFileName } = require('builder-util/out/filename');

interface Config {
  appId: string; productName: string; extraMetadata?: { name?: string }; files: unknown;
  nsis: { oneClick?: boolean; perMachine?: boolean; allowToChangeInstallationDirectory?: boolean; deleteAppDataOnUninstall?: boolean };
}
const CONFIGS: [string, Variant][] = [['electron-builder.yml', 'official'], ['electron-builder.dev.yml', 'dev']];
const load = (file: string): Promise<Config> => getConfig(appDir, file, null);
const pkg = JSON.parse(readFileSync(join(appDir, 'package.json'), 'utf8'));
/** The name the archive's package.json carries, which the app reads at each start (packageVariant). */
const packagedName = (c: Config): string => c.extraMetadata?.name ?? pkg.name;
/** The installer's folder under %LOCALAPPDATA%\Programs, by electron-builder's own rule (NsisTarget: APP_FILENAME). */
const installDir = (c: Config): string => getWindowsInstallationDirName(
  { productFilename: sanitizeFileName(c.productName), sanitizedName: sanitizeFileName(packagedName(c)) },
  c.nsis.oneClick === false || c.nsis.perMachine === true,
);

test('chaque configuration fait la variante que l’app lira dans son paquet : son appId, son nom, le nom du paquet', async () => {
  for (const [file, variant] of CONFIGS) {
    const c = await load(file), id = appIdentity({ appData: 'A', variant });
    expect(variantOf(packagedName(c)), file).toBe(variant);
    expect(c.appId, file).toBe(id.appId);
    expect(c.productName, file).toBe(id.name);
  }
  expect((await load('electron-builder.dev.yml')).extraMetadata?.name).toBe(DEV_PACKAGE);
});

test('une installation par utilisateur, sans page ni dossier à choisir, dont le désinstalleur n’efface jamais les données', async () => {
  for (const [file] of CONFIGS) {
    const { nsis } = await load(file);
    expect(nsis.oneClick, file).toBe(true);
    expect(nsis.perMachine, file).toBe(false);
    expect(nsis.allowToChangeInstallationDirectory, file).toBeUndefined();
    expect(nsis.deleteAppDataOnUninstall, file).toBe(false);
  }
});

test('aucun dossier d’installation n’est le début de l’autre : l’installateur de l’un arrête tout processus dont le chemin commence par le sien', async () => {
  const [official, dev] = await Promise.all(CONFIGS.map(([file]) => load(file).then(installDir)));
  expect(official).toBe('cirrus');
  expect(dev).toBe('@cirrusapp-dev');
  const [a, b] = [official, dev].map((d) => `C:\\Users\\u\\AppData\\Local\\Programs\\${d}`.toLowerCase());
  expect(a.startsWith(b) || b.startsWith(a)).toBe(false);
});

test('ni le nom du paquet ni le dossier d’installation n’est @cirrus\\app : --delete-app-data, s’il était passé, n’atteindrait jamais la base', async () => {
  for (const [file] of CONFIGS) {
    const c = await load(file);
    // The uninstaller's RMDir /r "$APPDATA\${APP_PACKAGE_NAME}" and "$APPDATA\${APP_FILENAME}" (uninstaller.nsh).
    for (const removed of [packagedName(c).replace(/\//g, '\\'), installDir(c)]) expect(removed.toLowerCase(), file).not.toBe('@cirrus\\app');
  }
});

test('l’archive ne porte pas les morceaux du banc (out/main/bench-*.js) : l’app empaquetée ne peut pas le brancher', async () => {
  for (const [file] of CONFIGS) expect(JSON.stringify((await load(file)).files), file).toContain('!out/main/bench-*.js');
});
