import type { FontData, RenderParams, Rgb } from '@cirrus/view';
import { Program } from '../gl/program.ts';

// Every mesh is drawn in world units relative to a local origin; uCamera and uView carry the camera (plan 3c task 7:
// the projection Pixi's containers made). On-screen sizes (widths, feathers, stars, markers) and fold transitions are
// computed here from uZoom, so geometry is only rebuilt when the visible set changes. Outputs are premultiplied.
// Antialiasing is analytic (no MSAA).

const COMMON = /* glsl */ `
uniform vec2 uCamera;  // the camera's centre, in world units relative to the local origin
uniform vec2 uView;    // 2 · zoom / the screen's size in CSS pixels: world to clip space
uniform float uZoom;
uniform float uBaseFont;
uniform float uTextScale;
uniform float uFactor;
uniform float uFold0;
uniform float uFold1;
vec4 project(vec2 p) {
  vec2 c = (p - uCamera) * uView;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
float textPx(float k) { return uBaseFont * uTextScale * pow(uFactor, k) * uZoom; }
// 1 when a group is closed, 0 when open (spec 8.2); k above 1e8 means "no group": never folded.
float foldT(float k) { return k > 1e8 ? 0.0 : 1.0 - smoothstep(uFold0, uFold1, textPx(k)); }
`;

/** No group: the sentinel step for foldT. */
export const NO_GROUP = 1e9;

type Values = Record<string, number | ArrayLike<number>>;
const setAll = (pr: Program, values: Values) => { for (const [k, v] of Object.entries(values)) pr.set(k, v); };

const lod = (p: RenderParams): Values => ({ uBaseFont: p.baseFontPx, uTextScale: p.textScale, uFactor: p.factor, uFold0: p.groupFold[0], uFold1: p.groupFold[1] });

// Connection lines and glyphs share their width and fade logic (spec 8.5).
const CONNECTION = /* glsl */ `
uniform float uWidthBase; uniform float uWidthMin; uniform float uWidthMax;
uniform vec4 uScreen;      // screen rectangle in local world units: minX, minY, maxX, maxY
uniform float uFadeWorld;  // connectionFadePx / zoom
uniform float uHot;        // hovered visible connection, -1 for none
uniform float uHoverBoost;
uniform float uAlpha;
float endpointFade(vec3 e) {
  vec2 d = max(max(uScreen.xy - e.xy, e.xy - uScreen.zw), 0.0);
  return max(0.0, 1.0 - max(0.0, length(d) - e.z) / max(uFadeWorld, 1e-9));
}
float slideT(vec2 fold) { return fold.x == 1.0 ? foldT(fold.y) : 0.0; }
float widthPx(float scale, float conn) {
  float raw = uWidthBase * scale * uZoom;
  return clamp(raw, uWidthMin, uWidthMax) + (conn == uHot ? uHoverBoost : 0.0);
}
float connectionAlpha(float scale, vec3 e0, vec3 e1, vec2 fold, float conn) {
  float raw = uWidthBase * scale * uZoom;
  float a = min(1.0, raw / uWidthMin) * max(endpointFade(e0), endpointFade(e1));
  if (fold.x == 2.0) a *= 1.0 - foldT(fold.y);
  return a * (conn == uHot ? 1.0 : uAlpha);
}
`;

const connection = (p: RenderParams): Values => ({
  uWidthBase: p.widthBasePx, uWidthMin: p.widthMinPx, uWidthMax: p.widthMaxPx, uHoverBoost: p.hoverBoostPx, uAlpha: p.connectionAlpha,
  uLineColor: p.connectionColor, uAbsent: p.absentColor, uSky: p.skyColor, uDash: p.dashPx,
});

