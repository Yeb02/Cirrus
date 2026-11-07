import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

/**
 * The renames the test makes fail (the antivirus holding the temporary file a moment, review of task 6, M5): each
 * pending code is thrown once by the next rename, in order. `rm` fails too when `rmFails` is set.
 */
const failing = vi.hoisted(() => ({ renames: [] as string[], rmFails: false, calls: 0 }));
vi.mock('node:fs/promises', async (original) => {
  const fs = await original<typeof import('node:fs/promises')>();
  const rename = async (from: string, to: string) => {
    failing.calls++;
    const code = failing.renames.shift();
    if (code) throw Object.assign(new Error(`${code}: operation not permitted, rename '${from}' -> '${to}'`), { code });
    return fs.rename(from, to);
  };
  const rm = async (...a: Parameters<typeof fs.rm>) => {
    if (failing.rmFails) throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    return fs.rm(...a);
  };
  return { ...fs, rename, rm, default: { ...fs, rename, rm } };
});
const { filePath, storeBytesAsync } = await import('../src/files.ts');

let storeDir: string;
beforeEach(() => {
  storeDir = mkdtempSync(join(tmpdir(), 'cirrus-files-retry-'));
  Object.assign(failing, { renames: [], rmFails: false, calls: 0 });
});
afterEach(() => { rmSync(storeDir, { recursive: true, force: true }); });

const temporaries = () => readdirSync(join(storeDir, 'files'), { recursive: true }).filter((n) => String(n).includes('.import-'));

test('storeBytesAsync (revue de la tâche 6, M5) : un fichier temporaire que l’antivirus tient un instant est renommé au deuxième ou au troisième essai', async () => {
  for (const codes of [['EPERM'], ['EBUSY', 'EACCES']]) {
    const bytes = new TextEncoder().encode(`@misc{${codes.join('')}}\n`);
    failing.renames = [...codes];
    failing.calls = 0;
    const ref = await storeBytesAsync(storeDir, 'k.bib', bytes);
    expect(ref.hash).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(new Uint8Array(readFileSync(filePath(storeDir, ref)))).toEqual(bytes);
    expect(failing.calls, codes.join()).toBe(codes.length + 1);
  }
  expect(temporaries()).toEqual([]);
});

test('storeBytesAsync : trois échecs, ou une autre erreur, rejettent sans blob ni temporaire ; un temporaire qu’on ne peut retirer ne masque pas un blob écrit entre-temps', async () => {
  const bytes = new TextEncoder().encode('@misc{a}\n');
  failing.renames = ['EPERM', 'EPERM', 'EPERM'];
  await expect(storeBytesAsync(storeDir, 'a.bib', bytes)).rejects.toThrow('EPERM');
  expect(failing.calls).toBe(3);
  expect(existsSync(filePath(storeDir, { name: 'a.bib', hash: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }))).toBe(false);
  expect(temporaries()).toEqual([]);
  // Another error: no second try.
  failing.renames = ['ENOSPC'];
  failing.calls = 0;
  await expect(storeBytesAsync(storeDir, 'a.bib', bytes)).rejects.toThrow('ENOSPC');
  expect(failing.calls).toBe(1);
  // The blob there by then (another write of the same content), its temporary held: the store has it, no error.
  const other = new TextEncoder().encode('@misc{b}\n');
  const ref = await storeBytesAsync(storeDir, 'b.bib', other);
  rmSync(filePath(storeDir, ref));
  failing.renames = ['ENOSPC'];
  failing.rmFails = true;
  const write = storeBytesAsync(storeDir, 'b.bib', other);
  // The rename fails after the blob reappears: its content is the store's.
  const { writeFileSync } = await import('node:fs');
  writeFileSync(filePath(storeDir, ref), other);
  await expect(write).resolves.toEqual(ref);
});
