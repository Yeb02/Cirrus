import { test, expect } from 'vitest';
import { widthPx, localScale, sampleBranch, ribbonAttributes, bundleBranches, endpointFade, bezierSegments, ribbonWorthDrawing, stubLine } from '../src/geometry/ribbon';
import { convexHull } from '../src/geometry/hull';
import { starsInRect, starLayerAlpha } from '../src/geometry/stars';
import { DEFAULT_PARAMS } from '../src/scene/params';
import type { Vec2 } from '../src/scene/types';

test('largeur bornée et fondu sous le minimum (exemples de la spec)', () => {
  expect(widthPx(8, 1, DEFAULT_PARAMS)).toEqual({ width: 5, alpha: 1 }); // brut 12 px
  expect(widthPx(1, 1, DEFAULT_PARAMS)).toEqual({ width: 1.5, alpha: 1 });
  const far = widthPx(1, 0.1, DEFAULT_PARAMS); // brut 0,15 px
  expect(far.width).toBe(1);
  expect(far.alpha).toBeCloseTo(0.15);
});

test("échelle locale géométrique le long d'une branche", () => {
  expect(localScale(0.5, 3, 0, 2)).toBeCloseTo(2.828, 3); // de 8 à 1
});

test('ruban : deux sommets par point, normales unitaires et perpendiculaires', () => {
  const line = sampleBranch({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 10 }, { x: 30, y: 10 }, 16);
  const a = ribbonAttributes(line, line.map(() => 1));
  expect(a.position.length).toBe(line.length * 2 * 2);
  for (let i = 0; i < a.normal.length; i += 2) expect(Math.hypot(a.normal[i], a.normal[i + 1])).toBeCloseTo(1);
  // perpendicular to the local tangent
  for (let j = 1; j < line.length - 1; j++) {
    const tx = line[j + 1].x - line[j - 1].x, ty = line[j + 1].y - line[j - 1].y;
    expect(Math.abs(tx * a.normal[4 * j] + ty * a.normal[4 * j + 1]) / Math.hypot(tx, ty)).toBeLessThan(1e-6); // float32
  }
});

test('faisceau : marqueur au milieu des centres, arrivée tangente au tronc', () => {
  const b = bundleBranches(
    [
      { pos: { x: 0, y: 0 }, role: 'source', k: 0 },
      { pos: { x: 0, y: 100 }, role: 'source', k: 0 },
      { pos: { x: 200, y: 50 }, role: 'target', k: 0 },
    ],
    16,
  );
  for (const { centerline: l } of b) {
    const end = l[l.length - 1], prev = l[l.length - 2];
    expect(end.x).toBeCloseTo(100);
    expect(end.y).toBeCloseTo(50); // marqueur
    expect(Math.abs(Math.sin(Math.atan2(end.y - prev.y, end.x - prev.x)))).toBeLessThan(0.05); // axe horizontal
  }
});

test('faisceau : nombre de segments adapté à la longueur de chaque branche', () => {
  const b = bundleBranches(
    [
      { pos: { x: 0, y: 0 }, role: 'source', k: 0 },
      { pos: { x: 1000, y: 0 }, role: 'target', k: 0 },
      { pos: { x: 500, y: 40 }, role: 'associate', k: 0 },
    ],
    (chord) => Math.ceil(chord / 10),
  );
  // marqueur en (500, 0) : branches de 500, 500 et 40 unités
  expect(b[0].centerline.length).toBe(51);
  expect(b[2].centerline.length).toBe(5);
});

test('extrémité : opaque à l\'écran, fondu sur la marge, invisible au-delà', () => {
  expect(endpointFade(0, DEFAULT_PARAMS)).toBe(1);
  expect(endpointFade(DEFAULT_PARAMS.connectionFadePx / 2, DEFAULT_PARAMS)).toBeCloseTo(0.5);
  expect(endpointFade(DEFAULT_PARAMS.connectionFadePx, DEFAULT_PARAMS)).toBe(0);
  expect(endpointFade(1e6, DEFAULT_PARAMS)).toBe(0);
});

test('segments selon la courbure : un seul pour une courbe droite', () => {
  expect(bezierSegments({ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }, { x: 30, y: 0 }, 1, 0.2)).toBe(1);
  // points de contrôle alignés mais inégalement espacés (cas des faisceaux) : toujours droite
  expect(bezierSegments({ x: 0, y: 0 }, { x: 900, y: 0 }, { x: 950, y: 0 }, { x: 1000, y: 0 }, 1, 0.2)).toBe(1);
  const curved = bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 1, 0.2);
  expect(curved).toBeGreaterThan(8);
  // à l'écran deux fois plus grand, il en faut plus
  expect(bezierSegments({ x: 0, y: 0 }, { x: 0, y: 100 }, { x: 100, y: 100 }, { x: 100, y: 0 }, 2, 0.2)).toBeGreaterThan(curved);
});

test('connexion trop fine pour être vue : écartée, mais pas une fois le zoom suffisant', () => {
  // deux groupes au cran 10 en vue d'ensemble : 1,5 × 1024 × 5e-6 ≈ 0,008 px de large, alpha ≈ 0,008
  expect(ribbonWorthDrawing(10, 5e-6, DEFAULT_PARAMS)).toBe(false);
  expect(ribbonWorthDrawing(10, 1e-3, DEFAULT_PARAMS)).toBe(true);
  expect(ribbonWorthDrawing(0, 1, DEFAULT_PARAMS)).toBe(true);
});

test("amorce : segment court partant de l'extrémité vers l'autre bout", () => {
  const l = stubLine({ x: 10, y: 0 }, { x: 1000, y: 0 }, 40);
  expect(l).toEqual([{ x: 10, y: 0 }, { x: 50, y: 0 }]);
});

test('enveloppe convexe', () => {
  expect(
    convexHull([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }, { x: 0.5, y: 0.5 }]),
  ).toHaveLength(4);
});

test('étoiles déterministes et fixes dans le monde', () => {
  const a = starsInRect({ x: 0, y: 0, w: 1000, h: 1000 }, 2, 7, DEFAULT_PARAMS);
  const b = starsInRect({ x: 500, y: 0, w: 1000, h: 1000 }, 2, 7, DEFAULT_PARAMS);
  const inOverlap = (s: Vec2) => s.x >= 500 && s.x < 1000;
  expect(a.filter(inOverlap).length).toBeGreaterThan(0);
  expect(a.filter(inOverlap)).toEqual(b.filter(inOverlap));
});

test("couche d'étoiles visible seulement dans son intervalle d'espacement", () => {
  // espacement écran = starCellWorld * 2^k * zoom
  expect(starLayerAlpha(0, 30 / 40, DEFAULT_PARAMS)).toBe(0); // 30 px < 40
  expect(starLayerAlpha(0, 100 / 40, DEFAULT_PARAMS)).toBeGreaterThan(0.9);
  expect(starLayerAlpha(0, 200 / 40, DEFAULT_PARAMS)).toBe(0); // 200 px > 160
});
