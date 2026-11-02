import type { Vec2 } from '@cirrus/core';
import type { FrameGeometry } from '@cirrus/view';

/** A frame as plain typed arrays named after the shader attributes: what the worker sends back (transferred). */
export interface PackedFrame {
  origin: Vec2;
  ribbons: Record<string, Float32Array>;
  ribbonIndex: Uint32Array;
  glyphs: Record<string, Float32Array>;
  glyphIndex: Uint32Array;
  envelopes: Record<string, Float32Array>;
  envelopeIndex: Uint32Array;
  centerlines: FrameGeometry['centerlines'];
  markers: FrameGeometry['markers'];
  titles: FrameGeometry['titles'];
  stubs: FrameGeometry['stubs'];
}

/** `copy`: detach the arrays from the frame's growable storage (needed to transfer them out of a worker). */
export function packFrame(f: FrameGeometry, copy: boolean): PackedFrame {
  const v = <T extends Float32Array | Uint32Array>(a: T): T => (copy ? (a.slice() as T) : a);
  const r = f.connections.ribbons, g = f.connections.glyphs, e = f.envelopes;
  return {
    origin: f.origin,
    ribbons: {
      aPosition: v(r.position.view()), aPosition2: v(r.position2.view()), aNormal: v(r.normal.view()), aNormal2: v(r.normal2.view()),
      aScale: v(r.scale.view()), aSide: v(r.side.view()), aDist: v(r.dist.view()), aEnd0: v(r.end0.view()), aEnd1: v(r.end1.view()),
      aFold: v(r.fold.view()), aConn: v(r.conn.view()),
    },
    ribbonIndex: v(r.index.view()),
    glyphs: {
      aPosition: v(g.position.view()), aPosition2: v(g.position2.view()), aOffset: v(g.offset.view()), aOffset2: v(g.offset2.view()),
      aScale: v(g.scale.view()), aFill: v(g.fill.view()), aEnd0: v(g.end0.view()), aEnd1: v(g.end1.view()), aFold: v(g.fold.view()), aConn: v(g.conn.view()),
    },
    glyphIndex: v(g.index.view()),
    envelopes: {
      aPosition: v(e.position.view()), aNormal: v(e.normal.view()), aAlpha: v(e.alpha.view()), aOpen: v(e.open.view()), aClosed: v(e.closed.view()),
      aFoldK: v(e.foldK.view()),
    },
    envelopeIndex: v(e.index.view()),
    centerlines: f.centerlines, markers: f.markers, titles: f.titles, stubs: f.stubs,
  };
}

export function transferables(p: PackedFrame): ArrayBuffer[] {
  return [...Object.values(p.ribbons), p.ribbonIndex, ...Object.values(p.glyphs), p.glyphIndex, ...Object.values(p.envelopes), p.envelopeIndex]
    .map((a) => a.buffer as ArrayBuffer);
}
