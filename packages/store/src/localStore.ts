import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  type Action, canonical, checkRecord, type ConnectionLayout, type ConnectionRec, type Flow, flowOf, fromSnapshot, type Id, type NodeRec, type Op,
  OpConflictError, type PhantomRec, type Placement, type PlanRec, type PreambleRec, type Reconciliation, type RemoteUnit, snapshotVersion, type State,
  subjectOf, type TagKeyDef, type Unit, uuidv7,
} from '@cirrus/core';
import { migrate } from './schema.ts';

export { SCHEMA_VERSION } from './schema.ts';

/**
 * A journal line's kind (plan 5a, D5): local, an action of this PC (pending until the server numbers it); remote, one
 * received from the server; rewind, the inverse of a pending write a reconciliation undid, never sent.
 */
export type ChangeKind = 'local' | 'remote' | 'rewind';

export interface ChangeRow {
  localSeq: number;
  serverSeq: number | null;
  actionId: Id;
  label: string;
  flow: Flow;
  at: number;
  pc: string;
  subject: Id;
  op: Op;
  /** The write it belongs to: one call to commit, or one write received. */
  unit: Id;
  kind: ChangeKind;
  /** A local line a reconciliation replaced by its replayed version, or dropped (« écartée »). */
  superseded: boolean;
}

/** The base's snapshot of the state (plan 3c, decision 4): its bytes, the last journal line it covers, its format. */
export interface StoredSnapshot { data: ArrayBuffer; seq: number; version: number }

interface ChangeDbRow {
  local_seq: number; server_seq: number | null; action_id: string; label: string; flow: string; at: number; pc: string; subject: string; op: string; unit: string;
  kind: string; superseded: number;
}
const toRow = (r: ChangeDbRow): ChangeRow => ({
  localSeq: r.local_seq, serverSeq: r.server_seq, actionId: r.action_id, label: r.label, flow: r.flow as Flow, at: r.at, pc: r.pc, subject: r.subject,
  op: JSON.parse(r.op) as Op, unit: r.unit, kind: r.kind as ChangeKind, superseded: r.superseded !== 0,
});

/** Who wrote a group of journal lines: their write, action, label, time, PC and kind; the server's number of the first, if any. */
interface Lines { unit: Id; action: Id; label: string; at: number; pc: string; kind: ChangeKind; serverSeq: number | null }

/** The pending lines: this PC's, not numbered by the server, not replaced (the partial index changes_pending). */
const PENDING = "kind = 'local' AND server_seq IS NULL AND superseded = 0";

type Query = (sql: string) => StatementSync;

/** The state tables, loaded in bulk and indexed once (fromSnapshot). */
function loadState(db: DatabaseSync): State {
  const json = <T>(sql: string) => (db.prepare(sql).all() as { json: string }[]).map((r) => JSON.parse(r.json) as T);
  return fromSnapshot({
    nodes: json<NodeRec>('SELECT json FROM nodes'), connections: json<ConnectionRec>('SELECT json FROM connections'),
    plans: json<PlanRec>('SELECT json FROM plans'), tagKeys: json<TagKeyDef>('SELECT json FROM tag_keys'),
    placements: json<Placement>('SELECT json FROM placements'), connLayouts: json<ConnectionLayout>('SELECT json FROM conn_layouts'),
    phantoms: json<PhantomRec>('SELECT json FROM phantoms'),
    branches: (db.prepare('SELECT plan, connection, node FROM branches').all() as { plan: string; connection: string; node: string }[])
      .map((b) => [b.plan, b.connection, b.node]),
    preamble: json<PreambleRec>('SELECT json FROM preamble WHERE id = 1')[0] ?? null,
  });
}

/**
 * A connection as the state keeps it (its columns): known fields only (checkRecord has refused what they cannot hold).
 * The tables then hold what the interface's copy holds.
 */
function storedConnection(c: ConnectionRec): ConnectionRec {
  const out: ConnectionRec = { id: c.id, kind: c.kind, title: c.title, relation: c.relation, tags: c.tags, members: c.members.map((m) => ({ node: m.node, role: m.role })) };
  if (c.trashedAt !== undefined) out.trashedAt = c.trashedAt;
  return out;
}

