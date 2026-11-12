import { FloatList } from './geometry/arrays.ts';
import type { RenderParams } from './params.ts';
import type { Measure } from './scene.ts';

/** A glyph of a bitmap font: its rectangle in the atlas (texels) and its metrics, in the font's units (`FontData.size`). */
interface FontChar { id: number; x: number; y: number; width: number; height: number; xoffset: number; yoffset: number; xadvance: number }

/**
 * A bitmap font as its BMFont XML descriptor gives it (scripts/build-font.mjs): plain data.
 */
export interface FontData {
  face: string;
  /** The size the glyphs were made at: every metric is in these units. */
  size: number;
  lineHeight: number;
  base: number;
  scaleW: number;
  scaleH: number;
  fieldType: string;
  /** The distance field's range, in atlas texels. */
  distanceRange: number;
  chars: FontChar[];
  kernings: { first: number; second: number; amount: number }[];
}

const ATTRIBUTE = /(\w+)="([^"]*)"/g;
/** A tag and its attributes; a quoted value may hold ">" (a character's own `char`). */
const tags = (xml: string, name: string): Record<string, string>[] =>
  [...xml.matchAll(new RegExp(`<${name}\\b((?:\\s+\\w+="[^"]*")*)\\s*/?>`, 'g'))].map((m) => Object.fromEntries([...m[1].matchAll(ATTRIBUTE)].map((a) => [a[1], a[2]])));

/**
 * The BMFont XML descriptor read with regular expressions (no DOMParser: the tests read it under Node). Reads
 * `info`, `common`, `distanceField`, the characters (by their `id`, a code point) and the kernings.
 */
export function parseBmFont(xml: string): FontData {
  const [info] = tags(xml, 'info'), [common] = tags(xml, 'common'), [field] = tags(xml, 'distanceField');
  if (!info || !common) throw new Error('Police BMFont illisible : info ou common absent.');
  const n = (r: Record<string, string>, key: string) => {
    const v = Number(r[key]);
    if (!Number.isFinite(v)) throw new Error(`Police BMFont illisible : ${key} absent ou invalide.`);
    return v;
  };
  return {
    face: info.face ?? '', size: n(info, 'size'), lineHeight: n(common, 'lineHeight'), base: n(common, 'base'),
    scaleW: n(common, 'scaleW'), scaleH: n(common, 'scaleH'), fieldType: field?.fieldType ?? 'none', distanceRange: field ? n(field, 'distanceRange') : 0,
    chars: tags(xml, 'char').map((c) => ({
      id: n(c, 'id'), x: n(c, 'x'), y: n(c, 'y'), width: n(c, 'width'), height: n(c, 'height'), xoffset: n(c, 'xoffset'), yoffset: n(c, 'yoffset'), xadvance: n(c, 'xadvance'),
    })),
    kernings: tags(xml, 'kerning').map((k) => ({ first: n(k, 'first'), second: n(k, 'second'), amount: n(k, 'amount') })),
  };
}

/** A title laid out in the font's units: per glyph x0, y0 (its top-left from the title's centre), w, h, and its place in the atlas. */
interface UnitLayout { lines: number; width: number; count: number; glyphs: Float32Array }
const UNIT = 6;

/** What a font is read through: glyphs by code point, kernings by pair, and the layouts already made. */
interface FontIndex {
  font: FontData;
  /** Index in `font.chars` by code point, -1 when absent. */
  byCode: Int32Array;
  /** Kerning by pair, first × 0x110000 + second. */
  kerning: Map<number, number>;
  space: number;
  question: number;
  /** The layouts made, by wrap width, line height (font units) and text; the oldest used is dropped beyond LAYOUT_CACHE_MAX. */
  layouts: Map<string, UnitLayout>;
}

/**
 * Layouts kept per font: more than the titles of the densest frame (Ruling R23: data-structure tuning, see the
 * registry). Past it, the least recently used is dropped.
 */
const LAYOUT_CACHE_MAX = 16_384;
const PAIR = 0x110000;
const indices = new WeakMap<FontData, FontIndex>();