/** Ribbons: two vertices per centerline point, pushed by half the on-screen width plus one pixel of antialiasing. */
const RIBBON = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aPosition2; in vec2 aNormal; in vec2 aNormal2;
  in float aScale; in float aSide; in float aDist; in vec3 aEnd0; in vec3 aEnd1; in vec2 aFold; in float aConn;
  out float vAlpha; out float vD; out float vHalf; out float vDist;
  ${COMMON}
  ${CONNECTION}
  void main() {
    float s = slideT(aFold);
    vec2 pos = mix(aPosition, aPosition2, s);
    vec2 n = mix(aNormal, aNormal2, s);
    n = length(n) > 1e-6 ? normalize(n) : vec2(0.0, 1.0);
    float w = widthPx(aScale, aConn);
    float half_ = 0.5 * w + 1.0;
    vAlpha = connectionAlpha(aScale, aEnd0, aEnd1, aFold, aConn);
    vD = aSide * half_;
    vHalf = 0.5 * w;
    vDist = aDist < 0.0 ? -1.0 : aDist * uZoom;
    gl_Position = project(pos + n * aSide * half_ / uZoom);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in float vAlpha; in float vD; in float vHalf; in float vDist;
  uniform vec3 uLineColor; uniform vec3 uAbsent; uniform vec2 uDash;
  out vec4 finalColor;
  void main() {
    float cov = clamp(vHalf + 0.5 - abs(vD), 0.0, 1.0);
    vec3 c = uLineColor;
    if (vDist >= 0.0) {
      if (mod(vDist, uDash.x + uDash.y) > uDash.x) discard;
      c = uAbsent;
    }
    finalColor = vec4(c, 1.0) * vAlpha * cov;
  }`,
};

/** Arrows, dots and hollow insides, sized in line widths at the node end (spec 8.5: the arrow follows the width). */
const ARROW = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aPosition2; in vec2 aOffset; in vec2 aOffset2;
  in float aScale; in float aFill; in vec3 aEnd0; in vec3 aEnd1; in vec2 aFold; in float aConn;
  out float vAlpha; out vec3 vColor;
  uniform vec3 uLineColor; uniform vec3 uAbsent; uniform vec3 uSky;
  ${COMMON}
  ${CONNECTION}
  void main() {
    float s = slideT(aFold);
    float w = widthPx(aScale, aConn);
    vAlpha = connectionAlpha(aScale, aEnd0, aEnd1, aFold, aConn);
    vColor = aFill == 1.0 ? uLineColor : aFill == 2.0 ? uAbsent : uSky;
    // A hollow inside covers the arrow fully: the connection's own transparency does not apply to it.
    if (aFill == 0.0 || aFill == 3.0) vAlpha = min(1.0, vAlpha / max(uAlpha, 1e-6));
    if (aFill == 3.0) vAlpha *= step(0.5, s);
    gl_Position = project(mix(aPosition, aPosition2, s) + mix(aOffset, aOffset2, s) * w / uZoom);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in float vAlpha; in vec3 vColor; out vec4 finalColor;
  void main() { finalColor = vec4(vColor, 1.0) * vAlpha; }`,
};

