import {
  DOT_SIDES, ENVELOPE_TEXTURE_WIDTH, type FontData, ITEM_BADGE, ITEM_STYLE, type RenderParams, type Rgb, SIMPLE_DASHED_A, SIMPLE_DASHED_B, SIMPLE_FADE_OUT,
  SIMPLE_ROLE_BITS, SLOT_ROW_SHIFT, TEXELS_PER_SLOT,
} from '@cirrus/view';
import { Program } from '../gl/program.ts';

// Every mesh is drawn in world units relative to a local origin; uCamera and uView carry the camera (plan 3c task 7:
// the projection Pixi's containers made). On-screen sizes (widths, feathers, stars, markers) and fold transitions are
// computed here from uZoom, so geometry is only rebuilt when the visible set changes. Outputs are premultiplied.
// Antialiasing is analytic (no MSAA). The items are read by slot from the item texture (plan 3c task 8): boxes, simple
// connections and titles follow it; the connections' cubics are evaluated here, curveSegments segments each.

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
// lod.ts's smooth (smooth is a GLSL keyword): 0 below a, 1 above b; a degenerate range is a step, where GLSL's
// smoothstep is undefined (a range at its bound may come out as [max, max]: params.ts, bounded).
float smoothRange(float a, float b, float v) {
  if (!(b > a)) return v >= a ? 1.0 : 0.0;
  float t = clamp((v - a) / (b - a), 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}
float textPx(float k) { return uBaseFont * uTextScale * pow(uFactor, k) * uZoom; }
// 1 when a group is closed, 0 when open (spec 8.2); k above 1e8 means "no group": never folded.
float foldT(float k) { return k > 1e8 ? 0.0 : 1.0 - smoothRange(uFold0, uFold1, textPx(k)); }
`;

/** No group: the sentinel step for foldT. */
export const NO_GROUP = 1e9;

/** The texture unit of the MSDF atlas, and of the item texture; the envelopes' index and edges take the two next ones. */
export const ATLAS_UNIT = 0, ITEMS_UNIT = 1, ENVELOPE_INDEX_UNIT = 2, ENVELOPE_EDGES_UNIT = 3;

/** A simple connection's glyph vertices per branch (a dot's triangles; an arrow uses six), and per instance. */
const SIMPLE_GLYPH_PER_BRANCH = 3 * DOT_SIDES;
export const SIMPLE_GLYPH_VERTICES = 2 * SIMPLE_GLYPH_PER_BRANCH;

// The item texture (instances.ts, itemTexels): two RGBA32F texels per slot, 512 slots per row of 1024 texels.
const ITEMS = /* glsl */ `
uniform highp sampler2D uItems;
// x, y (relative to the origin), halfW, halfH
vec4 itemA(int s) { return texelFetch(uItems, ivec2((s & ${(1 << SLOT_ROW_SHIFT) - 1}) * ${TEXELS_PER_SLOT}, s >> ${SLOT_ROW_SHIFT}), 0); }
// k, the parent's maxChildK (1e9: none), its own as a group (1e9 otherwise), flags (instances.ts, ITEM_*)
vec4 itemB(int s) { return texelFetch(uItems, ivec2((s & ${(1 << SLOT_ROW_SHIFT) - 1}) * ${TEXELS_PER_SLOT} + 1, s >> ${SLOT_ROW_SHIFT}), 0); }
`;

// The masks of the connections (spec 8.5, point 7 of 2026-11-12), geometry/mask.ts's twin: the fill of a group folding
// over an end, opaque, laid over the connection at the opacity of its fold — the connection's own opacity times
// 1 − s · coverage, s = its fold × (1 − its parent's fold), coverage its envelope's (padded hull, then a ring of
// featherOpenPx to featherClosedPx). Each group's envelope is a list of edges (nx, ny, c), read from the envelope
// textures (render/envelopeTexture.ts) by slot. Needs ITEMS. A mask list is an ivec4 of slots, −1 for none.
const MASK = /* glsl */ `
uniform highp sampler2D uEnvIndex; uniform highp sampler2D uEnvEdges; uniform float uFeatherOpen; uniform float uFeatherClosed;
vec4 envIndex(int s) { return texelFetch(uEnvIndex, ivec2(s & ${ENVELOPE_TEXTURE_WIDTH - 1}, s >> ${Math.log2(ENVELOPE_TEXTURE_WIDTH)}), 0); }
vec4 envEdge(int i) { return texelFetch(uEnvEdges, ivec2(i & ${ENVELOPE_TEXTURE_WIDTH - 1}, i >> ${Math.log2(ENVELOPE_TEXTURE_WIDTH)}), 0); }
// The signed distance from p to group g's padded envelope (negative inside): max over its edges of n · p − c.
float envelopeDistance(int g, vec2 p) {
  vec4 h = envIndex(g);
  int start = int(h.x), n = int(h.y);
  if (n == 0) return 1e30;
  float d = -1e30;
  for (int i = 0; i < n; i++) { vec4 e = envEdge(start + i); d = max(d, dot(e.xy, p) - e.z); }
  return d;
}
float maskStrength(int g) { if (g < 0) return 0.0; vec4 b = itemB(g); return foldT(b.z) * (1.0 - foldT(b.y)); }
// The distance out of the envelope in feathers: its coverage is clamp(1 − reach, 0, 1).
float maskReach(int g, vec2 p) {
  if (g < 0) return 1e9;
  float feather = mix(uFeatherOpen, uFeatherClosed, foldT(itemB(g).z));
  return envelopeDistance(g, p) * uZoom / max(feather, 1e-6);
}
vec4 maskStrengths(ivec4 m) { return vec4(maskStrength(m.x), maskStrength(m.y), maskStrength(m.z), maskStrength(m.w)); }
vec4 maskReaches(ivec4 m, vec2 p) { return vec4(maskReach(m.x, p), maskReach(m.y, p), maskReach(m.z, p), maskReach(m.w, p)); }
float maskAlpha(vec4 s, vec4 reach) { vec4 k = 1.0 - s * clamp(1.0 - reach, 0.0, 1.0); return k.x * k.y * k.z * k.w; }
`;

// Cubics, evaluated as geometry/ribbon.ts's sampleBranch samples them.
const CUBIC = /* glsl */ `
uniform int uSegments;
vec2 normOr(vec2 v, vec2 fallback) { float l = length(v); return l < 1e-9 ? fallback : v / l; }
vec2 cubic(vec2 p0, vec2 b1, vec2 b2, vec2 p3, float t) {
  float u = 1.0 - t;
  return (u * u * u) * p0 + (3.0 * u * u * t) * b1 + (3.0 * u * t * t) * b2 + (t * t * t) * p3;
}
// The unit normal at point i of n, from its neighbours (as normals() of the CPU polylines).
vec2 normalAt(vec2 p0, vec2 b1, vec2 b2, vec2 p3, int i, int n) {
  vec2 d = cubic(p0, b1, b2, p3, float(min(i + 1, n)) / float(n)) - cubic(p0, b1, b2, p3, float(max(i - 1, 0)) / float(n));
  d = normOr(d, vec2(1.0, 0.0));
  return vec2(-d.y, d.x);
}
// The length of the polyline from point 0 to point i: the dashes' distance.
float arcTo(vec2 p0, vec2 b1, vec2 b2, vec2 p3, int i, int n) {
  float acc = 0.0;
  vec2 prev = p0;
  for (int j = 1; j <= i; j++) { vec2 q = cubic(p0, b1, b2, p3, float(j) / float(n)); acc += length(q - prev); prev = q; }
  return acc;
}
`;

// The ribbon drawn along a cubic: two vertices per point, pushed by half the on-screen width plus one pixel of
// antialiasing, as the CPU ribbons were (a triangle strip: point i's two sides at vertices 2i and 2i + 1). Its masks'
// reaches at each vertex (linear along an edge of an envelope, so interpolated exactly across it), their strengths.
const RIBBON_VERTEX = /* glsl */ `
out float vAlpha; out float vD; out float vHalf; out float vDist; out vec4 vMaskReach; flat out vec4 vMaskStrength;
void ribbonVertex(vec2 pos, vec2 n, float side, float scale, float dist, vec3 e0, vec3 e1, vec2 fold, float conn, ivec4 masks) {
  float w = widthPx(scale, conn);
  float half_ = 0.5 * w + 1.0;
  vAlpha = connectionAlpha(scale, e0, e1, fold, conn);
  vD = side * half_;
  vHalf = 0.5 * w;
  vDist = dist < 0.0 ? -1.0 : dist * uZoom;
  vec2 at = pos + n * side * half_ / uZoom;
  vMaskStrength = maskStrengths(masks);
  vMaskReach = maskReaches(masks, at);
  gl_Position = project(at);
}
`;

// A simple connection's two branches (geometry/simple.ts, simpleBranches: its TS twin), from its two items' texels:
// bundleGeometry with two members, no trunk, both branches meeting midway; branches in its order (sources, targets,
// associates; a then b within a class). Flags: role codes (source 0, target 1, associate 2) of a then b, 2 bits each.
const SIMPLE = /* glsl */ `
uniform float uAnchorGap; uniform float uTension; uniform float uCullAlpha; uniform float uHeadroom;
struct Simple { vec2 p0; vec2 b1; vec2 b2; vec2 p3; float kNode; float kMarker; bool atStart; int end; bool assoc; };
vec2 anchorBox(vec2 pos, vec2 half_, float k, vec2 toward) {
  float gap = uAnchorGap * uTextScale * pow(uFactor, k);
  vec2 d = toward - pos;
  float sx = abs(d.x) > 1e-9 ? (half_.x + gap) / abs(d.x) : 1e30;
  float sy = abs(d.y) > 1e-9 ? (half_.y + gap) / abs(d.y) : 1e30;
  return pos + d * min(min(sx, sy), 1.0);
}
Simple simpleBranch(int which, vec4 a0, vec4 a1, vec4 b0, vec4 b1, int flags) {
  int ra = flags & ${(1 << SIMPLE_ROLE_BITS) - 1}, rb = (flags >> ${SIMPLE_ROLE_BITS}) & ${(1 << SIMPLE_ROLE_BITS) - 1};
  bool pairNeu = ra == 2 && rb == 2;
  // Each end's class: 0 converges on the marker, 1 leaves it, 2 joins it from the side.
  int ca = pairNeu ? 0 : ra, cb = pairNeu ? 1 : rb;
  vec2 pa = a0.xy, pb = b0.xy, zero = vec2(0.0);
  float nS = float(ca == 0) + float(cb == 0), nT = float(ca == 1) + float(cb == 1), nN = float(ca == 2) + float(cb == 2);
  vec2 sS = (ca == 0 ? pa : zero) + (cb == 0 ? pb : zero), sT = (ca == 1 ? pa : zero) + (cb == 1 ? pb : zero);
  vec2 sN = (ca == 2 ? pa : zero) + (cb == 2 ? pb : zero);
  vec2 fallback = nN > 0.0 ? sN / nN : (pa + pb) / 2.0;
  vec2 cs = nS > 0.0 ? sS / nS : fallback, ct = nT > 0.0 ? sT / nT : fallback;
  vec2 M = (cs + ct) * 0.5, u = normOr(ct - cs, vec2(1.0, 0.0));
  // a comes first unless b's class comes before a's.
  int e = (which == 0) == !(cb < ca) ? 0 : 1, c = e == 0 ? ca : cb;
  vec4 E0 = e == 0 ? a0 : b0, E1 = e == 0 ? a1 : b1;
  vec2 at = anchorBox(E0.xy, E0.zw, E1.x, M);
  float t = uTension * length(M - at);
  Simple s;
  s.kNode = E1.x; s.kMarker = max(a1.x, b1.x); s.end = e; s.assoc = pairNeu || (e == 0 ? ra : rb) == 2;
  if (c == 0) { s.p0 = at; s.b1 = at + normOr(M - at, u) * (t * 0.6); s.b2 = M - u * t; s.p3 = M; s.atStart = true; }
  else if (c == 1) { s.p0 = M; s.b1 = M + u * t; s.b2 = at + normOr(M - at, -u) * (t * 0.6); s.p3 = at; s.atStart = false; }
  else {
    // On the axis (always, with two members) it joins from +n, as on the CPU (bundle.ts, SIDE_TOLERANCE); float32's
    // rounding of that zero reaches 1e-4 of the distance within originShiftPx of the origin, hence a wider margin.
    vec2 n = vec2(-u.y, u.x), v = E0.xy - M;
    if (dot(n, v) < -1e-3 * length(v)) n = -n;
    s.p0 = at; s.b1 = at + normOr(M - at, -n) * (t * 0.6); s.b2 = M + n * t; s.p3 = M; s.atStart = true;
  }
  return s;
}
// Too thin at zoom × curveZoomHeadroom: not drawn (ribbonCullAlpha), as the CPU left such a bundle out.
bool culled(float kMax) { return min(1.0, uWidthBase * pow(uFactor, kMax) * uZoom * uHeadroom / uWidthMin) < uCullAlpha; }
// Flags beyond the roles (instances.ts, SIMPLE_*).
bool dashedEnd(int flags, int e) { return (flags & (e == 0 ? ${SIMPLE_DASHED_A} : ${SIMPLE_DASHED_B})) != 0; }
vec2 simpleFold(int flags, int fade) { return (flags & ${SIMPLE_FADE_OUT}) != 0 ? vec2(2.0, itemB(fade).z) : vec2(0.0); }
const vec4 NOWHERE = vec4(2.0, 2.0, 2.0, 1.0);
`;

type Values = Record<string, number | ArrayLike<number>>;
const setAll = (pr: Program, values: Values) => { for (const [k, v] of Object.entries(values)) pr.set(k, v); };

const lod = (p: RenderParams): Values => ({ uBaseFont: p.baseFontPx, uTextScale: p.textScale, uFactor: p.factor, uFold0: p.textFade[0], uFold1: p.textFade[1] });

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
  uLineColor: p.connectionColor, uAbsent: p.absentColor, uDash: p.dashPx,
});

/**
 * A ribbon's coverage: one pixel of antialiasing on its sides; dashed in the absent colour along a stub; under the
 * fills of its masks (MASK's maskAlpha).
 */
const RIBBON_FRAGMENT = /* glsl */ `#version 300 es
  precision highp float;
  in float vAlpha; in float vD; in float vHalf; in float vDist; in vec4 vMaskReach; flat in vec4 vMaskStrength;
  uniform vec3 uLineColor; uniform vec3 uAbsent; uniform vec2 uDash;
  out vec4 finalColor;
  void main() {
    float cov = clamp(vHalf + 0.5 - abs(vD), 0.0, 1.0);
    vec3 c = uLineColor;
    if (vDist >= 0.0) {
      if (mod(vDist, uDash.x + uDash.y) > uDash.x) discard;
      c = uAbsent;
    }
    vec4 k = 1.0 - vMaskStrength * clamp(1.0 - vMaskReach, 0.0, 1.0);
    finalColor = vec4(c, 1.0) * vAlpha * cov * (k.x * k.y * k.z * k.w);
  }`;

/**
 * A simple connection's two ribbons, one instance (instances.ts, SIMPLE_FIELDS: aEnds = slot a, slot b, flags, visible
 * index; aFade = the folding group it fades out with; aMasks = the groups laid over it): one strip per branch,
 * 2 (curveSegments + 1) vertices each, joined by two degenerate vertices. Its width and fade are the CPU ribbons'.
 */
const SIMPLE_RIBBON = {
  vertex: /* glsl */ `#version 300 es
  in ivec4 aEnds; in int aFade; in ivec4 aMasks;
  ${COMMON}
  ${CONNECTION}
  ${ITEMS}
  ${MASK}
  ${CUBIC}
  ${RIBBON_VERTEX}
  ${SIMPLE}
  void main() {
    int n = uSegments, per = 2 * (n + 1), v = gl_VertexID;
    int which = v <= per ? 0 : 1;
    int j = v < per ? v : v == per ? per - 1 : v == per + 1 ? 0 : v - per - 2;
    vec4 a0 = itemA(aEnds.x), a1 = itemB(aEnds.x), b0 = itemA(aEnds.y), b1 = itemB(aEnds.y);
    if (culled(max(a1.x, b1.x))) { gl_Position = NOWHERE; return; }
    Simple s = simpleBranch(which, a0, a1, b0, b1, aEnds.z);
    int i = j >> 1;
    float t = float(i) / float(n);
    float k = s.atStart ? s.kNode + (s.kMarker - s.kNode) * t : s.kMarker + (s.kNode - s.kMarker) * t;
    float dist = dashedEnd(aEnds.z, s.end) ? arcTo(s.p0, s.b1, s.b2, s.p3, i, n) : -1.0;
    ribbonVertex(cubic(s.p0, s.b1, s.b2, s.p3, t), normalAt(s.p0, s.b1, s.b2, s.p3, i, n), (j & 1) == 0 ? 1.0 : -1.0, pow(uFactor, k), dist,
      vec3(a0.xy, max(a0.z, a0.w)), vec3(b0.xy, max(b0.z, b0.w)), simpleFold(aEnds.z, aFade), float(aEnds.w), aMasks);
  }`,
  fragment: RIBBON_FRAGMENT,
};

/**
 * A simple connection's glyphs at its branches' node ends, computed here like its curves: per branch, 36 vertices of
 * triangles, a dot (associates: 12 triangles) or a notched arrow (2 triangles, the others degenerate). The arrow and
 * the dot of geometry/ribbon.ts's appendBundleGlyphs, sized in line widths.
 */
const SIMPLE_GLYPH = {
  vertex: /* glsl */ `#version 300 es
  in ivec4 aEnds; in int aFade; in ivec4 aMasks;
  out float vAlpha; out vec3 vColor;
  uniform vec3 uLineColor; uniform vec3 uAbsent;
  uniform float uArrowLength; uniform float uArrowHalfWidth; uniform float uArrowNotch; uniform float uDotRadius;
  ${COMMON}
  ${CONNECTION}
  ${ITEMS}
  ${MASK}
  ${CUBIC}
  ${SIMPLE}
  void main() {
    int v = gl_VertexID, which = v / ${SIMPLE_GLYPH_PER_BRANCH}, l = v - which * ${SIMPLE_GLYPH_PER_BRANCH};
    vec4 a0 = itemA(aEnds.x), a1 = itemB(aEnds.x), b0 = itemA(aEnds.y), b1 = itemB(aEnds.y);
    if (culled(max(a1.x, b1.x))) { gl_Position = NOWHERE; return; }
    Simple s = simpleBranch(which, a0, a1, b0, b1, aEnds.z);
    vec2 off;
    if (s.assoc) {
      int tri = l / 3, c = l - tri * 3;
      int idx = c == 0 ? 0 : c == 1 ? 1 + tri : 1 + (tri + 1) % ${DOT_SIDES};
      float ang = float(idx - 1) * 6.283185307179586 / ${DOT_SIDES}.0;
      off = idx == 0 ? vec2(0.0) : uDotRadius * vec2(cos(ang), sin(ang));
    } else {
      if (l >= 6) { gl_Position = NOWHERE; return; }
      int idx = l < 3 ? l : l == 3 ? 0 : l == 4 ? 2 : 3;
      float L = uArrowLength, H = uArrowHalfWidth;
      vec2 chord = normOr(s.p3 - s.p0, vec2(1.0, 0.0));
      if (s.atStart) {
        vec2 d = normOr(s.b1 - s.p0, chord), q = vec2(-d.y, d.x);
        off = idx == 0 ? d * L : idx == 1 ? q * H : idx == 2 ? d * (L * (1.0 - uArrowNotch)) : -q * H;
      } else {
        vec2 d = normOr(s.p3 - s.b2, chord), q = vec2(-d.y, d.x);
        off = idx == 0 ? vec2(0.0) : idx == 1 ? q * H - d * L : idx == 2 ? d * (-L * uArrowNotch) : -q * H - d * L;
      }
    }
    float sNode = pow(uFactor, s.kNode), conn = float(aEnds.w);
    vec2 fold = simpleFold(aEnds.z, aFade);
    vec2 node = s.atStart ? s.p0 : s.p3;
    // Masked as its ribbon is at the node end.
    vAlpha = connectionAlpha(sNode, vec3(a0.xy, max(a0.z, a0.w)), vec3(b0.xy, max(b0.z, b0.w)), fold, conn) * maskAlpha(maskStrengths(aMasks), maskReaches(aMasks, node));
    vColor = dashedEnd(aEnds.z, s.end) ? uAbsent : uLineColor;
    gl_Position = project(node + off * widthPx(sNode, conn) / uZoom);
  }`,
  fragment: /* glsl */ `#version 300 es
  precision highp float;
  in float vAlpha; in vec3 vColor; out vec4 finalColor;
  void main() { finalColor = vec4(vColor, 1.0) * vAlpha; }`,
};

/**
 * A complex bundle's branch or trunk, one instance (instances.ts, CURVE_FIELDS): its cubic; the scale from the step at
 * t = 0 to the step at t = 1; dashed along a stub; under the fills of its masks.
 */
const CURVE = {
  vertex: /* glsl */ `#version 300 es
  in vec4 aOpen0; in vec4 aOpen1; in vec4 aWidth; in vec3 aEnd0; in vec3 aEnd1; in vec2 aFold; in vec4 aMasks;
  ${COMMON}
  ${CONNECTION}
  ${ITEMS}
  ${MASK}
  ${CUBIC}
  ${RIBBON_VERTEX}
  void main() {
    int n = uSegments, j = gl_VertexID, i = j >> 1;
    float t = float(i) / float(n);
    vec2 pos = cubic(aOpen0.xy, aOpen0.zw, aOpen1.xy, aOpen1.zw, t), nrm = normalAt(aOpen0.xy, aOpen0.zw, aOpen1.xy, aOpen1.zw, i, n);
    float dist = aWidth.z > 0.5 ? arcTo(aOpen0.xy, aOpen0.zw, aOpen1.xy, aOpen1.zw, i, n) : -1.0;
    ribbonVertex(pos, nrm, (j & 1) == 0 ? 1.0 : -1.0, pow(uFactor, aWidth.x + (aWidth.y - aWidth.x) * t), dist, aEnd0, aEnd1, aFold, aWidth.w, ivec4(aMasks));
  }`,
  fragment: RIBBON_FRAGMENT,
};

/** Arrows and dots, sized in line widths at the node end (spec 8.5: the arrow follows the width), masked there. */
const ARROW = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aPosition; in vec2 aOffset; in float aScale; in float aFill; in vec3 aEnd0; in vec3 aEnd1; in vec2 aFold; in float aConn; in vec4 aMasks;
  out float vAlpha; out vec3 vColor;
  uniform vec3 uLineColor; uniform vec3 uAbsent;
  ${COMMON}
  ${CONNECTION}
  ${ITEMS}
  ${MASK}
  void main() {
    float w = widthPx(aScale, aConn);
    ivec4 m = ivec4(aMasks);
    vAlpha = connectionAlpha(aScale, aEnd0, aEnd1, aFold, aConn) * maskAlpha(maskStrengths(m), maskReaches(m, aPosition));
    vColor = aFill == 2.0 ? uAbsent : uLineColor;
    gl_Position = project(aPosition + aOffset * w / uZoom);
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
 * Boxes as signed-distance rounded rectangles (one quad each, an instance per slot, read from the item texture), with
 * a border and one pixel of antialiasing. Style: 0 node, 1 phantom of a node (translucent, dashed border), 2 centre
 * phantom (disc), 3 absent phantom (dot). A top-level node keeps minNodePx on screen (spec 8.2); a badge is a dot on
 * the top-right corner (spec 11.3).
 */
const BOX = {
  vertex: /* glsl */ `#version 300 es
  in int aSlot; in vec2 aCorner;
  out vec2 vLocal; out vec2 vHalf; out float vRadius; out float vAlpha; out float vStyle; out float vBadge;
  uniform float uMinNodePx; uniform float uRadius; uniform float uBoxHalf; uniform float uBadgePx;
  ${COMMON}
  ${ITEMS}
  void main() {
    vec4 a = itemA(aSlot), b = itemB(aSlot);
    int flags = int(b.w);
    float parentK = b.y, badge = (flags & ${ITEM_BADGE}) != 0 ? 1.0 : 0.0;
    vec2 half_ = a.zw;
    if (parentK > 1e8) {
      float px = max(half_.x, half_.y) * uZoom;
      if (px < 0.5 * uMinNodePx) half_ *= 0.5 * uMinNodePx / max(px, 1e-9);
    }
    float pad = (1.5 + badge * 2.0 * uBadgePx) / uZoom;
    vLocal = (aCorner * 2.0 - 1.0) * (half_ + pad);
    vHalf = half_;
    // The corner radius scales with the box: boxRadius at the width of a step-0 box.
    vRadius = min(uRadius * half_.x / uBoxHalf, min(half_.x, half_.y));
    vAlpha = 1.0 - foldT(parentK);
    vStyle = float(flags & ${ITEM_STYLE});
    vBadge = badge;
    gl_Position = project(a.xy + vLocal);
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

/** Bundle markers: discs of markerRadiusPx, fading with the connection titles (spec 8.2, 8.5), masked as their bundle. */
const MARKER = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aCenter; in vec2 aCorner; in float aK; in float aConn; in vec4 aMasks;
  out vec2 vLocal; out float vAlpha;
  uniform float uRadiusPx; uniform float uHot; uniform float uTitle0; uniform float uTitle1;
  ${COMMON}
  ${ITEMS}
  ${MASK}
  void main() {
    vLocal = aCorner * (uRadiusPx + 1.5);
    ivec4 m = ivec4(aMasks);
    vAlpha = (aConn == uHot ? 1.0 : smoothRange(uTitle0, uTitle1, textPx(aK))) * maskAlpha(maskStrengths(m), maskReaches(m, aCenter));
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
 * swapping with its fold, a connection's with its size, its fading level, its masks (MASK, at its anchor), and lit when
 * hovered. Below 1 %, a glyph is not drawn (BitmapText was hidden). The coverage is Pixi's MSDF shader's: the median's distance in screen pixels
 * (distanceRange · size · zoom / font size), its gamma by the ink's luminance, premultiplied. An item's title is
 * anchored on its item's centre, read from the item texture (plan 3c task 8); a connection's has its anchor.
 */
const TEXT = {
  vertex: /* glsl */ `#version 300 es
  in vec2 aCorner; in vec2 aAnchor; in vec4 aGlyph; in vec2 aAtlas; in vec4 aTitle; in vec2 aFold; in float aSlot; in vec4 aMasks;
  out vec2 vUv; out float vAlpha; out vec3 vColor; out float vDistance;
  uniform vec2 uTextFade; uniform vec2 uTitleFade; uniform vec2 uSwap; uniform float uHot;
  uniform vec3 uInk; uniform vec3 uTitleInk; uniform vec2 uAtlasSize; uniform float uFontSize; uniform float uRange;
  ${COMMON}
  ${ITEMS}
  ${MASK}
  void main() {
    vec2 anchor = aSlot >= 0.0 ? itemA(int(aSlot)).xy + aAnchor : aAnchor;
    float size = aTitle.x, kind = aTitle.y, px = size * uZoom;
    float a;
    if (kind == 3.0) {
      // Under the fills of its connection's masks where it sits, as its line there (point 7, ronde 1).
      ivec4 m = ivec4(aMasks);
      a = (aTitle.z == uHot ? 1.0 : smoothRange(uTitleFade.x, uTitleFade.y, px) * (1.0 - foldT(aFold.x))) * maskAlpha(maskStrengths(m), maskReaches(m, anchor));
    } else {
      a = aTitle.w * smoothRange(uTextFade.x, uTextFade.y, px) * (1.0 - foldT(aFold.y));
      if (kind == 1.0) a *= 1.0 - smoothRange(uSwap.x, uSwap.y, foldT(aFold.x));
      else if (kind == 2.0) a *= smoothRange(uSwap.x, uSwap.y, foldT(aFold.x));
    }
    vAlpha = a;
    vColor = kind == 3.0 ? uTitleInk : uInk;
    float s = size / uFontSize;
    vec2 corner = aCorner * aGlyph.zw;
    vUv = (aAtlas + corner) / uAtlasSize;
    vDistance = uRange * s * uZoom;
    gl_Position = a > 0.01 ? project(anchor + (aGlyph.xy + corner) * s) : vec4(2.0, 2.0, 2.0, 1.0);
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
  simpleRibbon: Program; simpleGlyph: Program; curve: Program; arrow: Program; envelope: Program; box: Program; marker: Program; outline: Program;
  star: Program; sky: Program; text: Program;
}

export function createPrograms(gl: WebGL2RenderingContext): Programs {
  const make = (name: string, s: { vertex: string; fragment: string }) => new Program(gl, name, s.vertex, s.fragment);
  return {
    simpleRibbon: make('rubans simples', SIMPLE_RIBBON), simpleGlyph: make('pointes simples', SIMPLE_GLYPH), curve: make('courbes', CURVE),
    arrow: make('pointes', ARROW), envelope: make('enveloppes', ENVELOPE), box: make('boîtes', BOX), marker: make('marqueurs', MARKER),
    outline: make('contours', OUTLINE), star: make('étoiles', STAR), sky: make('ciel', SKY), text: make('titres', TEXT),
  };
}

/** The programs drawn in the world (setView), and those that draw connections (their fade and hover uniforms). */
export const worldPrograms = (pr: Programs): Program[] =>
  [pr.simpleRibbon, pr.simpleGlyph, pr.curve, pr.arrow, pr.envelope, pr.box, pr.marker, pr.outline, pr.star, pr.text];
export const connectionPrograms = (pr: Programs): Program[] => [pr.simpleRibbon, pr.simpleGlyph, pr.curve, pr.arrow];

/**
 * The uniforms the settings give (set once, and again when they change); the atlas is read from texture unit
 * ATLAS_UNIT, the item texture from ITEMS_UNIT, the envelopes from ENVELOPE_INDEX_UNIT and ENVELOPE_EDGES_UNIT.
 */
export function setParamUniforms(pr: Programs, p: RenderParams, font: FontData): void {
  const l = lod(p);
  for (const x of worldPrograms(pr)) setAll(x, l);
  for (const x of connectionPrograms(pr)) setAll(x, connection(p));
  for (const x of [pr.simpleRibbon, pr.simpleGlyph, pr.curve]) setAll(x, { uSegments: p.curveSegments });
  for (const x of [pr.simpleRibbon, pr.simpleGlyph]) {
    setAll(x, { uAnchorGap: p.anchorGap, uTension: p.trunkTension, uCullAlpha: p.ribbonCullAlpha, uHeadroom: p.curveZoomHeadroom });
  }
  setAll(pr.simpleGlyph, { uArrowLength: p.arrowLength, uArrowHalfWidth: p.arrowHalfWidth, uArrowNotch: p.arrowNotch, uDotRadius: p.dotRadius });
  for (const x of [pr.simpleRibbon, pr.simpleGlyph, pr.curve, pr.arrow, pr.marker, pr.box, pr.text]) setAll(x, { uItems: ITEMS_UNIT });
  for (const x of [pr.simpleRibbon, pr.simpleGlyph, pr.curve, pr.arrow, pr.marker, pr.text]) {
    setAll(x, { uEnvIndex: ENVELOPE_INDEX_UNIT, uEnvEdges: ENVELOPE_EDGES_UNIT, uFeatherOpen: p.featherOpenPx, uFeatherClosed: p.featherClosedPx });
  }
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
    uAtlas: ATLAS_UNIT, uAtlasSize: [font.scaleW, font.scaleH], uFontSize: font.size, uRange: font.distanceRange,
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
