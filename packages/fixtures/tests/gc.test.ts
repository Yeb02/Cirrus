import { expect, test } from 'vitest';
import { forceGc } from '../src/gc.ts';

test('forceGc libère un tableau de 100 Mo', () => {
  forceGc();
  const before = process.memoryUsage().heapUsed;
  // 12.5 million doubles: 100 MB on the JS heap (a typed array would live outside it).
  let big: number[] | null = new Array<number>(12_500_000).fill(0.5);
  const held = process.memoryUsage().heapUsed;
  expect(big.length).toBe(12_500_000);
  expect(held - before).toBeGreaterThan(90e6);
  big = null;
  forceGc();
  expect(big).toBeNull();
  expect(process.memoryUsage().heapUsed - before).toBeLessThan(10e6);
});
