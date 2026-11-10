import { placeNode, setBranches, setLayout, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { menuFor } from '../src/menus.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { emptySelection } from '../src/selection.ts';
import { copyOf, fixture, measure, P, run } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene, these: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
  these = buildScene(s, ids.plans.these, measure, P);
});
const item = (scene: PlanScene, id: string) => ({ kind: 'item' as const, item: scene.byId.get(id)!, id });
const actions = (m: { action: string }[]) => m.map((x) => x.action);

test('nœud membre d’un groupe : connexion, sortie du groupe, échelle, renommer, cacher, supprimer', () => {
  const m = actions(menuFor(s, sc, item(sc, ids.nodes.mdl), emptySelection(), false));
  // MDL is also in the thesis' and the article's plans: « Voir dans un autre plan » ends its menu (plan 6a, D3).
  expect(m).toEqual(['connect', 'exclude', 'scaleDown', 'scaleUp', 'rename', 'hide', 'delete', 'seeElsewhere']);
});

test('nœud libre dans un plan ordinaire absent du lobby : pas de sortie de groupe, mais « ajouter au lobby »', () => {
  const m = actions(menuFor(s, these, item(these, ids.nodes.theseOnly), emptySelection(), false));
  expect(m).not.toContain('exclude');
  expect(m).toContain('addToLobby');
  // MDL is already in the lobby.
  expect(actions(menuFor(s, these, item(these, ids.nodes.mdl), emptySelection(), false))).not.toContain('addToLobby');
});

test('élément d’une sélection de plusieurs : le menu de sélection (spec 9.1)', () => {
  const sel = { items: new Set([ids.nodes.mdl, ids.nodes.monde]), connections: new Set<string>() };
  expect(actions(menuFor(s, sc, item(sc, ids.nodes.mdl), sel, true))).toEqual(['copy', 'hide', 'scaleDown', 'scaleUp', 'delete']);
});

test('fantôme, amorce, connexion, fond', () => {
  expect(actions(menuFor(s, sc, item(sc, ids.phantoms.node), emptySelection(), false))).toEqual(['teleport', 'joinArm']);
  expect(actions(menuFor(s, these, { kind: 'stub', conn: 0, stub: 0, connection: ids.connections.twoToOne, node: ids.nodes.entropie, title: '' }, emptySelection(), false))).toEqual(['importNode']);
  expect(actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), false))).toEqual(['newNode', 'importPublication', 'importBib', 'tagRegistry']);
  expect(actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), true))).toEqual(['newNode', 'paste', 'importPublication', 'importBib', 'tagRegistry']);
  // Plan 4c, task 5: a publication imported by its identifier, put down where the menu was opened.
  expect(menuFor(s, sc, { kind: 'background' }, emptySelection(), false)[1].label).toBe('Importer une publication…');
  // Task 6: a whole .bib, chosen in the system's dialog, its publications following the cursor in a block.
  expect(menuFor(s, sc, { kind: 'background' }, emptySelection(), false)[2].label).toBe('Importer un fichier .bib…');
  // Plan 6a, D4: the tag registry's panel, opened from the sky's menu, last.
  expect(menuFor(s, sc, { kind: 'background' }, emptySelection(), false)[3]).toEqual({ action: 'tagRegistry', label: 'Registre des tags…' });
});

test('chaque article a un libellé français', () => {
  for (const it of menuFor(s, sc, item(sc, ids.nodes.mdl), emptySelection(), true)) expect(it.label.length).toBeGreaterThan(2);
});

test('une connexion absente du lobby peut y être ajoutée (spec 7)', () => {
  const line = (id: string) => ({ kind: 'connection' as const, conn: -1, key: null, ids: [id], part: 'main' as const });
  expect(menuFor(s, these, line(ids.connections.twoToOne), emptySelection(), false).map((m) => m.action)).toContain('addToLobby');
  expect(menuFor(s, sc, line(ids.connections.twoToTwo), emptySelection(), false).map((m) => m.action)).not.toContain('addToLobby');
});