/** Group envelopes: opaque colours interpolated by the fold, a ring pushed out by the feather (spec 8.4). */
const ENVELOPE = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aNormal; in float aAlpha; in vec3 aOpen; in vec3 aClosed; in float aFoldK; in float aParentK;
  out float vAlpha; out vec3 vColor;
  uniform float uFeatherOpen; uniform float uFeatherClosed;
  ${COMMON}
  void main() {
    float t = foldT(aFoldK);
    vColor = mix(aOpen, aClosed, t);
    // A subgroup fades as its parent closes, like the boxes inside it (spec 8.4).
    vAlpha = aAlpha * (1.0 - foldT(aParentK));
    gl_Position = project(aPosition + aNormal * mix(uFeatherOpen, uFeatherClosed, t) / uZoom);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in float vAlpha; in vec3 vColor; out vec4 finalColor;
  void main() { finalColor = vec4(vColor, 1.0) * vAlpha; }`,
};

/**
 * Boxes as signed-distance rounded rectangles (one quad each), with a border and one pixel of antialiasing. Style:
 * 0 node, 1 phantom of a node (translucent, dashed border), 2 centre phantom (disc), 3 absent phantom (dot).
 * A top-level node keeps minNodePx on screen (spec 8.2); a badge is a dot on the top-right corner (spec 11.3).
 */
const BOX = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aCenter; in vec2 aHalf; in vec2 aCorner; in float aParentK; in float aStyle; in float aBadge;
  out vec2 vLocal; out vec2 vHalf; out float vRadius; out float vAlpha; out float vStyle; out float vBadge;
  uniform float uMinNodePx; uniform float uRadius; uniform float uBoxHalf; uniform float uBadgePx;
  ${COMMON}
  void main() {
    vec2 half_ = aHalf;
    if (aParentK > 1e8) {
      float px = max(half_.x, half_.y) * uZoom;
      if (px < 0.5 * uMinNodePx) half_ *= 0.5 * uMinNodePx / max(px, 1e-9);
    }
    float pad = (1.5 + aBadge * 2.0 * uBadgePx) / uZoom;
    vLocal = aCorner * (half_ + pad);
    vHalf = half_;
    // The corner radius scales with the box: boxRadius at the width of a step-0 box.
    vRadius = min(uRadius * half_.x / uBoxHalf, min(half_.x, half_.y));
    vAlpha = 1.0 - foldT(aParentK);
    vStyle = aStyle;
    vBadge = aBadge;
    gl_Position = project(aCenter + vLocal);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in vec2 vLocal; in vec2 vHalf; in float vRadius; in float vAlpha; in float vStyle; in float vBadge;
  uniform float uZoom; uniform float uBorderPx; uniform float uBadgePx; uniform vec2 uDash; uniform float uPhantomFill;
  uniform vec3 uNode; uniform vec3 uEdge; uniform vec3 uMarker; uniform vec3 uConnection; uniform vec3 uAbsent;
  out vec4 finalColor;
  float sdBox(vec2 q, vec2 b, float r) { vec2 d = abs(q) - b + r; return length(max(d, 0.0)) + min(max(d.x, d.y), 0.0) - r; }
  void main() {
    bool disc = vStyle >= 2.0;
    float d = (disc ? length(vLocal) - vHalf.x : sdBox(vLocal, vHalf, vRadius)) * uZoom;
    float inside = clamp(0.5 - d, 0.0, 1.0);
    float border = clamp(0.5 * uBorderPx + 0.5 - abs(d + 0.5 * uBorderPx), 0.0, 1.0);
    vec3 fill = uNode; vec3 edge = uEdge; float fillA = 1.0;
    if (vStyle == 1.0) {
      fillA = uPhantomFill;
      float period = uDash.x + uDash.y;
      if (mod((vLocal.x + vLocal.y) * uZoom, period) > uDash.x) border = 0.0;
    } else if (vStyle == 2.0) { fill = uMarker; edge = uConnection; }
    else if (vStyle == 3.0) { fill = uAbsent; edge = uAbsent; }
    vec4 c = vec4(fill, 1.0) * fillA * (inside - border * inside) + vec4(edge, 1.0) * border * inside;
    if (vBadge > 0.5) {
      vec2 corner = vec2(vHalf.x, -vHalf.y);
      float b = clamp(0.5 - (length(vLocal - corner) * uZoom - uBadgePx), 0.0, 1.0);
      c = mix(c, vec4(uAbsent, 1.0), b);
    }
    finalColor = c * vAlpha;
  }`,
};

/** Bundle markers: discs of markerRadiusPx, fading with the connection titles (spec 8.2, 8.5). */
const MARKER = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aCenter; in vec2 aCorner; in float aK; in float aConn;
  out vec2 vLocal; out float vAlpha;
  uniform float uRadiusPx; uniform float uHot; uniform float uTitle0; uniform float uTitle1;
  ${COMMON}
  void main() {
    vLocal = aCorner * (uRadiusPx + 1.5);
    vAlpha = aConn == uHot ? 1.0 : smoothstep(uTitle0, uTitle1, textPx(aK));
    gl_Position = project(aCenter + vLocal / uZoom);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in vec2 vLocal; in float vAlpha; out vec4 finalColor;
  uniform float uRadiusPx; uniform vec3 uFill; uniform vec3 uRing; uniform float uRingPx;
  void main() {
    float d = length(vLocal) - uRadiusPx;
    float inside = clamp(0.5 - d, 0.0, 1.0);
    float ring = clamp(0.5 * uRingPx + 0.5 - abs(d + 0.5 * uRingPx), 0.0, 1.0);
    finalColor = (vec4(uFill, 1.0) * (inside - ring * inside) + vec4(uRing, 1.0) * ring * inside) * vAlpha;
  }`,
};

/** Stars: one quad per star, constant on-screen size, layer alpha as a uniform (spec 8.6: no twinkling). */
const STAR = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aCorner; uniform float uStarPx;
  ${COMMON}
  void main() { gl_Position = project(aPosition + aCorner * (0.5 * uStarPx / uZoom)); }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  uniform float uLayerAlpha; uniform float uBrightness; uniform vec3 uStarColor; out vec4 finalColor;
  void main() { finalColor = vec4(uStarColor, 1.0) * uBrightness * uLayerAlpha; }`,
};

/**
 * Screen-space background: the sky gradient, and the fractal grid when chosen (spec 8.6). vWorld is the local world
 * position; uOffset* = origin mod spacing (computed in double precision), so lines stay fixed in the plan.
 */
