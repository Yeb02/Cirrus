import { readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSettingTime, newer, type SettingChange, type SettingRow, type Stamp } from '@cirrus/core';
import { DEFAULT_PARAMS, type RenderParams, sameSetting, settingValue } from '@cirrus/view';

// The settings (spec 19: outside the history and undo). settings.json holds those that differ from the defaults: this
// PC's copy. With a server paired (plan 5a, task 6, D9, R23), they are shared: the server keeps each with the time of
// its last change, and the more recent change wins, setting by setting, then the greater PC identifier (the core's
// merge order, `newer`). A change made here waits in settings-pending.json, its latest value only, until the server
// has it; a change received is written to settings.json at once, bounded as a file read (withOverrides), and told to
// the interface. Writing a setting rewrites these small files only; a batch received touches its keys only.

const SETTINGS_FILE = 'settings.json';
export const PENDING_SETTINGS_FILE = 'settings-pending.json';

/**
 * The settings differing from the defaults. A missing or unreadable file gives no override, so the app always opens.
 */
export function readSettings(dir: string): Record<string, unknown> {
  let text: string;
  try {
    text = readFileSync(join(dir, SETTINGS_FILE), 'utf8');
  } catch {
    return {};
  }
  try {
    const v: unknown = JSON.parse(text);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // reported below
  }
  console.warn('Réglages illisibles (settings.json) : valeurs par défaut utilisées.');
  return {};
}

/** settings.json or settings-pending.json, written to a temporary file then renamed: a crash never leaves half a file. */
function writeJson(dir: string, name: string, value: unknown): void {
  const tmp = join(dir, `${name}.${process.pid}.tmp`);
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  renameSync(tmp, join(dir, name));
}

const isObject = (x: unknown): x is Record<string, unknown> => typeof x === 'object' && x !== null && !Array.isArray(x);
const has = (o: object, key: string): boolean => Object.hasOwn(o, key);
/** A key of RenderParams (its own: never `constructor` or `__proto__`). */
const isSetting = (key: string): boolean => has(DEFAULT_PARAMS, key);
/** A change's time, as the PCs make them: whole milliseconds, from 0 to 2^53 − 1 (review of task 6, Minor 4). */
const isStamp = (x: Record<string, unknown>): boolean => isSettingTime(x.at);

/**
 * Shared settings as the server gives them (GET /settings, the event `settings`, the answer to POST /settings): each a
 * `{ value, at, pc }`; one of another form is left out, said in the console. Throws for what is no map at all.
 */
export function parseSettingRows(x: unknown): Record<string, SettingRow> {
  if (!isObject(x)) throw new Error('Réglages du serveur illisibles : mets à jour Cirrus, ou le serveur.');
  // Own entries only (fromEntries: a key `__proto__` stays a key, which is no setting).
  return Object.fromEntries(Object.entries(x).flatMap(([key, r]): [string, SettingRow][] => {
    if (isObject(r) && has(r, 'value') && isStamp(r) && typeof r.pc === 'string') return [[key, { value: r.value, at: r.at as number, pc: r.pc }]];
    console.warn(`Réglage « ${key.slice(0, 64)} » du serveur illisible : ignoré.`);
    return [];
  }));
}

/**
 * The time of a change made here (`at`: this PC's clock corrected by the server's, D4), and the latest the server takes
 * (R26: SyncClient.latestSettingTime).
 */
export interface SettingClock { at: number; latest: number }

/**
 * This PC's settings and their sharing (task 6). Without a server paired, a change goes to settings.json only, as
 * before. Paired, it also waits in settings-pending.json (its value and time, the latest per key) until the server
 * answers for it; the client sends them (pending), and hands over what the server gives (receive, acknowledge).
 */
export class SharedSettings {
  private readonly dir: string;
  /** This PC's identifier: its changes' stamp, beside their time. */
  private readonly pc: string;
  /** The interface told of the settings received that changed here (key: value, null back to the default), one batch at a time. */
  private readonly changed: (changes: Record<string, unknown>) => void;
  /** settings-pending.json, read at its first use (never without a server: nothing to read). */
  private waiting: Record<string, SettingChange> | null = null;
  /**
   * The stamp of each setting as last received from the server, since this connection's whole read (GET /settings): a
   * row received again, or older, is not applied twice (a change may come by the stream and by that read). A change
   * made here forgets its key's: the server's answer is then applied, whatever it is.
   */
  private readonly seen = new Map<string, Stamp>();