function indexOf(font: FontData): FontIndex {
  let fi = indices.get(font);
  if (fi) return fi;
  const top = font.chars.reduce((m, c) => Math.max(m, c.id), 0);
  const byCode = new Int32Array(top + 1).fill(-1);
  font.chars.forEach((c, i) => { byCode[c.id] = i; });
  const kerning = new Map<number, number>();
  for (const k of font.kernings) kerning.set(k.first * PAIR + k.second, k.amount);
  const at = (code: number) => (code < byCode.length ? byCode[code] : -1);
  fi = { font, byCode, kerning, space: at(0x20), question: at(0x3f), layouts: new Map() };
  indices.set(font, fi);
  return fi;
}

/** Pixi's `/\s/` test, which splits words at any Unicode space, the no-break space included. */
const SPACE = /\s/;
/** Characters a line may end after (as Pixi's BitmapText): hyphen, Unicode hyphen, en and em dashes, soft hyphen. */
const BREAK_AFTER = new Set([0x2d, 0x2010, 0x2013, 0x2014, 0xad]);

// Scratch lists of the layout in progress (one layout at a time: JS runs one task at a time).
const wordPos: number[] = [], wordGlyph: number[] = [];
const glyphPos: number[] = [], glyphChar: number[] = [], glyphLine: number[] = [];
const lineWidths: number[] = [];

/**
 * BitmapText's layout (Pixi 8, centred, `whiteSpace: 'pre'`, lines trimmed at the end), which drew the titles until
 * plan 3c task 7: the boxes were sized by it and its line breaks are kept. Greedy wrap at spaces (and after a hyphen
 * or a dash); a word too long overflows, alone on its line; kernings apply, the space's included. A character absent
 * from the font is drawn as « ? », or takes a space's advance if « ? » is absent too; an absent space is a space.
 * `wrapFU` 0: no wrapping. Lengths in the font's units.
 */
function layoutUnits(fi: FontIndex, text: string, wrapFU: number, lhFU: number, withGlyphs: boolean): UnitLayout {
  const { font, byCode, kerning } = fi;
  wordPos.length = wordGlyph.length = glyphPos.length = glyphChar.length = glyphLine.length = lineWidths.length = 0;
  let lineWidth = 0, wordWidth = 0, firstWord = true, prev = -1;
  /** Advances of the collapsible spaces ending the line, removed when it ends (BitmapText's trimEnd, kerning kept). */
  let trailing = 0;
  const overflows = () => !firstWord && wrapFU > 0 && lineWidth + wordWidth > wrapFU;
  const endWord = () => {
    for (let j = 0; j < wordGlyph.length; j++) {
      glyphPos.push(wordPos[j] + lineWidth);
      glyphChar.push(wordGlyph[j]);
      glyphLine.push(lineWidths.length);
    }
    if (wordGlyph.length > 0) trailing = 0;
    lineWidth += wordWidth;
    wordWidth = 0;
    wordPos.length = wordGlyph.length = 0;
    firstWord = false;
  };
  const endLine = () => {
    lineWidths.push(lineWidth - trailing);
    lineWidth = 0;
    trailing = 0;
    firstWord = true;
  };
  const chars = [...text];
  for (let i = 0; i <= chars.length; i++) {
    const end = i === chars.length;
    let code = end ? -1 : chars[i].codePointAt(0)!;
    const newline = code === 0x0a || code === 0x0d;
    const space = !end && !newline && SPACE.test(chars[i]);
    let g = end || newline ? -1 : code < byCode.length ? byCode[code] : -1;
    if (g < 0 && space) { code = 0x20; g = fi.space; }
    if (end || newline || space) {
      if (overflows()) endLine();
      endWord();
      if (newline) endLine();
      else if (!end && g >= 0) {
        const advance = font.chars[g].xadvance + (kerning.get(prev * PAIR + code) ?? 0);
        lineWidth += advance;
        // The no-break space ends a line's trimming, as in Pixi: only spaces and tabs are collapsible.
        if (code === 0x20 || code === 0x09) trailing += font.chars[g].xadvance; else trailing = 0;
      }
    } else {
      if (g < 0) { code = 0x3f; g = fi.question; }
      if (g < 0) {
        wordWidth += fi.space >= 0 ? font.chars[fi.space].xadvance : 0;
      } else {
        const k = kerning.get(prev * PAIR + code) ?? 0;
        wordPos.push(wordWidth + k);
        wordGlyph.push(g);
        wordWidth += font.chars[g].xadvance + k;
      }
      if (BREAK_AFTER.has(code)) {
        if (overflows()) endLine();
        endWord();
      }
    }
    prev = code;
  }
  endLine();
  const lines = lineWidths.length, width = Math.max(0, ...lineWidths);
  if (!withGlyphs) return { lines, width, count: 0, glyphs: new Float32Array(0) };
  // Pixi's placement: each line centred on the widest, positions rounded in font units, the block centred with the
  // font's base line offset (lineHeight − base) below.
  const offset = font.lineHeight - font.base;
  const shiftY = lhFU - font.size - 2 * offset < 0 ? 0 : (lhFU - font.size) / 2;
  const x0 = width / 2, y0 = (lines * lhFU + offset) / 2;
  let count = 0;
  for (let j = 0; j < glyphChar.length; j++) { const c = font.chars[glyphChar[j]]; if (c.width > 0 && c.height > 0) count++; }
  const out = new Float32Array(count * UNIT);
  let o = 0;
  for (let j = 0; j < glyphChar.length; j++) {
    const c = font.chars[glyphChar[j]];
    if (c.width <= 0 || c.height <= 0) continue;
    const line = glyphLine[j], align = width / 2 - lineWidths[line] / 2;
    out[o++] = Math.round(glyphPos[j] + align + c.xoffset) - x0;
    out[o++] = Math.round(offset + line * lhFU + c.yoffset + shiftY) - y0;
    out[o++] = c.width;
    out[o++] = c.height;
    out[o++] = c.x;
    out[o++] = c.y;
  }
  return { lines, width, count, glyphs: out };
}

