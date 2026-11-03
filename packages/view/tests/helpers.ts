import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type Action, applyOp, canonical, fromSnapshot, type Id, ROLES, type State, toSnapshot } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import type { Camera } from '../src/camera.ts';
import { DEFAULT_PARAMS, type RenderParams } from '../src/params.ts';
import { isLive, type Measure, PART_FAR, PART_GONE, partOf, type PlanScene } from '../src/scene.ts';

export const P = DEFAULT_PARAMS;
export const measure: Measure = (t) => Math.max(1, Math.ceil(t.length / 23));

export function fixture(): { s: State; ids: FixtureIds } {
  const dir = mkdtempSync(join(tmpdir(), 'cirrus-view-'));
  const store = LocalStore.open(dir, { pc: 'test' });
  const ids = buildFixture(store, dir);
  const s = store.loadState();
  store.close();
  rmSync(dir, { recursive: true, force: true });
  return { s, ids };
}

export const run = (st: State, a: Action): Action => { for (const op of a.ops) applyOp(st, op); return a; };
/** A copy of the state to change without touching the shared one (a state is changed in place since plan 3c, task 3). */
export const copyOf = (st: State): State => fromSnapshot(toSnapshot(st));
export const created = (a: Action, t: 'node' | 'plan' | 'connection'): Id =>
  (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;

/** mulberry32: a small seeded generator, so that a failure replays. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A number to 1e-9 (fifteen significant digits beyond a million): what the oracle compares. */
const near = (v: number): number => (!Number.isFinite(v) ? v : Math.abs(v) < 1e6 ? Math.round(v * 1e9) / 1e9 : Number(v.toPrecision(15)));
const rounded = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (_k, v: unknown) => (typeof v === 'number' ? near(v) : v)));

/**
 * What a scene shows, by identifiers, without its slots (plan 3c, task 5): each item with its parent and children
 * (in draw order), each part of a connection with its ends and stubs (in order), the roots in draw order, the bounds
 * and the hue ranks. Two scenes that show the same have the same description, to 1e-9.
 */
export function canonicalScene(sc: PlanScene): { plan: unknown; items: string[]; parts: string[]; roots: Id[]; bounds: unknown; hues: string[] } {
  const idOf = (i: number) => sc.items[i].id;
  const items: string[] = [];
  sc.items.forEach((it, i) => {
    if (!isLive(sc, i)) return;
    const { parent, children, ...rest } = it;
    items.push(canonical(rounded({ ...rest, parent: parent < 0 ? null : idOf(parent), children: children.map(idOf) })));
  });
  const parts: string[] = [];
  for (let i = 0; i < sc.partCount; i++) {
    if (sc.part[i] === PART_GONE) continue;
    const ends = [];
    for (let k = sc.endStart[i], end = k + sc.endCount[i]; k < end; k++) {
      const m = sc.ends.meta[k];
      ends.push({ item: idOf(sc.ends.item[k]), role: ROLES[m & 3], key: sc.items[sc.ends.item[k]].node, dashed: (m & 4) !== 0 });
    }
    const center = sc.center[i] >= 0 ? idOf(sc.center[i]) : null;
    parts.push(canonical(rounded({
      key: `${sc.ids[i]}|${sc.part[i] === PART_FAR ? 'far' : 'main'}|${center ?? ''}`, title: sc.titles[i], ends, stubs: sc.stubs.get(i) ?? [], center,
      layout: sc.layout[i] ?? null,
    })));
  }
  const hues: string[] = [];
  for (const [g, rank] of sc.hues) hues.push(`${idOf(g)}=${rank}`);
  return { plan: sc.plan, items: items.sort(), parts: parts.sort(), roots: sc.roots.map(idOf), bounds: rounded(sc.bounds), hues: hues.sort() };
}

/**
 * The slots' books (Review Focus 3): free slots are exactly the removed ones, and nothing points at one — parents,
 * children, roots, the item maps, the parts' ends and centres, the parts by connection, stubs and hues; every live
 * item and part is reachable from its maps. Returns the first problem found, or null.
 */
