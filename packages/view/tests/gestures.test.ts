import { expect, test } from 'vitest';
import { GestureMachine, type Input, isPinch, newlyPressed, stepWheel } from '../src/gestures.ts';
import type { Hit } from '../src/hit.ts';
import { P } from './helpers.ts';

const cam = { x: 0, y: 0, zoom: 2, widthPx: 800, heightPx: 600 };
const item: Hit = { kind: 'item', item: 3 };
const bg: Hit = { kind: 'background' };
const down = (sx: number, sy: number, hit: Hit, extra: Partial<Extract<Input, { t: 'down' }>> = {}): Input =>
  ({ t: 'down', button: 0, sx, sy, ctrl: false, alt: false, shift: false, hit, ...extra });
const move = (sx: number, sy: number): Input => ({ t: 'move', sx, sy });
const up = (sx: number, sy: number, button: 0 | 1 | 2 = 0): Input => ({ t: 'up', button, sx, sy });

test('un mouvement sous le seuil reste un clic', () => {
  const g = new GestureMachine(P);
  g.feed(down(100, 100, item), cam);
  expect(g.feed(move(102, 101), cam)).toEqual([]);
  expect(g.feed(up(102, 101), cam)).toEqual([{ t: 'click', hit: item, ctrl: false, shift: false, sx: 100, sy: 100 }]);
});

test('au-delà du seuil sur un élément : déplacement en coordonnées du monde, puis dépôt', () => {
  const g = new GestureMachine(P);
  g.feed(down(100, 100, item), cam);
  expect(g.feed(move(120, 100), cam)).toEqual([{ t: 'dragStart', hit: item, alt: false }, { t: 'dragMove', dx: 10, dy: 0, sx: 120, sy: 100 }]);
  expect(g.feed(move(140, 110), cam)).toEqual([{ t: 'dragMove', dx: 20, dy: 5, sx: 140, sy: 110 }]);
  expect(g.feed(up(140, 110), cam)).toEqual([{ t: 'dragEnd', dx: 20, dy: 5, at: { x: -130, y: -95 }, alt: false }]);
  expect(g.busy).toBe(false);
});

test('Échap, clic droit ou perte du focus annulent un déplacement (Review Focus 2)', () => {
  for (const interrupt of [{ t: 'key', key: 'Escape' }, { t: 'down', button: 2, sx: 0, sy: 0, ctrl: false, alt: false, shift: false, hit: bg }, { t: 'cancel' }] as Input[]) {
    const g = new GestureMachine(P);
    g.feed(down(100, 100, item), cam);
    g.feed(move(130, 100), cam);
    expect(g.feed(interrupt, cam)).toEqual([{ t: 'dragCancel' }]);
    expect(g.feed(up(130, 100), cam)).toEqual([]);
  }
});

test('sur le fond : la vue suit la souris ; Alt sur un élément : déplacement « exclure »', () => {
  const g = new GestureMachine(P);
  g.feed(down(100, 100, bg), cam);
  expect(g.feed(move(110, 95), cam)).toEqual([{ t: 'pan', dxPx: 10, dyPx: -5 }]);
  expect(g.feed(move(112, 95), cam)).toEqual([{ t: 'pan', dxPx: 2, dyPx: 0 }]);
  g.feed(up(112, 95), cam);
  const h = new GestureMachine(P);
  h.feed(down(100, 100, item, { alt: true }), cam);
  expect(h.feed(move(130, 100), cam)[0]).toEqual({ t: 'dragStart', hit: item, alt: true });
});

test('Ctrl et bouton enfoncé : rectangle de sélection, en coordonnées du monde', () => {
  const g = new GestureMachine(P);
  g.feed(down(100, 100, item, { ctrl: true }), cam);
  expect(g.feed(move(200, 160), cam)).toEqual([{ t: 'rectMove', rect: { minX: -150, minY: -100, maxX: -100, maxY: -70 } }]);
  expect(g.feed(up(200, 160), cam)).toEqual([{ t: 'rectEnd', rect: { minX: -150, minY: -100, maxX: -100, maxY: -70 } }]);
});