/** The layout of a title in font units, from the font's cache (most recently used last). */
function cachedLayout(fi: FontIndex, text: string, wrapFU: number, lhFU: number): UnitLayout {
  const key = `${wrapFU} ${lhFU} ${text}`;
  let l = fi.layouts.get(key);
  if (l) {
    fi.layouts.delete(key);
  } else {
    l = layoutUnits(fi, text, wrapFU, lhFU, true);
    if (fi.layouts.size >= LAYOUT_CACHE_MAX) fi.layouts.delete(fi.layouts.keys().next().value!);
  }
  fi.layouts.set(key, l);
  return l;
}

interface TextLayout {
  lines: number;
  width: number;
  height: number;
  /** World rectangles centred on (0, 0), each line centred, and their atlas coordinates (0 to 1). */
  glyphs: { x: number; y: number; w: number; h: number; u0: number; v0: number; u1: number; v1: number }[];
}

/**
 * A title laid out at world font size `size`: wrapped at world width `wrap` (0: not wrapped), `lineHeight` between
 * lines. Cached by text, wrap width and line height in font units, computed as Pixi did, `wrap × (font.size / size)`
 * at each call: the steps whose product comes out the same share a layout, one that differs by an ulp has its own
 * entry, and could in principle wrap differently from the boxes' measure (measureLines) at an exact boundary, as
 * BitmapText could.
 */
export function layoutText(font: FontData, text: string, size: number, wrap: number, lineHeight: number): TextLayout {
  const fi = indexOf(font), s = size / font.size;
  const l = cachedLayout(fi, text, wrap * (font.size / size), lineHeight * (font.size / size));
  const glyphs: TextLayout['glyphs'] = [];
  for (let j = 0; j < l.count; j++) {
    const g = l.glyphs.subarray(j * UNIT, (j + 1) * UNIT);
    glyphs.push({
      x: g[0] * s, y: g[1] * s, w: g[2] * s, h: g[3] * s,
      u0: g[4] / font.scaleW, v0: g[5] / font.scaleH, u1: (g[4] + g[2]) / font.scaleW, v1: (g[5] + g[3]) / font.scaleH,
    });
  }
  return { lines: l.lines, width: l.width * s, height: l.lines * lineHeight, glyphs };
}

/**
 * The lines a node's box is sized for (the scene's measure): the title at base size, wrapped at the box's inner width.
 * Exactly the title's lines: the empty line BitmapText counted after the last is no longer added (user's decision on
 * the Ruling of plan 3c task 7). Cached per title.
 */
