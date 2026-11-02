import { test, expect } from 'vitest';
import { Geometry, Mesh, type Shader } from 'pixi.js';
import { disposeMesh } from '../src/render/dispose';

test('remplacer un maillage libère aussi sa géométrie et ses tampons', () => {
  const geometry = new Geometry({ attributes: { aPosition: new Float32Array(6) }, indexBuffer: new Uint32Array([0, 1, 2]) });
  // No shader: compiling one needs a DOM; disposal does not depend on it.
  const mesh = new Mesh({ geometry }) as unknown as Mesh<Geometry, Shader>;
  const buffer = geometry.attributes.aPosition.buffer;
  let destroyed = 0;
  buffer.on('destroy', () => destroyed++);
  disposeMesh(mesh);
  expect(destroyed).toBe(1);
  expect(mesh.destroyed).toBe(true);
});
