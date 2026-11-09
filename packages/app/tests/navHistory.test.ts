import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, type Id, placementKey, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { buildScene, type Camera, DEFAULT_PARAMS as P, fitItem, type PlanScene } from '@cirrus/view';
import { afterAll, beforeAll, beforeEach, expect, test } from 'vitest';
import { destination, elsewhere, historyKey, NavHistory, navKeyOf, type Place, sideButton } from '../src/renderer/navigation.ts';
import { type JumpHost, Jumps, showNodeIn } from '../src/renderer/ui/graph/jumps.ts';
import { type RevealHost, Revealer } from '../src/renderer/ui/graph/reveal.ts';

// Previous and next (plan 6a, D2): the stack of places, the keys and buttons that drive it, and the jumps that push to it
// (the search's, « voir dans un autre plan », the pop-up's plan buttons, the teleport), on the test base.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-nav-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});
let s: State;
beforeEach(() => { s = store.loadState(); });

const cam = (x: number, y = 0, zoom = 1): Camera => ({ x, y, zoom, widthPx: 1600, heightPx: 900 });
const at = (plan: Id, x: number, y = 0, zoom = 1): Place => ({ plan, camera: cam(x, y, zoom) });
const alive = () => true;

test('la pile : pousser, revenir, repartir — chaque pas rend l’endroit d’où l’on est parti, et garde celui où l’on était', () => {
  const h = new NavHistory(100);
  h.push(at('A', 1));
  h.push(at('B', 2));
  // At C: back to B (C waits ahead), back to A (B waits), nothing before A.
  expect(h.back(at('C', 3), alive)).toEqual(at('B', 2));
  expect(h.back(at('B', 2), alive)).toEqual(at('A', 1));
  expect(h.back(at('A', 1), alive)).toBeNull();
  // Forward: B, then C, then nothing.
  expect(h.forward(at('A', 1), alive)).toEqual(at('B', 2));
  expect(h.forward(at('B', 2), alive)).toEqual(at('C', 3));
  expect(h.forward(at('C', 3), alive)).toBeNull();
  // And back again: the place left is where the view was (moved since the jump, or not).
  expect(h.back(at('C', 30), alive)).toEqual(at('B', 2));
  expect(h.forward(at('B', 2), alive)).toEqual(at('C', 30));
});

test('la pile : un saut après un retour efface ce qui était en avant', () => {
  const h = new NavHistory(100);
  h.push(at('A', 1));
  h.push(at('B', 2));
  expect(h.back(at('C', 3), alive)).toEqual(at('B', 2));
  expect(h.back(at('B', 2), alive)).toEqual(at('A', 1));
  // From A, a new jump: B and C are no longer ahead.
  h.push(at('A', 1));
  expect(h.forward(at('D', 4), alive)).toBeNull();
  expect(h.back(at('D', 4), alive)).toEqual(at('A', 1));
});

test('la pile : au plus `max` endroits, les plus anciens oubliés', () => {
  const h = new NavHistory(3);
  for (let i = 1; i <= 5; i++) h.push(at('A', i));
  const seen: number[] = [];
  for (let here = at('A', 6), back = h.back(here, alive); back; here = back, back = h.back(here, alive)) seen.push(back.camera.x);
  expect(seen).toEqual([5, 4, 3]);
  // The bound lowered: the oldest go at the next push.
  h.max = 2;
  h.push(at('A', 7));
  h.push(at('A', 8));
  expect(h.back(at('A', 9), alive)?.camera.x).toBe(8);
  expect(h.back(at('A', 8), alive)?.camera.x).toBe(7);
  expect(h.back(at('A', 7), alive)).toBeNull();
});

