import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOp, type Id, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import type { Camera } from '../src/camera.ts';
import { DEFAULT_PARAMS, type RenderParams } from '../src/params.ts';
import type { Measure, PlanScene } from '../src/scene.ts';

export const P = DEFAULT_PARAMS;
export const measure: Measure = (t) => Math.max(1, Math.ceil(t.length / 23));

export function fixture(): { s: State; ids: FixtureIds } {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-view-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  const ids = buildFixture(store, dir);
  return { s: store.state, ids };
}

export const run = (st: State, a: Action): Action => { for (const op of a.ops) applyOp(st, op); return a; };
export const created = (a: Action, t: 'node' | 'plan' | 'connection'): Id =>
  (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

/** A camera on the scene's centre, on a 2560×1600 screen, at the zoom where step k's text is `px` on screen. */
export function camAtTextPx(scene: PlanScene, k: number, px: number, p: RenderParams = P): Camera {
  const b = scene.bounds!;
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom: px / (p.baseFontPx * p.textScale * p.factor ** k), widthPx: 2560, heightPx: 1600 };
}
