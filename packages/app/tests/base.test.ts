import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import { dataDir, openBase } from '../src/main/base.ts';

test('première ouverture : un lobby et un identifiant de PC stable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-app-'));
  const a = openBase(dir);
  const pcA = readFileSync(join(dir, 'pc.json'), 'utf8');
  a.close();
  const b = openBase(dir);
  expect([...b.loadState().plans.values()].filter((p) => p.type === 'lobby')).toHaveLength(1);
  expect(b.changesSince(0)).toHaveLength(1);
  expect(readFileSync(join(dir, 'pc.json'), 'utf8')).toBe(pcA);
  expect(JSON.parse(pcA).id).toMatch(/^[0-9a-f-]{36}$/);
  b.close();
});

test('dossier des données : variable CIRRUS_DATA, sinon sous les données de l’app', () => {
  const before = process.env.CIRRUS_DATA;
  delete process.env.CIRRUS_DATA;
  expect(dataDir(join('C:', 'u'))).toBe(join('C:', 'u', 'base'));
  process.env.CIRRUS_DATA = join('D:', 'test');
  expect(dataDir(join('C:', 'u'))).toBe(join('D:', 'test'));
  if (before === undefined) delete process.env.CIRRUS_DATA; else process.env.CIRRUS_DATA = before;
});

test('banc et captures : sans CIRRUS_DATA, refus d’ouvrir la base de l’utilisateur', () => {
  const before = process.env.CIRRUS_DATA;
  delete process.env.CIRRUS_DATA;
  expect(() => dataDir(join('C:', 'u'), true)).toThrow(/CIRRUS_DATA/);
  process.env.CIRRUS_DATA = join('D:', 'banc');
  expect(dataDir(join('C:', 'u'), true)).toBe(join('D:', 'banc'));
  if (before === undefined) delete process.env.CIRRUS_DATA; else process.env.CIRRUS_DATA = before;
});
