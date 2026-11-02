import type { Geometry, Mesh, Shader } from 'pixi.js';

/**
 * Mesh.destroy() only drops the reference to its geometry: the geometry and its GPU buffers would linger until
 * Pixi's idle GC (60 s). Rebuilt meshes must free them explicitly (review of plan 1, finding 3).
 */
export function disposeMesh(mesh: Mesh<Geometry, Shader>): void {
  const geometry = mesh.geometry;
  mesh.destroy();
  geometry.destroy(true);
}
