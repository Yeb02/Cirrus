import { expect, test } from 'vitest';
import { sheetNode } from '../src/renderer/sheets.ts';
import { ageOf } from '../src/renderer/agenda.ts';

test('sheetNode : la première ligne non vide pour titre, le reste pour résumé, ses caractères spéciaux LaTeX échappés', () => {
  expect(sheetNode('\n  Idée  \nsuite 50% & co_x')).toEqual({ title: 'Idée', summary: 'suite 50\\% \\& co\\_x' });
  expect(sheetNode('A\n\\ { } $ # ^ ~')).toEqual({ title: 'A', summary: '\\textbackslash{} \\{ \\} \\$ \\# \\textasciicircum{} \\textasciitilde{}' });
  expect(sheetNode('')).toEqual({ title: 'Feuillet', summary: '' });
  expect(sheetNode('  \n\t\n ')).toEqual({ title: 'Feuillet', summary: '' });
});

test('sheetNode : une première ligne de 300 caractères est coupée à 200, le reste passe au résumé', () => {
  const line = `${'a'.repeat(200)}${'b'.repeat(100)}`;
  const r = sheetNode(`${line}\nsuite`);
  expect(r.title).toBe('a'.repeat(200));
  expect(r.summary).toBe(`${'b'.repeat(100)}\nsuite`);
});

test('ageOf : à l’instant, minutes, heures, jours, puis la date', () => {
  const now = new Date(2026, 10, 14, 12, 0, 0).getTime();
  const min = 60_000, h = 60 * min, d = 24 * h;
  expect(ageOf(now - 30_000, now)).toBe('à l’instant');
  expect(ageOf(now + 5_000, now)).toBe('à l’instant');
  expect(ageOf(now - 5 * min, now)).toBe('il y a 5 min');
  expect(ageOf(now - 59 * min, now)).toBe('il y a 59 min');
  expect(ageOf(now - 3 * h, now)).toBe('il y a 3 h');
  expect(ageOf(now - 2 * d, now)).toBe('il y a 2 j');
  expect(ageOf(now - 7 * d + min, now)).toBe('il y a 6 j');
  expect(ageOf(new Date(2026, 10, 7, 9, 0).getTime(), now)).toBe('07/11/2026');
});
