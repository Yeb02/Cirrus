import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  type Action, type Anchor, applyOps, canonical, type ConnectionLayout, connect, createAnnotation, createNode, createPlan, DEFAULT_PREAMBLE, editNode,
  emptyState, encodeState, fromSnapshot, type Id, type NodeRec, OpConflictError, type PhantomRec, preambleText, reconcile, type RemoteUnit, removeFromPlan,
  setPreamble, SNAPSHOT_VERSION, type State, type TagKeyDef, toSnapshot, type Unit, uuidv7,
} from '@cirrus/core';
import { LocalStore, SCHEMA_VERSION } from '../src/localStore.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-store-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

const afterId = (a: Action, t: string): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
/** The store keeps no state: the interface's copy, here, moves only once an action is written (EditSession). */
const write = (store: LocalStore, s: State, a: Action): number => { const seq = store.commit(a); applyOps(s, a.ops); return seq; };
const same = (a: State, b: State) => expect(canonical(sorted(a))).toBe(canonical(sorted(b)));
const sorted = (s: State) => Object.fromEntries(Object.entries(toSnapshot(s)).map(([k, v]) => [k, Array.isArray(v) ? v.map((x) => canonical(x)).sort() : canonical(v)]));

/** What schema 4 added (plan 5a), taken away: the journal as schema 3 left it, for the bases of earlier plans. */
const BEFORE_V4 = `DROP INDEX changes_unit; DROP INDEX changes_pending; ALTER TABLE changes DROP COLUMN unit; ALTER TABLE changes DROP COLUMN kind;
  ALTER TABLE changes DROP COLUMN superseded;`;

function withPlan(store: LocalStore, s: State): Id {
  const a = createPlan(s, 'Thèse', 'plan');
  write(store, s, a);
  return afterId(a, 'plan');
}

test('ouvrir crée la base au schéma courant, avec les tables de l’instantané et du préambule', () => {
  LocalStore.open(dir, { pc: 'pc1' }).close();
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  expect((db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  for (const name of ['snapshot', 'preamble']) expect(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name), name).toBeDefined();
  db.close();
  expect(SCHEMA_VERSION).toBe(4);
});

test('un fichier qui n’est pas une base : ouvrir échoue sans le garder ouvert (il s’efface aussitôt)', () => {
  const file = join(dir, 'cirrus.db');
  writeFileSync(file, Buffer.alloc(8192, 0x5a));
  expect(() => LocalStore.open(dir, { pc: 'pc1' })).toThrow(/not a database/);
  rmSync(file);
  expect(existsSync(file)).toBe(false);
});

test('une action validée persiste et se recharge depuis les tables à la réouverture', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'Minimum Description Length Principle (MDL)', x: 1, y: 2, k: 0 });
  write(store, s, a);
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' }), loaded = again.loadState();
  expect(loaded.nodes.get(afterId(a, 'node'))!.title).toBe('Minimum Description Length Principle (MDL)');
  expect(loaded.placements.size).toBe(1);
  same(loaded, s);
  again.close();
});

test('le journal reçoit une ligne par opération, numéros locaux croissants ; commit rend celui de la dernière', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.lastSeq()).toBe(0);
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  expect(write(store, s, a)).toBe(3);
  expect(store.lastSeq()).toBe(3);
  const all = store.changesSince(0);
  expect(all.map((r) => r.localSeq)).toEqual([1, 2, 3]);
  expect(all.every((r) => r.serverSeq === null && r.pc === 'pc1')).toBe(true);
  expect(all.slice(1).every((r) => r.actionId === a.id)).toBe(true);
  expect(all.map((r) => r.flow)).toEqual(['content', 'content', 'layout']);
  expect(store.changesSince(2).map((r) => r.op)).toEqual([a.ops[1]]);
  store.close();
});

