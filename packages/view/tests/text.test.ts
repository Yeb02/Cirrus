import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeAll, expect, test } from 'vitest';
import { NO_PARENT } from '../src/geometry/envelope.ts';
import { buildInstances } from '../src/instances.ts';
import { buildScene, type PlanScene } from '../src/scene.ts';
import { FloatList } from '../src/geometry/arrays.ts';
import {
  appendTitle, type FontData, GLYPH_AT, GLYPH_FIELDS, GLYPH_FLOATS, layoutText, measureLines, parseBmFont, TITLE_CONNECTION, TITLE_NODE,
} from '../src/text.ts';
import { buildIndex, computeVisible } from '../src/visibility.ts';
import { camAtTextPx, fixture, measure, P } from './helpers.ts';

// The app's MSDF font (scripts/build-font.mjs): Inter, 48 units, distance range 6.
const FNT = fileURLToPath(new URL('../../app/src/renderer/public/font/inter-msdf.fnt', import.meta.url));
let font: FontData;
beforeAll(() => {
  font = parseBmFont(readFileSync(FNT, 'utf8'));
});

/** Where a glyph instance's fields start. */
const { anchor: A, title: T, fold: F, slot: S } = GLYPH_AT;

/** A node title at base size, wrapped at the box's inner width. */
const node = (text: string) => layoutText(font, text, P.baseFontPx, P.boxWidth - 2 * P.boxPadX, P.baseFontPx * P.lineHeight);

test('parseBmFont lit info, common, distanceField, les caractères et les crénages de inter-msdf.fnt', () => {
  expect(font.chars).toHaveLength(401);
  expect(font.distanceRange).toBe(6);
  expect(font.fieldType).toBe('msdf');
  expect(font.size).toBe(48);
  expect(font.scaleW).toBe(740);
  expect(font.scaleH).toBe(747);
  expect([font.lineHeight, font.base]).toEqual([58, 47]);
  expect(font.kernings).toHaveLength(520);
  expect(font.chars.find((c) => c.id === 0x3f)).toEqual({ id: 63, x: 496, y: 536, width: 26, height: 42, xoffset: -1, yoffset: 9, xadvance: 25 });
  // Characters whose `char` attribute is escaped (&lt; &amp; &quot;) are read by their id.
  for (const id of [0x3c, 0x26, 0x22]) expect(font.chars.some((c) => c.id === id)).toBe(true);
});

test('la largeur d’une ligne vaut la somme des avances et des crénages', () => {
  const text = '*,*.';
  const adv = (id: number) => font.chars.find((c) => c.id === id)!.xadvance;
  const kern = (a: number, b: number) => font.kernings.find((k) => k.first === a && k.second === b)?.amount ?? 0;
  const codes = [...text].map((ch) => ch.codePointAt(0)!);
  const kernings = codes.slice(1).reduce((sum, c, i) => sum + kern(codes[i], c), 0);
  expect(kernings).toBeLessThan(0);
  const units = codes.reduce((sum, c) => sum + adv(c), 0) + kernings;
  expect(layoutText(font, text, font.size, 0, 60).width).toBe(units);
  expect(layoutText(font, text, 16, 0, 20).width).toBeCloseTo((units * 16) / font.size, 9);
});

test('coupure gloutonne aux espaces : les nombres de lignes connus, et la place de BitmapText', () => {
  expect(node('Entropie de Shannon').lines).toBe(1);
  expect(node('Complexité de Kolmogorov').lines).toBe(2);
  expect(node('Minimum Description Length Principle (MDL)').lines).toBe(2);
  expect(node('An Introduction to Kolmogorov Complexity and Its Applications').lines).toBe(3);
  // Pixi 8's own layout and placement (anchor 0.5), checked against getBitmapTextLayout before it was removed: lines
  // centred, positions rounded in font units, the block lowered by the font's base line offset.
  const l = node('Complexité de Kolmogorov');
  expect(l.width).toBeCloseTo(109.333333, 5);
  expect(l.height).toBe(40);
  expect(l.glyphs).toHaveLength(22);
  expect(l.glyphs[0]).toMatchObject({ x: expect.closeTo(-54.666667, 5), y: expect.closeTo(-15.166667, 5), w: 12, h: 14 });
  expect(l.glyphs[21]).toMatchObject({ x: expect.closeTo(36.333333, 5), y: expect.closeTo(7.833333, 5) });
  expect(l.glyphs[0].u0).toBeCloseTo(445 / 740, 9);
});

test('un mot de 60 caractères tient sur une seule ligne, qui dépasse ; après un autre mot, il passe seul à la ligne', () => {
  const word = 'x'.repeat(60);
  const l = node(word);
  expect(l.lines).toBe(1);
  expect(l.width).toBeGreaterThan(P.boxWidth - 2 * P.boxPadX);
  expect(node(`court ${word}`).lines).toBe(2);
});

