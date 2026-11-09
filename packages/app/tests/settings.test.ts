import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { writeJsonAtomic } from '../src/main/jsonFile.ts';
import { readSettings, SharedSettings } from '../src/main/settings.ts';

test('réglages : absents, corrompus, puis écrits', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-settings-'));
  expect(readSettings(dir)).toEqual({});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  writeFileSync(join(dir, 'settings.json'), '{pas du json');
  expect(readSettings(dir)).toEqual({});
  writeFileSync(join(dir, 'settings.json'), '[1, 2]');
  expect(readSettings(dir)).toEqual({});
  expect(warn).toHaveBeenCalled();
  warn.mockRestore();
  // Written as Réglages writes them, without a server.
  new SharedSettings(dir, 'pc-a', () => {}).local({ factor: 3 }, null);
  expect(readSettings(dir)).toEqual({ factor: 3 });
  expect(readdirSync(dir)).toEqual(['settings.json']); // no temporary file left
  rmSync(dir, { recursive: true, force: true });
});

test('relecture des corrections du plan 5a, N5 : un renommage refusé, ou une valeur que JSON n’écrit pas, ne laisse aucun fichier temporaire ; l’erreur est rendue', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-json-'));
  // The target a folder that holds a file: no system renames a file over it.
  const target = join(dir, 'settings.json');
  mkdirSync(target);
  writeFileSync(join(target, 'dedans'), '');
  expect(() => writeJsonAtomic(target, { factor: 3 }, { sync: true, space: 2 })).toThrow();
  expect(readdirSync(dir)).toEqual(['settings.json']);
  rmSync(target, { recursive: true });
  // A BigInt: refused before any file is opened.
  expect(() => writeJsonAtomic(target, { factor: 3n }, { sync: true })).toThrow(TypeError);
  expect(readdirSync(dir)).toEqual([]);
  rmSync(dir, { recursive: true, force: true });
});