test('commit refuse un « avant » périmé, relu dans la base : ni ligne, ni journal, même après des opérations déjà écrites (ROLLBACK)', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const ok = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, ok);
  const other = createNode(s, { plan, title: 'B', x: 5, y: 0, k: 0 });
  write(store, s, other);
  const link = connect(s, { plan, members: [{ node: afterId(ok, 'node'), role: 'source' }, { node: afterId(other, 'node'), role: 'target' }] });
  write(store, s, link);
  const n = s.nodes.get(afterId(ok, 'node'))!, c = s.connections.get(afterId(link, 'connection'))!;
  // A tag key, a layout, a phantom and a preamble in the base, for their stale "befores" too.
  const key: TagKeyDef = { key: 'mot', type: 'word', scope: 'both', multi: false, required: false };
  const layout: ConnectionLayout = { plan, connection: c.id, marker: { x: 1, y: 2 }, handles: {} };
  const phantom: PhantomRec = { id: 'f-1', plan, connection: c.id, of: { kind: 'node', node: n.id }, x: 3, y: 4, k: 0 };
  write(store, s, { id: 'extra', label: 'extra', ops: [
    { t: 'tagKey', before: null, after: key }, { t: 'connLayout', before: null, after: layout }, { t: 'phantom', before: null, after: phantom },
    { t: 'preamble', before: null, after: { text: 'P' } },
  ] });
  const fresh: NodeRec = { id: 'n-new', title: 'Nouveau', summary: '', tags: [], files: [] };
  const stale: Op[][] = [
    [{ t: 'node', before: { ...n, title: 'périmé' }, after: { ...n, title: 'C' } }],
    [{ t: 'node', before: null, after: { ...n, title: 'déjà là' } }],
    [{ t: 'connection', before: { ...c, title: 'autre' }, after: { ...c, title: 'D' } }],
    [{ t: 'branch', key: { plan, connection: c.id, node: 'personne' }, before: true, after: false }],
    [{ t: 'placement', before: { plan, node: n.id, x: 9, y: 9, k: 0 }, after: null }],
    [{ t: 'plan', before: null, after: { id: plan, name: 'Double', type: 'plan' } }],
    [{ t: 'tagKey', before: { ...key, multi: true }, after: null }],
    [{ t: 'tagKey', before: null, after: { ...key, required: true } }],
    [{ t: 'connLayout', before: { ...layout, angle: 1 }, after: null }],
    [{ t: 'phantom', before: { ...phantom, x: 9 }, after: { ...phantom, x: 10 } }],
    [{ t: 'phantom', before: null, after: { ...phantom, y: 0 } }],
    [{ t: 'preamble', before: null, after: { text: 'Q' } }],
    [{ t: 'preamble', before: { text: 'autre' }, after: { text: 'Q' } }],
    [{ t: 'preamble', before: { text: 'autre' }, after: null }],
  ];
  const tables = () => canonical(sorted(store.loadState()));
  const before = tables(), seq = store.lastSeq();
  for (const ops of stale) {
    const bad: Action = { id: 'bad', label: 'bad', ops: [{ t: 'node', before: null, after: fresh }, ...ops] };
    expect(() => store.commit(bad), JSON.stringify(ops[0])).toThrow(OpConflictError);
    expect(store.lastSeq()).toBe(seq);
    expect(tables()).toBe(before);
  }
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  expect(again.loadState().nodes.has('n-new')).toBe(false);
  expect(again.changesSince(seq)).toEqual([]);
  again.close();
});

test('l’« avant » se compare au sens canonique (ordre des clés, propriétés indéfinies), et les opérations d’une action se voient l’une l’autre', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, a);
  const n = s.nodes.get(afterId(a, 'node'))!;
  const reordered = { files: n.files, tags: n.tags, summary: n.summary, title: n.title, id: n.id, trashedAt: undefined } as NodeRec;
  const twice: Action = { id: 'x', label: 'deux fois', ops: [
    { t: 'node', before: reordered, after: { ...n, title: 'A2' } },
    { t: 'node', before: { ...n, title: 'A2' }, after: { ...n, title: 'A3' } },
  ] };
  write(store, s, twice);
  expect(store.loadState().nodes.get(n.id)!.title).toBe('A3');
  store.close();
});

test('un enregistrement que l’état refuserait, sans tags, une connexion comme un nœud, est refusé avant toute écriture : la base se relit toujours', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const node = [...s.nodes.keys()][0], seq = store.lastSeq(), tables = () => canonical(sorted(store.loadState())), before = tables();
  const fresh: NodeRec = { id: 'n-new', title: 'Nouveau', summary: '', tags: [], files: [] };
  const tagless: Op[] = [
    { t: 'connection', before: null, after: { id: 'c-bad', kind: 'knowledge', title: '', relation: '', members: [{ node, role: 'source' }] } as never },
    { t: 'node', before: null, after: { id: 'n-bad', title: 'Sans tags', summary: '', files: [] } as never },
    { t: 'node', before: s.nodes.get(node)!, after: { ...s.nodes.get(node)!, tags: undefined } as never },
    { t: 'preamble', before: null, after: { text: 42 } as never },
  ];
  for (const op of tagless) {
    expect(() => store.commit({ id: 'b', label: 'b', ops: [{ t: 'node', before: null, after: fresh }, op] }), JSON.stringify(op)).toThrow(/invalid/);
    expect(store.lastSeq()).toBe(seq);
    expect(tables()).toBe(before);
  }
  store.close();
});

