import { test, expect } from 'vitest';
import { generateScene } from '../src/scene/generate';
import { DEFAULT_PARAMS } from '../src/scene/params';

const spec = {
  seed: 42,
  nodeCount: 2000,
  connectionCount: 20000,
  minChildren: 4,
  maxChildren: 12,
  groupShare: 0.15,
  multiMemberShare: 0.1,
  locality: [0.8, 0.15, 0.05] as [number, number, number],
};

test('déterministe pour une graine donnée', () => {
  expect(JSON.stringify(generateScene(spec, DEFAULT_PARAMS))).toBe(
    JSON.stringify(generateScene(spec, DEFAULT_PARAMS)),
  );
});

test('respecte les volumes', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  expect(s.nodes.length).toBe(2000);
  expect(s.connections.length).toBe(20000);
});

test('chaque membre est dans le disque de son groupe', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  for (const n of s.nodes) {
    if (n.parent >= 0) {
      const g = s.nodes[n.parent];
      expect(Math.hypot(n.x - g.x, n.y - g.y)).toBeLessThanOrEqual(g.r);
    }
  }
});

test('un groupe est groupOffsetSteps crans au-dessus de ses membres', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  s.children.forEach((kids, g) => kids.forEach((c) => expect(s.nodes[g].k - s.nodes[c].k).toBe(2)));
});

test('connexions valides et proportions', () => {
  const s = generateScene(spec, DEFAULT_PARAMS);
  let multi = 0;
  let sameParent = 0;
  for (const c of s.connections) {
    const ids = c.members.map((m) => m.node);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThanOrEqual(2);
    if (ids.length >= 3) multi++;
    if (new Set(ids.map((i) => s.nodes[i].parent)).size === 1) sameParent++;
  }
  expect(multi / s.connections.length).toBeGreaterThan(0.08);
  expect(multi / s.connections.length).toBeLessThan(0.12);
  expect(sameParent / s.connections.length).toBeGreaterThanOrEqual(0.75);
});
