import { expect, test } from 'vitest';
import { gridLevels } from '../src/geometry/grid.ts';
import { starLayerAlpha, starLayers, starsInRect } from '../src/geometry/stars.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const P = DEFAULT_PARAMS;

test('étoiles déterministes et fixées dans le plan', () => {
  const r = { x: -500, y: -300, w: 1000, h: 600 };
  expect(starsInRect(r, 0, 7, P)).toEqual(starsInRect(r, 0, 7, P));
  const inner = starsInRect({ x: -100, y: -100, w: 200, h: 200 }, 0, 7, P);
  const outer = starsInRect(r, 0, 7, P);
  for (const s of inner) expect(outer).toContainEqual(s);
});

test.each([1e-3, 0.37, 1, 42, 1e3])('zoom %f : au plus trois couches, chacune bornée en densité (Review Focus 5)', (zoom) => {
  const ks = starLayers(zoom, P);
  expect(ks.length).toBeGreaterThan(0);
  expect(ks.length).toBeLessThanOrEqual(3);
  const w = 2560 / zoom, h = 1600 / zoom;
  for (const k of ks) {
    expect(starLayerAlpha(k, zoom, P)).toBeGreaterThan(0);
    expect(starsInRect({ x: -w / 2, y: -h / 2, w, h }, k, 7, P).length).toBeLessThan(10_000);
  }
});

test('grille fractale : niveaux à espacement borné, opacité au plus gridAlpha', () => {
  for (const zoom of [1e-3, 1, 1e3]) {
    const levels = gridLevels(zoom, P);
    expect(levels.length).toBeGreaterThan(0);
    for (const l of levels) {
      const px = l.spacingWorld * zoom;
      expect(px).toBeGreaterThanOrEqual(P.gridSpacingPx[0] - 1e-9);
      expect(px).toBeLessThanOrEqual(P.gridSpacingPx[1] + 1e-9);
      expect(l.alpha).toBeLessThanOrEqual(P.gridAlpha);
    }
  }
});

test('paramètres dégénérés hors des fiches : les couches restent bornées et le calcul se termine (C1)', () => {
  for (const bad of [{ factor: 1 }, { factor: Number.NaN }, { starSpacingPx: [0, 160] as [number, number] }, { gridSpacingPx: [0, 0] as [number, number] }, { starCellWorld: 0 }]) {
    const p = { ...P, ...bad };
    expect(starLayers(0.3, p).length).toBeLessThanOrEqual(3);
    expect(gridLevels(1, p).length).toBeLessThanOrEqual(64);
  }
});
