import { expect, test } from 'vitest';
import { chosenPalette, groupPalette, paletteColors, hexToRgb, mixRgb, oklchToRgb, rgbToHex, rgbToOklch } from '../src/color.ts';
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

test('rgbToOklch est l’inverse de oklchToRgb dans la gamme (plan 6b, D4) : 200 couleurs tirées, à 1e-3 près', () => {
  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < 200; i++) {
    const c: [number, number, number] = [rand(), rand(), rand()];
    const { L, C, h } = rgbToOklch(c);
    const back = oklchToRgb(L, C, h);
    for (let j = 0; j < 3; j++) expect(Math.abs(back[j] - c[j])).toBeLessThan(1e-3);
  }
  expect(rgbToOklch([1, 1, 1]).L).toBeCloseTo(1, 3);
  expect(rgbToOklch([0, 0, 0]).L).toBeCloseTo(0, 6);
});

test('chosenPalette (D4) : le groupe coloré montre sa couleur exacte ; ses sous-groupes, sa teinte, à un pas de luminosité chacun', () => {
  const p = DEFAULT_PARAMS, color = '#3a7bd5';
  const own = chosenPalette(color, 0, p);
  expect(rgbToHex(own.closed)).toBe(color);
  expect(own.open).toEqual(mixRgb(p.skyColor, own.closed, p.envelopeOpacityOpen));
  const base = rgbToOklch(hexToRgb(color)), one = rgbToOklch(chosenPalette(color, 1, p).closed), two = rgbToOklch(chosenPalette(color, 2, p).closed);
  expect(Math.abs(one.h - base.h)).toBeLessThan(1);
  expect(Math.abs(one.L - base.L - p.groupLightnessStep)).toBeLessThan(1e-3);
  expect(Math.abs(two.L - one.L - p.groupLightnessStep)).toBeLessThan(1e-3);
});

test('chosenPalette (Review Focus 2) : noir, blanc et un vert saturé donnent des sous-groupes distincts du groupe et entre eux', () => {
  const p = DEFAULT_PARAMS;
  for (const color of ['#000000', '#ffffff', '#00ff00']) {
    const L = [0, 1, 2, 3].map((d) => rgbToOklch(chosenPalette(color, d, p).closed).L);
    expect(rgbToHex(chosenPalette(color, 0, p).closed), color).toBe(color);
    for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) expect(Math.abs(L[i] - L[j]), `${color} ${i}/${j}`).toBeGreaterThanOrEqual(0.03);
  }
});

test('paletteColors (D4) : 12 couleurs #rrggbb distinctes, à la luminosité des groupes', () => {
  const c = paletteColors(DEFAULT_PARAMS);
  expect(c).toHaveLength(12);
  expect(new Set(c).size).toBe(12);
  for (const x of c) {
    expect(x).toMatch(/^#[0-9a-f]{6}$/);
    expect(Math.abs(rgbToOklch(hexToRgb(x)).L - DEFAULT_PARAMS.groupLightness)).toBeLessThan(0.02);
  }
});
