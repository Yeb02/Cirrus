import { Geometry, Shader } from 'pixi.js';
import type { RenderParams } from '../scene/params';

// Every mesh is drawn in world units relative to a local origin; the world container carries zoom and offset.
// Widths, star sizes and fold transitions are computed here from uZoom, so geometry is only rebuilt when the
// visible set changes.

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
// 1 when the group is closed, 0 when open (spec 8.2).
float foldT(float k) { return 1.0 - smoothstep(uFold0, uFold1, textPx(k)); }
`;

const lodUniforms = (p: RenderParams) => ({
  uZoom: { value: 1, type: 'f32' },
  uBaseFont: { value: p.baseFontPx, type: 'f32' },
  uTextScale: { value: p.textScale, type: 'f32' },
  uFactor: { value: p.factor, type: 'f32' },
  uFold0: { value: p.groupFold[0], type: 'f32' },
  uFold1: { value: p.groupFold[1], type: 'f32' },
});

/** Ribbons: centerline vertex + normal; the on-screen width is widthPx() of ribbon.ts. */
export function ribbonShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in vec2 aNormal; in float aScale;
      in vec3 aEnd0; in vec3 aEnd1; // two endpoints of the connection: (x, y, half extent), local world units
      uniform float uWidthBase; uniform float uWidthMin; uniform float uWidthMax;
      uniform vec4 uScreen;     // screen rectangle in local world units: minX, minY, maxX, maxY
      uniform float uFadeWorld; // connectionFadePx / zoom
      out float vAlpha;
      ${COMMON}
      // endpointFade() of ribbon.ts: 1 on screen, linear fade over the margin once the endpoint has left.
      float endpointFade(vec3 e) {
        vec2 d = max(max(uScreen.xy - e.xy, e.xy - uScreen.zw), 0.0);
        return max(0.0, 1.0 - max(0.0, length(d) - e.z) / uFadeWorld);
      }
      void main() {
        float raw = uWidthBase * aScale * uZoom;
        float w = clamp(raw, uWidthMin, uWidthMax);
        vAlpha = min(1.0, raw / uWidthMin) * max(endpointFade(aEnd0), endpointFade(aEnd1));
        gl_Position = project(aPosition + aNormal * (0.5 * w / uZoom));
      }`,
      fragment: /* glsl */ `#version 300 es
      in float vAlpha; uniform vec4 uRibbonColor; out vec4 finalColor;
      void main() { finalColor = vec4(uRibbonColor.rgb, 1.0) * uRibbonColor.a * vAlpha; }`,
    },
    resources: {
      lod: lodUniforms(p),
      ribbon: {
        uWidthBase: { value: p.widthBasePx, type: 'f32' },
        uWidthMin: { value: p.widthMinPx, type: 'f32' },
        uWidthMax: { value: p.widthMaxPx, type: 'f32' },
        uRibbonColor: { value: [0.56, 0.72, 1.0, 0.75], type: 'vec4<f32>' },
        uScreen: { value: [0, 0, 0, 0], type: 'vec4<f32>' },
        uFadeWorld: { value: p.connectionFadePx, type: 'f32' },
      },
    },
  });
}

/** Group envelopes: feathered ring alpha, two alternating level colours, opacity driven by the fold. */
export function hullShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in float aAlpha; in float aK; in float aLevel;
      out float vAlpha; out float vLevel;
      ${COMMON}
      void main() {
        float t = foldT(aK);
        vAlpha = aAlpha * (0.32 + 0.68 * t);
        vLevel = aLevel;
        gl_Position = project(aPosition);
      }`,
      fragment: /* glsl */ `#version 300 es
      in float vAlpha; in float vLevel; uniform vec3 uColorA; uniform vec3 uColorB; out vec4 finalColor;
      void main() { vec3 c = mix(uColorA, uColorB, vLevel); finalColor = vec4(c, 1.0) * vAlpha; }`,
    },
    resources: {
      lod: lodUniforms(p),
      hull: {
        uColorA: { value: [0.13, 0.25, 0.43], type: 'vec3<f32>' },
        uColorB: { value: [0.18, 0.35, 0.54], type: 'vec3<f32>' },
      },
    },
  });
}

/** Node boxes: fade out while their parent group closes (aParentK < -1e8 means top level). */
export function boxShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in float aParentK; out float vAlpha;
      ${COMMON}
      void main() {
        vAlpha = aParentK < -1e8 ? 1.0 : 1.0 - foldT(aParentK);
        gl_Position = project(aPosition);
      }`,
      fragment: /* glsl */ `#version 300 es
      in float vAlpha; uniform vec4 uBoxColor; out vec4 finalColor;
      void main() { finalColor = vec4(uBoxColor.rgb, 1.0) * uBoxColor.a * vAlpha; }`,
    },
    resources: { lod: lodUniforms(p), box: { uBoxColor: { value: [0.11, 0.17, 0.27, 1.0], type: 'vec4<f32>' } } },
  });
}

/** Stars: one quad per star, constant on-screen size, layer alpha as a uniform. */
export function starShader(p: RenderParams): Shader {
  return Shader.from({
    gl: {
      vertex: /* glsl */ `#version 300 es
      in vec2 aPosition; in vec2 aCorner; uniform float uStarPx;
      ${COMMON}
      void main() { gl_Position = project(aPosition + aCorner * (0.5 * uStarPx / uZoom)); }`,
      fragment: /* glsl */ `#version 300 es
      uniform float uLayerAlpha; out vec4 finalColor;
      void main() { finalColor = vec4(0.85, 0.9, 1.0, 1.0) * 0.7 * uLayerAlpha; }`,
    },
    resources: {
      lod: lodUniforms(p),
      star: { uStarPx: { value: p.starSizePx, type: 'f32' }, uLayerAlpha: { value: 0, type: 'f32' } },
    },
  });
}

/** Sets uZoom on every shader that has the lod group. */
export function setZoom(shaders: Shader[], zoom: number): void {
  for (const s of shaders) s.resources.lod.uniforms.uZoom = zoom;
}

export function makeGeometry(attributes: Record<string, { data: Float32Array; size: number }>, index: Uint32Array): Geometry {
  const FORMATS = { 1: 'float32', 2: 'float32x2', 3: 'float32x3' } as const;
  const attrs: Record<string, { buffer: Float32Array; format: (typeof FORMATS)[1 | 2 | 3] }> = {};
  for (const [name, a] of Object.entries(attributes)) attrs[name] = { buffer: a.data, format: FORMATS[a.size as 1 | 2 | 3] };
  return new Geometry({ attributes: attrs, indexBuffer: index });
}
