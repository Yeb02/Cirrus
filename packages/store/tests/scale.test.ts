import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Placement, placementKey, uuidv7 } from '@cirrus/core';
import { buildLargeState } from '@cirrus/fixtures';
import { expect, test } from 'vitest';
import { writeBenchBase } from '../src/bulk.ts';
import { LocalStore } from '../src/localStore.ts';

// Timed tests run one after the other in this file, not against each other.

/** The best of seven runs, after two to warm up (the machine may be shared: what else it does only adds). */
function cost<T>(fn: () => T): { ms: number; out: T } {
  let out = fn();
  out = fn();
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    out = fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, out };
}

test('base de référence : l’instantané se lit en 150 ms au plus, un déplacement s’écrit en 5 ms au plus, validé par SQL', () => {
  const { state, lobby } = buildLargeState({ seed: 1, nodes: 50_000, connections: 500_000 });
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-store-scale-'));
  try {
    writeBenchBase(dir, state);
    const store = LocalStore.open(dir, { pc: 'banc' });
    const read = cost(() => store.readSnapshot());
    expect(read.ms).toBeLessThanOrEqual(150);
    expect(read.out).toMatchObject({ seq: 0 });
    expect(read.out!.data.byteLength).toBeGreaterThan(1e6);
    // A move: one placement operation, its "before" checked against the row in the base.
    const node = [...state.nodes.keys()][123];
    let at: Placement = state.placements.get(placementKey(lobby, node))!;
    const move = cost(() => {
      const after = { ...at, x: at.x + 1 };
      const seq = store.commit({ id: uuidv7(), label: 'Déplacer', ops: [{ t: 'placement', before: at, after }] });
      at = after;
      return seq;
    });
    expect(move.ms).toBeLessThanOrEqual(5);
    expect(move.out).toBe(9);
    if (process.env.CIRRUS_COSTS) console.log(`readSnapshot ${read.ms.toFixed(1)} ms (${(read.out!.data.byteLength / 1e6).toFixed(1)} Mo), commit d’un déplacement ${move.ms.toFixed(3)} ms`);
    store.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 300_000);