test('un nœud d’annotation (plan 4c) s’écrit et se relit avec son ancre ; une ancre invalide est refusée avant toute écriture', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const pdfNode = createNode(s, { plan, title: 'Chapitre 1', x: 0, y: 0, k: 0 });
  write(store, s, pdfNode);
  const anchor: Anchor = { pdf: afterId(pdfNode, 'node'), file: 'chapitre_1.pdf', hash: 'ab'.repeat(32), page: 2, rects: [[72, 711, 413.5, 724.8], [72, 695, 190, 708.8]], text: 'Un code est préfixe\nsi aucun de ses mots' };
  const a = createAnnotation(s, anchor, 'Un code est préfixe si aucun de ses mots');
  write(store, s, a);
  const id = afterId(a, 'node');
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' }), loaded = again.loadState();
  expect(loaded.nodes.get(id)!.anchor).toEqual(anchor);
  same(loaded, s);
  expect(again.historyOf(id).map((r) => r.label)).toEqual(['Annoter « Un code est préfixe si aucun de ses mots », p. 2']);
  const n = loaded.nodes.get(id)!, seq = again.lastSeq(), tables = () => canonical(sorted(again.loadState())), before = tables();
  for (const bad of [{ ...anchor, page: 0 }, { ...anchor, rects: [] }, { ...anchor, hash: 'AB'.repeat(32) }]) {
    expect(() => again.commit({ id: 'b', label: 'b', ops: [{ t: 'node', before: n, after: { ...n, anchor: bad } }] }), JSON.stringify(bad)).toThrow(/invalid node anchor/);
    expect(again.lastSeq()).toBe(seq);
    expect(tables()).toBe(before);
  }
  again.close();
});

test('un enregistrement de connexion que l’état refuserait (genre, rôle, corbeille) est refusé avant toute écriture', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const node = [...s.nodes.keys()][0], seq = store.lastSeq();
  const base = { id: 'c-bad', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node, role: 'source' }] };
  for (const after of [{ ...base, kind: 'bogus' }, { ...base, members: [{ node, role: 'bogus' }] }, { ...base, trashedAt: 'hier' }]) {
    expect(() => store.commit({ id: 'b', label: 'b', ops: [{ t: 'connection', before: null, after } as Op] })).toThrow();
    expect(store.lastSeq()).toBe(seq);
  }
  store.close();
});

test('historique par objet', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, a);
  const id = afterId(a, 'node');
  write(store, s, editNode(s, id, { title: 'A2' }));
  write(store, s, editNode(s, id, { title: 'A3' }));
  expect(store.historyOf(id).filter((r) => r.op.t === 'node')).toHaveLength(3);
  store.close();
});

test('corbeille et lobby lus en SQL', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.hasLobby()).toBe(false);
  const plan = withPlan(store, s);
  expect(store.hasLobby()).toBe(false);
  write(store, s, createPlan(s, 'Lobby', 'lobby'));
  expect(store.hasLobby()).toBe(true);
  const a = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  write(store, s, a);
  write(store, s, createNode(s, { plan, title: 'B', x: 0, y: 0, k: 0 }));
  expect(store.trash()).toEqual([]);
  write(store, s, removeFromPlan(s, plan, afterId(a, 'node')));
  expect(store.trash()).toEqual([s.nodes.get(afterId(a, 'node'))]);
  store.close();
});