/** The row an operation's record lives in: its table's statement and key, and how a conflict names it. */
function rowOf(op: Exclude<Op, { t: 'branch' }>): { sql: string; key: string[]; what: string } {
  const rec = op.after ?? op.before;
  if (!rec) throw new Error(`empty ${op.t} operation`);
  switch (op.t) {
    case 'node': return { sql: 'SELECT json FROM nodes WHERE id = ?', key: [(rec as NodeRec).id], what: `Le nœud « ${(rec as NodeRec).title} »` };
    case 'connection': return { sql: 'SELECT json FROM connections WHERE id = ?', key: [(rec as ConnectionRec).id], what: 'La connexion' };
    case 'plan': return { sql: 'SELECT json FROM plans WHERE id = ?', key: [(rec as PlanRec).id], what: `Le plan « ${(rec as PlanRec).name} »` };
    case 'tagKey': return { sql: 'SELECT json FROM tag_keys WHERE key = ?', key: [(rec as TagKeyDef).key], what: `Le tag « ${(rec as TagKeyDef).key} »` };
    case 'placement': {
      const p = rec as Placement;
      return { sql: 'SELECT json FROM placements WHERE plan = ? AND node = ?', key: [p.plan, p.node], what: 'La position du nœud' };
    }
    case 'connLayout': {
      const l = rec as ConnectionLayout;
      return { sql: 'SELECT json FROM conn_layouts WHERE plan = ? AND connection = ?', key: [l.plan, l.connection], what: 'La forme de la connexion' };
    }
    case 'phantom': return { sql: 'SELECT json FROM phantoms WHERE id = ?', key: [(rec as PhantomRec).id], what: 'Le fantôme' };
    case 'preamble': return { sql: 'SELECT json FROM preamble WHERE id = 1', key: [], what: 'Le préambule' };
  }
}

/**
 * Checks an operation's "before" against what the base holds now, as applyOp checks it against the state: the row
 * read back and compared canonically (its text first: the same record serialises the same), a branch's presence.
 */
function checkBefore(q: Query, op: Op): void {
  if (op.t === 'branch') {
    const { plan, connection, node } = op.key;
    if ((q('SELECT 1 AS x FROM branches WHERE plan = ? AND connection = ? AND node = ?').get(plan, connection, node) !== undefined) !== op.before) {
      throw new OpConflictError("La branche a changé depuis : l'opération ne s'applique plus.");
    }
    return;
  }
  const { sql, key, what } = rowOf(op);
  const json = (q(sql).get(...key) as { json: string } | undefined)?.json, before = op.before ?? null;
  if (json === undefined ? before === null : json === JSON.stringify(before) || canonical(JSON.parse(json)) === canonical(before)) return;
  throw new OpConflictError(`${what} a changé depuis : l'opération ne s'applique plus.`);
}

