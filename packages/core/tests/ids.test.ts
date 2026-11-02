import { expect, test } from 'vitest';
import { uuidv7 } from '../src/ids.ts';

test('format UUID v7', () => {
  expect(uuidv7()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test('ordonné dans le temps', () => {
  expect(uuidv7(1_000) < uuidv7(2_000)).toBe(true);
});

test('unique sur 10 000 tirages', () => {
  expect(new Set(Array.from({ length: 10_000 }, () => uuidv7())).size).toBe(10_000);
});
