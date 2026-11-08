import { existsSync } from 'node:fs';
import {
  addedViolation, applyOps, decodeState, encodeState, invertOp, type Op, OpConflictError, parseUnit, type RemoteUnit, SNAPSHOT_VERSION, type State,
  SyncFormatError, type Unit, type UnitResult,
} from '@cirrus/core';
import { type ChangeRow, filePath, LocalStore } from '@cirrus/store';
import { MAX_JOURNAL_PAGE, SERVER_SNAPSHOT_UNITS } from './bounds.ts';

// The reference base (plan 5a, D1): a base in a PC's format, numbered — each line's server number is its journal
// number — and its state in memory, against which each write is checked as a command is.

/** The PC the server's base calls itself (its own lines would carry it; it writes none, each write keeps its PC's). */
const SERVER_PC = 'serveur';

/** A write signed by another PC than the one of the token that sent it: the request is refused (403). */
export class ForbiddenError extends Error {}

/**
 * The state of the base at its start: its snapshot and the journal after it, each operation checked (applyOps), as
 * the app opens its own (session.ts, openState); without a usable snapshot, from the tables (an unusable one dropped).
 * `snapshotSeq`: the number the snapshot covers (−1: none served).
 */
function load(store: LocalStore): { s: State; snapshotSeq: number } {
  const snap = store.readSnapshot();
  if (snap && snap.version === SNAPSHOT_VERSION) {
    try {
      const s = decodeState(snap.data);
      applyOps(s, store.changesSince(snap.seq).map((r) => r.op));
      return { s, snapshotSeq: snap.seq };
    } catch (e) {
      console.warn(`Instantané du serveur inutilisable (${e instanceof Error ? e.message : String(e)}) : l’état est relu des tables.`);
    }
  }
  if (snap) store.dropSnapshot();
  return { s: store.loadState(), snapshotSeq: -1 };
}

export class Canon {
  private readonly store: LocalStore;
  private readonly dir: string;
  /** Replaced once only, by a seed (task 5). */
  private s: State;
  private readonly relay: (u: RemoteUnit) => void;
  /** The server's last number: its journal's last line. */
  private last: number;
  /** The number the stored snapshot covers (−1: none usable). */
  private snapshotSeq: number;
  private sinceSnapshot = 0;

  private constructor(dir: string, store: LocalStore, relay: (u: RemoteUnit) => void) {
    this.dir = dir;
    this.store = store;
    this.relay = relay;
    const { s, snapshotSeq } = load(store);
    this.s = s;
    this.last = store.lastSeq();
    this.snapshotSeq = snapshotSeq;
  }

  /** The base in `dir` (created if absent) and its state; `relay` gets each write accepted, numbered (the event streams). */
  static open(dir: string, relay: (u: RemoteUnit) => void): Canon {
    const store = LocalStore.open(dir, { pc: SERVER_PC, durable: true });
    try {
      return new Canon(dir, store, relay);
    } catch (e) {
      store.close();
      throw e;
    }
  }

  /** The server's last number (0: nothing accepted yet). */
  get seq(): number {
    return this.last;
  }

  /** The state, read only: GET /snapshot encodes it. */
  get state(): State {
    return this.s;
  }

  /** The base, for what reads its journal (the event streams, GET /journal). */
  get base(): LocalStore {
    return this.store;
  }

  /** Empty in the sense of D7: no node, no connection, no placement, no plan but a lobby. */
  empty(): boolean {
    const s = this.s;
    if (s.nodes.size > 0 || s.connections.size > 0 || s.placements.size > 0) return false;
    for (const p of s.plans.values()) if (p.type !== 'lobby') return false;
    return true;
  }

  /**
   * Holding no base yet (task 5, D7, R7): no write accepted and an empty state. Only such a server takes a PC's base
   * whole (a seed), or an empty PC's lobby as its first write. A seeded base whose journal was empty (one built in bulk,
   * as the bench's) leaves it with no write, but not empty.
   */
  fresh(): boolean {
    return this.last === 0 && this.empty();
  }

