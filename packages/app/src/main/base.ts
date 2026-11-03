import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlan, emptyState, encodeState, SNAPSHOT_VERSION, uuidv7 } from '@cirrus/core';
import { LocalStore } from '@cirrus/store';

/**
 * Where the base lives: CIRRUS_DATA (tests, captures, a dev copy), else under the app's data folder. `measuring` (bench
 * and capture modes, which edit what they open) requires CIRRUS_DATA: they never open the user's own base.
 */
export function dataDir(userData: string, measuring = false): string {
  if (measuring && !process.env.CIRRUS_DATA) throw new Error('Mode banc ou capture sans CIRRUS_DATA : la base de l’utilisateur n’est pas ouverte.');
  return process.env.CIRRUS_DATA ?? join(userData, 'base');
}

/** The PC's identifier, created on first opening and kept in pc.json (it signs the journal lines, spec 6.2). */
function pcId(dir: string): string {
  const file = join(dir, 'pc.json');
  try {
    const id = JSON.parse(readFileSync(file, 'utf8')).id;
    if (typeof id === 'string' && id.length > 0) return id;
  } catch {
    // absent or unreadable: a new identifier below
  }
  const id = uuidv7();
  writeFileSync(file, JSON.stringify({ id }), 'utf8');
  return id;
}

/** Opens (or creates) the local base; a base without a lobby gets one (spec 7). The main process keeps no state. */
export function openBase(dir: string): LocalStore {
  mkdirSync(dir, { recursive: true });
  const store = LocalStore.open(dir, { pc: pcId(dir) });
  // A new plan's action depends on nothing else in the state: computed on an empty one, its "before" checked by the base.
  if (!store.hasLobby()) store.commit(createPlan(emptyState(), 'Lobby', 'lobby'));
  return store;
}

/** What cirrus:load sends the interface: the snapshot, the journal's operations after it as JSON, the number they reach. */
export interface Payload { data: ArrayBuffer; tail: string; seq: number }

/**
 * cirrus:load (plan 3c, decision 4): the base's snapshot and the journal after it. Without a snapshot of this format,
 * or when the interface could not use the one it got (`fromTables`), the state is built from the tables (the fallback
 * path), encoded, and forgotten; that bad snapshot is dropped and `rebuilt` asks for the new one to be kept once sent.
 */
export function loadPayload(store: LocalStore, fromTables: boolean): { payload: Payload; rebuilt: boolean } {
  const snap = fromTables ? null : store.readSnapshot();
  if (snap && snap.version === SNAPSHOT_VERSION) {
    const rows = store.changesSince(snap.seq);
    const seq = rows.length > 0 ? rows[rows.length - 1].localSeq : snap.seq;
    return { payload: { data: snap.data, tail: JSON.stringify(rows.map((r) => r.op)), seq }, rebuilt: false };
  }
  store.dropSnapshot();
  const seq = store.lastSeq();
  return { payload: { data: encodeState(store.loadState()), tail: '[]', seq }, rebuilt: true };
}

/** Keeps a snapshot the main process built itself (after it was sent): a failure is only reported, the tables have everything. */
export function keepSnapshot(store: LocalStore, data: ArrayBuffer, seq: number): void {
  try {
    store.writeSnapshot(data, seq);
  } catch (e) {
    console.warn(`Instantané de la base non enregistré : ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** SQLite's largest blob, by default. */
const MAX_SNAPSHOT_BYTES = 1e9;

/**
 * cirrus:snapshot:save: the interface's snapshot, its arguments checked before anything is written (an ArrayBuffer of a
 * sensible size, a journal number); kept only if later than the stored one (LocalStore.writeSnapshot).
 */
export function saveSnapshot(store: LocalStore, data: unknown, seq: unknown): void {
  if (!(data instanceof ArrayBuffer) || data.byteLength < 32 || data.byteLength > MAX_SNAPSHOT_BYTES) throw new Error('Instantané refusé : pas un tampon de taille admise.');
  if (typeof seq !== 'number' || !Number.isSafeInteger(seq) || seq < 0) throw new Error('Instantané refusé : numéro de journal invalide.');
  store.writeSnapshot(data, seq);
}
