import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LOCK_FILE, lockBase } from '../src/main/lock.ts';

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'cirrus-app-lock-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true, maxRetries: 5 }); });

test('verrou de la base : une seule instance la tient ; relâché, une autre le prend (I3)', () => {
  const base = join(dir, 'base');
  const first = lockBase(base);
  expect(first).not.toBeNull();
  expect(existsSync(join(base, LOCK_FILE))).toBe(true);
  expect(lockBase(base)).toBeNull();
  // Another base is not held.
  const other = lockBase(join(dir, 'autre'));
  expect(other).not.toBeNull();
  first!.release();
  first!.release();
  const again = lockBase(base);
  expect(again).not.toBeNull();
  again!.release();
  other!.release();
});

/** Polls `take` until it gives a lock (the system frees a dead process's locks shortly after it ends). */
async function eventually<T>(take: () => T | null, ms = 5000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const got = take();
    if (got !== null || Date.now() > end) return got;
    await new Promise((r) => setTimeout(r, 50));
  }
}

test('verrou tenu par un autre processus : refusé tant qu’il vit, libre après sa mort brutale (plantage), sans rien à nettoyer', async () => {
  const base = join(dir, 'base');
  const script = `import { lockBase } from ${JSON.stringify(new URL('../src/main/lock.ts', import.meta.url).href)};`
    + 'globalThis.held = lockBase(process.argv[1]); if (globalThis.held) console.log("pris"); setInterval(() => {}, 1000);';
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, base], { stdio: ['ignore', 'pipe', 'pipe'] });
  const exited = new Promise<void>((done) => child.once('exit', () => done()));
  try {
    const said = await new Promise<string>((done, fail) => {
      let out = '', err = '';
      child.stdout.on('data', (d) => { out += String(d); if (out.includes('pris')) done(out); });
      child.stderr.on('data', (d) => { err += String(d); });
      child.once('exit', (code) => fail(new Error(`processus fils terminé (${code}) : ${err}`)));
    });
    expect(said).toContain('pris');
    expect(lockBase(base)).toBeNull();
  } finally {
    child.kill('SIGKILL');
    await exited;
  }
  const after = await eventually(() => lockBase(base));
  expect(after).not.toBeNull();
  after!.release();
}, 30_000);