export function slotProblem(sc: PlanScene): string | null {
  const live = (i: number) => i >= 0 && i < sc.items.length && isLive(sc, i);
  const gone = sc.items.flatMap((_it, i) => (isLive(sc, i) ? [] : [i])).sort((a, b) => a - b);
  if (canonical([...sc.freeItems].sort((a, b) => a - b)) !== canonical(gone)) return `éléments libres ${canonical(sc.freeItems)} au lieu de ${canonical(gone)}`;
  const roots = new Set(sc.roots);
  if (roots.size !== sc.roots.length) return 'racine en double';
  for (let i = 0; i < sc.items.length; i++) {
    if (!live(i)) continue;
    const it = sc.items[i];
    if (it.parent >= 0 && (!live(it.parent) || !sc.items[it.parent].children.includes(i))) return `parent de ${it.id}`;
    if ((it.parent < 0) !== roots.has(i)) return `racine ${it.id}`;
    if (it.depth !== (it.parent < 0 ? 0 : sc.items[it.parent].depth + 1)) return `profondeur de ${it.id}`;
    for (const c of it.children) if (!live(c) || sc.items[c].parent !== i) return `enfant de ${it.id}`;
    if (it.kind === 'phantom' ? sc.itemOfPhantom.get(it.id) !== i : sc.byId.get(it.id) !== i) return `élément introuvable : ${it.id}`;
  }
  for (const r of sc.roots) if (!live(r)) return `racine libérée ${r}`;
  let mapped = 0;
  for (let r = 0; r < sc.itemOfNode.length; r++) {
    const i = sc.itemOfNode[r];
    if (i < 0) continue;
    mapped++;
    if (!live(i) || sc.items[i].kind === 'phantom') return `itemOfNode[${r}] = ${i}`;
  }
  if (mapped !== sc.items.filter((it, i) => live(i) && it.kind !== 'phantom').length) return 'itemOfNode incomplet';
  for (const [id, i] of sc.itemOfPhantom) if (!live(i) || sc.items[i].id !== id) return `itemOfPhantom ${id} = ${i}`;
  const goneParts: number[] = [];
  for (let i = 0; i < sc.partCount; i++) {
    if (sc.part[i] === PART_GONE) { goneParts.push(i); continue; }
    for (let k = sc.endStart[i], end = k + sc.endCount[i]; k < end; k++) if (!live(sc.ends.item[k])) return `extrémité libérée de la partie ${i}`;
    if (sc.center[i] >= 0 && !live(sc.center[i])) return `centre libéré de la partie ${i}`;
    if (!partOf(sc, sc.ids[i]).includes(i)) return `partie ${i} absente de partOf`;
  }
  if (canonical([...sc.freeParts].sort((a, b) => a - b)) !== canonical(goneParts)) return `parties libres ${canonical(sc.freeParts)} au lieu de ${canonical(goneParts)}`;
  for (let r = 0; r < sc.partHead.length; r++) {
    for (let i = sc.partHead[r], n = 0; i >= 0; i = sc.partNext[i], n++) {
      if (i >= sc.partCount || sc.part[i] === PART_GONE || sc.connRow[i] !== r || n > sc.partCount) return `partHead[${r}] mène à ${i}`;
    }
  }
  for (const k of sc.stubs.keys()) if (sc.part[k] === PART_GONE) return `amorces de la partie libérée ${k}`;
  for (const g of sc.hues.keys()) if (!live(g) || sc.items[g].kind !== 'group' || sc.items[g].parent >= 0) return `teinte de ${g}`;
  return null;
}

/** A camera on the scene's centre, on a 2560×1600 screen, at the zoom where step k's text is `px` on screen. */
export function camAtTextPx(scene: PlanScene, k: number, px: number, p: RenderParams = P): Camera {
  const b = scene.bounds!;
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom: px / (p.baseFontPx * p.textScale * p.factor ** k), widthPx: 2560, heightPx: 1600 };
}
