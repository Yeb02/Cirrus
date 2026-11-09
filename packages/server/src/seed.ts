import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { applyOps, checkState, decodeState, isObject, type State, SyncFormatError } from '@cirrus/core';
import { type ChangeRow, parseChangeRow } from '@cirrus/store';
import { MAX_JOURNAL_PAGE, MAX_SEED_BYTES } from './bounds.ts';

// The seed of an empty server (plan 5a, task 5, D7, R16): a PC sends its base — its snapshot, streamed into a
// temporary file and never held whole in memory while it arrives, then its journal by pages, kept in a staging
// database —, and `done` hands it to the canon whole. Until then the server's journal stays empty: a partial seed is
// invisible. The last PC to start a seed owns it: a new start drops the one under way, so no lock is ever stranded by a
// PC that crashed. Everything lives in `<data>/seed/<attempt>/`, removed once taken or dropped, and at each start.

/** A refused step of a seed: its HTTP status (400 malformed, 409 not the owner, 413 too large) and its reason in French. */
export class SeedError extends Error {
  readonly status: 400 | 409 | 413;

  constructor(status: 400 | 409 | 413, message: string) {
    super(message);
    this.status = status;
  }
}

/** The seeding PC's own steps, after another PC started one. */
const NOT_OWNER = 'Un autre PC a commencé d’envoyer sa base au serveur depuis : celle-ci n’est plus attendue.';

interface Attempt {
  /** The token that started it. */
  tokenHash: string;
  dir: string;
  /** The journal line the snapshot covers. */
  seq: number;
  /** The journal lines received, 1 to `rows`. */
  rows: number;
  /** The staging database of the lines received, once the snapshot is there. */
  journal: DatabaseSync | null;
}

/**
 * A line of a seeding PC's journal, checked whole (parseChangeRow: its operation as parseOp checks a write's), as the
 * server keeps it: numbered by itself (server_seq = local_seq, R6) whatever number an earlier server gave it.
 * `expected`: the journal number it must have. `history` (R32): a line the snapshot covers, which the PC's app may have
 * written before today's content bounds — its shape checked, not those bounds; a line after it is replayed on the
 * snapshot as a write is applied, and keeps the whole check.
 */
function seedRow(x: unknown, expected: number, history: boolean): ChangeRow {
  try {
    return { ...parseChangeRow(x, expected, history), serverSeq: expected };
  } catch (e) {
    if (e instanceof SyncFormatError) throw new SeedError(400, `Ligne ${expected} du journal de ce PC : ${e.message}`);
    throw e;
  }
}

/** A whole base, as `done` hands it to the canon: its state, its last journal line, its lines by pages. */
export interface Seeded { state: State; last: number; lines(after: number, limit: number): ChangeRow[] }

export class Seeds {
  private readonly root: string;
  private current: Attempt | null = null;

  /** The seeds of `root` (`<data>/seed`): what a former run left there is removed (its owner is gone with it). */
  constructor(root: string) {
    this.root = root;
    rmSync(root, { recursive: true, force: true });
  }

  /**
   * POST /seed: the seed under way, if any, dropped, and a new one owned by `tokenHash` (R16), its snapshot — covering
   * the journal up to `seq` — streamed into its file, MAX_SEED_BYTES at most. Another start during the upload drops this
   * one: 409 at its end.
   */
  async begin(tokenHash: string, body: AsyncIterable<Uint8Array>, seq: number): Promise<void> {
    this.drop();
    const a: Attempt = { tokenHash, dir: join(this.root, randomBytes(8).toString('hex')), seq, rows: 0, journal: null };
    this.current = a;
    mkdirSync(a.dir, { recursive: true });
    const out = await open(join(a.dir, 'snapshot'), 'w');
    let size = 0;
    try {
      for await (const chunk of body) {
        size += chunk.length;
        if (size > MAX_SEED_BYTES) throw new SeedError(413, `Instantané trop gros : ${MAX_SEED_BYTES} octets au plus.`);
        for (let at = 0; at < chunk.length; ) at += (await out.write(chunk, at, chunk.length - at)).bytesWritten;
      }
    } catch (e) {
      await out.close();
      this.dropAttempt(a);
      throw e;
    }
    await out.close();
    if (this.current !== a) {
      this.dropAttempt(a);
      throw new SeedError(409, NOT_OWNER);
    }
    a.journal = new DatabaseSync(join(a.dir, 'journal.db'));
    a.journal.exec('PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF; CREATE TABLE lines (local_seq INTEGER PRIMARY KEY, json TEXT NOT NULL);');
  }

  /** The seed `tokenHash` owns, with its snapshot received; 409 otherwise (another PC's, or none). */
  owned(tokenHash: string): Attempt & { journal: DatabaseSync } {
    const a = this.current;
    if (!a || a.tokenHash !== tokenHash) throw new SeedError(409, a ? NOT_OWNER : 'Aucun envoi de base n’est en cours : l’instantané d’abord (POST /seed).');
    if (!a.journal) throw new SeedError(409, 'L’instantané de cette base n’est pas encore arrivé.');
    return a as Attempt & { journal: DatabaseSync };
  }