test('instantané : écrit puis relu ; un plus ancien ne remplace pas un plus récent ; au-delà du journal ou pas un instantané, refusé', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.readSnapshot()).toBeNull();
  withPlan(store, s);
  const first = encodeState(s), seq1 = store.lastSeq();
  store.writeSnapshot(first, seq1);
  const read = store.readSnapshot()!;
  expect([read.seq, read.version, read.data.byteLength]).toEqual([seq1, SNAPSHOT_VERSION, first.byteLength]);
  expect(new Uint8Array(read.data)).toEqual(new Uint8Array(first));
  const plan2 = createPlan(s, 'Deux', 'plan');
  write(store, s, plan2);
  const second = encodeState(s), seq2 = store.lastSeq();
  store.writeSnapshot(second, seq2);
  // Older, or the same seq again: ignored.
  store.writeSnapshot(first, seq1);
  store.writeSnapshot(first, seq2);
  expect(new Uint8Array(store.readSnapshot()!.data)).toEqual(new Uint8Array(second));
  expect(() => store.writeSnapshot(second, seq2 + 1)).toThrow();
  expect(() => store.writeSnapshot(new ArrayBuffer(64), seq2)).toThrow();
  expect(store.readSnapshot()!.seq).toBe(seq2);
  store.dropSnapshot();
  expect(store.readSnapshot()).toBeNull();
  store.close();
});

test('migration du schéma 1 au schéma 2 : additive, rien de perdu, sans instantané', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'Ancien', x: 0, y: 0, k: 0 }));
  store.close();
  // The base as plan 3b left it: schema 1, no snapshot table (nor the preamble's of schema 3).
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  db.exec(`${BEFORE_V4} DROP TABLE snapshot; DROP TABLE preamble; PRAGMA user_version = 1;`);
  db.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  same(again.loadState(), s);
  expect(again.changesSince(0)).toHaveLength(3);
  expect(again.readSnapshot()).toBeNull();
  again.close();
});

test('un préambule écrit se relit après réouverture, dans l’historique de son sujet ; l’annuler efface sa ligne', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  expect(store.loadState().preamble).toBeNull();
  const text = `${DEFAULT_PREAMBLE}\\newcommand{\\K}{\\mathrm{K}}\n`;
  const a = setPreamble(s, text);
  write(store, s, a);
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc1' }), loaded = again.loadState();
  expect(loaded.preamble).toEqual({ text });
  expect(preambleText(loaded)).toBe(text);
  same(loaded, s);
  expect(again.historyOf('preamble').map((r) => [r.label, r.flow, r.op])).toEqual([['Modifier le préambule LaTeX', 'content', a.ops[0]]]);
  write(again, s, { id: 'undo', label: 'Annuler', ops: [{ t: 'preamble', before: { text }, after: null }] });
  expect(again.loadState().preamble).toBeNull();
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  expect(db.prepare('SELECT COUNT(*) AS n FROM preamble').get()).toEqual({ n: 0 });
  db.close();
  again.close();
});

test('migration du schéma 2 au schéma 3 : la table du préambule ajoutée, rien de perdu, sans préambule', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  write(store, s, createNode(s, { plan, title: 'Ancien', x: 0, y: 0, k: 0 }));
  store.writeSnapshot(encodeState(s), store.lastSeq());
  store.close();
  // The base as plan 4a left it: schema 2, its snapshot, no preamble table.
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  db.exec(`${BEFORE_V4} DROP TABLE preamble; PRAGMA user_version = 2;`);
  db.close();
  const again = LocalStore.open(dir, { pc: 'pc1' }), loaded = again.loadState();
  same(loaded, s);
  expect([loaded.preamble, preambleText(loaded)]).toEqual([null, DEFAULT_PREAMBLE]);
  expect(again.changesSince(0)).toHaveLength(3);
  expect(again.readSnapshot()!.seq).toBe(3);
  write(again, s, setPreamble(s, 'nouveau'));
  expect(again.loadState().preamble).toEqual({ text: 'nouveau' });
  again.close();
  const check = new DatabaseSync(join(dir, 'cirrus.db'));
  expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(SCHEMA_VERSION);
  check.close();
});

// Plan 5a: the journal's writes (units), their kind, the lines a reconciliation replaced, the server's numbers.

const wire = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const T0 = Date.UTC(2026, 10, 8, 9);
/** Commits `a` as one write of this PC (pc-a) and applies it to the interface's copy: the pending unit it keeps (task 4). */
function commitUnit(store: LocalStore, s: State, a: Action, at = T0): Unit {
  const unit = uuidv7();
  store.commit(a, { unit, at });
  applyOps(s, a.ops);
  return { unit, action: a.id, label: a.label, at, pc: 'pc-a', ops: a.ops };
}
/** The tables' state rebuilt by replaying the whole journal, in local order, from an empty state. */
function replayed(store: LocalStore): State {
  const t = emptyState();
  applyOps(t, store.changesSince(0).map((r) => r.op));
  return t;
}