test('un titre vide donne une ligne et aucun glyphe ; « ℝ€ », absents de l’atlas, deviennent des « ? »', () => {
  const empty = node('');
  expect(empty.lines).toBe(1);
  expect(empty.glyphs).toHaveLength(0);
  const odd = node('ℝ€');
  const question = node('?').glyphs[0];
  expect(odd.lines).toBe(1);
  expect(odd.glyphs).toHaveLength(2);
  for (const g of odd.glyphs) expect([g.u0, g.v0, g.w, g.h]).toEqual([question.u0, question.v0, question.w, question.h]);
});

test('measureLines : les lignes de layoutText à la taille de base, sans la ligne vide que comptait BitmapText', () => {
  const m = measureLines(font, P);
  for (const t of ['', 'Entropie de Shannon', 'Complexité de Kolmogorov', 'An Introduction to Kolmogorov Complexity and Its Applications', 'x'.repeat(60)]) {
    expect(m(t)).toBe(node(t).lines);
  }
  expect(m('Entropie de Shannon')).toBe(1);
});

test('le titre d’un nœud donne une instance par glyphe visible ; un texte illisible au zoom servi n’est pas construit', () => {
  const { s, ids } = fixture();
  const sc: PlanScene = buildScene(s, ids.plans.lobby, measure, P);
  const frameAt = (px: number) => {
    const cam = camAtTextPx(sc, 0, px);
    const visible = computeVisible(sc, buildIndex(sc, P), cam, P);
    const origin = { x: cam.x, y: cam.y };
    return { visible, origin, inst: buildInstances(sc, visible, cam, origin, P, undefined, font) };
  };
  const { visible, origin, inst } = frameAt(16);
  const g = inst.texts.view();
  expect(g.length % GLYPH_FLOATS).toBe(0);
  const of = (j: number) => {
    const out: number[] = [];
    for (let o = 0; o < g.length; o += GLYPH_FLOATS) if (g[o + T + 1] === TITLE_NODE && g[o + T + 2] === j) out.push(o);
    return out;
  };
  const j = visible.items.indexOf(sc.byId.get(ids.nodes.kolmogorov)!);
  const at = of(j), it = sc.items[visible.items[j]];
  expect(at).toHaveLength(node(it.title).glyphs.length);
  // Anchored on its item (the item texture gives its centre, plan 3c task 8).
  for (const o of at) expect([g[o + A], g[o + A + 1], g[o + S], g[o + T], g[o + T + 3], g[o + F]]).toEqual([0, 0, visible.items[j], P.baseFontPx, 1, NO_PARENT]);
  // A node's phantom is dimmed.
  const ph = visible.items.findIndex((i) => sc.items[i].kind === 'phantom' && sc.items[i].phantom === 'node');
  expect(ph).toBeGreaterThanOrEqual(0);
  expect(g[of(ph)[0] + T + 3]).toBeCloseTo(P.phantomTitleDim, 6);
  // Far out, no box title is readable even at the deepest zoom served: none is built.
  const far = frameAt(1).inst.texts.view();
  for (let o = 0; o < far.length; o += GLYPH_FLOATS) expect(far[o + T + 1]).not.toBe(TITLE_NODE);
  // Without a font, no glyph.
  const cam = camAtTextPx(sc, 0, 16);
  expect(buildInstances(sc, visible, cam, origin, P).texts.length).toBe(0);
});

test('la disposition d’une instance de glyphe n’a qu’une définition : appendTitle écrit chaque champ à sa place', () => {
  expect(GLYPH_FIELDS.map(([f]) => f)).toEqual(['anchor', 'glyph', 'atlas', 'title', 'fold', 'slot']);
  expect(GLYPH_FIELDS.reduce((n, [, size]) => n + size, 0)).toBe(GLYPH_FLOATS);
  let at = 0;
  for (const [f, size] of GLYPH_FIELDS) { expect(GLYPH_AT[f]).toBe(at); at += size; }
  const out = new FloatList();
  appendTitle(out, font, 'Ab', 32, 0, 40, 5, 6, TITLE_CONNECTION, 3, 0.5, 7, 8, 9);
  const l = layoutText(font, 'Ab', 32, 0, 40), d = out.view(), s = 32 / font.size, G = GLYPH_AT.glyph, U = GLYPH_AT.atlas;
  expect(d.length).toBe(l.glyphs.length * GLYPH_FLOATS);
  l.glyphs.forEach((gl, j) => {
    const o = j * GLYPH_FLOATS;
    expect([d[o + A], d[o + A + 1]]).toEqual([5, 6]);
    [gl.x, gl.y, gl.w, gl.h].forEach((v, c) => expect(d[o + G + c] * s).toBeCloseTo(v, 5));
    expect(d[o + U] / font.scaleW).toBeCloseTo(gl.u0, 9);
    expect(d[o + U + 1] / font.scaleH).toBeCloseTo(gl.v0, 9);
    expect([d[o + T], d[o + T + 1], d[o + T + 2], d[o + T + 3], d[o + F], d[o + F + 1], d[o + S]]).toEqual([32, TITLE_CONNECTION, 3, 0.5, 7, 8, 9]);
  });
});
