import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, addMember, applyOp, canonical, combine, CommandError, connect, createNode, createPlan, deleteConnection, deleteEverywhere, editConnection, editNode,
  exclude, fromSnapshot, type Id, include, joinArm, layoutKey, moveNodes, movePhantom, placeAbsent, placeNode, removeFromPlan, removeMember, restoreNode, type Role,
  ROLES, setBranches, setLayout, setRole, splitArm, type State, toSnapshot,
} from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import type { Camera } from '../src/camera.ts';
import { copyClip, pasteSteps } from '../src/clip.ts';
import { offsetPolygon } from '../src/geometry/hull.ts';
import { buildHitIndex } from '../src/hit.ts';
import { buildInstances } from '../src/instances.ts';
import { foldT } from '../src/lod.ts';
import { DEFAULT_PARAMS, type RenderParams } from '../src/params.ts';
import { buildScene, isLive, type Measure, PART_FAR, PART_GONE, partOf, type PlanScene } from '../src/scene.ts';
import { buildIndex, computeVisible, NO_PART, type PartLists, type SceneIndex, type VisibleSet } from '../src/visibility.ts';

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
    if (sc.part[i] === PART_GONE) {
      // A removed part keeps no reference: no ends, no centre, no next part, no layout.
      if (sc.endCount[i] !== 0 || sc.center[i] !== -1 || sc.partNext[i] !== -1 || sc.layout[i] !== undefined) return `partie retirée ${i} qui référence encore`;
      goneParts.push(i);
      continue;
    }
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

/**
 * What `byId`, `partOf` and the recycling read besides what canonicalScene describes, copied: a scene that must not
 * change (a previous one) compares equal to it afterwards.
 */
export function sceneBooks(sc: PlanScene): unknown {
  return {
    itemOfNode: Array.from(sc.itemOfNode), itemOfPhantom: [...sc.itemOfPhantom].sort(), partHead: Array.from(sc.partHead),
    partNext: Array.from(sc.partNext.subarray(0, sc.partCount)), freeItems: [...sc.freeItems], freeParts: [...sc.freeParts], partCount: sc.partCount,
    items: sc.items.length,
  };
}

/** A camera on the scene's centre, on a 2560×1600 screen, at the zoom where step k's text is `px` on screen. */
export function camAtTextPx(scene: PlanScene, k: number, px: number, p: RenderParams = P): Camera {
  const b = scene.bounds!;
  return { x: (b.minX + b.maxX) / 2, y: (b.minY + b.maxY) / 2, zoom: px / (p.baseFontPx * p.textScale * p.factor ** k), widthPx: 2560, heightPx: 1600 };
}

/** A frame at camAtTextPx: what is visible, its instances from the camera's centre, and their hit index. */
export const frameAt = (scene: PlanScene, k: number, px: number) => {
  const cam = camAtTextPx(scene, k, px);
  const visible = computeVisible(scene, buildIndex(scene, P), cam, P);
  const origin = { x: cam.x, y: cam.y };
  const inst = buildInstances(scene, visible, cam, origin, P);
  return { cam, visible, origin, inst, hits: buildHitIndex(scene, visible, inst, P) };
};

/**
 * Cameras drawn at random over a scene (an empty one: around the origin), on a 2560×1600 screen: centres in its
 * bounds widened by half, zooms log-uniform in [zMin, zMax].
 */
