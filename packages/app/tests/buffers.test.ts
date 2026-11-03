import { expect, test } from 'vitest';
import { type BufferGl, DynamicBuffer } from '../src/renderer/gl/buffers.ts';

const ARRAY_BUFFER = 0x8892;

/** The calls a DynamicBuffer makes, recorded (no WebGL under Node). */
function recorder() {
  const calls: { fn: string; target?: number; size?: number; offset?: number; bytes?: number }[] = [];
  const gl: BufferGl = {
    DYNAMIC_DRAW: 0x88e8,
    createBuffer: () => ({}) as WebGLBuffer,
    deleteBuffer: () => { calls.push({ fn: 'deleteBuffer' }); },
    bindBuffer: (target: number) => { calls.push({ fn: 'bindBuffer', target }); },
    bufferData: ((target: number, size: number) => { calls.push({ fn: 'bufferData', target, size }); }) as unknown as BufferGl['bufferData'],
    bufferSubData: ((target: number, offset: number, data: ArrayBufferView) => { calls.push({ fn: 'bufferSubData', target, offset, bytes: data.byteLength }); }) as unknown as BufferGl['bufferSubData'],
  };
  return { gl, calls };
}

test('DynamicBuffer : seule la partie utilisée est envoyée, la capacité double jusqu’à suffire', () => {
  const { gl, calls } = recorder();
  const b = new DynamicBuffer(gl, ARRAY_BUFFER, 1024);
  expect(b.capacity).toBe(1024);
  expect(calls).toEqual([{ fn: 'bindBuffer', target: ARRAY_BUFFER }, { fn: 'bufferData', target: ARRAY_BUFFER, size: 1024 }]);

  // Within the capacity: no reallocation, the used bytes only, from the start.
  calls.length = 0;
  const storage = new Float32Array(1000);
  b.upload(storage.subarray(0, 100));
  expect(calls).toEqual([{ fn: 'bindBuffer', target: ARRAY_BUFFER }, { fn: 'bufferSubData', target: ARRAY_BUFFER, offset: 0, bytes: 400 }]);
  expect([b.capacity, b.used]).toEqual([1024, 400]);

  // 1 200 bytes: doubled once (2 048); 4 100 bytes: doubled until it fits (4 096 is short: 8 192).
  calls.length = 0;
  b.upload(storage.subarray(0, 300));
  expect(calls.map((c) => c.fn)).toEqual(['bindBuffer', 'bufferData', 'bufferSubData']);
  expect(calls[1].size).toBe(2048);
  expect(calls[2].bytes).toBe(1200);
  calls.length = 0;
  b.upload(new Float32Array(1025));
  expect(calls[1]).toEqual({ fn: 'bufferData', target: ARRAY_BUFFER, size: 8192 });
  expect(calls[2].bytes).toBe(4100);
  expect(b.capacity).toBe(8192);

  // Smaller again: the capacity stays; nothing at all is sent for an empty upload.
  calls.length = 0;
  b.upload(storage.subarray(0, 10));
  expect(calls.map((c) => c.fn)).toEqual(['bindBuffer', 'bufferSubData']);
  expect(b.capacity).toBe(8192);
  calls.length = 0;
  b.upload(new Float32Array(0));
  expect(calls).toEqual([]);
  expect(b.used).toBe(0);
});