test('une connexion disposée à la main peut retrouver sa disposition automatique (spec 8.5)', () => {
  const st = copyOf(s);
  const conn = ids.connections.twoToTwo;
  run(st, setLayout(st, ids.plans.lobby, conn, { angle: 1, handles: {} }));
  const scene = buildScene(st, ids.plans.lobby, measure, P);
  const line = { kind: 'connection' as const, conn: -1, key: null, ids: [conn], part: 'main' as const };
  expect(menuFor(st, scene, line, emptySelection(), false).map((m) => m.action)).toContain('resetLayout');
  expect(menuFor(s, sc, line, emptySelection(), false).map((m) => m.action)).not.toContain('resetLayout');
});

test('clic droit sur le fond d’un groupe ouvert : le menu de ce groupe, puis de quoi créer ou coller (spec 9.1, I11 de la relecture 3b)', () => {
  const m = actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), true, ids.nodes.groupeML));
  expect(m).toEqual(['connect', 'scaleDown', 'scaleUp', 'rename', 'hide', 'delete', 'newNode', 'paste', 'importPublication', 'importBib', 'tagRegistry']);
});

test('« Voir dans un autre plan » (plan 6a, D3) : proposé à un nœud ou à une connexion seulement s’il est dans un autre plan — le lobby compte —, libellé en français', () => {
  const line = (id: string) => ({ kind: 'connection' as const, conn: -1, key: null, ids: [id], part: 'main' as const });
  const sees = (m: { action: string }[]) => actions(m).includes('seeElsewhere');
  // A node: in the lobby and elsewhere; in the lobby alone; in a plan and the lobby (which counts); in one plan alone.
  expect(sees(menuFor(s, sc, item(sc, ids.nodes.mdl), emptySelection(), false))).toBe(true);
  expect(sees(menuFor(s, sc, item(sc, ids.nodes.monde), emptySelection(), false))).toBe(false);
  expect(sees(menuFor(s, these, item(these, ids.nodes.compression), emptySelection(), false))).toBe(true);
  expect(sees(menuFor(s, these, item(these, ids.nodes.theseOnly), emptySelection(), false))).toBe(false);
  expect(menuFor(s, sc, item(sc, ids.nodes.mdl), emptySelection(), false).at(-1)).toEqual({ action: 'seeElsewhere', label: 'Voir dans un autre plan' });
  // After « ajouter au lobby » for a node that is in neither: the menu ends with both.
  const st = copyOf(s);
  run(st, placeNode(st, ids.plans.article, ids.nodes.theseOnly, 0, 0, 0));
  const sc2 = buildScene(st, ids.plans.article, measure, P);
  expect(actions(menuFor(st, sc2, item(sc2, ids.nodes.theseOnly), emptySelection(), false)).slice(-2)).toEqual(['addToLobby', 'seeElsewhere']);
  // A connection: drawn in the thesis' plan alone, then also in the lobby.
  expect(sees(menuFor(s, these, line(ids.connections.twoToOne), emptySelection(), false))).toBe(false);
  expect(sees(menuFor(s, sc, line(ids.connections.twoToTwo), emptySelection(), false))).toBe(false);
  const both = copyOf(s);
  run(both, setBranches(both, ids.connections.twoToOne, both.connections.get(ids.connections.twoToOne)!.members.map((m) => ({ plan: ids.plans.lobby, node: m.node })), true));
  const scThese = buildScene(both, ids.plans.these, measure, P);
  expect(menuFor(both, scThese, line(ids.connections.twoToOne), emptySelection(), false).map((m) => m.action)).toContain('seeElsewhere');
  // Never for a phantom, a stub, the background, or a selection of several.
  expect(sees(menuFor(s, sc, item(sc, ids.phantoms.node), emptySelection(), false))).toBe(false);
  const sel = { items: new Set([ids.nodes.mdl, ids.nodes.monde]), connections: new Set<string>() };
  expect(sees(menuFor(s, sc, item(sc, ids.nodes.mdl), sel, true))).toBe(false);
});
