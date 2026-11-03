import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseBranchKey, type State } from '@cirrus/core';
import { migrate } from './schema.ts';

/**
 * Writes a whole state as a new base, in the store's format (the rows LocalStore.commit would write), in one
 * transaction and with an empty journal: the bench's base on disk (plan 3c), a million rows in seconds rather than an
 * action per record. Refuses a folder that already holds a base.
 */
export function writeBenchBase(dir: string, s: State): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cirrus.db');
  if (existsSync(file)) throw new Error(`${dir} contient déjà une base.`);
  const db = new DatabaseSync(file);
  try {
    // A new file: nothing to keep safe while it is written, so no sync until it is complete.
    db.exec('PRAGMA synchronous = OFF;');
    migrate(db);
    const j = (v: unknown) => JSON.stringify(v);
    db.exec('BEGIN');
    try {
      const node = db.prepare('INSERT INTO nodes (id, json, trashed) VALUES (?, ?, ?)');
      for (const n of s.nodes.values()) node.run(n.id, j(n), n.trashedAt === undefined ? 0 : 1);
      const connection = db.prepare('INSERT INTO connections (id, kind, json, trashed) VALUES (?, ?, ?, ?)');
      for (const c of s.connections.values()) connection.run(c.id, c.kind, j(c), c.trashedAt === undefined ? 0 : 1);
      const plan = db.prepare('INSERT INTO plans (id, json) VALUES (?, ?)');
      for (const p of s.plans.values()) plan.run(p.id, j(p));
      const tagKey = db.prepare('INSERT INTO tag_keys (key, json) VALUES (?, ?)');
      for (const t of s.tagKeys.values()) tagKey.run(t.key, j(t));
      const placement = db.prepare('INSERT INTO placements (plan, node, json) VALUES (?, ?, ?)');
      for (const p of s.placements.values()) placement.run(p.plan, p.node, j(p));
      const branch = db.prepare('INSERT INTO branches (plan, connection, node) VALUES (?, ?, ?)');
      for (const key of s.branches) {
        const b = parseBranchKey(key);
        branch.run(b.plan, b.connection, b.node);
      }
      const layout = db.prepare('INSERT INTO conn_layouts (plan, connection, json) VALUES (?, ?, ?)');
      for (const l of s.connLayouts.values()) layout.run(l.plan, l.connection, j(l));
      const phantom = db.prepare('INSERT INTO phantoms (id, plan, json) VALUES (?, ?, ?)');
      for (const p of s.phantoms.values()) phantom.run(p.id, p.plan, j(p));
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
    // The journal mode LocalStore.open sets: the file is left as the store leaves its own.
    db.exec('PRAGMA journal_mode = WAL;');
  } finally {
    db.close();
  }
}
