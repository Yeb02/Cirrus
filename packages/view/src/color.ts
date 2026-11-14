import type { RenderParams, Rgb } from './params.ts';

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const gamma = (c: number) => (c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055);

/** OKLCH (L 0..1, C, hue in degrees) to sRGB 0..1, clipped to the gamut (Ottosson's matrices). */
export function oklchToRgb(L: number, C: number, hDeg: number): Rgb {
  const h = (hDeg * Math.PI) / 180;
  const a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
  const g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
  const bl = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
  return [clamp01(gamma(r)), clamp01(gamma(g)), clamp01(gamma(bl))];
}

const linear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/** sRGB 0..1 to OKLCH (L 0..1, C, hue in degrees 0..360): oklchToRgb's inverse within the gamut (Ottosson's matrices). */
export function rgbToOklch(c: Rgb): { L: number; C: number; h: number } {
  const r = linear(c[0]), g = linear(c[1]), b = linear(c[2]);
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  const h = (Math.atan2(B, A) * 180) / Math.PI;
  return { L, C: Math.hypot(A, B), h: h < 0 ? h + 360 : h };
}

export function hexToRgb(hex: string): Rgb {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function rgbToHex(c: Rgb): string {
  return `#${c.map((v) => Math.round(clamp01(v) * 255).toString(16).padStart(2, '0')).join('')}`;
}

export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/**
 * A lightness `depth` steps of groupLightnessStep away from `start`, bouncing inside groupLightnessRange: nested levels
 * stay apart however deep, and never leave the range.
 */
function bounced(start: number, depth: number, p: RenderParams): number {
  const [lo, hi] = p.groupLightnessRange;
  const span = Math.max(1e-6, hi - lo);
  const x = (((start - lo + depth * p.groupLightnessStep) % (2 * span)) + 2 * span) % (2 * span);
  return lo + (x <= span ? x : 2 * span - x);
}

/** Open, a group's colour seen through the sky at envelopeOpacityOpen, but opaque: nested levels never blend. */
const opened = (closed: Rgb, p: RenderParams) => ({ open: mixRgb(p.skyColor, closed, p.envelopeOpacityOpen), closed });

/**
 * Colours of a group at a nesting depth (spec 8.4): the parent's hue, lightness offset by groupLightnessStep per level
 * and bouncing inside groupLightnessRange. Closed: the full colour; open: that colour seen through the sky at
 * envelopeOpacityOpen, but opaque, so nested levels never blend into each other.
 */
export function groupPalette(g: { depth: number; hue: number }, p: RenderParams): { open: Rgb; closed: Rgb } {
  return opened(oklchToRgb(bounced(p.groupLightness, g.depth, p), p.groupChroma, g.hue), p);
}

/**
 * Colours of a group under a colour chosen in this plan (plan 6b, D4), `depth` levels below the group that carries it:
 * that group shows it exactly (depth 0); its subgroups keep its hue and chroma, their lightness `depth` steps away from
 * its own taken into groupLightnessRange, bouncing inside it — a black, a white or a colour out of the range still gives
 * subgroups apart from it and from each other.
 */
export function chosenPalette(color: string, depth: number, p: RenderParams): { open: Rgb; closed: Rgb } {
  const base = hexToRgb(color);
  if (depth <= 0) return opened(base, p);
  const { L, C, h } = rgbToOklch(base);
  const [lo, hi] = p.groupLightnessRange;
  return opened(oklchToRgb(bounced(Math.min(hi, Math.max(lo, L)), depth, p), C, h), p);
}

/** The palette a group's colour is chosen in (plan 6b, D4): one `#rrggbb` per groupPaletteHues, at groupLightness and groupPaletteChroma. */
export function paletteColors(p: RenderParams): string[] {
  return p.groupPaletteHues.map((h) => rgbToHex(oklchToRgb(p.groupLightness, p.groupPaletteChroma, h)));
}
