import type { DatabaseSync } from 'node:sqlite';

/** Forward-only migrations: index i upgrades user_version i to i + 1. Never edit a shipped migration. */
const MIGRATIONS: string[] = [
  /* v1 */ `
  CREATE TABLE nodes (id TEXT PRIMARY KEY, json TEXT NOT NULL, trashed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE connections (id TEXT PRIMARY KEY, kind TEXT NOT NULL, json TEXT NOT NULL, trashed INTEGER NOT NULL DEFAULT 0);
  CREATE TABLE plans (id TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE tag_keys (key TEXT PRIMARY KEY, json TEXT NOT NULL);
  CREATE TABLE placements (plan TEXT NOT NULL, node TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (plan, node));
  CREATE TABLE branches (plan TEXT NOT NULL, connection TEXT NOT NULL, node TEXT NOT NULL, PRIMARY KEY (plan, connection, node));
  CREATE TABLE conn_layouts (plan TEXT NOT NULL, connection TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY (plan, connection));
  CREATE TABLE phantoms (id TEXT PRIMARY KEY, plan TEXT NOT NULL, json TEXT NOT NULL);
  CREATE TABLE changes (
    local_seq INTEGER PRIMARY KEY AUTOINCREMENT,
    server_seq INTEGER UNIQUE,
    action_id TEXT NOT NULL,
    label TEXT NOT NULL,
    flow TEXT NOT NULL,
    at INTEGER NOT NULL,
    pc TEXT NOT NULL,
    subject TEXT NOT NULL,
    op TEXT NOT NULL
  );
  CREATE INDEX changes_subject ON changes (subject);
  CREATE INDEX changes_action ON changes (action_id);
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
  /* v2 (plan 3c): the binary snapshot of the state, a cache of the tables; seq is the last journal line it covers. */ `
  CREATE TABLE snapshot (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, seq INTEGER NOT NULL, data BLOB NOT NULL);
  `,
  /* v3 (plan 4b): the global LaTeX preamble, one row at most; none means DEFAULT_PREAMBLE. */ `
  CREATE TABLE preamble (id INTEGER PRIMARY KEY CHECK (id = 1), json TEXT NOT NULL);
  `,
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export class SchemaError extends Error {}

export function migrate(db: DatabaseSync): void {
  const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (current > SCHEMA_VERSION) {
    // A later app wrote this base: only later versions read older bases (spec 3), so this app must be updated.
    throw new SchemaError('Cette base a été écrite par une version plus récente de Cirrus : mets l’application à jour.');
  }
  for (let v = current; v < SCHEMA_VERSION; v++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}