test('la pile : un endroit dont le plan a disparu est sauté, en arrière comme en avant, et sans rien déplacer s’il n’en reste aucun', () => {
  const h = new NavHistory(100);
  h.push(at('A', 1));
  h.push(at('B', 2));
  h.push(at('B', 3));
  const without = (gone: Id) => (plan: Id) => plan !== gone;
  // B is gone: back from C skips both of its places and lands on A.
  expect(h.back(at('C', 4), without('B'))).toEqual(at('A', 1));
  // Forward: C, which waited ahead. B's places were dropped when skipped.
  expect(h.forward(at('A', 1), without('B'))).toEqual(at('C', 4));
  // Nothing alive behind: null, and nothing moved.
  const g = new NavHistory(100);
  g.push(at('X', 1));
  expect(g.back(at('Y', 2), without('X'))).toBeNull();
  expect(g.forward(at('Y', 2), alive)).toBeNull();
  // A place ahead whose plan is gone is skipped too.
  const k = new NavHistory(100);
  k.push(at('A', 1));
  k.push(at('B', 2));
  k.back(at('C', 3), alive);
  k.back(at('B', 2), alive);
  expect(k.forward(at('A', 1), without('B'))).toEqual(at('C', 3));
});

test('la pile : un endroit identique à celui où l’on est (même plan, même caméra) est sauté, et un saut ne le pousse pas deux fois', () => {
  const h = new NavHistory(100);
  h.push(at('A', 1));
  h.push(at('A', 1));
  h.push(at('B', 2));
  // At B, the same place as B's: skipped; A's twice is one.
  expect(h.back(at('B', 2), alive)).toEqual(at('A', 1));
  expect(h.back(at('A', 1), alive)).toBeNull();
});

test('les touches : Alt+← et Alt+→ vont en arrière et en avant, sans autre modificateur ; une flèche seule déplace la vue, Alt+flèche non', () => {
  const key = (k: string, m: Partial<{ altKey: boolean; ctrlKey: boolean; shiftKey: boolean; metaKey: boolean }> = {}) =>
    ({ key: k, altKey: false, ctrlKey: false, shiftKey: false, metaKey: false, ...m });
  expect(historyKey(key('ArrowLeft', { altKey: true }))).toBe('back');
  expect(historyKey(key('ArrowRight', { altKey: true }))).toBe('forward');
  expect(historyKey(key('ArrowLeft'))).toBeNull();
  expect(historyKey(key('ArrowUp', { altKey: true }))).toBeNull();
  expect(historyKey(key('ArrowLeft', { altKey: true, ctrlKey: true }))).toBeNull();
  expect(historyKey(key('ArrowLeft', { altKey: true, shiftKey: true }))).toBeNull();
  expect(historyKey(key('ArrowLeft', { altKey: true, metaKey: true }))).toBeNull();
  // The graph pans on the arrows alone: with Alt they no longer move the view; + − = still zoom.
  for (const k of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
    expect(navKeyOf(key(k)), k).toBe(k);
    expect(navKeyOf(key(k, { altKey: true })), k).toBeNull();
  }
  for (const k of ['+', '=', '-']) expect(navKeyOf(key(k)), k).toBe(k);
  expect(navKeyOf(key('a'))).toBeNull();
});

test('les boutons de la souris : les boutons latéraux (3 et 4) vont en arrière et en avant, et ne sont aucun des trois boutons du graphe', () => {
  expect(sideButton(3)).toBe('back');
  expect(sideButton(4)).toBe('forward');
  for (const b of [0, 1, 2]) expect(sideButton(b), String(b)).toBeNull();
  expect(sideButton(5)).toBeNull();
});