const SKY = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aWorld; in float aV;
  out vec2 vWorld; out float vV;
  uniform vec2 uSize;  // the screen in CSS pixels
  void main() {
    vWorld = aWorld; vV = aV;
    gl_Position = vec4(aPosition.x / uSize.x * 2.0 - 1.0, 1.0 - aPosition.y / uSize.y * 2.0, 0.0, 1.0);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in vec2 vWorld; in float vV; out vec4 finalColor;
  uniform vec3 uSky; uniform vec3 uSky2; uniform vec3 uGridColor; uniform float uZoom;
  uniform vec3 uSpacing; uniform vec3 uGridAlpha; uniform vec2 uOffset0; uniform vec2 uOffset1; uniform vec2 uOffset2;
  float line(vec2 offset, float spacing) {
    if (spacing <= 0.0) return 0.0;
    vec2 g = abs(fract((vWorld + offset) / spacing + 0.5) - 0.5) * spacing * uZoom;
    return clamp(1.0 - min(g.x, g.y), 0.0, 1.0);
  }
  void main() {
    vec3 c = mix(uSky2, uSky, vV);
    float a = line(uOffset0, uSpacing.x) * uGridAlpha.x;
    a = max(a, line(uOffset1, uSpacing.y) * uGridAlpha.y);
    a = max(a, line(uOffset2, uSpacing.z) * uGridAlpha.z);
    finalColor = vec4(mix(c, uGridColor, a), 1.0);
  }`,
};

/** Rings around selected boxes and envelopes, a drop target, intruders: a constant on-screen gap and width. */
const OUTLINE = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aNormal; in float aOuter;
  out float vEdge;
  uniform float uGapPx; uniform float uWidthPx;
  ${COMMON}
  void main() {
    float px = uGapPx + aOuter * (uWidthPx + 1.0);
    vEdge = aOuter * (uWidthPx + 1.0);
    gl_Position = project(aPosition + aNormal * px / uZoom);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in float vEdge; out vec4 finalColor;
  uniform vec3 uOutlineColor; uniform float uWidthPx;
  void main() {
    // One pixel of antialiasing on the outer side.
    float a = clamp(uWidthPx + 0.5 - vEdge, 0.0, 1.0);
    finalColor = vec4(uOutlineColor, 1.0) * a;
  }`,
};

/**
 * Titles: one quad per glyph of the MSDF atlas (spec 8.2 to 8.5, plan 3c task 7). The fades BitmapText's alphas
 * followed, from uZoom: a box's text with its step and its parent's fold (a phantom's dimmed), a group's two titles
 * swapping with its fold, a connection's with its size, its fading level, and lit when hovered. Below 1 %, a glyph is
 * not drawn (BitmapText was hidden). The coverage is Pixi's MSDF shader's: the median's distance in screen pixels
 * (distanceRange · size · zoom / font size), its gamma by the ink's luminance, premultiplied.
 */
