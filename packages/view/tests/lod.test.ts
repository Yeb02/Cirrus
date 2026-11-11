import { expect, test } from 'vitest';
import { foldT, smooth, stepScale, textPx } from '../src/lod.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

const p = DEFAULT_PARAMS;

test('ordre de disparition par défaut : titres de connexion, puis texte et repli des groupes ensemble (spec 8.2)', () => {
  expect(p.titleFade[0]).toBeGreaterThan(p.textFade[0]);
  expect(foldT(0, 6 / 16, p)).toBe(1);
  expect(foldT(0, 8 / 16, p)).toBe(0);
  expect(foldT(0, 7 / 16, p)).toBeCloseTo(0.5, 9);
});

test('le repli d’un groupe suit la plage du texte : le texte de son plus grand membre et son opacité vont ensemble', () => {
  const q = { ...p, textFade: [10, 14] as [number, number] };
  expect(foldT(0, 10 / 16, q)).toBe(1);
  expect(foldT(0, 14 / 16, q)).toBe(0);
  expect(foldT(0, 12 / 16, q)).toBeCloseTo(1 - smooth(10, 14, 12), 9);
  expect('groupFold' in p).toBe(false);
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
