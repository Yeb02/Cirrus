import { setLayout, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { menuFor } from '../src/menus.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { emptySelection } from '../src/selection.ts';
import { buildIndex, computeVisible } from '../src/visibility.ts';
import { camAtTextPx, fixture, measure, P, run } from './helpers.ts';

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
  expect(m).toEqual(['connect', 'exclude', 'scaleDown', 'scaleUp', 'rename', 'hide', 'delete']);
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
  expect(actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), false))).toEqual(['newNode']);
  expect(actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), true))).toEqual(['newNode', 'paste']);
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
  const st = structuredClone(s) as State;
  const conn = ids.connections.twoToTwo;
  run(st, setLayout(st, ids.plans.lobby, conn, { angle: 1, handles: {} }));
  const scene = buildScene(st, ids.plans.lobby, measure, P);
  const line = { kind: 'connection' as const, conn: -1, key: null, ids: [conn], part: 'main' as const };
  expect(menuFor(st, scene, line, emptySelection(), false).map((m) => m.action)).toContain('resetLayout');
  expect(menuFor(s, sc, line, emptySelection(), false).map((m) => m.action)).not.toContain('resetLayout');
});

test('clic droit sur le fond d’un groupe ouvert : le menu de ce groupe, puis de quoi créer ou coller (spec 9.1, I11 de la relecture 3b)', () => {
  const m = actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), true, ids.nodes.groupeML));
  expect(m).toEqual(['connect', 'scaleDown', 'scaleUp', 'rename', 'hide', 'delete', 'newNode', 'paste']);
});