test('migration du schéma 3 au schéma 4 : chaque ligne devient l’écriture de son action, locale, en attente ; rien de perdu', () => {
  const store = LocalStore.open(dir, { pc: 'pc1' }), s = emptyState();
  const plan = withPlan(store, s);
  const a = createNode(s, { plan, title: 'Ancien', x: 0, y: 0, k: 0 });
  write(store, s, a);
  store.close();
  // The base as plan 4c left it: schema 3, a journal without units, kinds or replaced lines.
  const db = new DatabaseSync(join(dir, 'cirrus.db'));
  db.exec(`${BEFORE_V4} PRAGMA user_version = 3;`);
  db.close();
  const again = LocalStore.open(dir, { pc: 'pc1' });
  same(again.loadState(), s);
  const rows = again.changesSince(0);
  expect(rows).toHaveLength(3);
  expect(rows.every((r) => r.unit === r.actionId && r.kind === 'local' && !r.superseded && r.serverSeq === null)).toBe(true);
  expect(again.pendingUnits().map((u) => [u.action, u.label, u.ops.length])).toEqual([[rows[0].actionId, 'Créer le plan « Thèse »', 1], [a.id, a.label, 2]]);
  expect(again.lastServerSeq()).toBe(0);
  again.close();
  const check = new DatabaseSync(join(dir, 'cirrus.db'));
  expect((check.prepare('PRAGMA user_version').get() as { user_version: number }).user_version).toBe(4);
  check.close();
});

test('commit : l’identifiant de l’écriture, son heure et son PC donnés ; pendingUnits rend les écritures en attente, dans l’ordre, bornées', () => {
  const store = LocalStore.open(dir, { pc: 'pc-a' }), s = emptyState();
  const p = createPlan(s, 'Thèse', 'plan');
  store.commit(p, { unit: 'u1', at: 5 });
  applyOps(s, p.ops);
  const plan = (p.ops[0].after as { id: Id }).id;
  const n = createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 });
  expect(store.commit(n, { unit: 'u2', at: 6 })).toBe(3);
  applyOps(s, n.ops);
  const id = (n.ops[0].after as NodeRec).id;
  // Two saves of a .tex: one action, two writes (D5).
  const e1 = editNode(s, id, { title: 'A1' });
  store.commit(e1);
  applyOps(s, e1.ops);
  const e2 = { ...editNode(s, id, { title: 'A2' }), id: e1.id };
  store.commit(e2, { pc: 'pc-z' });
  const units = store.pendingUnits();
  expect(units.slice(0, 2)).toEqual([
    { unit: 'u1', action: p.id, label: p.label, at: 5, pc: 'pc-a', ops: wire(p.ops) },
    { unit: 'u2', action: n.id, label: n.label, at: 6, pc: 'pc-a', ops: wire(n.ops) },
  ]);
  expect(units.slice(2).map((u) => [u.action, u.pc])).toEqual([[e1.id, 'pc-a'], [e1.id, 'pc-z']]);
  expect(units[2].unit).not.toBe(units[3].unit);
  expect(store.pendingUnits(1).map((u) => u.unit)).toEqual(['u1']);
  expect(store.pendingUnits(3).map((u) => u.unit)).toEqual(['u1', 'u2', units[2].unit]);
  expect(store.changesSince(0).map((r) => r.unit)).toEqual(['u1', 'u2', 'u2', units[2].unit, units[3].unit]);
  // A reading stopped early leaves nothing in progress: the next write goes through.
  store.commit(createPlan(s, 'Autre', 'plan'), { unit: 'u5' });
  expect(store.pendingUnits().map((u) => u.unit).at(-1)).toBe('u5');
  // Counted without reading their operations (the client's status, plan 5a task 3).
  expect(store.pendingCount()).toBe(5);
  store.close();
});

/**
 * A PC (pc-a) wrote a plan, a node and its renaming, all pending; the server accepted the first two as they were, then
 * a write of pc-b on the node, before the renaming came: what the PC receives.
 */
