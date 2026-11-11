import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOp, placeNode, setBranches, type Action, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { beforeEach, expect, test } from 'vitest';
import { connectionElsewhere, memberElsewhere, nodesElsewhere } from '../src/renderer/ui/graph/where.ts';

let s: State, ids: FixtureIds;
beforeEach(() => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-where-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
const run = (a: Action) => { for (const op of a.ops) applyOp(s, op); };

// The questions « Ici seulement / Partout » are asked only when another plan is concerned (2026-11-11): these say so.
test('des nœuds : ailleurs dès que l’un d’eux est placé dans un autre plan', () => {
  const { nodes, plans } = ids;
  expect(nodesElsewhere(s, plans.lobby, [nodes.monde, nodes.occam])).toBe(false);
  expect(nodesElsewhere(s, plans.lobby, [nodes.monde, nodes.mdl])).toBe(true); // MDL is in « Thèse » too
  expect(nodesElsewhere(s, plans.these, [nodes.theseOnly])).toBe(false);
  run(placeNode(s, plans.lecture, nodes.monde, 0, 0, 0));
  expect(nodesElsewhere(s, plans.lobby, [nodes.monde])).toBe(true);
});

test('un membre d’une connexion : ailleurs s’il y est montré dans un autre plan', () => {
  const { nodes, plans, connections } = ids;
  expect(memberElsewhere(s, plans.lobby, connections.mdlSolomonoff, nodes.mdl)).toBe(false);
  run(setBranches(s, connections.mdlSolomonoff, [{ plan: plans.these, node: nodes.mdl }], true));
  expect(memberElsewhere(s, plans.lobby, connections.mdlSolomonoff, nodes.mdl)).toBe(true);
  expect(memberElsewhere(s, plans.lobby, connections.mdlSolomonoff, nodes.solomonoff)).toBe(false);
  // Shown in another plan only, not here: elsewhere all the same.
  expect(memberElsewhere(s, plans.lecture, connections.mdlSolomonoff, nodes.mdl)).toBe(true);
});

test('une connexion : ailleurs si une de ses branches ou un de ses fantômes est dans un autre plan', () => {
  const { nodes, plans, connections } = ids;
  expect(connectionElsewhere(s, plans.lobby, connections.associates)).toBe(false);
  expect(connectionElsewhere(s, plans.these, connections.twoToOne)).toBe(false);
  expect(connectionElsewhere(s, plans.lobby, connections.split)).toBe(false); // its phantoms are in the lobby
  run(setBranches(s, connections.associates, [{ plan: plans.these, node: nodes.compression }], true));
  expect(connectionElsewhere(s, plans.lobby, connections.associates)).toBe(true);
});
