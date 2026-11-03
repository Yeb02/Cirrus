import type { Gl } from './context.ts';

/**
 * GPU time of what is drawn between `begin` and `end` (EXT_disjoint_timer_query_webgl2, the bench's measure): each
 * query is read once its result is available (`poll`), a few frames later; one the GPU timer saw disjoint (a change of
 * clock, a context switch) is counted and dropped. Without the extension there is no timer (`create` gives null):
 * the GPU time is reported unavailable, never guessed.
 */
export class GpuTimer<T> {
  /** Queries dropped as disjoint. */
  disjoint = 0;
  private readonly pending: { q: WebGLQuery; tag: T }[] = [];
  private open: WebGLQuery | null = null;
  private readonly g: Gl;

  private constructor(g: Gl) {
    this.g = g;
  }

  static create<T>(g: Gl): GpuTimer<T> | null {
    return g.timer ? new GpuTimer<T>(g) : null;
  }

  begin(): void {
    const { gl, timer } = this.g;
    if (!timer || this.open) return;
    this.open = gl.createQuery();
    if (this.open) gl.beginQuery(timer.TIME_ELAPSED_EXT, this.open);
  }

  end(tag: T): void {
    const { gl, timer } = this.g;
    if (!this.open) return;
    if (timer) {
      gl.endQuery(timer.TIME_ELAPSED_EXT);
      this.pending.push({ q: this.open, tag });
    }
    this.open = null;
  }

  /** Reads the queries answered so far, oldest first: `done(ms, tag)` for each one kept. */
  poll(done: (ms: number, tag: T) => void): void {
    const { gl, timer } = this.g;
    // A lost context drops its queries: nothing more will come of them.
    if (!timer) { this.pending.length = 0; return; }
    while (this.pending.length > 0 && gl.getQueryParameter(this.pending[0].q, gl.QUERY_RESULT_AVAILABLE)) {
      const { q, tag } = this.pending.shift()!;
      if (gl.getParameter(timer.GPU_DISJOINT_EXT)) this.disjoint++;
      else done(gl.getQueryParameter(q, gl.QUERY_RESULT) / 1e6, tag);
      gl.deleteQuery(q);
    }
  }

  get waiting(): number {
    return this.pending.length;
  }
}
