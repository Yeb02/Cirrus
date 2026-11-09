import { existsSync, renameSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { LocalStore } from '@cirrus/store';
import { SERVER_FILE } from './config.ts';
import { messageOf } from './connection.ts';
import { DOWNLOADS_FILE } from './downloads.ts';
import { archiveName, pristine, READY_FILE, stagedDir } from './firstSync.ts';

// The start on a base taken from the server (plan 5a, task 5, D7, R17): staged by the last run (adopt.ts), it replaces
// the base before the base opens, the old one kept aside, or deleted when vierge. And how the app starts again on it
// (R27).

/**
 * Whether a base taken from the server makes the app only quit, instead of starting again on it (R27):
 * CIRRUS_NO_RELAUNCH=1, for the interface's checks (scripts/interface.mjs), which start the app again themselves in
 * their window out of the user's way. Taken only on a test base in such a window — CIRRUS_DATA, and `capture` mode or
 * CIRRUS_BACKGROUND=1 —, as CIRRUS_BIB_PICK; inert otherwise. It can only turn a relaunch into a quit.
 */
export function quitsInsteadOfRelaunch(env: Record<string, string | undefined>, capture: boolean): boolean {
  return env.CIRRUS_NO_RELAUNCH === '1' && env.CIRRUS_DATA !== undefined && (capture || env.CIRRUS_BACKGROUND === '1');
}

/**
 * Whether the base in `dir` is vierge (pristine), read at the swap, before anything opens it: its store opened, read,
 * closed. One that cannot be read (not a base, a newer schema) is not: it is kept aside, as before.
 */
function pristineAt(dir: string): boolean {
  let store: LocalStore;
  try {
    // The PC's identifier signs writes only: none is made here.
    store = LocalStore.open(dir, { pc: '' });
  } catch {
    return false;
  }
  try {
    return pristine(store, dir);
  } catch {
    return false;
  } finally {
    store.close();
  }
}

/** The errors of a folder another program holds a moment (the antivirus scanning it): its rename is tried again. */
const HELD = new Set(['EPERM', 'EBUSY', 'EACCES']);
/**
 * A folder's renames at most at the swap, and the pause before the next one, times the attempt: 150 ms, 300 ms…, about
 * 7 s in all, long enough for an antivirus to scan a base written seconds before. Fixed bounds, not settings (R21): the
 * swap runs before any base, hence any setting, is open.
 */
const SWAP_TRIES = 10;
const SWAP_PAUSE_MS = 150;

/** How the swap retries a rename; `rename`, the system's, given otherwise by a test only. */
interface SwapRetry { tries: number; pauseMs: number; rename?: (from: string, to: string) => void }
const SWAP_RETRY: SwapRetry = { tries: SWAP_TRIES, pauseMs: SWAP_PAUSE_MS };

function rename(from: string, to: string, retry: SwapRetry): void {
  for (let attempt = 1; ; attempt++) {
    try {
      (retry.rename ?? renameSync)(from, to);
      return;
    } catch (e) {
      if (attempt >= retry.tries || !HELD.has((e as NodeJS.ErrnoException).code ?? '')) throw e;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, retry.pauseMs * attempt);
    }
  }
}

/** `path`, or `path (2)`, `path (3)`… : the first not taken. */
function freeName(path: string): string {
  if (!existsSync(path)) return path;
  for (let i = 2; ; i++) if (!existsSync(`${path} (${i})`)) return `${path} (${i})`;
}

const RELAUNCH = 'Ferme ce qui la tient ouverte (l’antivirus, l’explorateur), puis relance Cirrus.';

/**
 * At the start, before the base opens and nothing holds its folder (R17): a base taken from the server and staged by
 * the last run replaces it — the old one renamed `<base>-avant-jumelage-AAAA-MM-JJ` (« (2) », … when that name is
 * taken), without a list of downloads to do nor a server; one that is not complete (no mark: an interrupted adopt) is
 * removed. Costs one stat when there is none. A folder that holds no base (an interruption between the two renames)
 * is not archived. Each rename retried (`retry`); the staged base refused its place, the old one is put back the same
 * way. A failure throws, in French, naming where each base is. A vierge old base (pristine, read here: a write made
 * while the server's base was downloaded counts) is set aside the same way, so that it comes back should the staged
 * one be refused its place, then deleted once that one holds it (after the short review of plan 5a, 2026-11-09).
 */
