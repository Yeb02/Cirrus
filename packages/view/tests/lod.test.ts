import { expect, test } from 'vitest';
import { foldT, smooth, stepScale, textPx } from '../src/lod.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const p = DEFAULT_PARAMS;

test('ordre de disparition par défaut : titres de connexion, texte, puis repli des groupes (spec 8.2)', () => {
  expect(p.titleFade[0]).toBeGreaterThan(p.textFade[0]);
  expect(p.textFade[0]).toBeGreaterThan(p.groupFold[0]);
  expect(foldT(0, 4 / 16, p)).toBe(1);
  expect(foldT(0, 7 / 16, p)).toBe(0);
  expect(foldT(0, 5.5 / 16, p)).toBeGreaterThan(0);
  expect(foldT(0, 5.5 / 16, p)).toBeLessThan(1);
});

test('taille du texte à l’écran : base × échelle de texte × f^k × zoom (spec 8.1)', () => {
  expect(textPx(0, 1, p)).toBe(16);
  expect(textPx(2, 0.5, p)).toBe(32);
  expect(textPx(1, 1, { ...p, textScale: 1.5 })).toBe(48);
  expect(stepScale(-1, p)).toBe(0.5);
});

test('smooth : bornes et milieu', () => {
  expect(smooth(0, 1, -1)).toBe(0);
  expect(smooth(0, 1, 2)).toBe(1);
  expect(smooth(0, 1, 0.5)).toBe(0.5);
});

test('un groupe sans membre (maxChildK -Infinity) est replié', () => {
  expect(foldT(-Infinity, 1, p)).toBe(1);
});
