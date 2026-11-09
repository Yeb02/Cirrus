import { type Attribute, DynamicBuffer, VertexArray } from '../gl/buffers.ts';
import type { Program } from '../gl/program.ts';

export interface AttributeSpec { name: string; size: 1 | 2 | 3 | 4 }

/**
 * An indexed triangle mesh kept from one rebuild to the next, one buffer per attribute (as the view builds them):
 * update() sends only the used part of each, the capacity doubling when it must (DynamicBuffer); only the used
 * indices are drawn.
 */
export class Mesh {
  readonly program: Program;
  private readonly buffers = new Map<string, { buffer: DynamicBuffer; size: number }>();
  private readonly index: DynamicBuffer;
  private readonly vao: VertexArray;
  private readonly gl: WebGL2RenderingContext;
  private count = 0;

  constructor(gl: WebGL2RenderingContext, program: Program, specs: AttributeSpec[], initialVertices = 256) {
    this.gl = gl;
    this.program = program;
    const attributes: Attribute[] = specs.map((s) => {
      const buffer = new DynamicBuffer(gl, gl.ARRAY_BUFFER, initialVertices * s.size * 4);
      this.buffers.set(s.name, { buffer, size: s.size });
      return { name: s.name, buffer, size: s.size };
    });
    this.index = new DynamicBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, initialVertices * 3 * 4);
    this.vao = new VertexArray(gl, program, attributes, this.index);
  }

  update(data: Record<string, Float32Array>, index: Uint32Array): void {
    for (const [name, { buffer }] of this.buffers) buffer.upload(data[name]);
    this.index.upload(index);
    this.count = index.length;
  }

  /** Vertices [from, to) sent again, the indices as they are (a preview or an edit rewrites them in place). */
  updateRange(data: Record<string, Float32Array>, from: number, to: number): void {
    for (const [name, { buffer, size }] of this.buffers) buffer.uploadRange(data[name], from * size, to * size);
  }

  get empty(): boolean {
    return this.count === 0;
  }

  get length(): number {
    return this.count;
  }

  /** Draws indices [from, to) (all of them by default) with the program's uniforms as they are set. */
  draw(from = 0, to = this.count): void {
    if (to <= from) return;
    const gl = this.gl;
    this.program.use();
    this.vao.bind();
    gl.drawElements(gl.TRIANGLES, to - from, gl.UNSIGNED_INT, from * 4);
    this.vao.unbind();
  }

  dispose(): void {
    this.vao.dispose();
    for (const { buffer } of this.buffers.values()) buffer.dispose();
    this.index.dispose();
  }
}

/** One instance's attributes, interleaved: their names and sizes in floats (or ints), in order. */
type InstanceLayout = AttributeSpec[];

/**
 * Instances drawn by one or more programs (plan 3c task 8: a simple connection's ribbons and glyphs come from the same
 * instances), their attributes interleaved in one buffer, all floats or all ints: one upload, one draw call per
 * program. Each instance is `vertices` vertices of `mode` (by default a unit quad, a triangle strip of corners (0, 0)
 * to (1, 1) in `aCorner`); a program that computes its vertices from gl_VertexID ignores the corners.
 */
export class InstanceMesh {
  private readonly corners: DynamicBuffer;
  private readonly instances: DynamicBuffer;
  private readonly vaos: { program: Program; vao: VertexArray }[];
  private readonly gl: WebGL2RenderingContext;
  private readonly size: number;
  private count = 0;

  constructor(gl: WebGL2RenderingContext, programs: Program[], layout: InstanceLayout, initialInstances = 1024, integer = false) {
    this.gl = gl;
    this.size = layout.reduce((n, a) => n + a.size, 0);
    this.corners = new DynamicBuffer(gl, gl.ARRAY_BUFFER, 32);
    this.corners.upload(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    this.instances = new DynamicBuffer(gl, gl.ARRAY_BUFFER, initialInstances * this.size * 4);
    const stride = this.size * 4;
    let offset = 0;
    const attributes: Attribute[] = [{ name: 'aCorner', buffer: this.corners, size: 2 }];
    for (const a of layout) {
      attributes.push({ name: a.name, buffer: this.instances, size: a.size, stride, offset, divisor: 1, integer });
      offset += a.size * 4;
    }
    this.vaos = programs.map((program) => ({ program, vao: new VertexArray(gl, program, attributes) }));
  }

  /** `data`: whole instances, the layout's size each. */
  update(data: Float32Array | Int32Array): void {
    this.instances.upload(data);
    this.count = Math.floor(data.length / this.size);
  }

  /** Instances [from, to) of `data` (the storage last sent) sent again in place. */
  updateRange(data: Float32Array | Int32Array, from: number, to: number): void {
    this.instances.uploadRange(data, from * this.size, to * this.size);
  }

  get length(): number {
    return this.count;
  }

  /** Draws every instance with program `which` (in the constructor's order) and its uniforms as they are set. */
  draw(which = 0, vertices = 4, mode: number = this.gl.TRIANGLE_STRIP): void {
    if (this.count === 0) return;
    const { program, vao } = this.vaos[which];
    program.use();
    vao.bind();
    this.gl.drawArraysInstanced(mode, 0, vertices, this.count);
    vao.unbind();
  }

  dispose(): void {
    for (const { vao } of this.vaos) vao.dispose();
    this.corners.dispose();
    this.instances.dispose();
  }
}
