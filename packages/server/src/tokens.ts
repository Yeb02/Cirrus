import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { MAX_ID_CHARS, newer, type SettingRow } from '@cirrus/core';
import { MAX_PC_NAME_CHARS, MAX_SETTINGS_KEPT, PAIRING_TRIES, PAIRING_TTL_MS } from './bounds.ts';
import { SettingsError, type StoredChange } from './settings.ts';

// Pairing and tokens (plan 5a, D3): `jumeler` makes a one-time code, a PC trades it for a token of 256 bits. The
// server's own file, serveur.db, keeps only their SHA-256 hashes: neither a code nor a token is ever on its disk. It
// keeps the shared settings too (task 6, D9).

/** The server's own file, next to its base: the paired PCs, the pending codes, the shared settings. */
export const SERVER_DB = 'serveur.db';

/** How long a write of serveur.db waits for another (the command line writes it while the server runs). */
const BUSY_MS = 5000;

/** Forward-only migrations of serveur.db: index i upgrades user_version i to i + 1. Never edit a shipped migration. */
const MIGRATIONS: string[] = [
  /* v1: the paired PCs, each by its token's hash; the pending codes, by their hash, with the wrong tries made since. */ `
  CREATE TABLE pcs (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, machine TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, paired_at INTEGER NOT NULL);
  CREATE TABLE codes (code_hash TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE, expires_at INTEGER NOT NULL, failures INTEGER NOT NULL DEFAULT 0);
  `,
  /* v2 (task 6): the shared settings, each its last change: its value's JSON (NULL: back to the default), its time, its PC. */ `
  CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT, at REAL NOT NULL, pc TEXT NOT NULL);
  `,
];

/** Crockford's base 32: no I, L, O or U, which a code read aloud or copied by hand would mistake. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** A token as /pair gives it: 32 random bytes in base64url. */
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

/** The hash serveur.db keeps of a token (the token itself is never written). */
export function hashToken(token: string): string {
  return sha256(token);
}

/** A code as typed: upper case, without its spaces or dashes, the letters Crockford reads as digits read so. */
const normalizeCode = (code: string): string => code.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');

/** 16 characters of 5 random bits each (80 bits), shown in four groups. */
function newCodeText(): string {
  let out = '', value = 0, bits = 0;
  for (const byte of randomBytes(10)) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += ALPHABET[(value >>> bits) & 31];
    }
    value &= (1 << bits) - 1;
  }
  return out.match(/.{4}/g)!.join('-');
}

/** A refused /pair: `status` 400 for a body of the wrong shape (no code tried), 403 for a code that is not a pending one. */
export class PairingError extends Error {
  readonly status: 400 | 403;

  constructor(status: 400 | 403, message: string) {
    super(message);
    this.status = status;
  }
}

export interface PairedPc { id: string; name: string; machine: string; pairedAt: number }
export interface PendingCode { name: string; expiresAt: number }

/** A PC's name: what `jumeler` gives, and what the PC says of itself; text of 1 to MAX_PC_NAME_CHARS characters, no control character. */
function checkName(name: unknown): string | null {
  if (typeof name !== 'string') return null;
  const n = name.trim();
  return n.length > 0 && n.length <= MAX_PC_NAME_CHARS && !/[\u0000-\u001f\u007f]/.test(n) ? n : null;
}

/**
 * serveur.db (WAL: the command line pairs and revokes while the server runs): the paired PCs and the pending codes. A
 * code lives PAIRING_TTL_MS and serves once; PAIRING_TRIES wrong /pair attempts burn every pending code — the codes are
 * kept hashed, so a wrong attempt cannot be laid at one code's door, and with one code pending at a time (the usual
 * case) that is exactly D3's « 5 essais faux ».
 */
export class Tokens {
  private readonly db: DatabaseSync;
  private readonly statements = new Map<string, StatementSync>();

  private constructor(db: DatabaseSync) {
    this.db = db;
  }

  static open(dataDir: string): Tokens {
    mkdirSync(dataDir, { recursive: true });
    const db = new DatabaseSync(join(dataDir, SERVER_DB), { timeout: BUSY_MS });
    try {
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      migrate(db);
    } catch (e) {
      db.close();
      throw e;
    }
    return new Tokens(db);
  }

  private q(sql: string): StatementSync {
    let st = this.statements.get(sql);
    if (!st) {
      st = this.db.prepare(sql);
      this.statements.set(sql, st);
    }
    return st;
  }

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