  /**
   * A PC's base taken whole by this fresh server (task 5, D7: POST /seed/done, every input checked by Seeds.take): its
   * journal, each line numbered as this server numbers its own (server_seq = local_seq), and its state, written in one
   * transaction; then the state in memory replaced, and the numbering goes on after its last line. A failure writes
   * nothing and keeps the state.
   */
  seed(s: State, last: number, lines: (after: number, limit: number) => ChangeRow[]): void {
    if (!this.fresh()) throw new Error('Ce serveur tient déjà une base.');
    this.store.atomically(() => {
      for (let after = 0; after < last; ) {
        const page = lines(after, MAX_JOURNAL_PAGE);
        if (page.length === 0) throw new Error(`Journal de la base reçue incomplet : il s’arrête à la ligne ${after} sur ${last}.`);
        this.store.importJournal(page);
        after = page.at(-1)!.localSeq;
      }
      this.store.importState(s, last);
    });
    this.s = s;
    this.last = last;
    this.snapshotSeq = last;
    this.sinceSnapshot = 0;
  }

  /**
   * One write a PC sends, `pc` the PC of its token, in this order (plan 5a, task 2):
   * 1. its shape (parseUnit): refused otherwise;
   * 2. signed by `pc`: ForbiddenError otherwise (403);
   * 3. a write accepted already (its answer lost, D5): accepted with its number, nothing applied again;
   * 4. every file it adds to a node, and every anchor's PDF, in the server's store: refused otherwise (D6);
   * 5. applied to the state, each "before" checked (applyOps): stale otherwise, with the number to have received first;
   * 6. no violation added (addedViolation): refused otherwise, the state put back;
   * 7. written to the base, numbered, with the time, PC and identifiers received (a failure puts the state back, and is thrown);
   * 8. relayed to every open stream.
   * Costs what its operations touch, never the size of the base (a snapshot aside, every SERVER_SNAPSHOT_UNITS writes).
   */
  accept(x: unknown, pc: string): UnitResult {
    let u: Unit;
    try {
      u = parseUnit(x);
    } catch (e) {
      if (e instanceof SyncFormatError) return { refused: e.message };
      throw e;
    }
    if (u.pc !== pc) throw new ForbiddenError('Écriture signée d’un autre PC que celui du jeton : la requête est refusée.');
    const known = this.store.numberedUnit(u.unit);
    if (known) return known.pc === pc ? { accepted: known.seq } : { refused: 'Cet identifiant d’écriture est déjà celui d’une écriture d’un autre PC.' };
    if (this.missingFile(u.ops)) return { refused: 'Fichier manquant au serveur.' };
    try {
      applyOps(this.s, u.ops);
    } catch (e) {
      if (e instanceof OpConflictError) return { stale: this.last };
      // Not a "before" that no longer holds: a write that can never apply (applyOps has left the state as it was).
      return { refused: e instanceof Error ? e.message : String(e) };
    }
    const v = addedViolation(this.s, u.ops);
    if (v) {
      this.undo(u.ops);
      return { refused: v.message };
    }
    let seq: number;
    try {
      seq = this.store.commit({ id: u.action, label: u.label, ops: u.ops }, { at: u.at, unit: u.unit, pc: u.pc, numbered: true });
    } catch (e) {
      // The tables do not follow the state: nothing written, the state put back, and the request fails (500).
      this.undo(u.ops);
      throw e;
    }
    this.last = seq;
    this.relay({ ...u, seq });
    if (++this.sinceSnapshot >= SERVER_SNAPSHOT_UNITS) this.snapshot();
    return { accepted: seq };
  }

  /** Whether `ops` add to a node a file, or an anchor's PDF, that the server's store does not have (one the "before" had is there). */
  private missingFile(ops: readonly Op[]): boolean {
    for (const op of ops) {
      if (op.t !== 'node' || !op.after) continue;
      const had = new Set(op.before?.files.map((f) => f.hash));
      if (op.before?.anchor) had.add(op.before.anchor.hash);
      const hashes = op.after.files.map((f) => f.hash);
      if (op.after.anchor) hashes.push(op.after.anchor.hash);
      for (const hash of hashes) if (!had.has(hash) && !existsSync(filePath(this.dir, { name: '', hash, size: 0 }))) return true;
    }
    return false;
  }

  /** Takes `ops`, just applied, back out of the state, the last first. */
  private undo(ops: readonly Op[]): void {
    applyOps(this.s, [...ops].reverse().map(invertOp));
  }

  /** Keeps the state's snapshot, covering the journal up to now; a failure is only reported: the tables have everything. */
  private snapshot(): void {
    this.sinceSnapshot = 0;
    try {
      this.store.writeSnapshot(encodeState(this.s), this.last);
      this.snapshotSeq = this.last;
    } catch (e) {
      console.warn(`Instantané du serveur non enregistré : ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The snapshot kept when it does not cover the journal's end, then the base closed. */
  close(): void {
    if (this.last !== this.snapshotSeq) this.snapshot();
    this.store.close();
  }
}
