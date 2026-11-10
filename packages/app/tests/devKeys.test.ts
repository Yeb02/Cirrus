import { expect, test } from 'vitest';
import { devShortcut } from '../src/main/devKeys.ts';

// The development shortcuts the window keeps now that it has no menu (plan 6a, fix round 1, Important 1): Ctrl+R reloads,
// Ctrl+Shift+I opens the DevTools; nothing else, and only on a key going down.
const input = (key: string, m: Partial<{ type: string; control: boolean; shift: boolean; alt: boolean; meta: boolean }> = {}) =>
  ({ type: 'keyDown', key, control: false, shift: false, alt: false, meta: false, ...m });

test('Ctrl+R recharge la page, Ctrl+Maj+I ouvre les outils de développement, en majuscule ou non', () => {
  expect(devShortcut(input('r', { control: true }))).toBe('reload');
  expect(devShortcut(input('R', { control: true }))).toBe('reload');
  expect(devShortcut(input('i', { control: true, shift: true }))).toBe('devtools');
  expect(devShortcut(input('I', { control: true, shift: true }))).toBe('devtools');
});

test('rien d’autre : ni la touche relâchée, ni un autre modificateur, ni une autre touche', () => {
  expect(devShortcut(input('r', { control: true, type: 'keyUp' }))).toBeNull();
  expect(devShortcut(input('r'))).toBeNull();
  expect(devShortcut(input('r', { control: true, shift: true }))).toBeNull();
  expect(devShortcut(input('r', { control: true, alt: true }))).toBeNull();
  expect(devShortcut(input('r', { meta: true }))).toBeNull();
  expect(devShortcut(input('i', { control: true }))).toBeNull();
  expect(devShortcut(input('i', { control: true, shift: true, alt: true }))).toBeNull();
  expect(devShortcut(input('F12'))).toBeNull();
  expect(devShortcut(input('k', { control: true }))).toBeNull();
});
