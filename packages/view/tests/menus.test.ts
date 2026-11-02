import type { State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeAll, expect, test } from 'vitest';
import { menuFor } from '../src/menus.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { emptySelection } from '../src/selection.ts';
import { fixture, measure, P } from './helpers.ts';

let s: State, ids: FixtureIds, sc: PlanScene, these: PlanScene;
beforeAll(() => {
  ({ s, ids } = fixture());
  sc = buildScene(s, ids.plans.lobby, measure, P);
  these = buildScene(s, ids.plans.these, measure, P);
});
const item = (scene: PlanScene, id: string) => ({ kind: 'item' as const, item: scene.byId.get(id)! });
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
  expect(actions(menuFor(s, these, { kind: 'stub', conn: 0, stub: 0 }, emptySelection(), false))).toEqual(['importNode']);
  expect(actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), false))).toEqual(['newNode']);
  expect(actions(menuFor(s, sc, { kind: 'background' }, emptySelection(), true))).toEqual(['newNode', 'paste']);
});

test('chaque article a un libellé français', () => {
  for (const it of menuFor(s, sc, item(sc, ids.nodes.mdl), emptySelection(), true)) expect(it.label.length).toBeGreaterThan(2);
});
