import type { Program } from './program.ts';

/** The WebGL calls a DynamicBuffer makes (a recording stand-in serves the tests, without WebGL under Node). */
export type BufferGl = Pick<WebGL2RenderingContext, 'createBuffer' | 'bindBuffer' | 'bufferData' | 'bufferSubData' | 'deleteBuffer' | 'DYNAMIC_DRAW'>;

/**
 * A GPU buffer kept from one rebuild to the next (bench lesson: uploading weighs more than computing). `upload` sends
 * only the used part (bufferSubData); a larger one first doubles the capacity until it fits (bufferData, the same
 * buffer object: vertex arrays keep their bindings).
 */
export class DynamicBuffer {
  readonly buffer: WebGLBuffer | null;
  /** Bytes allocated on the GPU. */
  capacity: number;
  /** Bytes of the last upload. */
  used = 0;
  private readonly gl: BufferGl;
  private readonly target: number;

  constructor(gl: BufferGl, target: number, initialBytes = 1024) {
    this.gl = gl;
    this.target = target;
    this.buffer = gl.createBuffer();
    this.capacity = Math.max(4, initialBytes);
    gl.bindBuffer(target, this.buffer);
    gl.bufferData(target, this.capacity, gl.DYNAMIC_DRAW);
  }

  upload(data: ArrayBufferView): void {
    const gl = this.gl, bytes = data.byteLength;
    this.used = bytes;
    if (bytes === 0) return;
    gl.bindBuffer(this.target, this.buffer);
    if (bytes > this.capacity) {
      let cap = this.capacity * 2;
      while (cap < bytes) cap *= 2;
      this.capacity = cap;
      gl.bufferData(this.target, cap, gl.DYNAMIC_DRAW);
    }
    gl.bufferSubData(this.target, 0, data);
  }

  /**
   * Elements [from, to) of `data` sent again to the same place, within what the last upload sent (plan 3c task 9: a
   * preview or an edit rewrites a few instances in place).
   */
  uploadRange(data: Float32Array | Int32Array | Uint32Array, from: number, to: number): void {
    if (to <= from) return;
    const bytes = data.BYTES_PER_ELEMENT;
    if (to * bytes > this.used) throw new Error(`Envoi partiel au-delà du dernier envoi : ${to * bytes} octets sur ${this.used}`);
    this.gl.bindBuffer(this.target, this.buffer);
    this.gl.bufferSubData(this.target, from * bytes, data, from, to - from);
  }

  dispose(): void {
    this.gl.deleteBuffer(this.buffer);
  }
}

/** An attribute read from a buffer: `size` floats (or 32-bit ints), at `offset` bytes in a vertex (or instance) of `stride` bytes. */
export interface Attribute {
  name: string;
  buffer: DynamicBuffer;
  size: 1 | 2 | 3 | 4;
  stride?: number;
  offset?: number;
  /** 1: one value per instance (vertexAttribDivisor), 0 (default): per vertex. */
  divisor?: 0 | 1;
  /** Read as signed ints (an `int`/`ivec` input: slots, flags), not converted to floats. */
  integer?: boolean;
}

/**
 * The attributes of a program bound once (a vertex array object), per vertex and per instance, with an index buffer
 * if any. Nothing else is bound while it is: buffers are uploaded with no vertex array bound.
 */
export class VertexArray {
  private readonly vao: WebGLVertexArrayObject | null;
  private readonly gl: WebGL2RenderingContext;

  constructor(gl: WebGL2RenderingContext, program: Program, attributes: Attribute[], index?: DynamicBuffer) {
    this.gl = gl;
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    for (const a of attributes) {
      const loc = program.attribute(a.name);
      // An attribute the compiler dropped (unused) has no location.
      if (loc < 0) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, a.buffer.buffer);
      gl.enableVertexAttribArray(loc);
      if (a.integer) gl.vertexAttribIPointer(loc, a.size, gl.INT, a.stride ?? 0, a.offset ?? 0);
      else gl.vertexAttribPointer(loc, a.size, gl.FLOAT, false, a.stride ?? 0, a.offset ?? 0);
      gl.vertexAttribDivisor(loc, a.divisor ?? 0);
    }
    if (index) gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, index.buffer);
    gl.bindVertexArray(null);
  }

  bind(): void {
    this.gl.bindVertexArray(this.vao);
  }

  unbind(): void {
    this.gl.bindVertexArray(null);
  }

  dispose(): void {
    this.gl.deleteVertexArray(this.vao);
  }
}
