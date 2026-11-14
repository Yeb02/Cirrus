import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { type Consultation, type Id, parseConsultations, SEEN_KINDS, type SentConsultation } from '@cirrus/core';

/** The consultations' file (plan 6a, D6), in the base's folder and no part of it. */
export const CONSULTATIONS_FILE = 'consultations.db';

/** A row of `events` as pending reads it: its rowid as its seq, its absent fields NULL. */
interface EventRow { seq: number; at: number; kind: string; subject: string | null; plan: string | null; detail: string | null }

/** The kinds that say an object was looked at, as SQL reads them (SEEN_KINDS: the core's, the server's too). */
const SEEN_IN = `kind IN (${SEEN_KINDS.map((k) => `'${k}'`).join(', ')})`;

/**
 * The consultations' file of this PC (plan 6a, D6): a plain database beside the base, with one table, `events`, and an
 * index on its time. Opened on the first write (`open` touches no disk), in WAL with synchronous = NORMAL, the base's own
 * way; each batch goes in one transaction. Never part of the base's schema, the sync or the snapshot: the sync's swap of
 * a base moves it to the new one (swap.ts). A batch the file refuses — locked by another program, damaged, the disk full
 * or the folder gone — is dropped with one warning, said again only after a write succeeded: nothing is visible, the
 * app goes on, and a file that stays damaged does not flood the console. The file is never replaced nor repaired.
 *
 * Its events go to the server (plan 6b, D7: the sync client's), each numbered by its rowid — `events` has no key of its
 * own, nothing deletes from it, so the rowid grows —, this PC's alone. A second table, `sent (base, upto)`, keeps the
 * last number the server of each base (its baseId) has said it holds. Reading touches no disk either while the file is
 * absent: nothing recorded, nothing to send.
 */
export class Consultations {
  private readonly dir: string;
  private readonly pc: string;
  private db: DatabaseSync | null = null;
  private insert: StatementSync | null = null;
  /** The warnings said since the last write that succeeded: a batch the page should not have sent, and a file that failed. */
  private readonly warned = { batch: false, file: false };
  private constructor(dir: string, pc: string) {
    this.dir = dir;
    this.pc = pc;
  }

  static open(dir: string, pc: string): Consultations {
    return new Consultations(dir, pc);
  }

