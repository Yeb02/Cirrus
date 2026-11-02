import { Buffer, BufferUsage, Geometry, Mesh, type Shader } from 'pixi.js';

export type CustomMesh = Mesh<Geometry, Shader>;

/**
 * Mesh.destroy() only drops the reference to its geometry: the geometry and its GPU buffers would linger until Pixi's
 * idle GC. Replaced meshes must free them explicitly (plan 1 review).
 */
export function disposeMesh(mesh: CustomMesh): void {
  const geometry = mesh.geometry;
  mesh.destroy();
  geometry.destroy(true);
}

export interface AttributeSpec { name: string; size: 1 | 2 | 3 | 4 }
const FORMAT = { 1: 'float32', 2: 'float32x2', 3: 'float32x3', 4: 'float32x4' } as const;
const grow = (n: number) => 2 ** Math.ceil(Math.log2(Math.max(64, n)));

interface Slot<T extends Float32Array | Uint32Array> { buffer: Buffer; storage: T }

/**
 * A mesh kept from one rebuild to the next (bench lesson: uploading weighs more than computing). update() rewrites
 * the buffers in place when they are large enough (bufferSubData of the used part), and reallocates them at double
 * capacity otherwise; only the used indices are drawn.
 */
export class MeshSlot {
  readonly mesh: CustomMesh;
  private readonly attrs = new Map<string, Slot<Float32Array>>();
  private readonly index: Slot<Uint32Array>;

  constructor(specs: AttributeSpec[], shader: Shader, initialVertices = 256) {
    const attributes: Record<string, { buffer: Buffer; format: (typeof FORMAT)[1 | 2 | 3 | 4] }> = {};
    for (const s of specs) {
      const storage = new Float32Array(grow(initialVertices * s.size));
      const buffer = new Buffer({ data: storage, usage: BufferUsage.VERTEX | BufferUsage.COPY_DST, shrinkToFit: false });
      this.attrs.set(s.name, { buffer, storage });
      attributes[s.name] = { buffer, format: FORMAT[s.size] };
    }
    const storage = new Uint32Array(grow(initialVertices * 3));
    this.index = { buffer: new Buffer({ data: storage, usage: BufferUsage.INDEX | BufferUsage.COPY_DST, shrinkToFit: false }), storage };
    const geometry = new Geometry({ attributes, indexBuffer: this.index.buffer });
    this.mesh = new Mesh({ geometry, shader });
    this.mesh.visible = false;
  }

  update(data: Record<string, Float32Array>, index: Uint32Array): void {
    for (const [name, slot] of this.attrs) put(slot, data[name], (n) => new Float32Array(n));
    put(this.index, index, (n) => new Uint32Array(n));
    // indexCount 0 would mean "the whole buffer": hide the mesh instead.
    this.mesh.geometry.indexCount = index.length;
    this.mesh.visible = index.length > 0;
  }

  dispose(): void {
    disposeMesh(this.mesh);
  }
}

function put<T extends Float32Array | Uint32Array>(slot: Slot<T>, data: T, make: (n: number) => T): void {
  if (data.length > slot.storage.length) {
    slot.storage = make(grow(data.length));
    slot.storage.set(data);
    slot.buffer.data = slot.storage;
  } else {
    slot.storage.set(data);
    slot.buffer.setDataWithSize(slot.storage, Math.max(1, data.length), true);
  }
}
