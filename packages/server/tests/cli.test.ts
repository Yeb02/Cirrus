import { afterEach, beforeEach, expect, test } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { PAIRING_TTL_MS } from '../src/bounds.ts';
import { defaultDataDir, parse, type System, UsageError } from '../src/cli.ts';
import { Tokens } from '../src/tokens.ts';
import { T0 } from './support.ts';

// The command line on a rented machine (plan 9, task 1, D2, D5, D8): run by SSH, it finds its data on Linux without
// --data, takes the names the server answers to (--nom, or CIRRUS_NOM), gives the download page's address with a
// pairing code, and `pcs` prints no control character. The system it reads is injected: these tests run on Windows.

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-serveur-commande-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const sys = (platform: NodeJS.Platform, env: Record<string, string>, uid: number | null, home = '/home/ana'): System => ({ platform, env, uid, home, cwd: home });

test('dossier par défaut (D2) : LOCALAPPDATA sous Windows ; /var/lib/cirrus pour root, sinon XDG_DATA_HOME ou ~/.local/share ailleurs', () => {
  const win = 'C:\\Users\\ana\\AppData\\Local';
  expect(defaultDataDir(sys('win32', { LOCALAPPDATA: win }, null, 'C:\\Users\\ana'))).toBe(`${win}\\Cirrus\\serveur`);
  expect(() => defaultDataDir(sys('win32', {}, null, 'C:\\Users\\ana'))).toThrow(UsageError);
  expect(() => defaultDataDir(sys('win32', {}, null, 'C:\\Users\\ana'))).toThrow(/LOCALAPPDATA.*--data/);
  expect(defaultDataDir(sys('linux', { XDG_DATA_HOME: '/home/ana/.donnees', LOCALAPPDATA: 'C:\\x' }, 0, '/root'))).toBe('/var/lib/cirrus');
  expect(defaultDataDir(sys('linux', { XDG_DATA_HOME: '/home/ana/.donnees' }, 1000))).toBe('/home/ana/.donnees/cirrus');
  expect(defaultDataDir(sys('linux', {}, 1000))).toBe('/home/ana/.local/share/cirrus');
  // Empty or relative: not a place (the XDG specification).
  expect(defaultDataDir(sys('linux', { XDG_DATA_HOME: '' }, 1000))).toBe('/home/ana/.local/share/cirrus');
  expect(defaultDataDir(sys('linux', { XDG_DATA_HOME: 'donnees' }, 1000))).toBe('/home/ana/.local/share/cirrus');
  expect(defaultDataDir(sys('darwin', { LOCALAPPDATA: 'C:\\x' }, 501, '/Users/ana'))).toBe('/Users/ana/.local/share/cirrus');
  // No home to go by: --data is asked for.
  expect(() => defaultDataDir(sys('linux', {}, 1000, ''))).toThrow(/--data/);
  // The command line takes it when --data is not given.
  expect(parse([], sys('linux', {}, 0)).dataDir).toBe('/var/lib/cirrus');
  expect(parse(['pcs'], sys('linux', {}, 1000)).dataDir).toBe('/home/ana/.local/share/cirrus');
  expect(parse(['pcs', '--data', '/srv/cirrus'], sys('linux', {}, 1000)).dataDir).toMatch(/srv[\\/]cirrus$/);
});

test('ligne de commande : --nom répétable, en minuscules ; sinon CIRRUS_NOM ; un nom invalide est une erreur d’usage', () => {
  const linux = (env: Record<string, string> = {}) => sys('linux', env, 1000);
  expect(parse(['--nom', 'Cirrus.Exemple.fr', '--port', '7311', '--nom', 'autre.exemple.fr'], linux())).toMatchObject({
    command: 'serve', names: ['cirrus.exemple.fr', 'autre.exemple.fr'], port: 7311,
  });
  expect(parse(['jumeler', 'Portable'], linux({ CIRRUS_NOM: 'Cirrus.Exemple.fr' }))).toMatchObject({ command: 'jumeler', name: 'Portable', names: ['cirrus.exemple.fr'] });
  // --nom given: CIRRUS_NOM not added.
  expect(parse(['--nom', 'a.exemple.fr'], linux({ CIRRUS_NOM: 'b.exemple.fr' })).names).toEqual(['a.exemple.fr']);
  expect(parse([], linux()).names).toEqual([]);
  expect(parse([], linux({ CIRRUS_NOM: '' })).names).toEqual([]);
  for (const argv of [['--nom'], ['--nom', 'https://cirrus.exemple.fr'], ['--nom', 'cirrus.exemple.fr:443'], ['--nom', 'cirrus.exemple.fr/x']]) {
    expect(() => parse(argv, linux()), argv.join(' ')).toThrow(UsageError);
  }
  expect(() => parse([], linux({ CIRRUS_NOM: 'https://cirrus.exemple.fr' }))).toThrow(/CIRRUS_NOM/);
});

