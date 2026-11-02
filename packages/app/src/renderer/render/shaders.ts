import { Shader } from 'pixi.js';
import type { RenderParams, Rgb } from '@cirrus/view';

// Every mesh is drawn in world units relative to a local origin; the world container carries zoom and offset.
// On-screen sizes (widths, feathers, stars, markers) and fold transitions are computed here from uZoom, so geometry
// is only rebuilt when the visible set changes. Outputs are premultiplied. Antialiasing is analytic (no MSAA).

const COMMON = /* glsl */ `
uniform mat3 uProjectionMatrix;
uniform mat3 uWorldTransformMatrix;
uniform mat3 uTransformMatrix;
uniform float uZoom;
uniform float uBaseFont;
uniform float uTextScale;
uniform float uFactor;
uniform float uFold0;
uniform float uFold1;
vec4 project(vec2 p) {
  mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
  return vec4((mvp * vec3(p, 1.0)).xy, 0.0, 1.0);
}
float textPx(float k) { return uBaseFont * uTextScale * pow(uFactor, k) * uZoom; }
// 1 when a group is closed, 0 when open (spec 8.2); k above 1e8 means "no group": never folded.
float foldT(float k) { return k > 1e8 ? 0.0 : 1.0 - smoothstep(uFold0, uFold1, textPx(k)); }
`;

/** No group: the sentinel step for foldT. */
export const NO_GROUP = 1e9;

const lod = (p: RenderParams) => ({
  uZoom: { value: 1, type: 'f32' },
  uBaseFont: { value: p.baseFontPx, type: 'f32' },
  uTextScale: { value: p.textScale, type: 'f32' },
  uFactor: { value: p.factor, type: 'f32' },
  uFold0: { value: p.groupFold[0], type: 'f32' },
  uFold1: { value: p.groupFold[1], type: 'f32' },
});

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

const connectionUniforms = (p: RenderParams) => ({
  uWidthBase: { value: p.widthBasePx, type: 'f32' },
  uWidthMin: { value: p.widthMinPx, type: 'f32' },
  uWidthMax: { value: p.widthMaxPx, type: 'f32' },
  uScreen: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
  uFadeWorld: { value: p.connectionFadePx, type: 'f32' },
  uHot: { value: -1, type: 'f32' },
  uHoverBoost: { value: p.hoverBoostPx, type: 'f32' },
  uAlpha: { value: p.connectionAlpha, type: 'f32' },
  uLineColor: { value: p.connectionColor, type: 'vec3<f32>' },
  uAbsent: { value: p.absentColor, type: 'vec3<f32>' },
  uSky: { value: p.skyColor, type: 'vec3<f32>' },
  uDash: { value: p.dashPx, type: 'vec2<f32>' },
});

/** Ribbons: two vertices per centerline point, pushed by half the on-screen width plus one pixel of antialiasing. */
export function ribbonShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
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
    },
    resources: { lod: lod(p), conn: connectionUniforms(p) },
  });
}

/** Arrows, dots and hollow insides, sized in line widths at the node end (spec 8.5: the arrow follows the width). */
export function glyphShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
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
    },
    resources: { lod: lod(p), conn: connectionUniforms(p) },
  });
}

/** Group envelopes: opaque colours interpolated by the fold, a ring pushed out by the feather (spec 8.4). */
export function envelopeShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in vec2 aNormal; in float aAlpha; in vec3 aOpen; in vec3 aClosed; in float aFoldK;
      out float vAlpha; out vec3 vColor;
      uniform float uFeatherOpen; uniform float uFeatherClosed;
      ${COMMON}
      void main() {
        float t = foldT(aFoldK);
        vColor = mix(aOpen, aClosed, t);
        vAlpha = aAlpha;
        gl_Position = project(aPosition + aNormal * mix(uFeatherOpen, uFeatherClosed, t) / uZoom);
      }`,
      fragment: /* glsl */ `#version 300 es
      precision highp float;
      in float vAlpha; in vec3 vColor; out vec4 finalColor;
      void main() { finalColor = vec4(vColor, 1.0) * vAlpha; }`,
    },
    resources: {
      lod: lod(p),
      env: { uFeatherOpen: { value: p.featherOpenPx, type: 'f32' }, uFeatherClosed: { value: p.featherClosedPx, type: 'f32' } },
    },
  });
}

/**
 * Boxes as signed-distance rounded rectangles (one quad each), with a border and one pixel of antialiasing. Style:
 * 0 node, 1 phantom of a node (translucent, dashed border), 2 centre phantom (disc), 3 absent phantom (dot).
 * A top-level node keeps minNodePx on screen (spec 8.2); a badge is a dot on the top-right corner (spec 11.3).
 */
export function boxShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
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
      uniform float uZoom; uniform float uBorderPx; uniform float uBadgePx; uniform vec2 uDash;
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
          fillA = 0.45;
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
    },
    resources: {
      lod: lod(p),
      box: {
        uMinNodePx: { value: p.minNodePx, type: 'f32' },
        uRadius: { value: p.boxRadius, type: 'f32' },
        uBoxHalf: { value: p.boxWidth / 2, type: 'f32' },
        uBadgePx: { value: p.badgeRadiusPx, type: 'f32' },
        uBorderPx: { value: p.boxBorderPx, type: 'f32' },
        uDash: { value: p.dashPx, type: 'vec2<f32>' },
        uNode: { value: p.nodeColor, type: 'vec3<f32>' },
        uEdge: { value: p.nodeEdgeColor, type: 'vec3<f32>' },
        uMarker: { value: p.markerColor, type: 'vec3<f32>' },
        uConnection: { value: p.connectionColor, type: 'vec3<f32>' },
        uAbsent: { value: p.absentColor, type: 'vec3<f32>' },
      },
    },
  });
}

/** Bundle markers: discs of markerRadiusPx, fading with the connection titles (spec 8.2, 8.5). */
export function markerShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
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
      uniform float uRadiusPx; uniform vec3 uFill; uniform vec3 uRing;
      void main() {
        float d = length(vLocal) - uRadiusPx;
        float inside = clamp(0.5 - d, 0.0, 1.0);
        float ring = clamp(1.5 - abs(d + 1.0), 0.0, 1.0);
        finalColor = (vec4(uFill, 1.0) * (inside - ring * inside) + vec4(uRing, 1.0) * ring * inside) * vAlpha;
      }`,
    },
    resources: {
      lod: lod(p),
      marker: {
        uRadiusPx: { value: p.markerRadiusPx, type: 'f32' },
        uHot: { value: -1, type: 'f32' },
        uTitle0: { value: p.titleFade[0], type: 'f32' },
        uTitle1: { value: p.titleFade[1], type: 'f32' },
        uFill: { value: p.markerColor, type: 'vec3<f32>' },
        uRing: { value: p.connectionColor, type: 'vec3<f32>' },
      },
    },
  });
}