// The jumps, with a GraphView of stand-in: the scene shown, its cameras, the tab opened (which shows the scene of its plan
// and restores that plan's camera, as the scene effect does), the revealer and the stack wired as GraphView wires them.
const measure = (t: string) => Math.max(1, Math.ceil(t.length / 23));
function view(start: Id, max = 100) {
  const scenes = new Map<Id, PlanScene>();
  const sceneOf = (plan: Id) => { if (!scenes.has(plan)) scenes.set(plan, buildScene(s, plan, measure, P)); return scenes.get(plan)!; };
  const cameras = new Map<Id, Camera>();
  let shown = start, asked = start, busy = false;
  const flashed: Id[][] = [], opened: Id[] = [];
  cameras.set(start, cam(0));
  const cameraNow = () => cameras.get(shown)!;
  const moveCamera = (c: Camera) => { cameras.set(shown, c); };
  const rv: RevealHost = {
    state: () => s, scene: () => sceneOf(shown), plan: () => asked, camera: cameraNow, params: () => P,
    openPlan: (plan) => nav.openPlan(plan), moveCamera, flash: (x) => flashed.push(x),
  };
  const revealer = new Revealer(rv);
  const host: JumpHost = {
    state: () => s, place: () => ({ plan: shown, camera: cameraNow() }), max: () => max, busy: () => busy,
    remember: (plan, c) => cameras.set(plan, c), openPlan: (plan) => nav.openPlan(plan), moveCamera,
  };
  const nav = {
    // App's openPlan, then GraphView's scene effect: the plan's camera back (the size of the window kept), a jump waiting framed.
    openPlan(plan: Id) {
      opened.push(plan);
      asked = plan;
      shown = plan;
      cameras.set(plan, { ...(cameras.get(plan) ?? cam(0)), widthPx: 1600, heightPx: 900 });
      revealer.sceneShown();
    },
  };
  const jumps = new Jumps(host, revealer);
  return { jumps, cameras, opened, flashed, sceneOf, shown: () => shown, setBusy: (b: boolean) => { busy = b; } };
}

test('un saut pousse l’endroit d’où l’on part ; Alt+← y revient, avec son plan et sa caméra exacte, sans cercle ; Alt+→ repart', () => {
  const v = view(ids.plans.lobby);
  v.cameras.set(ids.plans.lobby, cam(123, -45, 0.5));
  const framed = fitItem(v.sceneOf(ids.plans.these), v.sceneOf(ids.plans.these).byId.get(ids.nodes.mdl)!, cam(0), P);
  expect(v.jumps.reveal({ plan: ids.plans.these, id: ids.nodes.mdl, kind: 'node' })).toBe(true);
  expect(v.shown()).toBe(ids.plans.these);
  expect(v.cameras.get(ids.plans.these)).toEqual(framed);
  expect(v.flashed).toEqual([[ids.nodes.mdl]]);
  // The view moved a little after the jump: that is where forward comes back to.
  v.cameras.set(ids.plans.these, { ...framed, x: framed.x + 7 });
  expect(v.jumps.back()).toBe(true);
  expect(v.shown()).toBe(ids.plans.lobby);
  expect(v.cameras.get(ids.plans.lobby)).toEqual(cam(123, -45, 0.5));
  expect(v.flashed.length).toBe(1);
  expect(v.jumps.forward()).toBe(true);
  expect(v.shown()).toBe(ids.plans.these);
  expect(v.cameras.get(ids.plans.these)).toEqual({ ...framed, x: framed.x + 7 });
  expect(v.flashed.length).toBe(1);
  // Nothing further ahead; and back twice more finds nothing behind the first place.
  expect(v.jumps.forward()).toBe(false);
  expect(v.jumps.back()).toBe(true);
  expect(v.jumps.back()).toBe(false);
});

test('un saut dans le même plan : retour à la caméra d’avant, la taille de la fenêtre étant celle d’aujourd’hui', () => {
  const v = view(ids.plans.lobby);
  v.cameras.set(ids.plans.lobby, cam(10, 20, 2));
  expect(v.jumps.reveal({ plan: ids.plans.lobby, id: ids.nodes.kolmogorov, kind: 'node' })).toBe(true);
  expect(v.shown()).toBe(ids.plans.lobby);
  expect(v.cameras.get(ids.plans.lobby)).not.toEqual(cam(10, 20, 2));
  // The window was resized meanwhile.
  v.cameras.set(ids.plans.lobby, { ...v.cameras.get(ids.plans.lobby)!, widthPx: 1000, heightPx: 700 });
  expect(v.jumps.back()).toBe(true);
  expect(v.cameras.get(ids.plans.lobby)).toEqual({ x: 10, y: 20, zoom: 2, widthPx: 1000, heightPx: 700 });
  expect(v.opened).toEqual([]);
});