  /**
   * POST /seed/journal: a page of the owner's journal, `{ rows }`, MAX_JOURNAL_PAGE lines at most, following the last
   * one received (the first from line 1), each checked whole before any is kept. The lines received so far.
   */
  page(tokenHash: string, body: unknown): number {
    const a = this.owned(tokenHash);
    if (!isObject(body) || !Array.isArray(body.rows)) throw new SeedError(400, 'Corps attendu : { rows: [...] }.');
    if (body.rows.length > MAX_JOURNAL_PAGE) throw new SeedError(400, `Au plus ${MAX_JOURNAL_PAGE} lignes par page.`);
    const rows = (body.rows as unknown[]).map((x, i) => seedRow(x, a.rows + i + 1, a.rows + i + 1 <= a.seq));
    const insert = a.journal.prepare('INSERT INTO lines (local_seq, json) VALUES (?, ?)');
    a.journal.exec('BEGIN');
    try {
      for (const r of rows) insert.run(r.localSeq, JSON.stringify(r));
      a.journal.exec('COMMIT');
    } catch (e) {
      a.journal.exec('ROLLBACK');
      throw e;
    }
    a.rows += rows.length;
    return a.rows;
  }

  /**
   * POST /seed/done, `{ last }`: the owner's base, once every line up to `last` came — its snapshot decoded (its
   * structure and checksum checked), the journal's lines after what it covers replayed on it, each "before" checked. A
   * base that fails these is refused (400) and dropped: the PC starts again. The rules of the graph it already breaks
   * are counted and reported, never refused (R19). Synchronous: no other request runs in between.
   */
  take(tokenHash: string, body: unknown): Seeded {
    const a = this.owned(tokenHash);
    const last = isObject(body) ? body.last : undefined;
    if (!Number.isSafeInteger(last) || (last as number) < 0) throw new SeedError(400, 'Corps attendu : { last }, la dernière ligne du journal envoyé.');
    if (last !== a.rows) throw new SeedError(400, `Le journal de ce PC n’est pas arrivé en entier : ${a.rows} lignes reçues sur ${String(last)}.`);
    const refuse = (message: string): never => {
      this.drop();
      throw new SeedError(400, message);
    };
    if (a.seq > a.rows) refuse(`L’instantané de ce PC couvre ${a.seq} lignes, son journal n’en a que ${a.rows}.`);
    const lines = (after: number, limit: number): ChangeRow[] =>
      (a.journal.prepare('SELECT json FROM lines WHERE local_seq > ? ORDER BY local_seq LIMIT ?').all(after, limit) as { json: string }[]).map((r) => JSON.parse(r.json) as ChangeRow);
    let state: State;
    try {
      const file = readFileSync(join(a.dir, 'snapshot'));
      state = decodeState(file.byteOffset === 0 && file.byteLength === file.buffer.byteLength ? file.buffer as ArrayBuffer : file.buffer.slice(file.byteOffset, file.byteOffset + file.byteLength) as ArrayBuffer);
    } catch (e) {
      return refuse(`Instantané de ce PC illisible : ${e instanceof Error ? e.message : String(e)}`);
    }
    try {
      for (let after = a.seq; ; ) {
        const page = lines(after, MAX_JOURNAL_PAGE);
        if (page.length === 0) break;
        applyOps(state, page.map((r) => r.op));
        after = page.at(-1)!.localSeq;
      }
    } catch (e) {
      return refuse(`Le journal de ce PC ne suit pas son instantané : ${e instanceof Error ? e.message : String(e)}`);
    }
    // R19: what the PC's base already carries is not refused (as addedViolation tolerates a violation already there);
    // counted and reported. Every write after this one is checked as usual.
    const broken = checkState(state);
    if (broken.length > 0) {
      console.warn(`Base reçue avec ${broken.length} violation${broken.length > 1 ? 's' : ''} des règles du graphe, déjà dans la base du PC (la première : ${broken[0].message}) : gardée telle quelle.`);
    }
    return { state, last: a.rows, lines };
  }

  /** The seed under way dropped (another start, a revoked token: only `tokenHash`'s then), its files removed. */
  drop(tokenHash?: string): void {
    const a = this.current;
    if (!a || (tokenHash !== undefined && a.tokenHash !== tokenHash)) return;
    this.dropAttempt(a);
  }

  private dropAttempt(a: Attempt): void {
    if (this.current === a) this.current = null;
    a.journal?.close();
    a.journal = null;
    // Its snapshot still being written by its own request: that one removes it when it ends.
    try {
      rmSync(a.dir, { recursive: true, force: true });
    } catch {
      // removed at the next start at the latest
    }
  }
}