  /**
   * The batch from the interface (checked, parseConsultations), written in one transaction. Never throws. A batch refused by
   * the check says so; the file is fine and its connection stays. A file that fails (locked, damaged, full, its folder gone)
   * says so, and its connection is let go: the next batch opens it again, mended perhaps. Each is said once until a write
   * succeeds.
   */
  write(batch: unknown): void {
    let events: Consultation[];
    try {
      events = parseConsultations(batch);
    } catch (err) {
      this.warn('batch', err);
      return;
    }
    if (events.length === 0) return;
    try {
      const db = this.handle(), insert = this.insert!;
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const e of events) insert.run(e.at, this.pc, e.kind, e.subject ?? null, e.plan ?? null, e.detail ?? null);
        db.exec('COMMIT');
      } catch (err) {
        try {
          db.exec('ROLLBACK');
        } catch {
          // the connection is let go below
        }
        throw err;
      }
      this.warned.batch = this.warned.file = false;
    } catch (err) {
      this.release();
      this.warn('file', err);
    }
  }

  private warn(which: keyof Consultations['warned'], err: unknown): void {
    if (this.warned[which]) return;
    this.warned[which] = true;
    console.warn(`Consultations non enregistrées : ${err instanceof Error ? err.message : String(err)}`);
  }

  /**
   * This PC's events after number `after`, in order, `max` at most, as the server takes them (SentConsultation: its
   * absent fields absent). A row another PC wrote (a folder brought from another machine) is never among them: the
   * server keys a PC's rows by its token's PC. Throws when the file cannot be read.
   */
  pending(after: number, max: number): SentConsultation[] {
    const rows = this.read((db) => db.prepare('SELECT rowid AS seq, at, kind, subject, plan, detail FROM events WHERE rowid > ? AND pc = ? ORDER BY rowid LIMIT ?')
      .all(after, this.pc, Math.max(0, Math.floor(max))) as unknown as EventRow[], []);
    return rows.map((r) => {
      const e: SentConsultation = { seq: r.seq, at: r.at, kind: r.kind as Consultation['kind'] };
      if (r.subject !== null) e.subject = r.subject;
      if (r.plan !== null) e.plan = r.plan;
      if (r.detail !== null) e.detail = r.detail;
      return e;
    });
  }

  /** The last number the server of base `base` said it holds of this PC's events; null when none has been heard of. Throws when the file cannot be read. */
  sentUpto(base: string): number | null {
    return this.read((db) => (db.prepare('SELECT upto FROM sent WHERE base = ?').get(base) as { upto: number } | undefined)?.upto ?? null, null);
  }

  /** What the server of base `base` holds now (its answer's `upto`), kept for the next sending. Throws when the file cannot be written. */
  markSent(base: string, upto: number): void {
    this.use((db) => { db.prepare('INSERT INTO sent (base, upto) VALUES (?, ?) ON CONFLICT(base) DO UPDATE SET upto = excluded.upto').run(base, upto); });
  }

  /**
   * The last time each subject was looked at (SEEN_KINDS, a subject given) by the events after number `after`, every row
   * of the file — another PC's too: what this file holds was seen by its user. Never throws: a file that cannot be read
   * is said once, and reads as nothing.
   */
  localSeen(after: number): Map<Id, number> {
    try {
      const rows = this.read((db) => db.prepare(`SELECT subject, MAX(at) AS at FROM events WHERE rowid > ? AND subject IS NOT NULL AND ${SEEN_IN} GROUP BY subject`)
        .all(after) as unknown as { subject: string; at: number }[], []);
      return new Map(rows.map((r) => [r.subject, r.at]));
    } catch (e) {
      this.warn('file', e);
      return new Map();
    }
  }

  /** `fn` on the file, opened if need be; a failure lets its connection go (the next use opens it again) and is thrown. */
  private use<T>(fn: (db: DatabaseSync) => T): T {
    try {
      return fn(this.handle());
    } catch (e) {
      this.release();
      throw e;
    }
  }

  /** As use, but `none` without opening the file when it does not exist: nothing was ever recorded. */
  private read<T>(fn: (db: DatabaseSync) => T, none: T): T {
    if (!this.db && !existsSync(join(this.dir, CONSULTATIONS_FILE))) return none;
    return this.use(fn);
  }

  /** Lets the file go (the app is quitting); a write after it opens the file again. */
  close(): void {
    this.release();
  }

  private handle(): DatabaseSync {
    if (this.db) return this.db;
    // No wait for a lock: this process is the only one that writes it, and its main thread never sleeps on a file.
    const db = new DatabaseSync(join(this.dir, CONSULTATIONS_FILE), { timeout: 0 });
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
      db.exec(`
        CREATE TABLE IF NOT EXISTS events (at INTEGER NOT NULL, pc TEXT NOT NULL, kind TEXT NOT NULL, subject TEXT, plan TEXT, detail TEXT);
        CREATE INDEX IF NOT EXISTS events_at ON events (at);
        CREATE TABLE IF NOT EXISTS sent (base TEXT PRIMARY KEY, upto INTEGER NOT NULL);
      `);
      this.insert = db.prepare('INSERT INTO events (at, pc, kind, subject, plan, detail) VALUES (?, ?, ?, ?, ?, ?)');
    } catch (err) {
      try {
        db.close();
      } catch {
        // the first error is the one said
      }
      throw err;
    }
    return (this.db = db);
  }

  private release(): void {
    const db = this.db;
    this.db = null;
    this.insert = null;
    try {
      db?.close();
    } catch {
      // nothing to do for a file that will not close
    }
  }
}
