import { readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from 'vitest';
import { wireBenchMode } from '../src/main/benchMode.ts';
import { benchCalls } from '../src/preload/bench.ts';

// The bench outside bench mode (plan 9, D8): the shipped app neither wires its calls nor carries its fixtures.

test('hors mode banc, le module du banc n’est jamais chargé, ses appels jamais branchés', async () => {
  let loaded = 0;
  const load = async () => {
    loaded++;
    return { wireBench: () => { throw new Error('branché hors mode banc'); } };
  };
  expect(await wireBenchMode(undefined, () => {}, load)).toBe(false);
  expect(await wireBenchMode('', () => {}, load)).toBe(false);
  expect(loaded).toBe(0);
});

test('en mode banc, le module est chargé puis branché avec son échelle et sa sortie', async () => {
  const exit = (_code: number) => {};
  const wired: unknown[] = [];
  const load = async () => ({ wireBench: (deps: { scale: string; exit(code: number): void }) => { wired.push(deps); } });
  expect(await wireBenchMode('50000,500000', exit, load)).toBe(true);
  expect(wired).toEqual([{ scale: '50000,500000', exit }]);
});

test('le préchargement n’expose les appels du banc qu’en mode banc', async () => {
  const invoked: unknown[][] = [];
  const invoke = async (...args: unknown[]) => { invoked.push(args); return 'ok'; };
  expect(benchCalls({}, invoke)).toEqual({});
  expect(benchCalls({ bench: '' }, invoke)).toEqual({});
  expect(benchCalls({ bench: 1 }, invoke)).toEqual({});
  const calls = benchCalls({ bench: 'vsync' }, invoke);
  expect(Object.keys(calls).sort()).toEqual(['benchDone', 'benchMemory']);
  await calls.benchMemory!();
  await calls.benchDone!({ label: 'vsync' });
  expect(invoked).toEqual([['cirrus:bench:memory'], ['cirrus:bench:done', { label: 'vsync' }]]);
});

const appDir = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * The modules `entries` import statically, transitively (the app's own files followed, a package named only): what
 * electron-vite puts in the entry's chunk. `import type` and dynamic `import()` are left out.
 */
function staticGraph(entries: string[]): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>(), packages = new Set<string>();
  const STATIC = /^(?:import|export)\s+(?!type\s)(?:[^;]*?\s+from\s+)?'([^']+)';/gm;
  const visit = (file: string) => {
    if (files.has(file)) return;
    files.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(STATIC)) {
      const spec = m[1];
      if (spec.startsWith('.')) visit(resolve(dirname(file), spec));
      else packages.add(spec);
    }
  };
  for (const e of entries) visit(join(appDir, e));
  return { files, packages };
}

test('le processus principal et le préchargement n’importent le banc que dynamiquement : ni @cirrus/fixtures, ni ses modules', () => {
  const { files, packages } = staticGraph(['src/main/index.ts', 'src/preload/index.ts']);
  const names = [...files].map((f) => relative(appDir, f).replaceAll('\\', '/'));
  // The walk does reach the app's modules (a check of the check).
  expect(names).toContain('src/main/window.ts');
  expect(names).toContain('src/main/ipc/base.ts');
  expect(names).toContain('src/preload/bench.ts');
  expect(packages).toContain('@cirrus/store');
  expect([...packages]).not.toContain('@cirrus/fixtures');
  expect(names).not.toContain('src/main/ipc/bench.ts');
  expect(names).not.toContain('src/main/bench.ts');
});