const MAIN = join(import.meta.dirname, '..', 'src', 'main.ts');
/** The command line on this test's data, CIRRUS_NOM unset unless `env` sets it. */
const cli = async (args: string[], env: Record<string, string> = {}) =>
  (await promisify(execFile)(process.execPath, [MAIN, ...args, '--data', dir], { encoding: 'utf8', windowsHide: true, env: { ...process.env, CIRRUS_NOM: undefined, ...env } })).stdout;

test('jumeler (D2, D5) : l’adresse de la page de téléchargement, https://<nom>/installer, quand un nom est connu', async () => {
  const page = /^Page de téléchargement : https:\/\/cirrus\.exemple\.fr\/installer$/m;
  expect(await cli(['jumeler', 'Portable', '--nom', 'Cirrus.Exemple.fr', '--nom', 'autre.exemple.fr'])).toMatch(page);
  expect(await cli(['jumeler', 'Bureau'], { CIRRUS_NOM: 'cirrus.exemple.fr' })).toMatch(page);
  const bare = await cli(['jumeler', 'Tablette']);
  expect(bare).toMatch(/Code de jumelage pour « Tablette »/);
  expect(bare).not.toMatch(/téléchargement|https?:/);
  await expect(cli(['jumeler', 'Autre', '--nom', 'https://cirrus.exemple.fr'])).rejects.toMatchObject({ code: 2 });
}, 30_000);

/** C0 (escape sequences among them), DEL, C1, and the bidi overrides and isolates (« Trojan Source »). */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/;

test('pcs (D8) : les noms affichés sans caractère de contrôle ni de sens d’écriture ; serveur.db les garde tels quels', async () => {
  // Names as an older or altered serveur.db may hold them, written past the checks of `jumeler` and /pair.
  Tokens.open(dir).close();
  const db = new DatabaseSync(join(dir, 'serveur.db'));
  const name = 'Port\u001b[2Jable\u0007\u007f\u009b31m\u202eelbat\u2066x\u2069', machine = 'DESKTOP\u202d-A\r\u0085', id = 'pc-\u001b]0;titre\u0007a';
  const code = 'Tab\u2067lette\u001b[1A';
  db.prepare('INSERT INTO pcs (id, name, machine, token_hash, paired_at) VALUES (?, ?, ?, ?, ?)').run(id, name, machine, 'h'.repeat(64), T0);
  db.prepare('INSERT INTO codes (code_hash, name, expires_at) VALUES (?, ?, ?)').run('c'.repeat(64), code, Date.now() + PAIRING_TTL_MS);
  db.close();
  const out = await cli(['pcs']);
  for (const line of out.split('\n')) expect(line, JSON.stringify(line)).not.toMatch(CONTROL);
  expect(out).toContain('Port[2Jable31melbatx — DESKTOP-A, jumelé le');
  expect(out).toContain('(identifiant pc-]0;titrea)');
  expect(out).toContain('Tablette[1A — jusqu’au');
  // Stored as they were.
  const check = new DatabaseSync(join(dir, 'serveur.db'));
  try {
    expect(check.prepare('SELECT id, name, machine FROM pcs').all()).toEqual([{ id, name, machine }]);
    expect(check.prepare('SELECT name FROM codes').all()).toEqual([{ name: code }]);
  } finally {
    check.close();
  }
}, 30_000);