/** Writes one operation's "after" into the state tables (null deletes). */
function persistOp(q: Query, op: Op): void {
  const j = (v: unknown) => JSON.stringify(v);
  switch (op.t) {
    case 'node': {
      const id = (op.after ?? op.before)!.id;
      if (op.after) q('INSERT INTO nodes (id, json, trashed) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, trashed = excluded.trashed')
        .run(id, j(op.after), op.after.trashedAt === undefined ? 0 : 1);
      else q('DELETE FROM nodes WHERE id = ?').run(id);
      return;
    }
    case 'connection': {
      const id = (op.after ?? op.before)!.id;
      if (op.after) {
        const c = storedConnection(op.after);
        q('INSERT INTO connections (id, kind, json, trashed) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, json = excluded.json, trashed = excluded.trashed')
          .run(id, c.kind, j(c), c.trashedAt === undefined ? 0 : 1);
      } else q('DELETE FROM connections WHERE id = ?').run(id);
      return;
    }
    case 'plan': {
      const id = (op.after ?? op.before)!.id;
      if (op.after) q('INSERT INTO plans (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(id, j(op.after));
      else q('DELETE FROM plans WHERE id = ?').run(id);
      return;
    }
    case 'tagKey': {
      const key = (op.after ?? op.before)!.key;
      if (op.after) q('INSERT INTO tag_keys (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(key, j(op.after));
      else q('DELETE FROM tag_keys WHERE key = ?').run(key);
      return;
    }
    case 'placement': {
      const { plan, node } = (op.after ?? op.before)!;
      if (op.after) q('INSERT INTO placements (plan, node, json) VALUES (?, ?, ?) ON CONFLICT(plan, node) DO UPDATE SET json = excluded.json').run(plan, node, j(op.after));
      else q('DELETE FROM placements WHERE plan = ? AND node = ?').run(plan, node);
      return;
    }
    case 'branch': {
      const { plan, connection, node } = op.key;
      if (op.after) q('INSERT OR IGNORE INTO branches (plan, connection, node) VALUES (?, ?, ?)').run(plan, connection, node);
      else q('DELETE FROM branches WHERE plan = ? AND connection = ? AND node = ?').run(plan, connection, node);
      return;
    }
    case 'connLayout': {
      const { plan, connection } = (op.after ?? op.before)!;
      if (op.after) q('INSERT INTO conn_layouts (plan, connection, json) VALUES (?, ?, ?) ON CONFLICT(plan, connection) DO UPDATE SET json = excluded.json').run(plan, connection, j(op.after));
      else q('DELETE FROM conn_layouts WHERE plan = ? AND connection = ?').run(plan, connection);
      return;
    }
    case 'phantom': {
      const rec = (op.after ?? op.before)!;
      if (op.after) q('INSERT INTO phantoms (id, plan, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, json = excluded.json').run(rec.id, rec.plan, j(op.after));
      else q('DELETE FROM phantoms WHERE id = ?').run(rec.id);
      return;
    }
    case 'preamble': {
      if (op.after) q('INSERT INTO preamble (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(j(op.after));
      else q('DELETE FROM preamble WHERE id = 1').run();
      return;
    }
  }
}

/**
 * The PC's local copy (spec 6): current state in tables, every change in an append-only journal, and a binary snapshot
 * of the state (a cache of the tables), all in one SQLite file. It keeps no state in memory (plan 3c, decision 3): an
 * action is checked against the tables and written in one transaction, all or nothing.
 */
export class LocalStore {
  private readonly db: DatabaseSync;
  private readonly pc: string;
  private readonly statements = new Map<string, StatementSync>();
  /** Prepared once per statement. */
  private readonly q: Query = (sql) => {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  };

  private constructor(db: DatabaseSync, pc: string) {
    this.db = db;
    this.pc = pc;
  }

  /**
   * `durable`, for the server's base (plan 5a, task 2): each transaction synced to the disk before it returns, so that
   * a power cut never takes back a write the server numbered and relayed; a PC's base keeps NORMAL (a crash of the app
   * loses nothing, a power cut its last actions at most).
   */
  static open(dir: string, opts: { pc: string; durable?: boolean }): LocalStore {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'cirrus.db'));
    try {
      db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = ${opts.durable ? 'FULL' : 'NORMAL'};`);
      migrate(db);
    } catch (e) {
      // Not a base, or one that cannot be migrated: the file is not left open (the main process quits on this).
      db.close();
      throw e;
    }
    return new LocalStore(db, opts.pc);
  }

  /** The state built from the tables (the fallback path when there is no usable snapshot): built at each call, kept by no one here. */
  loadState(): State {
    return loadState(this.db);
  }

  /**
   * Writes an action in one transaction, as one write (unit) of this PC, pending: each operation's record checked as the
   * state checks it (checkRecord) and its "before" against the row it replaces, then its "after" written and its journal
   * line added. The first that fails throws (OpConflictError for a "before" that no longer matches) and nothing is
   * written (ROLLBACK). `opts`: the write's identifier (the interface's, plan 5a; uuidv7() otherwise), its time (now),
   * its PC (this one; the server writes each PC's own, task 2); `numbered`, for the server's base only (task 2): each
   * line takes its journal number as its server number, so that none is pending there and the journal it serves
   * carries its numbers. Returns the journal number of the action's last line.
   */
  commit(a: Action, opts: { at?: number; unit?: Id; pc?: string; numbered?: boolean } = {}): number {
    const lines: Lines = { unit: opts.unit ?? uuidv7(), action: a.id, label: a.label, at: opts.at ?? Date.now(), pc: opts.pc ?? this.pc, kind: 'local', serverSeq: null };
    const seq = this.transaction(() => {
      if (!opts.numbered) return this.write(a.ops, lines);
      const first = this.lastSeq() + 1, last = this.write(a.ops, { ...lines, serverSeq: first });
      // The journal only grows: its next line is its last one's plus one, which the numbers above took for granted.
      if (last >= 0 && last !== first + a.ops.length - 1) throw new Error(`Journal du serveur : la ligne ${last} n’est pas la ${first + a.ops.length - 1}.`);
      return last;
    });
    return seq < 0 ? this.lastSeq() : seq;
  }

  /**
   * A write the server numbered, found by its identifier (plan 5a, D5: the server knows a write it accepted already):
   * its number, its last line's, and its PC; null when no numbered line has this identifier.
   */
  numberedUnit(unit: Id): { seq: number; pc: string } | null {
    const row = this.q('SELECT MAX(server_seq) AS seq, pc FROM changes WHERE unit = ? AND server_seq IS NOT NULL').get(unit) as { seq: number | null; pc: string | null };
    return row.seq === null ? null : { seq: row.seq, pc: row.pc as string };
  }

  /**
   * The numbered writes after the server's number `after`, in order, each whole: a run of consecutive lines of one
   * write, numbered by its last line. At least `minLines` lines unless the journal ends first, then up to the end of the
   * write under way: the pages of the server's event stream (plan 5a, task 2). RangeError when `after` falls inside a
   * write.
   */
  unitsAfter(after: number, minLines: number): RemoteUnit[] {
    const rows = this.q('SELECT server_seq, unit, action_id, label, at, pc, op FROM changes WHERE server_seq >= ? ORDER BY server_seq').iterate(after) as Iterable<ChangeDbRow & { server_seq: number }>;
    const out: RemoteUnit[] = [];
    let lines = 0, previous: string | null = null;
    for (const r of rows) {
      // Line `after` itself: the write it ends must not go on.
      if (r.server_seq === after) { previous = r.unit; continue; }
      const last = out.at(-1);
      const goesOn = last ? last.unit === r.unit && last.seq === r.server_seq - 1 : previous === r.unit && r.server_seq === after + 1;
      if (goesOn && !last) throw new RangeError(`Le numéro ${after} tombe au milieu d’une écriture.`);
      if (!goesOn && lines >= minLines) break;
      const op = JSON.parse(r.op) as Op;
      if (last && goesOn) {
        last.ops.push(op);
        last.seq = r.server_seq;
      } else {
        out.push({ unit: r.unit, action: r.action_id, label: r.label, at: r.at, pc: r.pc, ops: [op], seq: r.server_seq });
      }
      lines++;
    }
    return out;
  }

  /**
   * Writes a reconciliation (plan 5a, D4 and D5) in one transaction, all or nothing, each "before" checked as commit
   * checks it: the acknowledged writes' lines take their server numbers; when pending writes were undone, their lines
   * are marked replaced and the inverses written (rewind); then each received write's lines, numbered (local when it is
   * this PC's own, accepted after others), and the replayed pending writes; last_server_seq with them, so that a crash
   * neither loses nor doubles anything. The server's numbers must follow last_server_seq without a gap or an overlap.
   * Returns the journal number of the last line.
   */
  applyReconciliation(r: Reconciliation): number {
    const q = this.q;
    this.transaction(() => {
      let next = this.lastServerSeq() + 1, i = 0;
      /** The server's number of a received write's first line, checked to follow the last one. */
      const firstOf = (u: RemoteUnit): number => {
        const first = u.seq - u.ops.length + 1;
        if (u.ops.length === 0 || first !== next) throw new Error(`Le serveur reprend au numéro ${first} ; ce PC attendait le ${next}.`);
        next = u.seq + 1;
        return first;
      };
      for (; i < r.acked.length; i++) {
        const u = r.remote[i];
        if (u?.unit !== r.acked[i]) throw new Error('Réconciliation incohérente : les écritures accusées ne sont pas en tête des reçues.');
        const first = firstOf(u), lines = q(`SELECT local_seq FROM changes WHERE unit = ? AND ${PENDING} ORDER BY local_seq`).all(u.unit) as { local_seq: number }[];
        if (lines.length !== u.ops.length) throw new OpConflictError(`L’écriture « ${u.label} » n’est plus en attente ici : la réconciliation ne s’applique plus.`);
        lines.forEach((l, j) => q('UPDATE changes SET server_seq = ? WHERE local_seq = ?').run(first + j, l.local_seq));
      }
      if (r.rewind.length > 0) {
        const replaced = Number(q(`UPDATE changes SET superseded = 1 WHERE ${PENDING}`).run().changes);
        if (replaced !== r.rewind.length) throw new OpConflictError('Les écritures en attente ont changé depuis : la réconciliation ne s’applique plus.');
        const id = uuidv7();
        this.write(r.rewind, { unit: id, action: id, label: 'Défaire les écritures en attente (synchronisation)', at: Date.now(), pc: this.pc, kind: 'rewind', serverSeq: null });
      }
      for (; i < r.remote.length; i++) {
        const u = r.remote[i];
        this.write(u.ops, { unit: u.unit, action: u.action, label: u.label, at: u.at, pc: u.pc, kind: u.pc === this.pc ? 'local' : 'remote', serverSeq: firstOf(u) });
      }
      if (r.rewind.length > 0) {
        for (const u of r.rebased) this.write(u.ops, { unit: u.unit, action: u.action, label: u.label, at: u.at, pc: u.pc, kind: 'local', serverSeq: null });
      }
      if (r.remote.length > 0) {
        q("INSERT INTO meta (key, value) VALUES ('last_server_seq', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(String(next - 1));
      }
    });
    return this.lastSeq();
  }

  /**
   * The pending writes (plan 5a): this PC's lines the server has not numbered and no reconciliation replaced, grouped by
   * write, in order; at most `limit` writes, for a batch to send only — a reconciliation undoes them all, so the
   * interface's list of them must be complete (applyReconciliation checks that it was).
   */
  pendingUnits(limit = Infinity): Unit[] {
    const units: Unit[] = [];
    const rows = this.q(`SELECT unit, action_id, label, at, pc, op FROM changes WHERE ${PENDING} ORDER BY local_seq`).iterate() as Iterable<ChangeDbRow>;
    for (const r of rows) {
      const last = units.at(-1), op = JSON.parse(r.op) as Op;
      if (last?.unit === r.unit) {
        last.ops.push(op);
        continue;
      }
      if (units.length >= limit) break;
      units.push({ unit: r.unit, action: r.action_id, label: r.label, at: r.at, pc: r.pc, ops: [op] });
    }
    return units;
  }

  /**
   * How many writes pendingUnits would give (a write: a run of consecutive pending lines of one identifier), counted on
   * the pending lines' index without reading their operations: the sync client's status (plan 5a, task 3).
   */
  pendingCount(): number {
    const sql = `SELECT COUNT(*) AS n FROM (SELECT unit, LAG(unit) OVER (ORDER BY local_seq) AS previous FROM changes WHERE ${PENDING}) WHERE previous IS NULL OR previous != unit`;
    return (this.q(sql).get() as { n: number }).n;
  }

  /** The server's number of the last line received (0: none yet): where its stream resumes. */
  lastServerSeq(): number {
    const row = this.q("SELECT value FROM meta WHERE key = 'last_server_seq'").get() as { value: string } | undefined;
    return row ? Number(row.value) : 0;
  }

  /** Checks and writes `ops` into the tables, one journal line each, inside the caller's transaction; the last line's number (−1: none). */
  private write(ops: readonly Op[], l: Lines): number {
    const q = this.q, insert = q('INSERT INTO changes (server_seq, action_id, label, flow, at, pc, subject, op, unit, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
    let seq = -1;
    ops.forEach((op, i) => {
      checkRecord(op);
      checkBefore(q, op);
      persistOp(q, op);
      seq = Number(insert.run(l.serverSeq === null ? null : l.serverSeq + i, l.action, l.label, flowOf(op), l.at, l.pc, subjectOf(op), JSON.stringify(op), l.unit, l.kind).lastInsertRowid);
    });
    return seq;
  }

  /** `fn` in one write transaction: all of it, or nothing (ROLLBACK, and its error thrown). */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** The journal number of the last line (0 for an empty journal). */
  lastSeq(): number {
    return (this.q('SELECT COALESCE(MAX(local_seq), 0) AS seq FROM changes').get() as { seq: number }).seq;
  }

  /** The journal's lines after `localSeq`, in order; `limit` of them at most (a page of the server's journal, plan 5a). */
  changesSince(localSeq: number, limit = -1): ChangeRow[] {
    return (this.q('SELECT * FROM changes WHERE local_seq > ? ORDER BY local_seq LIMIT ?').all(localSeq, limit) as unknown as ChangeDbRow[]).map(toRow);
  }

  /**
   * Per-object history (spec 6.3): the local and received lines, those a reconciliation replaced too (`superseded`: the
   * losing change, « écartée », D5), never the inverses it wrote.
   */
  historyOf(subject: Id): ChangeRow[] {
    return (this.q("SELECT * FROM changes WHERE subject = ? AND kind != 'rewind' ORDER BY local_seq").all(subject) as unknown as ChangeDbRow[]).map(toRow);
  }

  /** The nodes in the trash, in the order they were created. */
  trash(): NodeRec[] {
    return (this.q('SELECT json FROM nodes WHERE trashed = 1 ORDER BY rowid').all() as { json: string }[]).map((r) => JSON.parse(r.json) as NodeRec);
  }

  /** Whether the base has a lobby plan (spec 7). */
  hasLobby(): boolean {
    return this.q("SELECT 1 AS x FROM plans WHERE json_extract(json, '$.type') = 'lobby' LIMIT 1").get() !== undefined;
  }

  /**
   * Empty in the sense of D7 (plan 5a), as the server reads its own (Canon.empty): no node (in the trash included), no
   * connection, no placement, no plan but a lobby. A few index lookups, whatever the size of the base.
   */
  isEmpty(): boolean {
    const sql = `SELECT EXISTS (SELECT 1 FROM nodes) OR EXISTS (SELECT 1 FROM connections) OR EXISTS (SELECT 1 FROM placements)
      OR EXISTS (SELECT 1 FROM plans WHERE json_extract(json, '$.type') != 'lobby') AS full`;
    return (this.q(sql).get() as { full: number }).full === 0;
  }

  readSnapshot(): StoredSnapshot | null {
    const row = this.q('SELECT version, seq, data FROM snapshot WHERE id = 1').get() as { version: number; seq: number; data: Uint8Array } | undefined;
    if (!row) return null;
    const d = row.data;
    const data = d.byteOffset === 0 && d.byteLength === d.buffer.byteLength ? d.buffer : d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength);
    return { data: data as ArrayBuffer, seq: row.seq, version: row.version };
  }

  /**
   * Keeps `data` as the snapshot covering the journal up to `seq`, only if that is later than the stored one's: an
   * older snapshot never replaces a newer one. Throws on a buffer that is not a snapshot, or a seq beyond the journal.
   */
  writeSnapshot(data: ArrayBuffer, seq: number): void {
    const version = snapshotVersion(data), last = this.lastSeq();
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > last) throw new Error(`Instantané au numéro ${seq} : le journal s’arrête à ${last}.`);
    this.q('INSERT INTO snapshot (id, version, seq, data) VALUES (1, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET version = excluded.version, seq = excluded.seq, data = excluded.data WHERE excluded.seq > snapshot.seq')
      .run(version, seq, new Uint8Array(data));
  }

  /** Forgets the snapshot (unreadable, or of another version): the next one written replaces nothing. */
  dropSnapshot(): void {
    this.q('DELETE FROM snapshot').run();
  }

  close(): void {
    this.db.close();
  }
}
