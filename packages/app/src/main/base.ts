import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPlan, uuidv7 } from '@cirrus/core';
import { LocalStore } from '@cirrus/store';

/** Where the base lives: CIRRUS_DATA (tests, captures, a dev copy), else under the app's data folder. */
export function dataDir(userData: string): string {
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

/** Opens (or creates) the local base; a base without a lobby gets one (spec 7). */
export function openBase(dir: string): LocalStore {
  mkdirSync(dir, { recursive: true });
  const store = LocalStore.open(dir, { pc: pcId(dir) });
  if (![...store.state.plans.values()].some((p) => p.type === 'lobby')) store.commit(createPlan(store.state, 'Lobby', 'lobby'));
  return store;
}
