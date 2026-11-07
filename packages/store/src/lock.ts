import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/** The lock file in a base's folder: an empty SQLite database, only ever locked (I3 of the final review). */
export const LOCK_FILE = 'cirrus.lock';

/** SQLite's « database is locked » (SQLITE_BUSY), its extended codes included. */
const SQLITE_BUSY = 5;

/**
 * Takes the base's lock, one instance per base (I3 of the final review): two instances on one base would each save a
 * snapshot that misses the other's actions. The lock is a system file lock, held through an exclusive transaction kept
 * open on `cirrus.lock` in the base's folder, never written; the system frees it when the process ends, a crash
 * included, so no stale lock is ever left. Returns null when another process (or another call) holds it. The handle
 * must stay referenced as long as the base is open: collected, its database is closed and the lock let go. `cirrus.db`
 * is not touched: its own locking and journal stay the store's. Here since the final review of plan 4c (M6): the
 * scripts that write into a test base take it too (fixtures/scripts/add-reading.ts), as the app does.
 */
export function lockBase(dir: string): { release(): void } | null {
  mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(join(dir, LOCK_FILE), { timeout: 0 });
  try {
    // No journal file next to it: nothing is ever written.
    db.exec('PRAGMA journal_mode = MEMORY');
    db.exec('BEGIN EXCLUSIVE');
  } catch (e) {
    db.close();
    if (((e as { errcode?: number }).errcode ?? 0) % 256 === SQLITE_BUSY) return null;
    throw e;
  }
  return { release: () => { if (db.isOpen) db.close(); } };
}
