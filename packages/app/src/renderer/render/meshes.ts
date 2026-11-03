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
  private readonly buffers = new Map<string, DynamicBuffer>();
  private readonly index: DynamicBuffer;
  private readonly vao: VertexArray;
  private readonly gl: WebGL2RenderingContext;
  private count = 0;

  constructor(gl: WebGL2RenderingContext, program: Program, specs: AttributeSpec[], initialVertices = 256) {
    this.gl = gl;
    this.program = program;
    const attributes: Attribute[] = specs.map((s) => {
      const buffer = new DynamicBuffer(gl, gl.ARRAY_BUFFER, initialVertices * s.size * 4);
      this.buffers.set(s.name, buffer);
      return { name: s.name, buffer, size: s.size };
    });
    this.index = new DynamicBuffer(gl, gl.ELEMENT_ARRAY_BUFFER, initialVertices * 3 * 4);
    this.vao = new VertexArray(gl, program, attributes, this.index);
  }

  update(data: Record<string, Float32Array>, index: Uint32Array): void {
    for (const [name, buffer] of this.buffers) buffer.upload(data[name]);
    this.index.upload(index);
    this.count = index.length;
  }

  get empty(): boolean {
    return this.count === 0;
  }

  /** Draws with the program's uniforms as they are set. */
  draw(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    this.program.use();
    this.vao.bind();
    gl.drawElements(gl.TRIANGLES, this.count, gl.UNSIGNED_INT, 0);
    this.vao.unbind();
  }

  dispose(): void {
    this.vao.dispose();
    for (const b of this.buffers.values()) b.dispose();
    this.index.dispose();
  }
}

/** One instance's attributes, interleaved: their names and sizes in floats, in order. */
export type InstanceLayout = AttributeSpec[];

/**
 * A unit quad drawn once per instance (a triangle strip of corners (0, 0) to (1, 1) in `aCorner`), the instances'
 * attributes interleaved in one buffer: one upload and one draw call for all of them.
 */
export class InstanceMesh {
  readonly program: Program;
  private readonly corners: DynamicBuffer;
  private readonly instances: DynamicBuffer;
  private readonly vao: VertexArray;
  private readonly gl: WebGL2RenderingContext;
  private readonly floats: number;
  private count = 0;

  constructor(gl: WebGL2RenderingContext, program: Program, layout: InstanceLayout, initialInstances = 1024) {
    this.gl = gl;
    this.program = program;
    this.floats = layout.reduce((n, a) => n + a.size, 0);
    this.corners = new DynamicBuffer(gl, gl.ARRAY_BUFFER, 32);
    this.corners.upload(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]));
    this.instances = new DynamicBuffer(gl, gl.ARRAY_BUFFER, initialInstances * this.floats * 4);
    const stride = this.floats * 4;
    let offset = 0;
    const attributes: Attribute[] = [{ name: 'aCorner', buffer: this.corners, size: 2 }];
    for (const a of layout) {
      attributes.push({ name: a.name, buffer: this.instances, size: a.size, stride, offset, divisor: 1 });
      offset += a.size * 4;
    }
    this.vao = new VertexArray(gl, program, attributes);
  }

  /** `data`: whole instances, `floats` each. */
  update(data: Float32Array): void {
    this.instances.upload(data);
    this.count = Math.floor(data.length / this.floats);
  }

  get length(): number {
    return this.count;
  }

  draw(): void {
    if (this.count === 0) return;
    const gl = this.gl;
    this.program.use();
    this.vao.bind();
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
    this.vao.unbind();
  }

  dispose(): void {
    this.vao.dispose();
    this.corners.dispose();
    this.instances.dispose();
  }
}