  /**
   * A new code for the PC to be called `name` (`jumeler`), valid PAIRING_TTL_MS from `now`, once; it replaces a code
   * pending under that name. Refused, in French, for a name that is not one, or that a paired PC has already.
   */
  createCode(name: string, now: number): { code: string; expiresAt: number } {
    const n = checkName(name);
    if (n === null) throw new Error(`Le nom d’un PC compte de 1 à ${MAX_PC_NAME_CHARS} caractères, sans caractère de contrôle.`);
    const code = newCodeText(), expiresAt = now + PAIRING_TTL_MS;
    this.transaction(() => {
      if (this.q('SELECT 1 AS x FROM pcs WHERE name = ?').get(n) !== undefined) {
        throw new Error(`Un PC jumelé s’appelle déjà « ${n} » : revoque-le d’abord (revoquer "${n}"), ou choisis un autre nom.`);
      }
      this.q('DELETE FROM codes WHERE name = ? OR expires_at <= ?').run(n, now);
      this.q('INSERT INTO codes (code_hash, name, expires_at) VALUES (?, ?, ?)').run(sha256(normalizeCode(code)), n, expiresAt);
    });
    return { code, expiresAt };
  }

  /**
   * POST /pair: `body` checked ({ code, pc, name }: a code, the PC's identifier, the name it gives of itself), then its
   * code traded for a new token, in one transaction. A pending code: it is spent, and the PC paired under the code's
   * name (a PC paired already, under this identifier, takes the new name and token: its old token dies). Otherwise the
   * attempt counts against every pending code, and burns those that reach PAIRING_TRIES. Expired codes go first.
   * Returns the token, the only time it exists in clear here; PairingError otherwise.
   */
  pair(body: unknown, now: number): string {
    const shape = (): never => { throw new PairingError(400, 'Jumelage refusé : { code, pc, name } attendus (le code, l’identifiant de ce PC, son nom).'); };
    if (typeof body !== 'object' || body === null || Array.isArray(body)) shape();
    const { code, pc, name, ...rest } = body as Record<string, unknown>;
    if (typeof code !== 'string' || code.length > 64 || typeof pc !== 'string' || pc.length === 0 || pc.length > MAX_ID_CHARS || Object.keys(rest).length > 0) shape();
    const machine = checkName(name) ?? shape();
    const token = randomBytes(32).toString('base64url');
    const paired = this.transaction(() => {
      this.q('DELETE FROM codes WHERE expires_at <= ?').run(now);
      const hash = sha256(normalizeCode(code as string));
      const row = this.q('SELECT name FROM codes WHERE code_hash = ?').get(hash) as { name: string } | undefined;
      if (!row) {
        this.q('UPDATE codes SET failures = failures + 1').run();
        this.q('DELETE FROM codes WHERE failures >= ?').run(PAIRING_TRIES);
        return false;
      }
      this.q('DELETE FROM codes WHERE code_hash = ?').run(hash);
      this.q(`INSERT INTO pcs (id, name, machine, token_hash, paired_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET name = excluded.name, machine = excluded.machine, token_hash = excluded.token_hash, paired_at = excluded.paired_at`)
        .run(pc as string, row.name, machine, hashToken(token), now);
      return true;
    });
    if (!paired) throw new PairingError(403, 'Code de jumelage faux, expiré ou déjà servi : demande un nouveau code au serveur (jumeler).');
    return token;
  }

  /** The PC whose token has this hash, while it is paired; null otherwise (unknown, or revoked since). */
  pcOfHash(tokenHash: string): string | null {
    return (this.q('SELECT id FROM pcs WHERE token_hash = ?').get(tokenHash) as { id: string } | undefined)?.id ?? null;
  }

  /** The PC of a token as a request gives it; null for anything that is not a paired PC's token. */
  pcOf(token: string): string | null {
    return TOKEN.test(token) ? this.pcOfHash(hashToken(token)) : null;
  }

  /** The paired PCs, in the order they were paired (`pcs`). */
  pcs(): PairedPc[] {
    return (this.q('SELECT id, name, machine, paired_at FROM pcs ORDER BY paired_at, name').all() as { id: string; name: string; machine: string; paired_at: number }[])
      .map((r) => ({ id: r.id, name: r.name, machine: r.machine, pairedAt: r.paired_at }));
  }

