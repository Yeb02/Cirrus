import { afterEach, beforeEach, expect, test } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ancestors, canonical, checkState, groupOf, parseBranchKey, placementKey, type State } from '@cirrus/core';
import { filePath, LocalStore } from '@cirrus/store';
import { buildFixture } from '../src/build.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-fixture-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

// Sorted: Map/Set iteration order depends on insertion history, not on content.
const sorted = <T>(xs: Iterable<T>) => [...xs].map((x) => canonical(x)).sort();
const snapshot = (s: State) => canonical({
  n: sorted(s.nodes), c: sorted(s.connections), p: sorted(s.plans), t: sorted(s.tagKeys), pl: sorted(s.placements),
  b: sorted(s.branches), l: sorted(s.connLayouts), ph: sorted(s.phantoms),
});

test('la base de test se construit sans violation', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  buildFixture(store, dir);
  expect(checkState(store.state)).toEqual([]);
  store.close();
});

test('chaque fonctionnalité est présente', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  const ids = buildFixture(store, dir);
  const s = store.state;
  const live = [...s.connections.values()].filter((c) => c.trashedAt === undefined);
  const roles = (id: string) => s.connections.get(id)!.members.map((m) => m.role).sort().join(',');
  const placedIn = (node: string) => [...s.placements.values()].filter((p) => p.node === node).map((p) => p.plan);

  // Plans, by type.
  expect([...s.plans.values()].map((p) => p.type).sort()).toEqual(['document', 'lobby', 'plan']);

  // Tag registry.
  for (const key of ['statut_epistémique', 'pertinence', 'nature', 'provenance', 'auteur', 'date_de_publication']) expect(s.tagKeys.has(key)).toBe(true);
  expect(s.tagKeys.get('statut_epistémique')).toMatchObject({ type: 'enum', required: true });
  expect(s.tagKeys.get('auteur')!.multi).toBe(true);

  // The user's example.
  const mdl = s.nodes.get(ids.nodes.mdl)!;
  expect(mdl.title).toBe('Minimum Description Length Principle (MDL)');
  expect(mdl.tags).toContainEqual({ key: 'statut_epistémique', value: 'consensus_scientifique' });
  expect(mdl.files.map((f) => f.name)).toEqual(['Enoncé_détaillé.tex', 'calcul_mdl_séquence_aléatoire.py']);
  for (const f of mdl.files) expect(existsSync(filePath(dir, f))).toBe(true);
  for (const k of ['solomonoff', 'universalite', 'monde'] as const) expect(s.nodes.has(ids.nodes[k])).toBe(true);
  expect(s.nodes.size).toBeGreaterThanOrEqual(24);

  // Connections, by kind and shape.
  const ms = s.connections.get(ids.connections.mdlSolomonoff)!;
  expect(ms.tags).toContainEqual({ key: 'parallèle' });
  expect(ms.relation).not.toBe('');
  expect(roles(ids.connections.mdlSolomonoff)).toBe('associate,associate');
  expect(roles(ids.connections.twoToOne)).toBe('source,source,target');
  expect(roles(ids.connections.twoToTwo)).toBe('source,source,target,target');
  for (const kind of ['knowledge', 'inclusion', 'structure']) expect(live.some((c) => c.kind === kind)).toBe(true);

  // Groups: three levels in the lobby, another group for the same node in "Thèse", a node only in "Thèse".
  expect(Math.max(...[...s.nodes.keys()].map((n) => ancestors(s, ids.plans.lobby, n).length))).toBe(3);
  const g1 = groupOf(s, ids.plans.lobby, ids.nodes.mdl), g2 = groupOf(s, ids.plans.these, ids.nodes.mdl);
  expect(g1 && g2 && g1 !== g2).toBe(true);
  expect(placedIn(ids.nodes.theseOnly)).toEqual([ids.plans.these]);

  // A stub: a branch shown in "Thèse" whose node is not placed there.
  const stubs = [...s.branches].map(parseBranchKey)
    .filter((b) => b.plan === ids.plans.these && !s.placements.has(placementKey(b.plan, b.node)));
  expect(stubs.length).toBeGreaterThan(0);

  // Split arm: two phantoms, one of them in a group.
  const phantoms = [...s.phantoms.values()];
  expect(phantoms.map((p) => p.of.kind).sort()).toEqual(['center', 'node']);
  expect(phantoms.some((p) => p.group !== undefined)).toBe(true);

  // Document: parts 1 to 3, a sub-part, a chain of "suivant".
  const structure = live.filter((c) => c.kind === 'structure');
  const parts = structure.filter((c) => c.tags.some((t) => t.key === 'partie'));
  const rootParts = parts.filter((c) => c.members.some((m) => m.role === 'source' && m.node === ids.nodes.docRoot));
  expect(rootParts.map((c) => c.tags.find((t) => t.key === 'partie')!.value).sort()).toEqual([1, 2, 3]);
  expect(parts.length).toBeGreaterThan(rootParts.length);
  expect(structure.filter((c) => c.tags.some((t) => t.key === 'suivant')).length).toBeGreaterThanOrEqual(2);

  // Files and publications.
  const pub = s.nodes.get(ids.nodes.publication)!;
  expect(pub.tags.filter((t) => t.key === 'auteur')).toHaveLength(2);
  expect(pub.tags.some((t) => t.key === 'date_de_publication')).toBe(true);
  expect(pub.files.some((f) => f.name.endsWith('.pdf'))).toBe(true);
  expect([...s.nodes.values()].some((n) => n.files.some((f) => f.name.endsWith('.png')))).toBe(true);

  // Trash and history.
  expect(store.trash().map((n) => n.id)).toEqual([ids.nodes.trashed]);
  expect(store.changesSince(0).some((r) => r.label.startsWith('Annuler : '))).toBe(true);
  store.close();
});

test('réouverture identique', () => {
  const store = LocalStore.open(dir, { pc: 'fixture' });
  buildFixture(store, dir);
  const before = snapshot(store.state);
  store.close();
  const again = LocalStore.open(dir, { pc: 'fixture' });
  expect(snapshot(again.state)).toBe(before);
  again.close();
});
