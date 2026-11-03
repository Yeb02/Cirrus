/** EXT_disjoint_timer_query_webgl2's constants (the bench's GPU time, timer.ts). */
export interface TimerExt { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number }

/**
 * A WebGL 2 context on a canvas (plan 3c, task 7): no multisampling (the shaders antialias analytically), premultiplied
 * output, no depth nor stencil. Its drawing buffer follows the canvas's CSS size × devicePixelRatio; a lost context
 * stops the drawing until it is restored, after which every GPU resource is made again (`onRestored`).
 */
export interface Gl {
  readonly gl: WebGL2RenderingContext;
  readonly canvas: HTMLCanvasElement;
  /** The canvas's CSS size: the camera's screen. */
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
  /** Between a loss and its restoration: nothing is drawn, the resources are gone. */
  readonly lost: boolean;
  /** EXT_disjoint_timer_query_webgl2, null without it (or while lost). */
  readonly timer: TimerExt | null;
  /** Fits the drawing buffer to the canvas's CSS size and the devicePixelRatio; returns whether it changed. */
  resize(): boolean;
  /** Called once the context is back after a loss: programs, buffers and textures are to be made again, then drawn. */
  onRestored: () => void;
  /** Sets the state every pass assumes: premultiplied blending, no depth test. */
  reset(): void;
  destroy(): void;
}

export function createGl(canvas: HTMLCanvasElement): Gl {
  const context = canvas.getContext('webgl2', {
    alpha: false, antialias: false, premultipliedAlpha: true, depth: false, stencil: false, preserveDrawingBuffer: false,
  });
  if (!context) throw new Error('WebGL 2 indisponible : la vue ne peut pas être dessinée.');
  const gl = context;
  const timerOf = () => gl.getExtension('EXT_disjoint_timer_query_webgl2') as TimerExt | null;
  const g = {
    gl, canvas, width: 0, height: 0, dpr: 1, lost: false, timer: timerOf(),
    onRestored: () => {},
    resize(): boolean {
      const dpr = window.devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
      const pw = Math.max(1, Math.round(w * dpr)), ph = Math.max(1, Math.round(h * dpr));
      if (w === g.width && h === g.height && dpr === g.dpr && canvas.width === pw && canvas.height === ph) return false;
      g.width = w;
      g.height = h;
      g.dpr = dpr;
      canvas.width = pw;
      canvas.height = ph;
      return true;
    },
    reset(): void {
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    },
    destroy(): void {
      canvas.removeEventListener('webglcontextlost', onLost);
      canvas.removeEventListener('webglcontextrestored', onBack);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    },
  };
  // Without preventDefault the context would never come back.
  const onLost = (e: Event) => {
    e.preventDefault();
    g.lost = true;
    g.timer = null;
  };
  const onBack = () => {
    g.lost = false;
    g.timer = timerOf();
    g.reset();
    g.onRestored();
  };
  canvas.addEventListener('webglcontextlost', onLost);
  canvas.addEventListener('webglcontextrestored', onBack);
  g.reset();
  return g;
}