export function measureLines(font: FontData, p: RenderParams): Measure {
  const fi = indexOf(font), k = font.size / p.baseFontPx;
  const wrapFU = (p.boxWidth - 2 * p.boxPadX) * k, lhFU = p.baseFontPx * p.lineHeight * k;
  const cache = new Map<string, number>();
  return (title) => {
    let n = cache.get(title);
    if (n === undefined) cache.set(title, (n = layoutUnits(fi, title, wrapFU, lhFU, false).lines));
    return n;
  };
}

/** Kinds of title (a glyph instance's `kind`): their fades differ (spec 8.2, 8.4, 8.5). */
export const TITLE_NODE = 0, TITLE_GROUP_OPEN = 1, TITLE_GROUP_CLOSED = 2, TITLE_CONNECTION = 3;

/**
 * A glyph instance (`Instances.texts`): its fields in order, interleaved, with their sizes in floats. The one
 * definition: appendTitle writes at GLYPH_AT, the renderer's attributes are `a` + each field's name.
 * - anchor (2): the title's centre, world: from its item's centre when it has a slot (a title follows its item through
 *   the item texture, plan 3c task 8), else relative to the origin (a connection's title);
 * - glyph (4): x0, y0, w, h of its rectangle from the anchor, in font units;
 * - atlas (2): its top-left in the atlas, in texels;
 * - title (4): world font size, kind (TITLE_*), visible index (the connection's, for the hover), attenuation;
 * - fold (2): the group's or the fading connection's maxChildK, the parent group's (NO_PARENT: none);
 * - slot (1): its item's slot in the item texture, −1 for none.
 */
export const GLYPH_FIELDS = [['anchor', 2], ['glyph', 4], ['atlas', 2], ['title', 4], ['fold', 2], ['slot', 1], ['masks', 4]] as const;
type GlyphField = (typeof GLYPH_FIELDS)[number][0];

const starts = {} as Record<GlyphField, number>;
let floats = 0;
for (const [f, size] of GLYPH_FIELDS) { starts[f] = floats; floats += size; }
/** Where each field of a glyph instance starts. */
export const GLYPH_AT: Readonly<Record<GlyphField, number>> = starts;
/** Floats per glyph instance. */
export const GLYPH_FLOATS = floats;
const { anchor: AT_ANCHOR, glyph: AT_GLYPH, atlas: AT_ATLAS, title: AT_TITLE, fold: AT_FOLD, slot: AT_SLOT, masks: AT_MASKS } = GLYPH_AT;

/**
 * Appends one instance per visible glyph of a title (world font size `size`, wrap and line height in world units):
 * (x, y) from the centre of the item at `slot`, or relative to the origin without one (slot −1). `masks`: a connection
 * title's, its connection's (instances.ts, masksOf: the shader hides it under their fills where it sits, point 7); none
 * for an item's title.
 */
export function appendTitle(
  out: FloatList, font: FontData, text: string, size: number, wrap: number, lineHeight: number,
  x: number, y: number, kind: number, index: number, dim: number, foldK: number, parentK: number, slot: number, masks?: ArrayLike<number>,
): void {
  const fi = indexOf(font);
  const l = cachedLayout(fi, text, wrap * (font.size / size), lineHeight * (font.size / size));
  if (l.count === 0) return;
  let o = out.extend(l.count * GLYPH_FLOATS);
  const d = out.storage, g = l.glyphs;
  for (let j = 0; j < l.count; j++, o += GLYPH_FLOATS) {
    const u = j * UNIT, a = o + AT_ANCHOR, r = o + AT_GLYPH, t = o + AT_ATLAS, m = o + AT_TITLE, f = o + AT_FOLD;
    d[a] = x; d[a + 1] = y;
    d[r] = g[u]; d[r + 1] = g[u + 1]; d[r + 2] = g[u + 2]; d[r + 3] = g[u + 3];
    d[t] = g[u + 4]; d[t + 1] = g[u + 5];
    d[m] = size; d[m + 1] = kind; d[m + 2] = index; d[m + 3] = dim;
    d[f] = foldK; d[f + 1] = parentK;
    d[o + AT_SLOT] = slot;
    const k = o + AT_MASKS;
    if (masks) { d[k] = masks[0]; d[k + 1] = masks[1]; d[k + 2] = masks[2]; d[k + 3] = masks[3]; } else { d[k] = -1; d[k + 1] = -1; d[k + 2] = -1; d[k + 3] = -1; }
  }
}