test('un saut manqué (objet jeté, retiré de son plan) ne pousse rien : « précédent » ne revient pas à un endroit où l’on n’a pas bougé', () => {
  const v = view(ids.plans.lobby);
  expect(v.jumps.reveal({ plan: ids.plans.lobby, id: ids.nodes.trashed, kind: 'node' })).toBe(false);
  expect(v.jumps.reveal({ plan: ids.plans.these, id: ids.nodes.monde, kind: 'node' })).toBe(false);
  expect(v.jumps.back()).toBe(false);
  expect(v.opened).toEqual([]);
});

test('un saut après un retour efface ce qui était en avant', () => {
  const v = view(ids.plans.lobby);
  v.jumps.reveal({ plan: ids.plans.these, id: ids.nodes.mdl, kind: 'node' });
  v.jumps.back();
  v.jumps.reveal({ plan: ids.plans.article, id: ids.nodes.mdl, kind: 'node' });
  expect(v.shown()).toBe(ids.plans.article);
  expect(v.jumps.forward()).toBe(false);
  expect(v.jumps.back()).toBe(true);
  expect(v.shown()).toBe(ids.plans.lobby);
});

test('un plan supprimé entre-temps : « précédent » ne mène pas à lui, il saute à l’endroit d’avant (Review Focus 3)', () => {
  const v = view(ids.plans.lobby);
  v.cameras.set(ids.plans.lobby, cam(5));
  v.jumps.reveal({ plan: ids.plans.these, id: ids.nodes.mdl, kind: 'node' });
  v.jumps.reveal({ plan: ids.plans.article, id: ids.nodes.mdl, kind: 'node' });
  // The thesis' plan deleted (its placements gone first): the stack holds a place in it.
  for (const n of [ids.nodes.mdl, ids.nodes.compression, ids.nodes.kolmogorov, ids.nodes.generalisation, ids.nodes.theseOnly]) {
    const p = s.placements.get(placementKey(ids.plans.these, n));
    if (p) applyOps(s, [{ t: 'placement', before: p, after: null }]);
  }
  const rec = s.plans.get(ids.plans.these)!;
  applyOps(s, [{ t: 'plan', before: rec, after: null }]);
  expect(v.jumps.back()).toBe(true);
  expect(v.shown()).toBe(ids.plans.lobby);
  expect(v.cameras.get(ids.plans.lobby)).toEqual(cam(5));
  // Forward: the article's, where we were.
  expect(v.jumps.forward()).toBe(true);
  expect(v.shown()).toBe(ids.plans.article);
});

test('précédent et suivant attendent un geste, une question ou un dépôt en cours', () => {
  const v = view(ids.plans.lobby);
  v.jumps.reveal({ plan: ids.plans.these, id: ids.nodes.mdl, kind: 'node' });
  v.setBusy(true);
  expect(v.jumps.back()).toBe(false);
  expect(v.shown()).toBe(ids.plans.these);
  v.setBusy(false);
  expect(v.jumps.back()).toBe(true);
});

test('navHistoryMax borne la pile de la session : les plus anciens endroits sont oubliés', () => {
  const v = view(ids.plans.lobby, 2);
  for (const plan of [ids.plans.these, ids.plans.article, ids.plans.these, ids.plans.article]) v.jumps.reveal({ plan, id: ids.nodes.mdl, kind: 'node' });
  expect(v.jumps.back()).toBe(true);
  expect(v.jumps.back()).toBe(true);
  expect(v.jumps.back()).toBe(false);
});

