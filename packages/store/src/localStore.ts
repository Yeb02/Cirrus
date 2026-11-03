import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Action, applyOp, cloneState, type ConnectionLayout, type ConnectionRec, type Flow, flowOf, fromSnapshot, type Id, type NodeRec, type Op,
  type PhantomRec, type Placement, type PlanRec, type State, subjectOf, type TagKeyDef,
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

interface ChangeDbRow { local_seq: number; server_seq: number | null; action_id: string; label: string; flow: string; at: number; pc: string; subject: string; op: string }
const toRow = (r: ChangeDbRow): ChangeRow => ({
  localSeq: r.local_seq, serverSeq: r.server_seq, actionId: r.action_id, label: r.label, flow: r.flow as Flow, at: r.at, pc: r.pc, subject: r.subject,
  op: JSON.parse(r.op) as Op,
});

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

/** Writes one operation's "after" into the state tables (null deletes). */
function persistOp(db: DatabaseSync, op: Op): void {
  const j = (v: unknown) => JSON.stringify(v);
  switch (op.t) {
    case 'node': {
      const id = (op.after ?? op.before)!.id;
      if (op.after) db.prepare('INSERT INTO nodes (id, json, trashed) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json, trashed = excluded.trashed')
        .run(id, j(op.after), op.after.trashedAt === undefined ? 0 : 1);
      else db.prepare('DELETE FROM nodes WHERE id = ?').run(id);
      return;
    }
    case 'connection': {
      const id = (op.after ?? op.before)!.id;
      if (op.after) db.prepare('INSERT INTO connections (id, kind, json, trashed) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, json = excluded.json, trashed = excluded.trashed')
        .run(id, op.after.kind, j(op.after), op.after.trashedAt === undefined ? 0 : 1);
      else db.prepare('DELETE FROM connections WHERE id = ?').run(id);
      return;
    }
    case 'plan': {
      const id = (op.after ?? op.before)!.id;
      if (op.after) db.prepare('INSERT INTO plans (id, json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json').run(id, j(op.after));
      else db.prepare('DELETE FROM plans WHERE id = ?').run(id);
      return;
    }
    case 'tagKey': {
      const key = (op.after ?? op.before)!.key;
      if (op.after) db.prepare('INSERT INTO tag_keys (key, json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET json = excluded.json').run(key, j(op.after));
      else db.prepare('DELETE FROM tag_keys WHERE key = ?').run(key);
      return;
    }
    case 'placement': {
      const { plan, node } = (op.after ?? op.before)!;
      if (op.after) db.prepare('INSERT INTO placements (plan, node, json) VALUES (?, ?, ?) ON CONFLICT(plan, node) DO UPDATE SET json = excluded.json').run(plan, node, j(op.after));
      else db.prepare('DELETE FROM placements WHERE plan = ? AND node = ?').run(plan, node);
      return;
    }
    case 'branch': {
      const { plan, connection, node } = op.key;
      if (op.after) db.prepare('INSERT OR IGNORE INTO branches (plan, connection, node) VALUES (?, ?, ?)').run(plan, connection, node);
      else db.prepare('DELETE FROM branches WHERE plan = ? AND connection = ? AND node = ?').run(plan, connection, node);
      return;
    }
    case 'connLayout': {
      const { plan, connection } = (op.after ?? op.before)!;
      if (op.after) db.prepare('INSERT INTO conn_layouts (plan, connection, json) VALUES (?, ?, ?) ON CONFLICT(plan, connection) DO UPDATE SET json = excluded.json').run(plan, connection, j(op.after));
      else db.prepare('DELETE FROM conn_layouts WHERE plan = ? AND connection = ?').run(plan, connection);
      return;
    }
    case 'phantom': {
      const rec = (op.after ?? op.before)!;
      if (op.after) db.prepare('INSERT INTO phantoms (id, plan, json) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET plan = excluded.plan, json = excluded.json').run(rec.id, rec.plan, j(op.after));
      else db.prepare('DELETE FROM phantoms WHERE id = ?').run(rec.id);
      return;
    }
  }
}

/**
 * The PC's local copy (spec 6): current state in tables, every change in an append-only journal, all in one SQLite
 * file. An action is all or nothing: checked on a draft, written in one transaction, then applied in memory.
 */
export class LocalStore {
  readonly state: State;
  private readonly db: DatabaseSync;
  private readonly pc: string;

  private constructor(db: DatabaseSync, pc: string, state: State) {
    this.db = db;
    this.pc = pc;
    this.state = state;
  }

  static open(dir: string, opts: { pc: string }): LocalStore {
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'cirrus.db'));
    db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;');
    migrate(db);
    return new LocalStore(db, opts.pc, loadState(db));
  }

  commit(a: Action): ChangeRow[] {
    // 1. Dry run: every "before" must match; throws before anything is written.
    const draft = cloneState(this.state);
    for (const op of a.ops) applyOp(draft, op);
    // 2. One transaction for the tables and the journal.
    const at = Date.now();
    const rows: ChangeRow[] = [];
    const insert = this.db.prepare('INSERT INTO changes (server_seq, action_id, label, flow, at, pc, subject, op) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?)');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const op of a.ops) {
        persistOp(this.db, op);
        const flow = flowOf(op), subject = subjectOf(op);
        const res = insert.run(a.id, a.label, flow, at, this.pc, subject, JSON.stringify(op));
        rows.push({ localSeq: Number(res.lastInsertRowid), serverSeq: null, actionId: a.id, label: a.label, flow, at, pc: this.pc, subject, op });
      }
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    // 3. Only now does the in-memory state move (the dry run proved every operation applies).
    for (const op of a.ops) applyOp(this.state, op);
    return rows;
  }

  changesSince(localSeq: number): ChangeRow[] {
    return (this.db.prepare('SELECT * FROM changes WHERE local_seq > ? ORDER BY local_seq').all(localSeq) as unknown as ChangeDbRow[]).map(toRow);
  }

  /** Per-object history (spec 6.3). */
  historyOf(subject: Id): ChangeRow[] {
    return (this.db.prepare('SELECT * FROM changes WHERE subject = ? ORDER BY local_seq').all(subject) as unknown as ChangeDbRow[]).map(toRow);
  }

  trash(): NodeRec[] {
    return [...this.state.nodes.values()].filter((n) => n.trashedAt !== undefined);
  }

  close(): void {
    this.db.close();
  }
}