/** Stars: one quad per star, constant on-screen size, layer alpha as a uniform (spec 8.6: no twinkling). */
export function starShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in vec2 aCorner; uniform float uStarPx;
      ${COMMON}
      void main() { gl_Position = project(aPosition + aCorner * (0.5 * uStarPx / uZoom)); }`,
      fragment: /* glsl */ `#version 300 es
      precision highp float;
      uniform float uLayerAlpha; uniform float uBrightness; out vec4 finalColor;
      void main() { finalColor = vec4(0.85, 0.9, 1.0, 1.0) * uBrightness * uLayerAlpha; }`,
    },
    resources: {
      lod: lod(p),
      star: { uStarPx: { value: p.starSizePx, type: 'f32' }, uLayerAlpha: { value: 0, type: 'f32' }, uBrightness: { value: p.starBrightness, type: 'f32' } },
    },
  });
}

/**
 * Screen-space background: the sky gradient, and the fractal grid when chosen (spec 8.6). vWorld is the local world
 * position; uOffset* = origin mod spacing (computed in double precision), so lines stay fixed in the plan.
 */
export function skyShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in vec2 aWorld; in float aV;
      out vec2 vWorld; out float vV;
      uniform mat3 uProjectionMatrix; uniform mat3 uWorldTransformMatrix; uniform mat3 uTransformMatrix;
      void main() {
        vWorld = aWorld; vV = aV;
        mat3 mvp = uProjectionMatrix * uWorldTransformMatrix * uTransformMatrix;
        gl_Position = vec4((mvp * vec3(aPosition, 1.0)).xy, 0.0, 1.0);
      }`,
      fragment: /* glsl */ `#version 300 es
      precision highp float;
      in vec2 vWorld; in float vV; out vec4 finalColor;
      uniform vec3 uSky; uniform vec3 uSky2; uniform float uZoom;
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
        finalColor = vec4(mix(c, vec3(0.85, 0.9, 1.0), a), 1.0);
      }`,
    },
    resources: {
      sky: {
        uSky: { value: p.skyColor, type: 'vec3<f32>' },
        uSky2: { value: p.skyColor2, type: 'vec3<f32>' },
        uZoom: { value: 1, type: 'f32' },
        uSpacing: { value: [0, 0, 0], type: 'vec3<f32>' },
        uGridAlpha: { value: [0, 0, 0], type: 'vec3<f32>' },
        uOffset0: { value: [0, 0], type: 'vec2<f32>' },
        uOffset1: { value: [0, 0], type: 'vec2<f32>' },
        uOffset2: { value: [0, 0], type: 'vec2<f32>' },
      },
    },
  });
}

/** Sets uZoom on every shader that has the lod group. */
export function setZoom(shaders: Shader[], zoom: number): void {
  for (const s of shaders) s.resources.lod.uniforms.uZoom = zoom;
}

/** Selection outlines: rings around selected boxes and envelopes, at a constant on-screen gap and width. */
export function outlineShader(p: RenderParams, color: Rgb = p.selectionColor): Shader {
  return Shader.from({
    gl: {
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
    },
    resources: {
      lod: lod(p),
      outline: {
        uGapPx: { value: p.selectionGapPx, type: 'f32' },
        uWidthPx: { value: p.selectionWidthPx, type: 'f32' },
        uOutlineColor: { value: color, type: 'vec3<f32>' },
      },
    },
  });
}