function scenario() {
  const store = LocalStore.open(dir, { pc: 'pc-a' }), s = emptyState();
  const u0 = commitUnit(store, s, createPlan(s, 'Thèse', 'plan'));
  const plan = (u0.ops[0].after as { id: Id }).id;
  const u1 = commitUnit(store, s, createNode(s, { plan, title: 'A', x: 0, y: 0, k: 0 }));
  const id = (u1.ops[0].after as NodeRec).id;
  const u2 = commitUnit(store, s, editNode(s, id, { title: 'A2' }), T0 + 2);
  const server = emptyState();
  applyOps(server, wire([...u0.ops, ...u1.ops]));
  const b = editNode(server, id, { summary: 'vu par B' });
  applyOps(server, b.ops);
  const incoming: RemoteUnit[] = [
    { ...wire(u0), seq: 1 }, { ...wire(u1), seq: 3 }, { unit: 'ub', action: b.id, label: b.label, at: T0 + 1, pc: 'pc-b', ops: wire(b.ops), seq: 4 },
  ];
  return { store, s, server, id, u0, u1, u2, incoming };
}

test('applyReconciliation : accusés numérotés en place, inverses, reçues et rejouées écrites ; last_server_seq ; le journal rejoué redonne les tables', () => {
  const { store, s, server, id, u0, u1, u2, incoming } = scenario();
  expect(store.pendingUnits().map((u) => u.unit)).toEqual([u0.unit, u1.unit, u2.unit]);
  const r = reconcile(s, store.pendingUnits(), incoming, []);
  expect(r.acked).toEqual([u0.unit, u1.unit]);
  expect(r.rewind).toHaveLength(1);
  expect(store.applyReconciliation(r)).toBe(store.lastSeq());
  same(store.loadState(), s);
  same(replayed(store), store.loadState());
  expect(store.lastServerSeq()).toBe(4);
  expect(store.pendingUnits()).toEqual(wire(r.rebased));
  expect(store.pendingCount()).toBe(1);
  expect(store.changesSince(0).map((x) => [x.kind, x.serverSeq, x.superseded, x.unit, x.pc])).toEqual([
    ['local', 1, false, u0.unit, 'pc-a'], ['local', 2, false, u1.unit, 'pc-a'], ['local', 3, false, u1.unit, 'pc-a'],
    ['local', null, true, u2.unit, 'pc-a'],
    ['rewind', null, false, expect.any(String), 'pc-a'],
    ['remote', 4, false, 'ub', 'pc-b'],
    ['local', null, false, u2.unit, 'pc-a'],
  ]);
  // The history shows local and received lines (the node's creation and placement), the replaced one too, never the inverses.
  expect(store.historyOf(id).map((x) => [x.kind, x.superseded])).toEqual([['local', false], ['local', false], ['local', true], ['remote', false], ['local', false]]);
  // The server takes the replayed write: its echo is an acknowledgement, numbered in place.
  applyOps(server, wire(r.rebased[0].ops));
  const ack = reconcile(s, store.pendingUnits(), [{ ...wire(r.rebased[0]), seq: 5 }], []);
  expect(ack.acked).toEqual([u2.unit]);
  store.applyReconciliation(ack);
  expect(store.pendingUnits()).toEqual([]);
  expect(store.pendingCount()).toBe(0);
  expect(store.lastServerSeq()).toBe(5);
  same(store.loadState(), server);
  same(replayed(store), server);
  store.close();
  const again = LocalStore.open(dir, { pc: 'pc-a' });
  expect(again.lastServerSeq()).toBe(5);
  again.close();
});

test('applyReconciliation : tout ou rien — un « avant » périmé, un trou dans les numéros du serveur, la même réconciliation deux fois', () => {
  const { store, s, incoming } = scenario();
  const tables = () => canonical(sorted(store.loadState())), journal = () => JSON.stringify(store.changesSince(0));
  const r = reconcile(fromSnapshot(toSnapshot(s)), store.pendingUnits(), incoming, []);
  const before = [tables(), journal(), store.lastServerSeq()];
  const n = r.remote[2].ops[0].before as NodeRec;
  const stale = { ...r, remote: [r.remote[0], r.remote[1], { ...r.remote[2], ops: [{ ...r.remote[2].ops[0], before: { ...n, title: 'jamais vu' } }] as Op[] }] };
  expect(() => store.applyReconciliation(stale)).toThrow(OpConflictError);
  expect([tables(), journal(), store.lastServerSeq()]).toEqual(before);
  const gap = { ...r, remote: [r.remote[0], r.remote[1], { ...r.remote[2], seq: 9 }] };
  expect(() => store.applyReconciliation(gap)).toThrow(/numéro/);
  expect([tables(), journal(), store.lastServerSeq()]).toEqual(before);
  const m = r.rebased[0].ops[0].before as NodeRec;
  const badRebased = { ...r, rebased: [{ ...r.rebased[0], ops: [{ ...r.rebased[0].ops[0], before: { ...m, title: 'autre' } }] as Op[] }] };
  expect(() => store.applyReconciliation(badRebased)).toThrow(OpConflictError);
  expect([tables(), journal(), store.lastServerSeq()]).toEqual(before);
  store.applyReconciliation(r);
  const after = [tables(), journal(), store.lastServerSeq()];
  expect(() => store.applyReconciliation(r)).toThrow();
  expect([tables(), journal(), store.lastServerSeq()]).toEqual(after);
  store.close();
});