  constructor(dir: string, pc: string, changed: (changes: Record<string, unknown>) => void) {
    this.dir = dir;
    this.pc = pc;
    this.changed = changed;
  }

  /**
   * Settings changed in Réglages (cirrus:settings:set): only those changed, key: value, null back to the default; a
   * key that is no setting is ignored, a value bounded as withOverrides reads it. Written to settings.json; with a
   * server paired (`at`: now, the server's clock, D4), each waits too, its latest value. Its time is later than the
   * setting's last one here, its own or received: a change the user makes after seeing another comes after it — but
   * never past `clock.latest`, the latest time the server takes (R26): a row seen far ahead then holds its setting
   * until the clock has caught up, rather than a change refused.
   * settings-pending.json is written first (review of task 6, Minor 5): a stop between the two files leaves the change
   * to go, and the server's answer writes settings.json. Returns what is now written for each of these keys (null: the
   * default), which the interface adopts (review, Minor 2): a row received while the change was on its way may have
   * passed it.
   */
  local(changes: unknown, clock: SettingClock | null): Record<string, unknown> {
    const written: Record<string, unknown> = {};
    if (!isObject(changes)) return written;
    const overrides = readSettings(this.dir), pending = clock === null ? null : this.pending();
    let changed = false;
    for (const [key, v] of Object.entries(changes)) {
      const value = v === null ? null : settingValue(key, v);
      if (value === undefined || !isSetting(key)) continue;
      changed = put(overrides, key, value) || changed;
      written[key] = has(overrides, key) ? overrides[key] : null;
      if (pending && clock !== null) {
        const floor = Math.max(pending[key]?.at ?? -Infinity, this.seen.get(key)?.at ?? -Infinity);
        pending[key] = { value: written[key], at: Math.min(Math.max(clock.at, floor + 1), clock.latest) };
        this.seen.delete(key);
      }
    }
    if (pending && Object.keys(written).length > 0) this.savePending();
    if (changed) writeJson(this.dir, SETTINGS_FILE, overrides);
    return written;
  }

  /**
   * The changes made here that the server has not answered for, by key (the client sends them). `latest`, as they are
   * about to leave: none later than it (R26) — one stamped while this PC did not know the server's clock yet (offline
   * since its start) is brought back to it, and waits so.
   */
  pending(latest?: number): Record<string, SettingChange> {
    const waiting = (this.waiting ??= this.read());
    if (latest === undefined) return waiting;
    let clamped = false;
    for (const [key, c] of Object.entries(waiting)) {
      if (c.at <= latest) continue;
      waiting[key] = { value: c.value, at: latest };
      clamped = true;
    }
    if (clamped) this.savePending();
    return waiting;
  }

  /** settings-pending.json: the well-formed changes it holds. */
  private read(): Record<string, SettingChange> {
    let read: unknown = null;
    try {
      read = JSON.parse(readFileSync(join(this.dir, PENDING_SETTINGS_FILE), 'utf8'));
    } catch {
      // absent (nothing pending), or unreadable: nothing pending, the server's settings apply
    }
    const entries = isObject(read) ? Object.entries(read) : [];
    return Object.fromEntries(entries.flatMap(([key, c]): [string, SettingChange][] => (
      isSetting(key) && isObject(c) && has(c, 'value') && isStamp(c) ? [[key, { value: c.value, at: c.at as number }]] : []
    )));
  }

