import { expect, test } from 'vitest';
import { groupPalette, hexToRgb, mixRgb, oklchToRgb, rgbToHex } from '../src/color.ts';
import { DEFAULT_PARAMS } from '../src/params.ts';

test('OKLCH : blanc, noir', () => {
  expect(oklchToRgb(1, 0, 0).map((v) => Math.round(v * 255))).toEqual([255, 255, 255]);
  expect(oklchToRgb(0, 0, 0)).toEqual([0, 0, 0]);
});

test('OKLCH : une teinte bleue a plus de bleu que de rouge, et reste dans le gamut', () => {
  const [r, g, b] = oklchToRgb(0.6, 0.15, 255);
  expect(b).toBeGreaterThan(r);
  for (const c of [r, g, b]) {
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  }
});

test('teinte conservée entre niveaux, luminosités distinctes (spec 8.4)', () => {
  const a = groupPalette({ depth: 0, hue: 255 }, DEFAULT_PARAMS), b = groupPalette({ depth: 1, hue: 255 }, DEFAULT_PARAMS);
  expect(a.closed).not.toEqual(b.closed);
  for (const c of [...a.closed, ...a.open, ...b.closed, ...b.open]) {
    expect(c).toBeGreaterThanOrEqual(0);
    expect(c).toBeLessThanOrEqual(1);
  }
});

test('la couleur ouverte est la repliée vue à travers le ciel, opaque', () => {
  const p = DEFAULT_PARAMS;
  const a = groupPalette({ depth: 0, hue: 200 }, p);
  expect(a.open).toEqual(mixRgb(p.skyColor, a.closed, p.envelopeOpacityOpen));
});

test('une profondeur extrême reste dans les bornes de luminosité', () => {
  for (let d = 0; d < 30; d++) {
    for (const c of groupPalette({ depth: d, hue: 60 }, DEFAULT_PARAMS).closed) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(1);
    }
  }
});

test('hexadécimal aller-retour', () => {
  expect(hexToRgb('#ff8000')).toEqual([1, 128 / 255, 0]);
  expect(rgbToHex([1, 128 / 255, 0])).toBe('#ff8000');
  expect(rgbToHex(hexToRgb('#0a1120'))).toBe('#0a1120');
});
