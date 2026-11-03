import { combine, groupOf, placementKey, removeFromPlan, type State } from '@cirrus/core';
import type { FixtureIds } from '@cirrus/fixtures';
import { beforeEach, expect, test } from 'vitest';
import { copyClip, deleteSummary, pasteSteps } from '../src/clip.ts';
import { buildScene } from '../src/scene.ts';
import { fixture, measure, P, run } from './helpers.ts';

let s: State, ids: FixtureIds;
beforeEach(() => { ({ s, ids } = fixture()); });

const paste = (clip: NonNullable<ReturnType<typeof copyClip>>, plan: string, at: { x: number; y: number }, zoom: number, group: string | null = null) => {
  const target = buildScene(s, plan, measure, P);
  const drawn = (id: string) => { const i = target.byId.get(id); return i === undefined ? undefined : { x: target.items[i].x, y: target.items[i].y }; };
  const r = pasteSteps(s, clip, plan, at, zoom, group, P, drawn);
  run(s, combine(s, 'Coller', r.steps));
  return r;
};

test('copier un groupe et un nœud : le contenu du groupe suit, avec le plan et le zoom d’origine', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const clip = copyClip(s, sc, [sc.byId.get(ids.nodes.groupeInduction)!, sc.byId.get(ids.nodes.mdl)!], 0.5)!;
  expect(clip.plan).toBe(ids.plans.lobby);
  expect(clip.zoom).toBe(0.5);
  const copied = clip.nodes.map((n) => n.id);
  for (const id of [ids.nodes.groupeInduction, ids.nodes.mdl, ids.nodes.solomonoff]) expect(copied).toContain(id);
  expect(copied).toHaveLength(4); // the group, its two members (Solomonoff, Priore), MDL
  // Connections with two nodes copied: MDL–Solomonoff, Priore → Solomonoff, « Déduction jointe »; not Solomonoff → Universalité.
  const conns = new Set(clip.connections.map((c) => c.id));
  expect(conns.has(ids.connections.mdlSolomonoff)).toBe(true);
  expect(clip.connections.find((c) => c.id === ids.connections.mdlSolomonoff)!.nodes.sort()).toEqual([ids.nodes.mdl, ids.nodes.solomonoff].sort());
  expect(copyClip(s, sc, [], 1)).toBeNull();
});

test('coller dans un plan qui contient déjà un nœud : il garde sa place et son groupe, les autres arrivent dilatés de f^Δk (Review Focus 4)', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const clip = copyClip(s, lobby, [lobby.byId.get(ids.nodes.groupeInduction)!, lobby.byId.get(ids.nodes.mdl)!], 0.5)!;
  const these = ids.plans.these;
  const mdlBefore = { ...s.placements.get(placementKey(these, ids.nodes.mdl))! };
  const at = { x: 2000, y: 1000 };
  const r = paste(clip, these, at, 0.25); // Δk = round(log2(0.5 / 0.25)) = 1
  expect(r.present).toEqual([ids.nodes.mdl]);
  expect(s.placements.get(placementKey(these, ids.nodes.mdl))).toEqual(mdlBefore);
  expect(groupOf(s, these, ids.nodes.mdl)).toBe(ids.nodes.theseOnly);
  // Relative positions kept, scaled by f; steps raised by one.
  const from = (id: string) => lobby.items[lobby.byId.get(id)!]; // where it was drawn when copied
  const to = (id: string) => s.placements.get(placementKey(these, id))!;
  const [a, b] = [ids.nodes.solomonoff, ids.nodes.groupeInduction];
  expect(to(a).x - to(b).x).toBeCloseTo((from(a).x - from(b).x) * P.factor, 9);
  expect(to(a).k).toBe(from(a).k + 1);
  // The pasted nodes keep their group where it came along; the group itself has no ancestor here: free.
  expect(groupOf(s, these, ids.nodes.solomonoff)).toBe(ids.nodes.groupeInduction);
  expect(groupOf(s, these, ids.nodes.groupeInduction)).toBeUndefined();
  // A connection follows when two of its nodes were copied; its other branches become stubs (Occam is not here).
  const shown = (c: string, n: string) => s.branches.has({ plan: these, connection: c, node: n });
  expect(shown(ids.connections.mdlSolomonoff, ids.nodes.solomonoff)).toBe(true);
  const deduction = clip.connections.find((c) => c.nodes.includes(ids.nodes.occam))!;
  expect(shown(deduction.id, ids.nodes.occam)).toBe(true);
  expect(s.placements.has(placementKey(these, ids.nodes.occam))).toBe(false);
});

test('coller dans une enveloppe : ce qui n’a pas d’ancêtre présent entre dans le groupe sous le point (spec 7, 10)', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const clip = copyClip(s, lobby, [lobby.byId.get(ids.nodes.solomonoff)!], 1)!;
  paste(clip, ids.plans.these, { x: 0, y: 0 }, 1, ids.nodes.theseOnly);
  expect(groupOf(s, ids.plans.these, ids.nodes.solomonoff)).toBe(ids.nodes.theseOnly);
});

test('décompte avant suppression : instances, et les nœuds dont c’est le dernier plan', () => {
  const sum = deleteSummary(s, [ids.nodes.mdl, ids.nodes.monde]);
  expect(sum.instances).toBe(3 + 1); // MDL: lobby, Thèse, Article; Monde: lobby
  expect(sum.last).toEqual([ids.nodes.monde]);
});

test('copier un groupe retient la place où il est dessiné (centre de ses membres), pas sa position propre périmée', () => {
  const sc = buildScene(s, ids.plans.lobby, measure, P);
  const g = sc.byId.get(ids.nodes.groupeInduction)!;
  const clip = copyClip(s, sc, [g], 1)!;
  expect(clip.nodes.find((n) => n.id === ids.nodes.groupeInduction)).toMatchObject({ x: sc.items[g].x, y: sc.items[g].y });
});

test('des membres nouveaux d’un groupe déjà présent arrivent près de lui, pas au point de collage (I4 de la relecture 3b)', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const clip = copyClip(s, lobby, [lobby.byId.get(ids.nodes.groupeInduction)!], 1)!; // Induction, Solomonoff, Priore
  const these = ids.plans.these;
  paste(clip, these, { x: 0, y: 3000 }, 1);
  const priore = clip.nodes.find((n) => n.id !== ids.nodes.groupeInduction && n.id !== ids.nodes.solomonoff)!.id;
  run(s, removeFromPlan(s, these, priore));
  paste(clip, these, { x: -30_000, y: -30_000 }, 1);
  const sc = buildScene(s, these, measure, P);
  const pr = sc.items[sc.byId.get(priore)!], sol = sc.items[sc.byId.get(ids.nodes.solomonoff)!];
  expect(groupOf(s, these, priore)).toBe(ids.nodes.groupeInduction);
  expect(Math.hypot(pr.x - sol.x, pr.y - sol.y)).toBeLessThan(1000); // the group stays compact
});

test('une connexion à bras scindé suit la copie de ses deux nœuds (I5 de la relecture 3b)', () => {
  const lobby = buildScene(s, ids.plans.lobby, measure, P);
  const clip = copyClip(s, lobby, [lobby.byId.get(ids.nodes.mdl)!, lobby.byId.get(ids.nodes.universalite)!], 1)!;
  const split = clip.connections.find((c) => c.id === ids.connections.split)!;
  expect(split.nodes.sort()).toEqual([ids.nodes.mdl, ids.nodes.universalite].sort());
});
