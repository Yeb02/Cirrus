import { mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { readSettings, writeSettings } from '../src/main/settings.ts';

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
  writeSettings(dir, { factor: 3 });
  expect(readSettings(dir)).toEqual({ factor: 3 });
  expect(readdirSync(dir)).toEqual(['settings.json']); // no temporary file left
});
