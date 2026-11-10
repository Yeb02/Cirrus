import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MAX_ID_CHARS } from '@cirrus/core';
import { CONSULTATION_KINDS, type Consultation, MAX_CONSULTATION_BATCH, MAX_DETAIL_CHARS } from '../renderer/consultations.ts';

/** The consultations' file (plan 6a, D6), in the base's folder and no part of it. */
export const CONSULTATIONS_FILE = 'consultations.db';

const KINDS: ReadonlySet<string> = new Set(CONSULTATION_KINDS);
const FIELDS: ReadonlySet<string> = new Set(['at', 'kind', 'subject', 'plan', 'detail']);

/** An identifier, as a field of an event: text of 1 to MAX_ID_CHARS characters, or absent. */
function idField(x: unknown, what: string): string | undefined {
  if (x === undefined) return undefined;
  if (typeof x !== 'string' || x.length === 0 || x.length > MAX_ID_CHARS) throw new Error(`${what} n’est pas un identifiant`);
  return x;
}

/**
 * A batch from the interface, checked whole before anything is written: an array of at most MAX_CONSULTATION_BATCH
 * events, each a plain object of the fields at, kind, subject, plan and detail alone (the PC is this process's to say),
 * a known kind, an integer time, identifiers within MAX_ID_CHARS, a detail within MAX_DETAIL_CHARS. One event out of
 * line refuses the batch: a page that sends one is not the page that was built. Throws, in French, saying what.
 */
export function parseConsultations(batch: unknown): Consultation[] {
  if (!Array.isArray(batch)) throw new Error('le lot n’est pas un tableau');
  if (batch.length > MAX_CONSULTATION_BATCH) throw new Error(`le lot compte plus de ${MAX_CONSULTATION_BATCH} événements`);
  return batch.map((x: unknown, i): Consultation => {
    try {
      if (x === null || typeof x !== 'object' || Array.isArray(x)) throw new Error('pas un objet');
      for (const key of Object.keys(x)) if (!FIELDS.has(key)) throw new Error(`le champ « ${key.slice(0, 40)} » est inconnu`);
      const e = x as Record<string, unknown>;
      if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) throw new Error('genre inconnu');
      if (typeof e.at !== 'number' || !Number.isSafeInteger(e.at) || e.at < 0) throw new Error('l’heure n’est pas un entier positif');
      if (e.detail !== undefined && (typeof e.detail !== 'string' || e.detail.length > MAX_DETAIL_CHARS)) throw new Error(`le détail n’est pas un texte de ${MAX_DETAIL_CHARS} caractères au plus`);
      const out: Consultation = { at: e.at, kind: e.kind as Consultation['kind'] };
      const subject = idField(e.subject, 'le sujet'), plan = idField(e.plan, 'le plan');
      if (subject !== undefined) out.subject = subject;
      if (plan !== undefined) out.plan = plan;
      if (e.detail !== undefined) out.detail = e.detail as string;
      return out;
    } catch (err) {
      throw new Error(`événement ${i} : ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

/**
 * The consultations' file of this PC (plan 6a, D6): a plain database beside the base, with one table, `events`, and an
 * index on its time. Opened on the first write (`open` touches no disk), in WAL with synchronous = NORMAL, the base's own
 * way; each batch goes in one transaction. Never part of the base's schema, the sync or the snapshot: the sync's swap of
 * a base moves it to the new one (swap.ts). A batch the file refuses — locked by another program, damaged, the disk full
 * or the folder gone — is dropped with one warning, said again only after a write succeeded: nothing is visible, the
 * app goes on, and a file that stays damaged does not flood the console. The file is never replaced nor repaired.
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