export function randomCameras(scene: PlanScene, count: number, r: () => number, zMin: number, zMax: number): Camera[] {
  const b = scene.bounds ?? { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const w = b.maxX - b.minX, h = b.maxY - b.minY;
  return Array.from({ length: count }, () => ({
    x: b.minX - w / 4 + r() * 1.5 * w, y: b.minY - h / 4 + r() * 1.5 * h, zoom: zMin * (zMax / zMin) ** r(), widthPx: 2560, heightPx: 1600,
  }));
}

// ———— Random actions

/** A pick that makes no sense here (an empty plan, a connection without members): no action of that kind this time. */
class Skip extends Error {}
const need = <T>(v: T | undefined): T => {
  if (v === undefined) throw new Skip();
  return v;
};

/** The kinds the brief of plan 3c task 5 lists, that its 300 actions must each make at least once. */
export const KINDS = [
  'déplacement', 'renommage', 'création', 'connexion', 'inclusion', 'exclusion', 'retrait d’un plan', 'suppression partout', 'scission de bras',
  'réunion de bras', 'amorce placée', 'disposition', 'collage',
];

/**
 * The core's commands and pasteSteps, on nodes, connections and phantoms picked at random among those of the test base
 * (and those the actions make), in every plan: what the interface can do. A refusal of the core (CommandError) is a
 * menu choice refused; any other error fails the test.
 */
export function randomActions(s: State, r: () => number): () => { kind: string; action: Action } | null {
  const pick = <T>(xs: readonly T[]): T => need(xs.length === 0 ? undefined : xs[Math.floor(r() * xs.length)]);
  const plans = () => [...s.plans.keys()];
  const nodes = () => [...s.nodes.keys()];
  const placed = (plan: Id) => [...s.placements.values()].filter((pl) => pl.plan === plan).map((pl) => pl.node);
  const conns = () => [...s.connections.keys()];
  const membersOf = (c: Id) => need(s.connections.get(c)).members;
  const phantoms = () => [...s.phantoms.values()];
  const roles: Role[] = ['source', 'target', 'associate'];
  const titles = ['Court', 'Un titre un peu plus long que la boîte', 'Encore un titre vraiment très long qui prend trois lignes au moins, sinon plus'];
  const at = () => ({ x: Math.round(r() * 2000 - 1000), y: Math.round(r() * 1400 - 700) });
  const commands: [string, () => Action][] = [
    ['déplacement', () => { const plan = pick(plans()); return moveNodes(s, plan, [{ node: pick(placed(plan)), ...at() }]); }],
    ['cran', () => { const plan = pick(plans()), node = pick(placed(plan)); return moveNodes(s, plan, [{ node, k: Math.floor(r() * 5) - 1 }]); }],
    ['renommage', () => editNode(s, pick(nodes()), { title: pick(titles) })],
    ['création', () => createNode(s, { plan: pick(plans()), title: pick(titles), ...at(), k: Math.floor(r() * 3) })],
    ['connexion', () => {
      const plan = pick(plans()), ns = placed(plan);
      return connect(s, { plan, members: [...new Set([pick(ns), pick(ns), pick(ns)])].map((node) => ({ node, role: pick(roles) })) });
    }],
    ['membre ajouté', () => addMember(s, pick(plans()), pick(conns()), { node: pick(nodes()), role: pick(roles) })],
    ['membre retiré', () => removeMember(s, pick(conns()), pick(nodes()))],
    ['titre de connexion', () => editConnection(s, pick(conns()), { title: pick(['', 'relie', 'un titre de connexion']) })],
    ['rôle', () => { const c = pick(conns()); return setRole(s, c, pick(membersOf(c)).node, pick(roles)); }],
    ['inclusion', () => { const plan = pick(plans()), ns = placed(plan); return include(s, plan, pick(ns), pick(ns)); }],
    ['exclusion', () => { const plan = pick(plans()); return exclude(s, plan, pick(placed(plan))); }],
    ['retrait d’un plan', () => { const plan = pick(plans()); return removeFromPlan(s, plan, pick(placed(plan))); }],
    ['placement', () => placeNode(s, pick(plans()), pick(nodes()), at().x, at().y, 0)],
    ['suppression partout', () => deleteEverywhere(s, pick(nodes()))],
    ['restauration', () => restoreNode(s, pick(nodes()), pick(plans()), at().x, at().y, 0)],
    ['branches', () => { const c = pick(conns()); return setBranches(s, c, [{ plan: pick(plans()), node: pick(membersOf(c)).node }], r() < 0.5); }],
    ['scission de bras', () => {
      const b = pick([...s.branches]);
      return splitArm(s, b.plan, b.connection, b.node, { ...at(), k: 0 }, { ...at(), k: Math.floor(r() * 2) });
    }],
    ['réunion de bras', () => { const ph = pick(phantoms().filter((x) => x.of.kind !== 'absent')); return joinArm(s, ph.plan, ph.connection, ph.of.node); }],
    ['amorce placée', () => {
      const b = pick([...s.branches].filter((x) => !s.placements.has(`${x.plan}|${x.node}`)));
      return placeAbsent(s, b.plan, b.connection, b.node, at().x, at().y, 0);
    }],
    ['fantôme déplacé', () => {
      const ph = pick(phantoms()), groups = placed(ph.plan);
      return movePhantom(s, ph.id, at().x, at().y, r() < 0.3 && groups.length > 0 ? pick(groups) : r() < 0.5 ? null : undefined, r() < 0.3 ? ph.k + 1 : undefined);
    }],
    ['disposition', () => {
      const plan = pick(plans()), c = pick(conns());
      const handles = Object.fromEntries(membersOf(c).slice(0, 2).map((m) => [m.node, { b1: at(), b2: at() }]));
      const reset = r() < 0.3 && s.connLayouts.has(layoutKey(plan, c));
      return setLayout(s, plan, c, reset ? null : { handles, ...(r() < 0.5 ? { marker: at() } : {}), ...(r() < 0.5 ? { angle: r() * 3 } : {}) });
    }],
    ['connexion supprimée', () => deleteConnection(s, pick(conns()))],
    ['collage', () => {
      // Copied from one plan, pasted into another (spec 7): a group with its content, the connections that follow.
      const from = pick(plans()), to = pick(plans()), sc = buildScene(s, from, measure, P);
      if (sc.items.length === 0) throw new Skip();
      const items = Array.from({ length: 1 + Math.floor(r() * 3) }, () => Math.floor(r() * sc.items.length)).filter((i) => isLive(sc, i));
      const clip = need(copyClip(s, sc, items, 1) ?? undefined);
      return combine(s, 'Coller', pasteSteps(s, clip, to, at(), 1, null, P).steps);
    }],
    ['répercussion', () => {
      // « Partout » (spec 10): one node changes group in two plans at once.
      const [p1, p2] = [pick(plans()), pick(plans())], node = pick(placed(p1)), group = pick(placed(p1));
      return combine(s, 'Répercuter', [(x) => include(x, p1, node, group), (x) => include(x, p2, node, group)]);
    }],
    ['plan créé', () => createPlan(s, 'Nouveau', pick(['plan', 'document'] as const))],
  ];
  return () => {
    const [kind, command] = pick(commands);
    try {
      return { kind, action: command() };
    } catch (e) {
      if (e instanceof CommandError || e instanceof Skip) return null;
      throw e;
    }
  };
}

// ———— Visibility (plan 3c, task 6)

const ROOT = -1;
/** What bruteVisible reads of a scene whatever the camera: each item's box, each part's common group. */
const sceneFacts = new WeakMap<PlanScene, { box: Float64Array; lca: Int32Array }>();

function factsOf(sc: PlanScene): { box: Float64Array; lca: Int32Array } {
  let f = sceneFacts.get(sc);
  if (f) return f;
  const n = sc.items.length, box = new Float64Array(4 * n), lca = new Int32Array(sc.partCount).fill(NO_PART);
  sc.items.forEach((it, i) => {
    let b = [Infinity, Infinity, -Infinity, -Infinity];
    if (!isLive(sc, i)) b = [Infinity, Infinity, -Infinity, -Infinity];
    else if (it.kind === 'group') {
      const poly = offsetPolygon(it.hull!, it.pad!);
      b = [Math.min(...poly.map((q) => q.x)), Math.min(...poly.map((q) => q.y)), Math.max(...poly.map((q) => q.x)), Math.max(...poly.map((q) => q.y))];
    } else b = [it.x - it.halfW, it.y - it.halfH, it.x + it.halfW, it.y + it.halfH];
    box.set(b, 4 * i);
  });
  // The common group: the first strict ancestor of the first end that is a strict ancestor of every other item.
  const above = (i: number) => { const out: number[] = []; for (let a = sc.items[i].parent; a >= 0; a = sc.items[a].parent) out.push(a); return out; };
  for (let c = 0; c < sc.partCount; c++) {
    if (sc.part[c] === PART_GONE) continue;
    const touched: number[] = [];
    for (let k = sc.endStart[c]; k < sc.endStart[c] + sc.endCount[c]; k++) touched.push(sc.ends.item[k]);
    if (sc.center[c] >= 0) touched.push(sc.center[c]);
    const chains = touched.map((i) => new Set(above(i)));
    lca[c] = above(touched[0]).find((a) => chains.every((ch) => ch.has(a))) ?? ROOT;
  }
  f = { box, lca };
  sceneFacts.set(sc, f);
  return f;
}

/**
 * The visible set by its rule (plan 3c, task 6), from the scene alone — every item and every part looked at, no index.
 * An item is drawn when its box (a group's: its padded envelope) meets the view widened by viewMarginPx and every group
 * above it is drawn and not closed. A part is seen when its common group (the lowest group above all its ends and its
 * centre) is the top level or a drawn group not closed, and an end lifted under that group — to its highest closed
 * ancestor, or to its highest closed or fading ancestor below that group — or its centre is in the view; a centre
 * folded away leaves it out, and so do fewer than two distinct drawn ends (its stubs and centre counted). Items in
 * pre-order of the scene's tree; parts by their common group's rank among the open groups drawn (the top level first),
 * then by slot.
 */
export function bruteVisible(sc: PlanScene, cam: Camera, p: RenderParams = P): { items: number[]; groups: number[]; parts: number[] } {
  const { box, lca } = factsOf(sc), n = sc.items.length;
  const halfW = (cam.widthPx / 2 + p.viewMarginPx) / cam.zoom, halfH = (cam.heightPx / 2 + p.viewMarginPx) / cam.zoom;
  const inView = (i: number) => box[4 * i + 2] >= cam.x - halfW && box[4 * i] <= cam.x + halfW && box[4 * i + 3] >= cam.y - halfH && box[4 * i + 1] <= cam.y + halfH;
  const group = (i: number) => sc.items[i].kind === 'group';
  /** 1 open, 2 fading, 3 closed (0: not computed yet). */
  const states = new Int8Array(n);
  const state = (g: number) => {
    if (states[g] === 0) { const t = foldT(sc.items[g].maxChildK!, cam.zoom, p); states[g] = t >= 1 ? 3 : t > 0 ? 2 : 1; }
    return states[g];
  };
  const items: number[] = [], groups: number[] = [], rank = new Int32Array(n).fill(-1);
  let open = 0;
  const visit = (i: number, shown: boolean) => {
    const drawn = shown && inView(i);
    if (drawn) {
      (group(i) ? groups : items).push(i);
      if (group(i) && state(i) !== 3) rank[i] = ++open;
    }
    for (const c of sc.items[i].children) visit(c, drawn && rank[i] >= 0);
  };
  for (const r of sc.roots) visit(r, true);
  const highest = (m: number, below: number, closedOnly: boolean) => {
    let x = m;
    for (let a = sc.items[m].parent; a >= 0 && a !== below; a = sc.items[a].parent) if (closedOnly ? state(a) === 3 : state(a) >= 2) x = a;
    return x;
  };
  const keyed: [number, number][] = [];
  for (let c = 0; c < sc.partCount; c++) {
    if (sc.part[c] === PART_GONE) continue;
    const L = lca[c];
    if (L !== ROOT && rank[L] < 0) continue;
    let seen = false;
    const drawnEnds = new Set<number>();
    for (let k = sc.endStart[c]; k < sc.endStart[c] + sc.endCount[c]; k++) {
      const m = sc.ends.item[k], o = highest(m, ROOT, true);
      drawnEnds.add(o);
      if (inView(o) || inView(highest(m, L, false))) seen = true;
    }
    const center = sc.center[c];
    if (center >= 0) {
      if (highest(center, ROOT, true) !== center) continue;
      if (inView(center)) seen = true;
    }
    const extra = (sc.stubs.get(c)?.length ?? 0) + (center >= 0 ? 1 : 0);
    if (seen && drawnEnds.size + extra >= 2) keyed.push([L === ROOT ? 0 : rank[L], c]);
  }
  keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { items, groups, parts: keyed.map(([, c]) => c) };
}

/**
 * A visible set against bruteVisible: the same items and groups in the same order, the same parts, in the same order
 * (each line's parts follow it, each line comes at its first part). Returns the first difference, or null.
 */
export function visibleDifference(v: VisibleSet, b: ReturnType<typeof bruteVisible>): string | null {
  if (canonical(v.items) !== canonical(b.items)) return `éléments ${canonical(v.items)} au lieu de ${canonical(b.items)}`;
  if (canonical(v.groups) !== canonical(b.groups)) return `groupes ${canonical(v.groups)} au lieu de ${canonical(b.groups)}`;
  const got = v.connections.flatMap((vc) => vc.conns), num = (x: number, y: number) => x - y;
  if (canonical([...got].sort(num)) !== canonical([...b.parts].sort(num))) return `parties ${canonical([...got].sort(num))} au lieu de ${canonical([...b.parts].sort(num))}`;
  const at = new Map(b.parts.map((c, k) => [c, k]));
  let last = -1;
  for (const vc of v.connections) {
    if (at.get(vc.conns[0])! < last) return `ligne de la partie ${vc.conns[0]} hors de l’ordre`;
    last = at.get(vc.conns[0])!;
    for (let k = 1; k < vc.conns.length; k++) if (at.get(vc.conns[k])! < at.get(vc.conns[k - 1])!) return `parties de la ligne ${vc.conns[0]} hors de l’ordre`;
  }
  return null;
}

/**
 * What an index says of a scene, for comparing an index kept up to date with one built anew: per item slot, per part
 * slot, the lists by top and by item (as sets), the fold levels, the roots' ranks. Its tree and its dirty roots, which
 * depend on its history, are left out (indexProblem checks them).
 */
export function indexContent(ix: SceneIndex, sc: PlanScene): unknown {
  const n = sc.items.length, m = sc.partCount;
  const lists = (pool: PartLists) => [...pool.keys()].map((k) => [k, [...pool.of(k)].sort((a, b) => a - b)] as const);
  const slice = (a: Int32Array | Float64Array, len: number) => Array.from(a.subarray(0, len));
  return {
    itemCount: ix.itemCount, partCount: ix.partCount, parent: slice(ix.parent, n), depth: slice(ix.depth, n), minX: slice(ix.minX, n), minY: slice(ix.minY, n),
    maxX: slice(ix.maxX, n), maxY: slice(ix.maxY, n), maxChildK: slice(ix.maxChildK, n), node: ix.node.slice(0, n), rootRank: slice(ix.rootRank, n), lca: slice(ix.lca, m),
    byTop: lists(ix.byTop), incident: lists(ix.incident), levels: ix.levels,
  };
}

/**
 * The index's books (Review Focus 3): no list names a free item or part slot, a free part has no common group, each
 * live part is filed under each of its items and under tops right under its common group; the tree's entries are live
 * roots, or marked stale, and every live root is in the tree or among the dirty roots. Returns the first problem found,
 * or null.
 */
export function indexProblem(ix: SceneIndex, sc: PlanScene): string | null {
  const liveItem = (i: number) => i >= 0 && i < sc.items.length && isLive(sc, i);
  const livePart = (c: number) => c >= 0 && c < sc.partCount && sc.part[c] !== PART_GONE;
  const topped = new Set<number>();
  for (const [name, pool] of [['byTop', ix.byTop], ['incident', ix.incident]] as const) {
    for (const k of pool.keys()) {
      const list = [...pool.of(k)];
      if (!liveItem(k)) return `${name} : emplacement libre ${k}`;
      for (const c of list) if (!livePart(c)) return `${name} : partie libre ${c} sous ${k}`;
      if (new Set(list).size !== list.length) return `${name} : partie en double sous ${k}`;
      if (name !== 'byTop') continue;
      for (const c of list) {
        if (sc.items[k].parent !== ix.lca[c]) return `byTop : ${k} n’est pas juste sous le groupe commun de la partie ${c}`;
        topped.add(c);
      }
    }
  }
  for (let c = 0; c < sc.partCount; c++) {
    if (!livePart(c)) { if (ix.lca[c] !== NO_PART) return `partie libre ${c} avec un groupe commun`; continue; }
    for (let k = sc.endStart[c]; k < sc.endStart[c] + sc.endCount[c]; k++) if (!ix.incident.of(sc.ends.item[k]).includes(c)) return `partie ${c} absente de son extrémité`;
    if (sc.center[c] >= 0 && !ix.incident.of(sc.center[c]).includes(c)) return `partie ${c} absente de son centre`;
    if (!topped.has(c)) return `partie ${c} sans sommet`;
  }
  const inTree = new Set<number>();
  ix.treeRoots.forEach((r) => {
    if (ix.stale[r]) return;
    inTree.add(r);
  });
  for (const r of inTree) if (!liveItem(r) || sc.items[r].parent >= 0) return `arbre : ${r} n’est plus une racine sans être marquée`;
  for (const r of sc.roots) if (!inTree.has(r) && !ix.dirtyRoots.includes(r)) return `racine ${r} ni dans l’arbre ni parmi les racines changées`;
  for (const r of ix.dirtyRoots) if (!ix.stale[r]) return `racine changée ${r} non marquée`;
  return null;
}
