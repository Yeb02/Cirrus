import { buildLargeState } from '@cirrus/fixtures';
import { expect, test } from 'vitest';
import { intruders } from '../src/edit.ts';
import { buildScene } from '../src/scene.ts';
import { measure, P } from './helpers.ts';

// Costs at the scale the spec aims for (spec 21), on the bench's synthetic base: what runs at every edit must not
// grow with the square of the plan (C1 of the plan 3b review: intruders took 15 s at 50 000 nodes).
const { state, lobby } = buildLargeState({ seed: 3, nodes: 20_000, connections: 20_000 });
const scene = buildScene(state, lobby, measure, P);

test('les intrus d’une scène de 20 000 nœuds se trouvent en moins de 150 ms', () => {
  const t0 = performance.now();
  const found = intruders(scene);
  const ms = performance.now() - t0;
  expect(found.size).toBeGreaterThanOrEqual(0);
  expect(ms).toBeLessThan(150);
});