test('S’y téléporter : la vue se centre sur l’original et l’endroit quitté est poussé ; Alt+← le rend', () => {
  const v = view(ids.plans.lobby);
  v.cameras.set(ids.plans.lobby, cam(10, 20, 2));
  v.jumps.moveTo({ ...cam(10, 20, 2), x: 400, y: -300 });
  expect(v.cameras.get(ids.plans.lobby)).toEqual({ ...cam(10, 20, 2), x: 400, y: -300 });
  expect(v.jumps.back()).toBe(true);
  expect(v.cameras.get(ids.plans.lobby)).toEqual(cam(10, 20, 2));
  // Teleporting where the view already is leaves nothing to come back to.
  v.jumps.moveTo(cam(10, 20, 2));
  expect(v.jumps.back()).toBe(false);
});

test('les boutons de plan du pop-up d’un nœud cadrent le nœud dans ce plan (D2), et comptent comme un saut', () => {
  const v = view(ids.plans.lobby);
  v.cameras.set(ids.plans.lobby, cam(77));
  const said: Id[] = [];
  const scene = v.sceneOf(ids.plans.these);
  showNodeIn(v.jumps, (plan) => said.push(plan), ids.plans.these, ids.nodes.compression);
  expect(said).toEqual([]);
  expect(v.shown()).toBe(ids.plans.these);
  expect(v.cameras.get(ids.plans.these)).toEqual(fitItem(scene, scene.byId.get(ids.nodes.compression)!, cam(0), P));
  expect(v.flashed).toEqual([[ids.nodes.compression]]);
  expect(v.jumps.back()).toBe(true);
  expect(v.cameras.get(ids.plans.lobby)).toEqual(cam(77));
  // A node no longer in that plan: the plan opens, as the button did before (no frame, no push).
  showNodeIn(v.jumps, (plan) => said.push(plan), ids.plans.these, ids.nodes.monde);
  expect(said).toEqual([ids.plans.these]);
});

test('les autres plans d’un objet : le lobby d’abord, puis les onglets dans leur ordre, puis les plans fermés par leur nom — le plan montré n’y est pas', () => {
  const lobby = ids.plans.lobby;
  // MDL is in the lobby, the thesis' plan and the article's.
  const all = elsewhere(s, 'node', ids.nodes.mdl, ids.plans.these, []);
  expect(all[0]).toBe(lobby);
  expect(new Set(all)).toEqual(new Set([lobby, ids.plans.article]));
  expect(elsewhere(s, 'node', ids.nodes.mdl, lobby, [ids.plans.article, ids.plans.these])).toEqual([ids.plans.article, ids.plans.these].filter((p) => p !== lobby && s.placements.has(`${p}|${ids.nodes.mdl}`)));
  // A node of the lobby alone: nowhere else.
  expect(elsewhere(s, 'node', ids.nodes.monde, lobby, [])).toEqual([]);
  expect(elsewhere(s, 'node', ids.nodes.monde, ids.plans.these, [])).toEqual([lobby]);
  // A connection: where it has branches or phantoms. The twoToOne is in the thesis' plan.
  expect(elsewhere(s, 'connection', ids.connections.twoToOne, lobby, [])).toEqual([ids.plans.these]);
  // The trash, and what is not there at all.
  expect(elsewhere(s, 'node', ids.nodes.trashed, ids.plans.these, [])).toEqual([]);
  expect(elsewhere(s, 'node', 'absent', ids.plans.these, [])).toEqual([]);
});

test('la destination d’un nœud (« Aller au nœud ») : ce plan s’il y est, sinon le lobby, sinon le premier autre plan ; aucun plan, rien', () => {
  const lobby = ids.plans.lobby;
  expect(destination(s, 'node', ids.nodes.mdl, ids.plans.these, [])).toBe(ids.plans.these);
  expect(destination(s, 'node', ids.nodes.monde, ids.plans.these, [])).toBe(lobby);
  expect(destination(s, 'node', ids.nodes.theseOnly, lobby, [])).toBe(ids.plans.these);
  expect(destination(s, 'node', ids.nodes.annotationPage2, lobby, [])).toBeNull();
  expect(destination(s, 'node', ids.nodes.trashed, lobby, [])).toBeNull();
});