  /** The codes not yet spent nor burnt, expired ones included until the next code or pairing clears them (`pcs`). */
  codes(): PendingCode[] {
    return (this.q('SELECT name, expires_at FROM codes ORDER BY expires_at').all() as { name: string; expires_at: number }[])
      .map((r) => ({ name: r.name, expiresAt: r.expires_at }));
  }

  /** `revoquer`: the PC called `name` unpaired, its token worth nothing from the next request, and a code pending under that name dropped. Whether there was either. */
  revoke(name: string): boolean {
    return this.transaction(() => {
      const pcs = Number(this.q('DELETE FROM pcs WHERE name = ?').run(name.trim()).changes);
      const codes = Number(this.q('DELETE FROM codes WHERE name = ?').run(name.trim()).changes);
      return pcs + codes > 0;
    });
  }

  /**
   * POST /unpair (R15): the PC of this token's hash unpaired by itself, its token worth nothing from the next request;
   * no other PC touched. Whether there was one.
   */
  revokeToken(tokenHash: string): boolean {
    return Number(this.q('DELETE FROM pcs WHERE token_hash = ?').run(tokenHash).changes) > 0;
  }

  /** GET /settings (task 6): every shared setting the server keeps, a reset to the default included (value null). */
  settings(): Record<string, SettingRow> {
    const out: Record<string, SettingRow> = {};
    for (const r of this.q('SELECT key, value, at, pc FROM settings').all() as unknown as SettingsRow[]) out[r.key] = rowOf(r);
    return out;
  }

  /**
   * POST /settings (task 6, D9, R23): each change of PC `pc` kept if it is more recent than the setting's last one, by
   * the core's merge order (`newer`: its time, then the PC's identifier), in one transaction. `rows`: the setting as the
   * server keeps it now, for every key sent; `changed`: those this request changed, for the event streams. A change
   * sent again (its answer lost) changes nothing. SettingsError, nothing written, for a request that would keep more
   * than MAX_SETTINGS_KEPT settings.
   */
  putSettings(changes: Map<string, StoredChange>, pc: string): { rows: Record<string, SettingRow>; changed: Record<string, SettingRow> } {
    return this.transaction(() => {
      const rows: Record<string, SettingRow> = {}, changed: Record<string, SettingRow> = {};
      const kept = [...changes.keys()].map((key) => this.q('SELECT key, value, at, pc FROM settings WHERE key = ?').get(key) as unknown as SettingsRow | undefined);
      // The settings kept bounded (review of task 6, Minor 3), checked before anything is written.
      const added = kept.filter((r) => r === undefined).length;
      if (added > 0 && (this.q('SELECT count(*) AS n FROM settings').get() as { n: number }).n + added > MAX_SETTINGS_KEPT) {
        throw new SettingsError(`Le serveur garde au plus ${MAX_SETTINGS_KEPT} réglages : cette requête en ajouterait ${added} de trop.`);
      }
      let i = 0;
      for (const [key, c] of changes) {
        const before = kept[i++];
        if (before && !newer({ at: c.at, pc }, before)) {
          rows[key] = rowOf(before);
          continue;
        }
        this.q('INSERT INTO settings (key, value, at, pc) VALUES (?, ?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, at = excluded.at, pc = excluded.pc')
          .run(key, c.json, c.at, pc);
        rows[key] = changed[key] = rowOf({ key, value: c.json, at: c.at, pc });
      }
      return { rows, changed };
    });
  }

  close(): void {
    this.db.close();
  }
}

/** A row of the table `settings`. */
interface SettingsRow { key: string; value: string | null; at: number; pc: string }
/** A setting as the protocol gives it: its value read back from the JSON kept (which the server wrote itself). */
const rowOf = (r: SettingsRow): SettingRow => ({ value: r.value === null ? null : JSON.parse(r.value), at: r.at, pc: r.pc });

/** Brings serveur.db to the last version, in one transaction that a second process opening it at the same time waits for. */
function migrate(db: DatabaseSync): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    const current = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
    if (current > MIGRATIONS.length) throw new Error('Ces données ont été écrites par une version plus récente du serveur Cirrus : mets-le à jour.');
    for (let v = current; v < MIGRATIONS.length; v++) db.exec(MIGRATIONS[v]);
    db.exec(`PRAGMA user_version = ${MIGRATIONS.length}`);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