export function swapStaged(dir: string, day = new Date(), retry: SwapRetry = SWAP_RETRY): 'none' | 'dropped' | 'swapped' {
  const staged = stagedDir(dir);
  if (!existsSync(staged)) return 'none';
  if (!existsSync(join(staged, READY_FILE))) {
    rmSync(staged, { recursive: true, force: true });
    return 'dropped';
  }
  let archive: string | null = null, blank = false;
  if (existsSync(join(dir, 'cirrus.db'))) {
    blank = pristineAt(dir);
    archive = freeName(join(dirname(resolve(dir)), archiveName(dir, day)));
    try {
      rename(dir, archive, retry);
    } catch (e) {
      throw new Error(`La base de ce PC n’a pas pu être mise de côté (${messageOf(e)}) : la base prise du serveur attend dans « ${staged} ».`);
    }
  } else {
    rmSync(dir, { recursive: true, force: true });
  }
  try {
    rename(staged, dir, retry);
  } catch (e) {
    if (!archive) throw new Error(`La base prise du serveur n’a pas pu prendre sa place (${messageOf(e)}) : elle attend dans « ${staged} ». ${RELAUNCH}`);
    // The old base put back: it opens, and the staged one waits for the next start.
    try {
      rename(archive, dir, retry);
    } catch (back) {
      throw new Error(`La base prise du serveur n’a pas pu prendre sa place (${messageOf(e)}), ni celle de ce PC y revenir (${messageOf(back)}) : la base de ce PC est dans « ${archive} », celle du serveur attend dans « ${staged} ». ${RELAUNCH}`);
    }
    throw new Error(`La base prise du serveur n’a pas pu prendre sa place (${messageOf(e)}) : elle attend dans « ${staged} ».`);
  }
  if (archive && blank) {
    // Nothing of the user's in it: deleted, retried as a rename is. At best: one that resists stays aside, as any.
    try {
      rmSync(archive, { recursive: true, force: true, maxRetries: retry.tries, retryDelay: retry.pauseMs });
    } catch (e) {
      console.warn(`Base vierge de ce PC non effacée (${messageOf(e)}) : elle reste dans « ${archive} ».`);
    }
  } else if (archive) {
    for (const f of [DOWNLOADS_FILE, SERVER_FILE]) rmSync(join(archive, f), { force: true });
  }
  rmSync(join(dir, READY_FILE), { force: true });
  return 'swapped';
}

/**
 * The start's step before the base opens (index.ts): the swap (swapStaged), and what follows — the base opens, with
 * what to report in the console; or, when the swap failed and left no base at its place, the start stops with the
 * message, never opening a new empty base there (review of task 5, Important 2).
 */
export function startBase(dir: string, day = new Date(), retry: SwapRetry = SWAP_RETRY): { open: true; log: string | null } | { open: false; message: string } {
  try {
    const done = swapStaged(dir, day, retry);
    if (done === 'none') return { open: true, log: null };
    return { open: true, log: done === 'swapped' ? `Base prise du serveur installée : ${dir}.` : `Base prise du serveur incomplète (téléchargement interrompu) : effacée, ${dir} gardée.` };
  } catch (e) {
    if (existsSync(join(dir, 'cirrus.db'))) return { open: true, log: `Base prise du serveur non installée : ${messageOf(e)}` };
    return { open: false, message: messageOf(e) };
  }
}

/** Whether a base taken from the server, complete, waits beside this one (its swap failed at the start): one stat. */
export const stagedWaiting = (dir: string): boolean => existsSync(join(stagedDir(dir), READY_FILE));

/** What the interface says of a base that waits (stagedWaiting). */
export const waitingMessage = (dir: string): string =>
  `Une base prise du serveur attend dans « ${stagedDir(dir)} » : elle n’a pas pu prendre la place de celle-ci au démarrage. ${RELAUNCH}`;
