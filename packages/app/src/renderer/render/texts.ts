import type { Measure, RenderParams } from '@cirrus/view';
import { BitmapFontManager, BitmapText, type Container, TextStyle } from 'pixi.js';

/** The MSDF atlas built by scripts/build-font.mjs from Inter (Latin, Greek, the symbols titles use). */
export const FONT_FAMILY = 'Inter-Regular';
export const FONT_URL = 'font/inter-msdf.fnt';

/**
 * Lines of a title at base size, as BitmapText will lay it out (the layout is scale-invariant, so one measure serves
 * every step). Cached per title.
 */
export function measureTitle(p: RenderParams): Measure {
  const style = new TextStyle({
    fontFamily: FONT_FAMILY, fontSize: p.baseFontPx, wordWrap: true, wordWrapWidth: p.boxWidth - 2 * p.boxPadX,
    lineHeight: p.baseFontPx * p.lineHeight, align: 'center',
  });
  const cache = new Map<string, number>();
  return (title) => {
    let n = cache.get(title);
    if (n === undefined) cache.set(title, (n = Math.max(1, BitmapFontManager.getLayout(title, style).lines.length)));
    return n;
  };
}

export interface TextSpec {
  text: string;
  /** World font size. */
  size: number;
  /** World wrap width; 0: no wrapping. */
  wrap: number;
  lineHeight: number;
  x: number;
  y: number;
  color: number;
}

const POOL_MAX = 4000;

/** BitmapText objects reused from one rebuild to the next (bench lesson: creating them is what costs). */
export class TextPool {
  private readonly pool: BitmapText[] = [];

  private readonly layer: Container;

  constructor(layer: Container) {
    this.layer = layer;
  }

  acquire(spec: TextSpec): BitmapText {
    let t = this.pool.pop();
    if (!t) {
      t = new BitmapText({ text: '', style: { fontFamily: FONT_FAMILY, fontSize: spec.size, fill: 0xffffff, align: 'center' } });
      t.anchor.set(0.5);
    }
    this.apply(t, spec);
    t.visible = true;
    this.layer.addChild(t);
    return t;
  }

  /** Changes only what differs (setting text or style triggers a new layout). */
  apply(t: BitmapText, spec: TextSpec): void {
    if (t.text !== spec.text) t.text = spec.text;
    const st = t.style;
    if (st.fontSize !== spec.size) st.fontSize = spec.size;
    const wrap = spec.wrap > 0;
    if (st.wordWrap !== wrap) st.wordWrap = wrap;
    if (wrap && st.wordWrapWidth !== spec.wrap) st.wordWrapWidth = spec.wrap;
    if (st.lineHeight !== spec.lineHeight) st.lineHeight = spec.lineHeight;
    t.tint = spec.color;
    t.position.set(spec.x, spec.y);
  }

  release(t: BitmapText): void {
    this.layer.removeChild(t);
    if (this.pool.length < POOL_MAX) { t.visible = false; this.pool.push(t); } else t.destroy();
  }

  destroy(): void {
    for (const t of this.pool) t.destroy();
    this.pool.length = 0;
  }
}
