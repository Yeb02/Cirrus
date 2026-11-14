import { afterEach, beforeEach, expect, test } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, applyOps, createNode, createPlan, emptyState, include, putAgendaEntry, putSheet, type RemoteUnit, setGroupColor, type State, uuidv7,
} from '@cirrus/core';
import { Canon } from '../src/canon.ts';
import { type RunningServer, startServer } from '../src/server.ts';
import { created, FORMAT, newCode, pair, T0 } from './support.ts';

// The format 2 (plan 6b, D1) at the server: a PC still at protocol 1 is refused at /hello (Review Focus 1: it must take
// the forced update, never read a write it does not know), and the new records are accepted and kept.

let dir: string;
const running: RunningServer[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-format-')); });
afterEach(async () => {
  for (const s of running.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
let at = T0;
const unit = (a: Action) => ({ unit: uuidv7(), action: a.id, label: a.label, at: at++, pc: 'pc-a', ops: a.ops });

test('un PC en protocole 1 est refusé : /hello répond 409, et dit de mettre Cirrus à jour', async () => {
  const s = await startServer({ dataDir: dir, port: 0, now: () => T0 });
  running.push(s);
  const res = await pair(s.url, { code: newCode(dir, 'pc-a', T0), pc: 'pc-a', name: 'Machine pc-a' });
  const { token } = (await res.json()) as { token: string };
  const hello = (protocol: string) => fetch(`${s.url}/hello`, { headers: { Authorization: `Bearer ${token}`, ...FORMAT, 'Cirrus-Protocol': protocol } });
  expect((await hello(FORMAT['Cirrus-Protocol'])).status).toBe(200);
  const old = await hello('1');
  expect(old.status).toBe(409);
  const { error } = (await old.json()) as { error: string };
  expect(error).toContain('protocole 2, ici 1');
  expect(error).toContain('mets à jour Cirrus');
});

test('le serveur accepte une écriture d’agenda, un feuillet et la couleur d’un groupe, relus après redémarrage ; une entrée hors de ses bornes est refusée', () => {
  const base = join(dir, 'base'), relayed: RemoteUnit[] = [];
  let canon = Canon.open(base, (u) => relayed.push(u));
  const s = emptyState();
  expect(canon.accept(unit(run(s, createPlan(s, 'Lobby', 'lobby'))), 'pc-a')).toEqual({ accepted: 1 });
  const entry = { id: 'a-1', day: '2026-11-14', title: 'Relire', text: '', nodes: [] };
  const agenda = run(s, putAgendaEntry(s, entry));
  expect(canon.accept(unit(agenda), 'pc-a')).toEqual({ accepted: 2 });
  // A base that holds an agenda entry, and nothing else, is not empty (D1): it is not taken over at a first pairing.
  expect(canon.empty()).toBe(false);
  const sheet = { id: 'f-1', createdAt: T0, text: 'Une idée.' };
  expect(canon.accept(unit(run(s, putSheet(s, sheet))), 'pc-a')).toEqual({ accepted: 3 });
  // A group, then its colour.
  const plan = run(s, createPlan(s, 'P', 'plan')), P = created(plan, 'plan');
  const g = run(s, createNode(s, { plan: P, title: 'G', x: 0, y: 0, k: 0 })), m = run(s, createNode(s, { plan: P, title: 'M', x: 0, y: 0, k: 0 }));
  const G = created(g, 'node');
  const grouped = run(s, include(s, P, created(m, 'node'), G));
  const color = run(s, setGroupColor(s, P, G, '#3a7bd5'));
  expect([plan, g, m, grouped, color].map((a) => canon.accept(unit(a), 'pc-a'))).toEqual([4, 6, 8, 11, 12].map((n) => ({ accepted: n })));
  expect(relayed.at(-1)!.ops).toEqual(color.ops);
  // Out of its bounds (a day that is not one): refused by the shared check, nothing written.
  const bad = { ...unit(agenda), ops: [{ t: 'agenda', before: null, after: { ...entry, id: 'a-2', day: '2026-02-30' } }] };
  expect(canon.accept(bad, 'pc-a')).toMatchObject({ refused: expect.stringContaining('day') });
  canon.close();
  canon = Canon.open(base, () => {});
  expect([...canon.state.agenda.values()]).toEqual([entry]);
  expect([...canon.state.sheets.values()]).toEqual([sheet]);
  expect(canon.state.placements.get(`${P}|${G}`)?.color).toBe('#3a7bd5');
  expect(canon.seq).toBe(12);
  canon.close();
});
