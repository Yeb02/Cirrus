import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createPlan, emptyState, uuidv7 } from '@cirrus/core';
import { LocalStore, lockBase } from '@cirrus/store';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { buildFixture } from '../src/build.ts';
import { FIXTURE_PC, isUserBase, testBaseRefusal, userBaseDir } from '../src/testBase.ts';

// Final review of plan 4c, M6: add-reading.ts writes into a test base only — never the user's own, which these tests
// never open: its place is mimicked under a temporary %APPDATA% (APPDATA given to the check, and to the script's process).
let root: string;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'cirrus-garde-')); });
afterEach(() => { rmSync(root, { recursive: true, force: true, maxRetries: 5 }); });

const ADD_READING = fileURLToPath(new URL('../scripts/add-reading.ts', import.meta.url));
const MAKE_FIXTURE = fileURLToPath(new URL('../scripts/make-fixture.ts', import.meta.url));
/** A test base, as make-fixture.ts builds it, in `dir`. */
function fixtureBase(dir: string): void {
  const store = LocalStore.open(dir, { pc: FIXTURE_PC });
  buildFixture(store, dir);
  store.close();
}
/** A base as the app opens one: its journal signed by the PC's identifier (pc.json: a uuidv7), a lobby, nothing else. */
function appBase(dir: string): void {
  const store = LocalStore.open(dir, { pc: uuidv7() });
  store.commit(createPlan(emptyState(), 'Lobby', 'lobby'));
  store.close();
}
const nodes = (dir: string) => {
  const db = new DatabaseSync(join(dir, 'cirrus.db'), { readOnly: true });
  try { return Number((db.prepare('SELECT count(*) AS n FROM nodes').get() as { n: number }).n); } finally { db.close(); }
};
/** add-reading.ts run on `dir`, %APPDATA% the temporary one. */
const addReading = (dir: string) => spawnSync(process.execPath, [ADD_READING, dir], {
  env: { ...process.env, APPDATA: join(root, 'AppData', 'Roaming'), INIT_CWD: root }, encoding: 'utf8', timeout: 60_000,
});

test('testBaseRefusal : une base de make-fixture.ts est acceptée ; la base de l’utilisateur, une base de l’app, un dossier sans base sont refusés', () => {
  const env = { APPDATA: join(root, 'AppData', 'Roaming') };
  const user = userBaseDir(env)!;
  expect(user).toBe(join(root, 'AppData', 'Roaming', '@cirrus', 'app', 'base'));
  const fixture = join(root, 'test');
  fixtureBase(fixture);
  expect(testBaseRefusal(fixture, env)).toBeNull();
  // The user's place, even holding a test base (copied there by hand), and whatever the case of its path on Windows.
  mkdirSync(user, { recursive: true });
  fixtureBase(user);
  expect(testBaseRefusal(user, env)).toMatch(/est la base de l’utilisateur/);
  expect(testBaseRefusal(join(user, '.'), env)).toMatch(/est la base de l’utilisateur/);
  if (process.platform === 'win32') expect(testBaseRefusal(user.toUpperCase(), env)).toMatch(/est la base de l’utilisateur/);
  // A base the app made: cirrus.db is there, but its journal is not make-fixture.ts's.
  const app = join(root, 'copie');
  appBase(app);
  expect(testBaseRefusal(app, env)).toMatch(/n’est pas une base de test/);
  // No base at all.
  expect(testBaseRefusal(join(root, 'vide'), env)).toMatch(/ne contient pas de base/);
  // Without APPDATA (another system), the mark alone decides.
  expect(userBaseDir({})).toBeNull();
  expect(testBaseRefusal(fixture, {})).toBeNull();
  expect(testBaseRefusal(app, {})).toMatch(/n’est pas une base de test/);
});

test('add-reading.ts : refuse la place de la base de l’utilisateur et une base de l’app sans rien y écrire ; prend le verrou de la base', () => {
  const user = userBaseDir({ APPDATA: join(root, 'AppData', 'Roaming') })!;
  mkdirSync(user, { recursive: true });
  fixtureBase(user);
  const before = nodes(user);
  const r = addReading(user);
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toMatch(/est la base de l’utilisateur/);
  expect(nodes(user)).toBe(before);
  const app = join(root, 'copie');
  appBase(app);
  const refused = addReading(app);
  expect([refused.status, nodes(app)]).toEqual([1, 0]);
  expect(refused.stderr).toMatch(/n’est pas une base de test/);
  // A test base that Cirrus holds open (its lock): refused, untouched.
  const test = join(root, 'test');
  fixtureBase(test);
  const count = nodes(test), lock = lockBase(test)!;
  try {
    const held = addReading(test);
    expect(held.status, held.stderr).toBe(1);
    expect(held.stderr).toMatch(/ouverte par Cirrus/);
    expect(nodes(test)).toBe(count);
  } finally {
    lock.release();
  }
  // Free: its two nodes and its 50 annotations.
  const ok = addReading(test);
  expect(ok.status, ok.stderr).toBe(0);
  expect(nodes(test)).toBe(count + 52);
}, 120_000);

test('make-fixture.ts : ne bâtit pas une base de test à la place de celle de l’utilisateur', () => {
  const env = { APPDATA: join(root, 'AppData', 'Roaming') }, user = userBaseDir(env)!;
  expect([isUserBase(user, env), isUserBase(join(user, 'sous-dossier'), env), isUserBase(join(root, 'test'), env), isUserBase(user, {})]).toEqual([true, true, false, false]);
  const r = spawnSync(process.execPath, [MAKE_FIXTURE, user], { env: { ...process.env, ...env, INIT_CWD: root }, encoding: 'utf8', timeout: 60_000 });
  expect(r.status, r.stderr).toBe(1);
  expect(r.stderr).toMatch(/place de la base de l’utilisateur/);
  expect(existsSync(join(user, 'cirrus.db'))).toBe(false);
});
