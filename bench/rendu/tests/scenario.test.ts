import { test, expect } from 'vitest';
import { benchScenario, cameraAt } from '../src/bench/scenario';
import { generateScene } from '../src/scene/generate';
import { DEFAULT_PARAMS } from '../src/scene/params';

const scene = generateScene({ seed: 3, nodeCount: 3000, connectionCount: 3000, minChildren: 4, maxChildren: 12, groupShare: 0.15, multiMemberShare: 0.1, locality: [0.8, 0.15, 0.05] }, DEFAULT_PARAMS);

test('scénario de 40 s qui descend jusqu\'à un nœud du cran 0 et remonte', () => {
  const kf = benchScenario(scene);
  expect(kf[0].t).toBe(0);
  expect(kf[kf.length - 1].t).toBe(40);
  const deepest = Math.max(...kf.map((k) => k.cam.zoom));
  expect(deepest).toBeGreaterThanOrEqual(1); // texte du cran 0 à 16 px au moins
  expect(kf[kf.length - 1].cam.zoom).toBeCloseTo(kf[0].cam.zoom);
});

test('interpolation : exacte aux images clés, zoom géométrique entre elles', () => {
  const kf = [
    { t: 0, cam: { x: 0, y: 0, zoom: 0.01 } },
    { t: 10, cam: { x: 100, y: 0, zoom: 1 } },
  ];
  expect(cameraAt(kf, 0)).toEqual({ x: 0, y: 0, zoom: 0.01 });
  expect(cameraAt(kf, 10)).toEqual({ x: 100, y: 0, zoom: 1 });
  expect(cameraAt(kf, 5).zoom).toBeCloseTo(0.1);
  expect(cameraAt(kf, 99)).toEqual({ x: 100, y: 0, zoom: 1 });
});
