import { existsSync, realpathSync } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * The signature of a test base's journal (spec 6.2: each line names its PC): make-fixture.ts opens the base under it,
 * the app under the PC's identifier of pc.json, a uuidv7 — never this word.
 */
export const FIXTURE_PC = 'fixture';

/**
 * The user's own base, where the app keeps it: Electron's data folder of « @cirrus/app », then « base »
 * (main/base.ts's dataDir), so %APPDATA%\@cirrus\app\base on Windows; null without APPDATA (another system: the mark
 * of a test base alone then decides).
 */
export function userBaseDir(env: Record<string, string | undefined>): string | null {
  return env.APPDATA ? join(env.APPDATA, '@cirrus', 'app', 'base') : null;
}

/** A folder as the system names it (links and junctions followed), else as given, absolute. */
function canonical(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}
/** Windows compares paths without case. */
const folded = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);

/** Whether `dir` is the user's base (userBaseDir) or a folder inside it, whatever its case or the links on the way. */
export function isUserBase(dir: string, env: Record<string, string | undefined> = process.env): boolean {
  const user = userBaseDir(env);
  if (user === null) return false;
  const d = folded(canonical(dir)), u = folded(canonical(user));
  return d === u || d.startsWith(u.endsWith(sep) ? u : u + sep);
}

/**
 * Why a script that writes into a test base refuses `dir`, in French; null when it is one (final review of plan 4c,
 * M6: no script touches the user's base). Refused: the user's base (isUserBase), even holding a test base copied
 * there; a folder without a base; a base whose journal does not begin with a line signed FIXTURE_PC — one the app
 * made, or a copy of the user's —, read without writing. cirrus.db alone is no mark: the user's base has one too.
 */
export function testBaseRefusal(dir: string, env: Record<string, string | undefined> = process.env): string | null {
  if (isUserBase(dir, env)) return `${dir} est la base de l’utilisateur : ce script n’écrit que dans une base de test.`;
  const db = join(dir, 'cirrus.db');
  if (!existsSync(db)) return `${dir} ne contient pas de base (make-fixture.ts d’abord).`;
  let first: unknown;
  try {
    const read = new DatabaseSync(db, { readOnly: true });
    try {
      first = (read.prepare('SELECT pc FROM changes ORDER BY local_seq LIMIT 1').get() as { pc?: unknown } | undefined)?.pc;
    } finally {
      read.close();
    }
  } catch {
    first = undefined;
  }
  return first === FIXTURE_PC ? null : `${dir} n’est pas une base de test : son journal ne commence pas par les lignes de make-fixture.ts.`;
}