test('clic droit sans bouger : menu contextuel', () => {
  const g = new GestureMachine(P);
  g.feed(down(50, 60, item, { button: 2 }), cam);
  expect(g.feed(up(50, 60, 2), cam)).toEqual([{ t: 'context', hit: item, sx: 50, sy: 60 }]);
});

test('geste sans bouton : suit le curseur, se pose au clic gauche, s’annule au clic droit ou par Échap', () => {
  const g = new GestureMachine(P);
  g.start('place');
  expect(g.busy).toBe(true);
  expect(g.feed(move(500, 400), cam)).toEqual([{ t: 'placeMove', at: { x: 50, y: 50 }, sx: 500, sy: 400 }]);
  expect(g.feed(down(500, 400, item), cam)).toEqual([{ t: 'place', mode: 'place', at: { x: 50, y: 50 }, hit: item }]);
  expect(g.busy).toBe(false);
  g.start('connect');
  expect(g.feed(down(0, 0, bg, { button: 2 }), cam)).toEqual([{ t: 'placeCancel', mode: 'connect' }]);
  g.start('paste');
  expect(g.feed({ t: 'key', key: 'Escape' }, cam)).toEqual([{ t: 'placeCancel', mode: 'paste' }]);
});

test('une amorce se tire comme un élément, pour lui donner une place (spec 8.5)', () => {
  const g = new GestureMachine(P);
  const stub: Hit = { kind: 'stub', conn: 0, stub: 0 };
  g.feed(down(100, 100, stub), cam);
  expect(g.feed(move(130, 100), cam)[0]).toEqual({ t: 'dragStart', hit: stub, alt: false });
});

test('scission d’un bras : deux poses de suite, le relâchement de la première ne compte pas', () => {
  const g = new GestureMachine(P);
  g.start('split');
  expect(g.feed(down(10, 10, bg), cam)).toMatchObject([{ t: 'place', mode: 'split' }]);
  g.start('split');
  expect(g.feed(up(10, 10), cam)).toEqual([]);
  expect(g.busy).toBe(true);
  expect(g.feed({ t: 'key', key: 'Escape' }, cam)).toEqual([{ t: 'placeCancel', mode: 'split' }]);
});

test('Ctrl+molette : les crans d’un même geste s’additionnent, une pause ou une autre cible en commence un autre', () => {
  let acc = stepWheel(null, 'a', -120, 0, P);
  expect(acc).toMatchObject({ target: 'a', delta: 1, flush: null });
  acc = stepWheel(acc, 'a', -120, 100, P);
  expect(acc).toMatchObject({ delta: 2, flush: null });
  acc = stepWheel(acc, 'a', 120, 200, P);
  expect(acc).toMatchObject({ delta: 1, flush: null });
  const later = stepWheel(acc, 'a', -120, 200 + P.scaleGesturePauseMs + 1, P);
  expect(later).toMatchObject({ delta: 1, flush: { target: 'a', delta: 1 } });
  const other = stepWheel(later, 'b', 120, 1000, P);
  expect(other).toMatchObject({ target: 'b', delta: -1, flush: { target: 'a', delta: 1 } });
});

test('Ctrl+molette : un cran de molette vaut un cran, les petits défilements s’additionnent ; un pincement n’en est pas (I13 de la relecture 3b)', () => {
  let acc = stepWheel(null, 'a', -40, 0, P);
  expect(acc.delta).toBe(0);
  acc = stepWheel(acc, 'a', -40, 10, P);
  expect(acc.delta).toBe(0);
  acc = stepWheel(acc, 'a', -40, 20, P); // 120 ≥ scaleWheelStepPx
  expect(acc.delta).toBe(1);
  acc = stepWheel(acc, 'a', -120, 30, P);
  expect(acc.delta).toBe(2);
  expect(isPinch(-3.25)).toBe(true);
  expect(isPinch(-120)).toBe(false);
  expect(isPinch(100)).toBe(false);
});

test('un second bouton pressé pendant un geste n’arrive qu’en mouvement : on le reconnaît au masque des boutons (I1 de la relecture 3b)', () => {
  expect(newlyPressed(1, 3)).toEqual([2]); // right pressed while left is held
  expect(newlyPressed(0, 1)).toEqual([0]);
  expect(newlyPressed(3, 1)).toEqual([]);
  expect(newlyPressed(1, 5)).toEqual([1]); // middle
});
