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
 * Colours of a group at a nesting depth (spec 8.4): the parent's hue, lightness offset by groupLightnessStep per level
 * and bouncing inside groupLightnessRange. Closed: the full colour; open: that colour seen through the sky at
 * envelopeOpacityOpen, but opaque, so nested levels never blend into each other.
 */
export function groupPalette(g: { depth: number; hue: number }, p: RenderParams): { open: Rgb; closed: Rgb } {
  const [lo, hi] = p.groupLightnessRange;
  const span = Math.max(1e-6, hi - lo);
  const x = (((p.groupLightness - lo + g.depth * p.groupLightnessStep) % (2 * span)) + 2 * span) % (2 * span);
  const L = lo + (x <= span ? x : 2 * span - x);
  const closed = oklchToRgb(L, p.groupChroma, g.hue);
  return { open: mixRgb(p.skyColor, closed, p.envelopeOpacityOpen), closed };
}
