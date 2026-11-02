import { expect, test } from 'vitest';
import { appendEnvelope, newEnvelopeMeshes } from '../src/geometry/envelope.ts';

test('enveloppe : éventail intérieur opaque, anneau extérieur à alpha 0 avec normales unitaires', () => {
  const m = newEnvelopeMeshes();
  const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  appendEnvelope(m, sq, 10, { open: [0.1, 0.2, 0.3], closed: [0.4, 0.5, 0.6] }, 2);
  const alpha = [...m.alpha.view()], normal = [...m.normal.view()];
  const n = alpha.length;
  expect(n).toBe(1 + 2 * 4);
  expect(alpha.filter((a) => a === 1)).toHaveLength(5);
  expect(alpha.filter((a) => a === 0)).toHaveLength(4);
  for (let i = 0; i < n; i++) {
    const l = Math.hypot(normal[i * 2], normal[i * 2 + 1]);
    expect(l).toBeCloseTo(alpha[i] === 0 ? 1 : 0, 6); // float32 storage
  }
  expect([...m.foldK.view()].every((k) => k === 2)).toBe(true);
  expect([...m.closed.view()].slice(0, 3).map((c) => Math.round(c * 10))).toEqual([4, 5, 6]);
  expect([...m.index.view()].every((i) => i < n)).toBe(true);
});

test('deux enveloppes à la suite : indices décalés', () => {
  const m = newEnvelopeMeshes();
  const sq = [{ x: -1, y: -1 }, { x: 1, y: -1 }, { x: 1, y: 1 }, { x: -1, y: 1 }];
  appendEnvelope(m, sq, 10, { open: [0, 0, 0], closed: [0, 0, 0] }, 0);
  appendEnvelope(m, sq, 10, { open: [0, 0, 0], closed: [0, 0, 0] }, 0);
  expect(Math.max(...m.index.view())).toBe(2 * 9 - 1);
});
