import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import {
  type Action, canonical, type ConnectionLayout, type ConnectionRec, type Flow, flowOf, fromSnapshot, type Id, KINDS, type NodeRec, type Op, OpConflictError,
  type PhantomRec, type Placement, type PlanRec, ROLES, snapshotVersion, type State, subjectOf, type TagKeyDef,
} from '@cirrus/core';
import { migrate } from './schema.ts';

export { SCHEMA_VERSION } from './schema.ts';

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
}

/** The base's snapshot of the state (plan 3c, decision 4): its bytes, the last journal line it covers, its format. */
export interface StoredSnapshot { data: ArrayBuffer; seq: number; version: number }

interface ChangeDbRow { local_seq: number; server_seq: number | null; action_id: string; label: string; flow: string; at: number; pc: string; subject: string; op: string }
const toRow = (r: ChangeDbRow): ChangeRow => ({
  localSeq: r.local_seq, serverSeq: r.server_seq, actionId: r.action_id, label: r.label, flow: r.flow as Flow, at: r.at, pc: r.pc, subject: r.subject,
  op: JSON.parse(r.op) as Op,
});

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
  });
}

/**
 * A connection as the state keeps it (its columns): known fields only, after the checks the state makes, which refuse
 * the record before anything is written. The tables then hold what the interface's copy holds.
 */
function storedConnection(c: ConnectionRec): ConnectionRec {
  if (!KINDS.includes(c.kind)) throw new Error(`unknown connection kind: ${c.kind}`);
  for (const m of c.members) if (!ROLES.includes(m.role)) throw new Error(`unknown role: ${m.role}`);
  if (c.trashedAt !== undefined && (typeof c.trashedAt !== 'number' || Number.isNaN(c.trashedAt))) throw new Error(`invalid trashedAt: ${String(c.trashedAt)}`);
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

  static open(dir: string, opts: { pc: string }): LocalStore {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'cirrus.db'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    migrate(db);
    return new LocalStore(db, opts.pc);
  }

  /** The state built from the tables (the fallback path when there is no usable snapshot): built at each call, kept by no one here. */
  loadState(): State {
    return loadState(this.db);
  }

  /**
   * Writes an action in one transaction: each operation's "before" checked against the row it replaces, then its
   * "after" written and its journal line added. The first that does not match throws OpConflictError and nothing is
   * written (ROLLBACK). Returns the journal number of the action's last line.
   */
  commit(a: Action): number {
    const at = Date.now(), q = this.q;
    const insert = q('INSERT INTO changes (server_seq, action_id, label, flow, at, pc, subject, op) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)');
    let seq = -1;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of a.ops) {
        checkBefore(q, op);
        persistOp(q, op);
        seq = Number(insert.run(a.id, a.label, flowOf(op), at, this.pc, subjectOf(op), JSON.stringify(op)).lastInsertRowid);
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return seq < 0 ? this.lastSeq() : seq;
  }

  /** The journal number of the last line (0 for an empty journal). */
  lastSeq(): number {
    return (this.q('SELECT COALESCE(MAX(local_seq), 0) AS seq FROM changes').get() as { seq: number }).seq;
  }

  changesSince(localSeq: number): ChangeRow[] {
    return (this.q('SELECT * FROM changes WHERE local_seq > ? ORDER BY local_seq').all(localSeq) as unknown as ChangeDbRow[]).map(toRow);
  }

  /** Per-object history (spec 6.3). */
  historyOf(subject: Id): ChangeRow[] {
    return (this.q('SELECT * FROM changes WHERE subject = ? ORDER BY local_seq').all(subject) as unknown as ChangeDbRow[]).map(toRow);
  }

  /** The nodes in the trash, in the order they were created. */
  trash(): NodeRec[] {
    return (this.q('SELECT json FROM nodes WHERE trashed = 1 ORDER BY rowid').all() as { json: string }[]).map((r) => JSON.parse(r.json) as NodeRec);
  }

  /** Whether the base has a lobby plan (spec 7). */
  hasLobby(): boolean {
    return this.q("SELECT 1 AS x FROM plans WHERE json_extract(json, '$.type') = 'lobby' LIMIT 1").get() !== undefined;
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