type Op = Action['ops'][number];

test('commit numéroté (le serveur, plan 5a) : chaque ligne prend son numéro du journal comme numéro du serveur, rien n’est en attente', () => {
  const store = LocalStore.open(dir, { pc: 'serveur' }), s = emptyState();
  const plan = createPlan(s, 'P', 'plan');
  applyOps(s, plan.ops);
  expect(store.commit(plan, { at: 5, unit: 'u1', pc: 'pc-a', numbered: true })).toBe(1);
  const node = createNode(s, { plan: afterId(plan, 'plan'), title: 'X', x: 0, y: 0, k: 0 });
  applyOps(s, node.ops);
  expect(store.commit(node, { at: 6, unit: 'u2', pc: 'pc-b', numbered: true })).toBe(3);
  expect(store.changesSince(0).map((r) => [r.localSeq, r.serverSeq, r.unit, r.pc, r.at, r.kind])).toEqual([
    [1, 1, 'u1', 'pc-a', 5, 'local'], [2, 2, 'u2', 'pc-b', 6, 'local'], [3, 3, 'u2', 'pc-b', 6, 'local'],
  ]);
  expect(store.pendingUnits()).toEqual([]);
  // A write of the server, found again by its identifier: its number (its last line's) and its PC.
  expect(store.numberedUnit('u2')).toEqual({ seq: 3, pc: 'pc-b' });
  expect(store.numberedUnit('inconnue')).toBeNull();
  // A pending line (a PC's) is not one of the server's.
  const edit = editNode(s, afterId(node, 'node'), { title: 'Y' });
  store.commit(edit, { unit: 'u3' });
  expect(store.numberedUnit('u3')).toBeNull();
  // The journal by pages.
  expect(store.changesSince(1, 1).map((r) => r.localSeq)).toEqual([2]);
  expect(store.changesSince(0).map((r) => r.localSeq)).toEqual([1, 2, 3, 4]);
  store.close();
});

test('unitsAfter : les écritures numérotées après un numéro, entières, par pages ; un numéro au milieu d’une écriture est refusé', () => {
  const store = LocalStore.open(dir, { pc: 'serveur' }), s = emptyState();
  const plan = createPlan(s, 'P', 'plan');
  applyOps(s, plan.ops);
  store.commit(plan, { at: 1, unit: 'u1', pc: 'pc-a', numbered: true });
  const P = afterId(plan, 'plan');
  const nodes: Action[] = [];
  for (let i = 0; i < 4; i++) {
    const a = createNode(s, { plan: P, title: `n${i}`, x: i, y: 0, k: 0 });
    applyOps(s, a.ops);
    store.commit(a, { at: 2 + i, unit: `n${i}`, pc: 'pc-b', numbered: true });
    nodes.push(a);
  }
  // Lines: 1 (u1), 2-3 (n0), 4-5 (n1), 6-7 (n2), 8-9 (n3).
  const all = store.unitsAfter(0, 1000);
  expect(all.map((u) => [u.unit, u.seq, u.ops.length])).toEqual([['u1', 1, 1], ['n0', 3, 2], ['n1', 5, 2], ['n2', 7, 2], ['n3', 9, 2]]);
  expect(all[1]).toEqual({ unit: 'n0', action: nodes[0].id, label: nodes[0].label, at: 2, pc: 'pc-b', ops: nodes[0].ops, seq: 3 });
  // At least `minLines` lines, then up to the end of the write: never half of one.
  expect(store.unitsAfter(1, 3).map((u) => u.seq)).toEqual([3, 5]);
  expect(store.unitsAfter(3, 1).map((u) => u.seq)).toEqual([5]);
  expect(store.unitsAfter(9, 10)).toEqual([]);
  expect(() => store.unitsAfter(2, 10)).toThrow(RangeError);
  store.close();
});