const TEXT = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aCorner; in vec2 aAnchor; in vec4 aGlyph; in vec2 aAtlas; in vec4 aTitle; in vec2 aFold;
  out vec2 vUv; out float vAlpha; out vec3 vColor; out float vDistance;
  uniform vec2 uTextFade; uniform vec2 uTitleFade; uniform vec2 uSwap; uniform float uHot;
  uniform vec3 uInk; uniform vec3 uTitleInk; uniform vec2 uAtlasSize; uniform float uFontSize; uniform float uRange;
  ${COMMON}
  void main() {
    float size = aTitle.x, kind = aTitle.y, px = size * uZoom;
    float a;
    if (kind == 3.0) {
      a = aTitle.z == uHot ? 1.0 : smoothstep(uTitleFade.x, uTitleFade.y, px) * (1.0 - foldT(aFold.x));
    } else {
      a = aTitle.w * smoothstep(uTextFade.x, uTextFade.y, px) * (1.0 - foldT(aFold.y));
      if (kind == 1.0) a *= 1.0 - smoothstep(uSwap.x, uSwap.y, foldT(aFold.x));
      else if (kind == 2.0) a *= smoothstep(uSwap.x, uSwap.y, foldT(aFold.x));
    }
    vAlpha = a;
    vColor = kind == 3.0 ? uTitleInk : uInk;
    float s = size / uFontSize;
    vec2 corner = aCorner * aGlyph.zw;
    vUv = (aAtlas + corner) / uAtlasSize;
    vDistance = uRange * s * uZoom;
    gl_Position = a > 0.01 ? project(aAnchor + (aGlyph.xy + corner) * s) : vec4(2.0, 2.0, 2.0, 1.0);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in vec2 vUv; in float vAlpha; in vec3 vColor; in float vDistance;
  uniform sampler2D uAtlas;
  out vec4 finalColor;
  void main() {
    vec4 t = texture(uAtlas, vUv);
    float median = t.r + t.g + t.b - min(t.r, min(t.g, t.b)) - max(t.r, max(t.g, t.b));
    median = min(median, t.a);
    float alpha = clamp(vDistance * (median - 0.5) + 0.5, 0.0, 1.0);
    if (median < 0.01) alpha = 0.0;
    else if (median > 0.99) alpha = 1.0;
    vec4 shape = vec4(vColor * vAlpha, vAlpha);
    float gamma = mix(1.0, 1.0 / 2.2, dot(shape.rgb, vec3(0.299, 0.587, 0.114)));
    finalColor = pow(shape.a * alpha, gamma) * shape;
  }`,
};

export interface Programs {
  ribbon: Program; arrow: Program; envelope: Program; box: Program; marker: Program; outline: Program; star: Program; sky: Program; text: Program;
}

export function createPrograms(gl: WebGL2RenderingContext): Programs {
  const make = (name: string, s: { vertex: string; fragment: string }) => new Program(gl, name, s.vertex, s.fragment);
  return {
    ribbon: make('rubans', RIBBON), arrow: make('pointes', ARROW), envelope: make('enveloppes', ENVELOPE), box: make('boîtes', BOX),
    marker: make('marqueurs', MARKER), outline: make('contours', OUTLINE), star: make('étoiles', STAR), sky: make('ciel', SKY), text: make('titres', TEXT),
  };
}

/** The uniforms the settings give (set once, and again when they change); the atlas is read from texture unit 0. */
export function setParamUniforms(pr: Programs, p: RenderParams, font: FontData): void {
  const l = lod(p);
  for (const x of [pr.ribbon, pr.arrow, pr.envelope, pr.box, pr.marker, pr.outline, pr.star, pr.text]) setAll(x, l);
  setAll(pr.ribbon, connection(p));
  setAll(pr.arrow, connection(p));
  setAll(pr.envelope, { uFeatherOpen: p.featherOpenPx, uFeatherClosed: p.featherClosedPx });
  setAll(pr.box, {
    uMinNodePx: p.minNodePx, uRadius: p.boxRadius, uBoxHalf: p.boxWidth / 2, uBadgePx: p.badgeRadiusPx, uBorderPx: p.boxBorderPx,
    uPhantomFill: p.phantomFillAlpha, uDash: p.dashPx, uNode: p.nodeColor, uEdge: p.nodeEdgeColor, uMarker: p.markerColor,
    uConnection: p.connectionColor, uAbsent: p.absentColor,
  });
  setAll(pr.marker, {
    uRadiusPx: p.markerRadiusPx, uTitle0: p.titleFade[0], uTitle1: p.titleFade[1], uFill: p.markerColor, uRing: p.connectionColor, uRingPx: p.markerRingPx,
  });
  setAll(pr.star, { uStarPx: p.starSizePx, uBrightness: p.starBrightness, uStarColor: p.starColor });
  setAll(pr.sky, { uSky: p.skyColor, uSky2: p.skyColor2, uGridColor: p.gridColor });
  setAll(pr.outline, { uGapPx: p.selectionGapPx, uWidthPx: p.selectionWidthPx });
  setAll(pr.text, {
    uTextFade: p.textFade, uTitleFade: p.titleFade, uSwap: p.groupTitleSwap, uInk: p.inkColor, uTitleInk: p.titleColor,
    uAtlas: 0, uAtlasSize: [font.scaleW, font.scaleH], uFontSize: font.size, uRange: font.distanceRange,
  });
}

/** The camera, for every program drawn in the world: zoom, its centre relative to the local origin, the screen. */
export function setView(programs: Program[], zoom: number, cx: number, cy: number, widthPx: number, heightPx: number): void {
  const view = [(2 * zoom) / widthPx, (2 * zoom) / heightPx], camera = [cx, cy];
  for (const pr of programs) {
    pr.set('uZoom', zoom);
    pr.set('uCamera', camera);
    pr.set('uView', view);
  }
}

/** The colour of a ring (selection, drop target, intruder), set before it is drawn. */
export function setOutlineColor(pr: Programs, c: Rgb): void {
  pr.outline.set('uOutlineColor', c);
}