  /**
   * Settings the server gave (D9): each applied unless a change made here is more recent (it then waits, and goes); a
   * change made here that loses leaves settings-pending.json. `whole`: every setting the server keeps (GET /settings,
   * at each connection) — a setting this PC holds that the server lacks, and that waits for nothing here, goes back to
   * its default. A key that is no setting is ignored, a value of another kind kept as it is here (said in the console),
   * a value out of its bounds brought inside them (R24). The interface is told of what changed, in one batch.
   */
  receive(rows: Record<string, SettingRow>, whole: boolean): void {
    const pending = this.pending(), overrides = readSettings(this.dir), told: Record<string, unknown> = {};
    let pendingChanged = false;
    if (whole) this.seen.clear();
    for (const [key, row] of Object.entries(rows)) {
      if (!isSetting(key)) continue;
      const last = this.seen.get(key);
      if (last && !newer(row, last)) continue;
      const mine = pending[key];
      if (mine && newer({ at: mine.at, pc: this.pc }, row)) continue;
      this.seen.set(key, { at: row.at, pc: row.pc });
      if (mine) {
        delete pending[key];
        pendingChanged = true;
      }
      const value = row.value === null ? null : settingValue(key, row.value);
      if (value === undefined) {
        console.warn(`Réglage « ${key} » reçu du serveur d’un autre genre (${JSON.stringify(row.value).slice(0, 80)}) : celui de ce PC est gardé.`);
        continue;
      }
      if (put(overrides, key, value)) told[key] = has(overrides, key) ? overrides[key] : null;
    }
    if (whole) {
      for (const key of Object.keys(overrides)) {
        if (has(rows, key) || has(pending, key) || !isSetting(key)) continue;
        delete overrides[key];
        told[key] = null;
      }
    }
    if (pendingChanged) this.savePending();
    if (Object.keys(told).length === 0) return;
    writeJson(this.dir, SETTINGS_FILE, overrides);
    this.changed(told);
  }

  /**
   * The server's answer to the changes `sent` (POST /settings): each that still waits as it was sent leaves
   * settings-pending.json (one changed since stays, and goes next), then the server's settings are applied — a change
   * that lost gives way to the winner's.
   */
  acknowledge(sent: Record<string, SettingChange>, rows: Record<string, SettingRow>): void {
    const pending = this.pending();
    let pendingChanged = false;
    for (const [key, c] of Object.entries(sent)) {
      const now = pending[key];
      if (!now || now.at !== c.at || !sameSetting(now.value, c.value)) continue;
      delete pending[key];
      pendingChanged = true;
    }
    if (pendingChanged) this.savePending();
    this.receive(rows, false);
  }

  /**
   * The first sync settled, this PC's settings sent (R23: a seed, or an empty PC paired with an empty server): every
   * one of settings.json waits, stamped `at`, the pairing's time.
   */
  pairedAt(at: number): void {
    const pending: Record<string, SettingChange> = {};
    for (const [key, v] of Object.entries(readSettings(this.dir))) {
      const value = settingValue(key, v);
      if (value !== undefined) pending[key] = { value, at };
    }
    this.waiting = pending;
    this.seen.clear();
    this.savePending();
  }

  /**
   * A base taken from the server (R23: an adopt, or a replace): the server's settings, `rows` (GET /settings), in
   * settings.json; nothing of this PC's waits (an empty settings-pending.json).
   */
  adopt(rows: Record<string, SettingRow>): void {
    this.waiting = {};
    this.receive(rows, true);
    this.savePending();
  }

  /** Unpaired: nothing waits any more (settings-pending.json removed); settings.json stays, this PC's own. */
  unpaired(): void {
    this.waiting = {};
    this.seen.clear();
    rmSync(join(this.dir, PENDING_SETTINGS_FILE), { force: true });
  }

  private savePending(): void {
    writeJson(this.dir, PENDING_SETTINGS_FILE, this.waiting ?? {});
  }
}

/**
 * `value` (bounded; null: the default) put in `overrides`, which hold only what differs from the defaults; whether
 * that changed them.
 */
function put(overrides: Record<string, unknown>, key: string, value: unknown): boolean {
  const def = value === null || sameSetting(value, DEFAULT_PARAMS[key as keyof RenderParams]);
  if (def) {
    if (!has(overrides, key)) return false;
    delete overrides[key];
    return true;
  }
  if (has(overrides, key) && sameSetting(overrides[key], value)) return false;
  overrides[key] = value;
  return true;
}
