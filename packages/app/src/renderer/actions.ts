import {
  type Action, addMember, combine, CommandError, conflictName, connect, type ConnectionRec, createNode, defineTagKey, deleteConnection, deleteEverywhere, deleteTagKey,
  editConnection, editNode, exclude, type FileRef, fileNameKey, groupOf, type Id, include, joinArm, moveNodes, movePhantom, type NodeRec, phantomsOf, placeAbsent, placementKey, placeNode, removeFromPlan,
  removeMember, renameEnumValue, renameTagKey, type Role, setBranches, setLayout, setPreamble, setRole, splitArm, type State, type TagKeyDef, type TagValue, truncateLabel, type Vec2,
} from '@cirrus/core';
import {
  type Clip, type ConnectTarget, deleteSummary, dropEffects, dropTarget, type Layout, PART_MAIN, partEnds, partOf, pasteSteps, type PlanScene, type RenderParams,
  scaleMoves, type SceneIndex,
} from '@cirrus/view';
import { checkFileName, type Merge, mergeFiles, sameName } from './files/merge.ts';
import { type Draft, definitionOf, type EnumRename, freedNames, planRenames, sameDefinition, withRenames } from './tagRegistry.ts';

/** An edit to run through the session: a pure command over the state, or null when there is nothing to do. */
export type Build = ((s: State) => Action) | null;

/** These items and everything they contain. */
const subtree = (scene: PlanScene, items: number[]): Set<number> => {
  const out = new Set<number>();
  const take = (i: number) => { out.add(i); for (const c of scene.items[i].children) take(c); };
  for (const i of items) take(i);
  return out;
};

/**
 * The connections whose every end moves keep their shape (spec 8.1, I10 of the plan 3b review): their pinned marker
 * goes through `map`, their Bézier offsets are scaled by `scale`. Only the connections with a layout in this plan are
 * looked at (the state's layouts, then their parts), never every part of the scene.
 */
function layoutsFollowing(s: State, scene: PlanScene, moved: Set<number>, map: (q: Vec2) => Vec2, scale: number): ((s: State) => Action)[] {
  const out: ((s: State) => Action)[] = [];
  for (const own of s.connLayouts.values()) {
    if (own.plan !== scene.plan.id) continue;
    for (const i of partOf(scene, own.connection)) {
      const l = scene.layout[i], ends = partEnds(scene, i);
      if (scene.part[i] !== PART_MAIN || !l || ends.length === 0 || !ends.every((e) => moved.has(e.item))) continue;
      const handles = Object.fromEntries(Object.entries(l.handles).map(([k, h]) => [k, {
        b1: { x: h.b1.x * scale, y: h.b1.y * scale }, b2: { x: h.b2.x * scale, y: h.b2.y * scale },
      }]));
      const next = { handles, ...(l.marker ? { marker: map(l.marker) } : {}), ...(l.angle !== undefined ? { angle: l.angle } : {}) };
      out.push((x) => setLayout(x, scene.plan.id, own.connection, next));
    }
  }
  return out;
}

/**
 * Moving items by (dx, dy) and dropping them onto `target` (spec 10): one action for the moves, then the groups left
 * and entered (with Alt, leaving the group); a simple node receiving its first members becomes a group,
 * groupOffsetSteps above its largest member (spec 8.1). `target`: where the drop enters (dropTarget), found once by the
 * caller for this and dropMemberships (I2 of the final review).
 */
export function dropBuild(base: PlanScene, items: number[], dx: number, dy: number, target: number | null, alt: boolean, p: RenderParams): Build {
  const effects = dropEffects(base, items, target, alt);
  if (dx === 0 && dy === 0 && effects.every((f) => !f.leave && f.enter === null)) return null;
  const effectOf = new Map(effects.map((f) => [f.item, f]));
  const nodes: { node: Id; x: number; y: number }[] = [], phantoms: { id: Id; x: number; y: number; group?: Id | null }[] = [];
  const memberships: ((s: State) => Action)[] = [];
  const plan = base.plan.id, targetId = target === null ? null : base.items[target].id;
  const collect = (i: number) => {
    const it = base.items[i], f = effectOf.get(i);
    const group = f?.enter != null ? targetId : f?.leave ? null : undefined;
    if (it.kind === 'phantom') phantoms.push({ id: it.id, x: it.x + dx, y: it.y + dy, ...(group !== undefined ? { group } : {}) });
    else {
      // A group's own position follows where it is drawn: emptied later, it stays there (I2 of the plan 3b review).
      nodes.push({ node: it.id, x: it.x + dx, y: it.y + dy });
      if (f?.enter != null) memberships.push((x) => include(x, plan, it.id, targetId!));
      else if (f?.leave) memberships.push((x) => exclude(x, plan, it.id));
    }
    for (const c of it.children) collect(c);
  };
  for (const i of items) collect(i);
  const entering = effects.filter((f) => f.enter !== null).map((f) => base.items[f.item].k);
  if (target !== null && base.items[target].kind === 'node' && entering.length > 0) {
    const k = Math.max(...entering) + p.groupOffsetSteps;
    if (base.items[target].k < k) memberships.push((x) => moveNodes(x, plan, [{ node: targetId!, k }]));
  }
  const count = nodes.length + phantoms.length;
  const moved = subtree(base, items);
  const label = targetId !== null && effects.some((f) => f.enter !== null) ? `Mettre dans « ${base.items[target!].title} »`
    : effects.some((f) => f.leave) ? 'Sortir du groupe' : count === 1 ? 'Déplacer un élément' : `Déplacer ${count} éléments`;
  return (st) => combine(st, label, [
    ...(nodes.length > 0 ? [(x: State) => moveNodes(x, plan, nodes)] : []),
    ...phantoms.map((ph) => (x: State) => movePhantom(x, ph.id, ph.x, ph.y, ph.group)),
    ...memberships,
    ...(dx === 0 && dy === 0 ? [] : layoutsFollowing(st, base, moved, (q) => ({ x: q.x + dx, y: q.y + dy }), 1)),
  ]);
}

/** One scale step up or down for these items (spec 8.1): steps, and positions of the groups' contents. */
export function scaleBuild(scene: PlanScene, items: number[], delta: number, p: RenderParams): Build {
  const m = scaleMoves(scene, items, delta, p);
  if (m.nodes.length === 0 && m.phantoms.length === 0) return null;
  const plan = scene.plan.id, moved = subtree(scene, items);
  return (st) => combine(st, delta > 0 ? 'Agrandir d’un cran' : 'Réduire d’un cran', [
    ...(m.nodes.length > 0 ? [(x: State) => moveNodes(x, plan, m.nodes)] : []),
    ...m.phantoms.map((ph) => (x: State) => movePhantom(x, ph.id, ph.x, ph.y, undefined, ph.k)),
    ...layoutsFollowing(st, scene, moved, (q) => ({ x: m.center.x + (q.x - m.center.x) * m.factor, y: m.center.y + (q.y - m.center.y) * m.factor }), m.factor),
  ]);
}

/** These nodes (phantoms aside), with everything they contain when `withContent`, deepest first: a group after its members. */
const nodesOf = (scene: PlanScene, ids: Id[], withContent: boolean): Id[] => {
  const chosen = new Set<number>();
  const take = (i: number) => {
    if (scene.items[i].kind === 'phantom') return;
    chosen.add(i);
    if (withContent) for (const c of scene.items[i].children) take(c);
  };
  for (const id of ids) { const i = scene.byId.get(id); if (i !== undefined) take(i); }
  return [...chosen].sort((a, b) => scene.items[b].depth - scene.items[a].depth).map((i) => scene.items[i].id);
};

/**
 * « Cacher » (spec 7): out of this plan only; a node leaving its last plan goes to the trash, an annotation aside (it
 * stays under its PDF: removeFromPlan). A group's content follows when `withContent`; otherwise each member shows in
 * its nearest ancestor present in the plan.
 */
export function hideBuild(scene: PlanScene, ids: Id[], withContent = false): Build {
  const nodes = nodesOf(scene, ids, withContent);
  if (nodes.length === 0) return null;
  const plan = scene.plan.id;
  return (st) => combine(st, nodes.length === 1 ? 'Cacher dans ce plan' : `Cacher ${nodes.length} éléments dans ce plan`, nodes.map((n) => (x: State) => removeFromPlan(x, plan, n)));
}

/**
 * The nodes that hiding these (with their content or not) would send to the trash: this plan is their last (spec 7, I12
 * of the review), annotations aside — leaving their last plan, they stay under their PDF (removeFromPlan).
 */
export function lastPlanNodes(s: State, scene: PlanScene, ids: Id[], withContent: boolean): Id[] {
  return deleteSummary(s, nodesOf(scene, ids, withContent)).last.filter((id) => s.nodes.get(id)?.anchor === undefined);
}

/**
 * Deletion (spec 7): « ici seulement » takes the nodes out of this plan — with a group's content when `withContent` —
 * « partout » out of every plan, to the trash.
 */
export function deleteBuild(scene: PlanScene, ids: Id[], everywhere: boolean, withContent = false): Build {
  const nodes = nodesOf(scene, ids, withContent && !everywhere);
  if (nodes.length === 0) return null;
  const plan = scene.plan.id, n = nodes.length;
  const label = everywhere ? (n === 1 ? 'Supprimer partout' : `Supprimer ${n} nœuds partout`) : (n === 1 ? 'Supprimer de ce plan' : `Supprimer ${n} nœuds de ce plan`);
  return (st) => combine(st, label, nodes.map((node) => (x: State) => (everywhere ? deleteEverywhere(x, node) : removeFromPlan(x, plan, node))));
}

/**
 * An annotation deleted from its line's menu (final review, I2: in a reader's margin or a PDF's pop-up, where one in
 * no plan is otherwise out of reach): everywhere (deleteEverywhere) — out of its plans and groups, to the trash —, one
 * action, one Ctrl+Z. Refused when it is computed if the node is no annotation, is gone, or is in the trash already (a
 * line shown a moment too long).
 */
export function deleteAnnotationBuild(node: Id): Build {
  return (st) => {
    const n = st.nodes.get(node);
    if (!n) throw new CommandError('Cette annotation n’existe plus.');
    if (n.anchor === undefined) throw new CommandError('Ce nœud n’est pas une annotation.');
    if (n.trashedAt !== undefined) throw new CommandError('Cette annotation est déjà supprimée.');
    return deleteEverywhere(st, node);
  };
}

/** A connection's deletion (spec 7): « ici seulement » hides its branches and phantoms in this plan, « partout » trashes it. */
export function deleteConnectionBuild(plan: Id, connection: Id, everywhere: boolean): Build {
  if (everywhere) return (st) => deleteConnection(st, connection);
  return (st) => {
    const c = st.connections.get(connection);
    const shown = (node: Id) => st.branches.has({ plan, connection, node })
      || phantomsOf(st, connection).some((id) => { const ph = st.phantoms.get(id); return ph !== undefined && ph.plan === plan && ph.of.node === node; });
    const nodes = (c?.members ?? []).map((m) => m.node).filter(shown);
    return combine(st, 'Ôter la connexion de ce plan', [(x) => setBranches(x, connection, nodes.map((node) => ({ plan, node })), false)]);
  };
}

/** « Ajouter au lobby » for a connection (spec 7): it places itself, every member shown, as a stub where absent. */
export function lobbyConnectionBuild(lobby: Id, connection: Id): Build {
  return (st) => combine(st, 'Ajouter la connexion au lobby', [
    (x) => setBranches(x, connection, (x.connections.get(connection)?.members ?? []).map((m) => ({ plan: lobby, node: m.node })), true),
  ]);
}

/**
 * Pasting a clip at `at` (spec 7) as one action; `present`: the nodes that were already there and kept their place.
 * `index`: the scene's visibility index, if at hand (groupAt).
 */
export function pasteBuild(s: State, clip: Clip, scene: PlanScene, at: Vec2, zoom: number, p: RenderParams, index?: SceneIndex): { build: Build; present: Id[] } {
  const drawn = (id: Id) => { const i = scene.byId.get(id); return i === undefined ? undefined : { x: scene.items[i].x, y: scene.items[i].y }; };
  const r = pasteSteps(s, clip, scene.plan.id, at, zoom, groupAt(scene, at, zoom, p, index), p, drawn);
  const n = clip.nodes.length;
  return { build: r.steps.length === 0 ? null : (st) => combine(st, n === 1 ? 'Coller un nœud' : `Coller ${n} nœuds`, r.steps), present: r.present };
}

/** The step whose text reads at the base size at this zoom (a node created or brought in from elsewhere). */
export const readableStep = (zoom: number, p: RenderParams): number => Math.round(Math.log(1 / (zoom * p.textScale)) / Math.log(p.factor));

/**
 * The group whose envelope receives a node put down at `at`, if any (spec 10). `index`: the scene's visibility index,
 * by which only what lies under the point is read instead of the whole plan, the same answer (I2 of the final review).
 */
export const groupAt = (scene: PlanScene, at: Vec2, zoom: number, p: RenderParams, index?: SceneIndex): Id | null => {
  const target = dropTarget(scene, at, [], zoom, p, index);
  return target !== null && scene.items[target].kind === 'group' ? scene.items[target].id : null;
};

/**
 * A new node placed at `at` (spec 12), at the step whose text reads at the base size at this zoom; dropped inside an
 * envelope, it enters that group like any free node (spec 10). `index`: the scene's visibility index, if at hand (groupAt).
 */
export function createBuild(scene: PlanScene, title: string, at: Vec2, zoom: number, p: RenderParams, index?: SceneIndex): Build {
  const name = title.trim();
  if (!name) return null;
  return newNodeBuild(scene, { title: name }, at, zoom, p, `Créer « ${name} »`, index);
}

/**
 * createBuild's node with its tags and its files, already in the store (an imported publication, plan 4c, D7), as one
 * action labelled `label`: put down at `at`, at the readable step, entering the group whose envelope receives it.
 */
export function newNodeBuild(
  scene: PlanScene, rec: { title: string; tags?: TagValue[]; files?: FileRef[] }, at: Vec2, zoom: number, p: RenderParams, label: string, index?: SceneIndex,
): (s: State) => Action {
  const k = readableStep(zoom, p);
  const group = groupAt(scene, at, zoom, p, index);
  const plan = scene.plan.id;
  return (st) => {
    let id = '';
    return combine(st, label, [
      (x) => {
        const a = createNode(x, { plan, title: rec.title, x: at.x, y: at.y, k, tags: rec.tags, files: rec.files });
        id = (a.ops[0] as { after: { id: Id } }).after.id;
        return a;
      },
      ...(group !== null ? [(x: State) => include(x, plan, id, group)] : []),
    ]);
  };
}

/** The id of the connection an action creates. */
const createdConnection = (a: Action): Id => (a.ops.find((o) => o.t === 'connection' && o.before === null) as { after: ConnectionRec }).after.id;
/** The branches of these members in these plans. */
const branchesIn = (plans: Id[], nodes: Id[]) => plans.flatMap((plan) => nodes.map((node) => ({ plan, node })));

/**
 * A connection drawn from a node (spec 11.1): to another node, a new connection leaving `from`; to the core of a
 * connection, `from` joins it as a source. `everywhere`: the other plans where it is shown too (« partout »).
 */
export function connectBuild(scene: PlanScene, from: number, target: ConnectTarget, everywhere: Id[]): Build {
  const plan = scene.plan.id, source = scene.items[from].node;
  if (target.kind === 'connection') return addMemberBuild(plan, scene.ids[target.conn], source, everywhere, 'source');
  const to = scene.items[target.item].node;
  return (st) => {
    let id = '';
    return combine(st, 'Créer une connexion', [
      (x) => { const a = connect(x, { plan, members: [{ node: source, role: 'source' }, { node: to, role: 'target' }] }); id = createdConnection(a); return a; },
      ...(everywhere.length > 0 ? [(x: State) => setBranches(x, id, branchesIn(everywhere, [source, to]), true)] : []),
    ]);
  };
}

/** A member added to a connection (spec 11.2), here and in `everywhere`; a node absent from a plan shows there as a stub. */
export function addMemberBuild(plan: Id, connection: Id, node: Id, everywhere: Id[], role: Role = 'target'): Build {
  return (st) => combine(st, 'Ajouter un nœud à la connexion', [
    (x) => addMember(x, plan, connection, { node, role }),
    ...(everywhere.length > 0 ? [(x: State) => setBranches(x, connection, branchesIn(everywhere, [node]), true)] : []),
  ]);
}

/** « Ici seulement »: the member is no longer shown in this plan; « partout »: it leaves the connection (spec 11.2). */
export function removeMemberBuild(plan: Id, connection: Id, node: Id, everywhere: boolean): Build {
  return everywhere ? (st) => removeMember(st, connection, node) : (st) => setBranches(st, connection, [{ plan, node }], false);
}

export function roleBuild(connection: Id, node: Id, role: Role): Build {
  return (st) => setRole(st, connection, node, role);
}

export function connectionTextBuild(connection: Id, patch: { title?: string; relation?: string }): Build {
  return (st) => editConnection(st, connection, patch);
}

/**
 * Split arm (spec 8.5): the far node's phantom, put down by the bundle, takes the step readable at this zoom; the
 * centre's phantom, next to the far node, that node's step (I14 of the plan 3b review).
 */
export function splitBuild(scene: PlanScene, connection: Id, node: Id, near: Vec2, far: Vec2, zoom: number, p: RenderParams): Build {
  const i = scene.byId.get(node);
  if (i === undefined) return null;
  return (st) => splitArm(st, scene.plan.id, connection, node, { ...near, k: readableStep(zoom, p) }, { ...far, k: scene.items[i].k });
}

export function joinBuild(plan: Id, connection: Id, node: Id): Build {
  return (st) => joinArm(st, plan, connection, node);
}

/**
 * A node brought into the plan from a stub or an absent phantom (spec 11.3), at the step readable at this zoom;
 * inside an envelope, it enters that group. `index`: the scene's visibility index, if at hand (groupAt).
 */
export function importBuild(
  scene: PlanScene, node: Id, at: Vec2, zoom: number, p: RenderParams, label = 'Importer un nœud dans ce plan', index?: SceneIndex,
): Build {
  const plan = scene.plan.id;
  const group = groupAt(scene, at, zoom, p, index);
  return (st) => combine(st, label, [
    (x) => placeNode(x, plan, node, at.x, at.y, readableStep(zoom, p)),
    ...(group !== null ? [(x: State) => include(x, plan, node, group)] : []),
  ]);
}

/** What a node dropped into a plan that holds it already is told (placeDroppedBuild); the view is framed on it. */
export const ALREADY_HERE = 'Déjà dans ce plan.';

/**
 * A node dragged out of a list of annotations and let go at `at` (plan 4c, D4): brought into this plan as importBuild
 * does — at the step readable at this zoom, entering the group whose envelope receives it — and, let go on a simple
 * node, entering that node, which becomes a group groupOffsetSteps above it, as a node dropped on a node does
 * (dropBuild; spec 8.1, 10). One action. Refused « Déjà dans ce plan. » when the node is placed here by the time it is
 * computed; a node in the trash, by placeNode. `index`: the scene's visibility index, if at hand (dropTarget).
 */
export function placeDroppedBuild(scene: PlanScene, node: Id, at: Vec2, zoom: number, p: RenderParams, index?: SceneIndex): Build {
  const plan = scene.plan.id, t = dropTarget(scene, at, [], zoom, p, index);
  const host = t === null ? null : scene.items[t];
  const label = host === null ? 'Poser un nœud dans ce plan' : `Poser un nœud dans « ${host.title} »`;
  const imported = importBuild(scene, node, at, zoom, p, label, index)!;
  const simple = host !== null && host.kind === 'node' ? host : null, k = readableStep(zoom, p) + p.groupOffsetSteps;
  return (st) => {
    if (st.placements.has(placementKey(plan, node))) throw new CommandError(ALREADY_HERE);
    if (simple === null) return imported(st);
    return combine(st, label, [
      imported,
      (x) => include(x, plan, node, simple.id),
      ...(simple.k < k ? [(x: State) => moveNodes(x, plan, [{ node: simple.id, k }])] : []),
    ]);
  };
}

/** A stub put down by hand (spec 8.5): its absent phantom, at the largest step of the connection here. */
export function absentBuild(scene: PlanScene, connection: Id, node: Id, at: Vec2): Build {
  const ends = partOf(scene, connection).flatMap((i) => partEnds(scene, i));
  const k = ends.length > 0 ? Math.max(...ends.map((e) => scene.items[e.item].k)) : 0;
  return (st) => placeAbsent(st, scene.plan.id, connection, node, at.x, at.y, k);
}

export function renameBuild(id: Id, title: string): Build {
  const name = title.trim();
  return name ? (st) => editNode(st, id, { title: name }) : null;
}

/** The node, or the core's refusal when it is gone. */
const nodeRec = (s: State, node: Id): NodeRec => {
  const n = s.nodes.get(node);
  if (!n) throw new CommandError('Nœud introuvable.');
  return n;
};

/** A node's summary as typed in its pop-up: LaTeX source (its compiled preview comes with plan 4b). */
export function summaryBuild(node: Id, summary: string): Build {
  return (st) => editNode(st, node, { summary });
}

/**
 * A node's tags changed by `change` (withTag, withoutTag) on the state the action is computed on, so that two quick
 * changes both count; one that changes nothing by then (the same tag added twice) is refused rather than written empty.
 */
export function tagsBuild(node: Id, change: (tags: TagValue[], defs: ReadonlyMap<string, TagKeyDef>) => TagValue[]): Build {
  return (st) => {
    const tags = nodeRec(st, node).tags, next = change(tags, st.tagKeys);
    if (next === tags) throw new CommandError('Ces tags sont déjà à jour.');
    return editNode(st, node, { tags: next });
  };
}

/** The connection, or the core's refusal when it is gone. */
const connectionRec = (s: State, connection: Id): ConnectionRec => {
  const c = s.connections.get(connection);
  if (!c) throw new CommandError('Connexion introuvable.');
  return c;
};

/**
 * A connection's tags changed by `change` (withTag, withoutTag), as tagsBuild does a node's (plan 6a, D4): computed on the
 * state the action is made on, and one that changes nothing is refused rather than written empty.
 */
export function connectionTagsBuild(connection: Id, change: (tags: TagValue[], defs: ReadonlyMap<string, TagKeyDef>) => TagValue[]): Build {
  return (st) => {
    const tags = connectionRec(st, connection).tags, next = change(tags, st.tagKeys);
    if (next === tags) throw new CommandError('Ces tags sont déjà à jour.');
    return editConnection(st, connection, { tags: next });
  };
}

// The tag registry's panel (plan 6a, D4): each of the core's commands as an edit of the session, one action that Ctrl+Z
// undoes. A refusal (CommandError) is the session's, told in a toast; so is the gate's, when a rename is too big to send.

/** A key created, or its definition changed. */
export function defineTagKeyBuild(def: TagKeyDef): Build {
  return (st) => defineTagKey(st, def);
}

/** A key renamed everywhere: its definition, the nodes and the connections that carry it, the trash included. */
export function renameTagKeyBuild(from: string, to: string): Build {
  return (st) => renameTagKey(st, from, to);
}

/** A key taken out of the registry; the objects keep its tags. */
export function deleteTagKeyBuild(key: string): Build {
  return (st) => deleteTagKey(st, key);
}

/** A value of an enumeration renamed, on the objects that carry it too. */
export function renameEnumValueBuild(key: string, from: string, to: string): Build {
  return (st) => renameEnumValue(st, key, from, to);
}

/**
 * The form of an enumeration saved: its values renamed (`renames`, in an order planRenames made) and the definition as
 * the form has it, in one action — one Ctrl+Z gives all of it back. `freed`: values removed whose name a rename takes
 * (freedNames), taken out of the definition first, the core refusing a rename to a name that exists. The definition is
 * written (last) only if the renames leave it different from `def`; with no renames it is defineTagKey alone, which
 * refuses a definition that changes nothing.
 */
export function saveTagKeyBuild(def: TagKeyDef, renames: readonly EnumRename[], freed: readonly string[] = []): Build {
  if (renames.length === 0) return defineTagKeyBuild(def);
  return (st) => {
    let now = st.tagKeys.get(def.key);
    const steps: ((x: State) => Action)[] = [];
    if (now && freed.length > 0) {
      const { defaultValue, ...rest } = now;
      const less: TagKeyDef = { ...rest, enumValues: (now.enumValues ?? []).filter((e) => !freed.includes(e.name)) };
      if (defaultValue !== undefined && !freed.includes(String(defaultValue))) less.defaultValue = defaultValue;
      steps.push((x) => defineTagKey(x, less));
      now = less;
    }
    for (const r of renames) steps.push((x) => renameEnumValue(x, def.key, r.from, r.to));
    if (!now || !sameDefinition(withRenames(now, renames), def)) steps.push((x) => defineTagKey(x, def));
    return combine(st, `Modifier le tag « ${def.key} »`, steps);
  };
}

/**
 * The tag registry's form saved (plan 6a, D4): a key created — refused when the registry has that name already, which
 * would overwrite its definition (« Créer » on a name taken) —, or a key's definition changed, its values renamed and
 * removed with it in one action (saveTagKeyBuild). Everything is computed on the state at the time, so a rank that is no
 * number, an exchange of names and a name taken are refusals of the session, shown in a toast.
 */
export function formSaveBuild(draft: Draft, creating: boolean): Build {
  return (st) => {
    const next = definitionOf(draft), now = st.tagKeys.get(next.key);
    if (creating && now) throw new CommandError(`Le tag « ${next.key} » existe déjà dans le registre.`);
    const both = now?.type === 'enum' && next.type === 'enum';
    const renames = both ? planRenames(now, draft) : [];
    return saveTagKeyBuild(next, renames, both ? freedNames(now, draft, renames) : [])!(st);
  };
}

/** Where the file `name` is among `files`, by its exact name; gone since the gesture began, refused. */
const fileAt = (files: FileRef[], name: string): number => {
  const i = files.findIndex((f) => f.name === name);
  if (i < 0) throw new CommandError(`« ${name} » n’est plus dans ce nœud.`);
  return i;
};
const changes = (m: Merge) => m.added.length + m.replaced.length > 0;
/** What a drop of files already there, unchanged, is told: when filesBuild gives null (importInto), or at run time. */
export const UP_TO_DATE = 'Déjà à jour.';

/**
 * Files dropped on a node, already copied into the store (spec 5.2; plan 4a, D6), merged by mergeFiles as one action:
 * one undo step (spec 6.4). Null when every file is there already, unchanged (Review Focus 1), as `s` has them; the merge
 * is made again on the state the action is computed on, where the same drop applied in between is refused « Déjà à jour. ».
 */
export function filesBuild(s: State, node: Id, incoming: FileRef[]): Build {
  const n = s.nodes.get(node);
  if (n && !changes(mergeFiles(n.files, incoming))) return null;
  return (st) => {
    const now = nodeRec(st, node), m = mergeFiles(now.files, incoming);
    if (!changes(m)) throw new CommandError(UP_TO_DATE);
    const label = m.added.length === 0 && m.replaced.length === 1 ? `Remplacer « ${m.replaced[0]} »` : `Ajouter des fichiers à « ${now.title} »`;
    return combine(st, label, [(x) => editNode(x, node, { files: m.files })]);
  };
}

/**
 * A new version of a node's .tex, saved from its full screen (plan 4b, D6) and already in the store (`ref`, under the
 * file's name): filesBuild, which replaces it in its place, labelled « Modifier « name » » (cut to MAX_LABEL_CHARS, R20). Null when the node holds
 * that very content already. Refused when the action is computed if the node is gone or in the trash, or the file no
 * longer in it: a save never brings back what was removed meanwhile (Review Focus 4).
 *
 * `keepTheirs` (plan 5b, D6): the version that came from elsewhere while the full screen held text not yet saved. The
 * version the node holds under that name when the action is computed — `keepTheirs`, or newer still: the one this save
 * replaces — stays, under its conflict name (texConflictName, at `at`, now by default), in the same action, after the
 * node's files: one undo step gives both files back as they were. None when that version is the saved text's own.
 */
export function texSaveBuild(s: State, node: Id, ref: FileRef, opts: { keepTheirs?: FileRef; at?: number } = {}): Build {
  const label = truncateLabel(`Modifier « ${ref.name} »`);
  if (opts.keepTheirs) {
    const at = opts.at ?? Date.now();
    return (st) => {
      const why = texSaveRefusal(st, node, ref.name);
      if (why) throw new CommandError(why);
      const n = nodeRec(st, node), theirs = n.files.find((f) => sameName(f.name, ref.name))!;
      const copy = theirs.hash === ref.hash ? [] : [{ ...theirs, name: texConflictName(n.files, ref.name, at) }];
      const m = mergeFiles(n.files, [ref, ...copy]);
      if (!changes(m)) throw new CommandError(UP_TO_DATE);
      return combine(st, label, [(x) => editNode(x, node, { files: m.files })]);
    };
  }
  const replace = filesBuild(s, node, [ref]);
  if (!replace) return null;
  return (st) => {
    const why = texSaveRefusal(st, node, ref.name);
    if (why) throw new CommandError(why);
    return { ...replace(st), label };
  };
}

/**
 * A .tex reconciled with its conflict copy, from the comparison's full screen (plan 5b, D7): the text taken is stored
 * already (`ref`, under the original's name; null: nothing taken, the original is left as it is) and replaces the
 * original in its place, as texSaveBuild has it; with `removeCopy`, the copy compared — its name and the hash of the
 * version shown — leaves the node's files in the same action, its blob staying in the store, where the history refers
 * to it (spec 5.2): never deleted. A copy that holds another version when the action is computed (changed on another PC
 * meanwhile) stays: only what was compared is removed (task 8a, from the review of task 6). One action, « Réconcilier
 * « x.tex » » (cut to MAX_LABEL_CHARS): one undo step gives both files back. Null when `s` holds all of it already;
 * refused when the action is computed if the node is gone or in the trash, or the original no longer in it
 * (texSaveRefusal). A copy gone meanwhile is not an error: what was asked of it is done.
 *
 * `keepTheirs` (D6, texSaveBuild's): the original changed elsewhere while the comparison was open; the version the node
 * holds when the action is computed stays under its conflict name (texConflictName, at `at`, now by default), unless it
 * is the saved text's own.
 */
export function reconcileTexBuild(
  s: State, node: Id, original: string, ref: FileRef | null,
  opts: { removeCopy?: Pick<FileRef, 'name' | 'hash'>; keepTheirs?: boolean; at?: number } = {},
): Build {
  const label = truncateLabel(`Réconcilier « ${original} »`);
  const at = opts.at ?? Date.now();
  /** The node's files once reconciled: the same objects when nothing changes. */
  const reconciled = (files: readonly FileRef[]): FileRef[] => {
    let out = [...files];
    if (ref) {
      const theirs = files.find((f) => sameName(f.name, original));
      const kept = opts.keepTheirs && theirs && theirs.hash !== ref.hash ? [{ ...theirs, name: texConflictName(files, original, at) }] : [];
      out = mergeFiles(out, [ref, ...kept]).files;
    }
    const copy = opts.removeCopy;
    return copy === undefined ? out : out.filter((f) => !(sameName(f.name, copy.name) && f.hash === copy.hash));
  };
  const unchanged = (files: readonly FileRef[]) => {
    const next = reconciled(files);
    return next.length === files.length && next.every((f, i) => f === files[i]);
  };
  const n = s.nodes.get(node);
  if (n && unchanged(n.files)) return null;
  return (st) => {
    const why = texSaveRefusal(st, node, original);
    if (why) throw new CommandError(why);
    const files = nodeRec(st, node).files;
    if (unchanged(files)) throw new CommandError(UP_TO_DATE);
    return combine(st, label, [(x) => editNode(x, node, { files: reconciled(files) })]);
  };
}

/**
 * The name the version from elsewhere of the .tex `name` is kept under by a save at `at` (plan 5b, D6): the core's
 * conflictName, « nom (conflit du AAAA-MM-JJ HHhMM).tex » in this PC's time, numbered after it when `files` hold that
 * name already — the copies the synchronisation's merge makes are named so too.
 */
export function texConflictName(files: readonly FileRef[], name: string, at: number): string {
  return conflictName(name, at, new Set(files.map((f) => fileNameKey(f.name))));
}

/** Why the .tex `name` of `node` cannot be saved in `s`, in French: the node gone or in the trash, the file no longer in it; null when it can. */
export function texSaveRefusal(s: State, node: Id, name: string): string | null {
  const n = s.nodes.get(node);
  if (!n || n.trashedAt !== undefined) return 'Ce nœud n’existe plus.';
  return n.files.some((f) => sameName(f.name, name)) ? null : `« ${name} » n’est plus dans ce nœud.`;
}

/**
 * The global LaTeX preamble saved from its full screen (D5, task 7): « Modifier le préambule LaTeX », in the history,
 * undone by Ctrl+Z; refused when it is the one in effect by then.
 */
export function preambleBuild(text: string): Build {
  return (st) => setPreamble(st, text);
}

/** A node's file renamed in its place, its content kept; a name checkFileName refuses is refused when the action is computed. */
export function renameFileBuild(node: Id, name: string, newName: string): Build {
  if (newName === name) return null;
  return (st) => {
    const files = nodeRec(st, node).files, i = fileAt(files, name);
    const why = checkFileName(newName, files, name);
    if (why) throw new CommandError(why);
    return combine(st, `Renommer « ${name} »`, [(x) => editNode(x, node, { files: files.map((f, j) => (j === i ? { ...f, name: newName } : f)) })]);
  };
}

/** A file taken out of a node; its copy stays in the store, where the history refers to it (spec 5.2). */
export function removeFileBuild(node: Id, name: string): Build {
  return (st) => {
    const n = nodeRec(st, node), i = fileAt(n.files, name);
    return combine(st, `Retirer « ${name} » de « ${n.title} »`, [(x) => editNode(x, node, { files: n.files.filter((_, j) => j !== i) })]);
  };
}

/** A connection's layout in this plan (spec 8.5): set by its handles, or null for the automatic one. */
export function layoutBuild(plan: Id, connection: Id, layout: Layout | null): Build {
  return (st) => setLayout(st, plan, connection, layout);
}

/**
 * The nodes whose group a drop onto `target` changes in its plan (spec 10), for the « partout » question; phantoms'
 * groups are their plan's only. `target`: the one dropBuild is given (I2 of the final review).
 */
export function dropMemberships(s: State, base: PlanScene, items: number[], target: number | null, alt: boolean): { node: Id; from: Id | null; to: Id | null }[] {
  const plan = base.plan.id;
  return dropEffects(base, items, target, alt)
    .filter((f) => (f.leave || f.enter !== null) && base.items[f.item].kind !== 'phantom')
    .map((f) => {
      const node = base.items[f.item].id;
      return { node, from: groupOf(s, plan, node) ?? null, to: f.enter !== null ? base.items[f.enter].id : null };
    });
}

/** « Partout » (spec 10): the drop, then the plans whose change needs no hand placement, as one action. */
export function withRepercussion(drop: Build, autos: { plan: Id; node: Id; to: Id | null }[]): Build {
  if (!drop || autos.length === 0) return drop;
  return (st) => {
    const first = drop(st);
    return combine(st, first.label, [() => first, ...autos.map((r) => (x: State) => (r.to !== null ? include(x, r.plan, r.node, r.to) : exclude(x, r.plan, r.node)))]);
  };
}

/**
 * A node put down by hand in a plan the repercussion touches (spec 10): it moves there with all it contains (a group
 * moves as a block) and takes its new group, or leaves its group.
 */
export function placeInPlanBuild(scene: PlanScene, node: Id, at: Vec2, to: Id | null): Build {
  const i = scene.byId.get(node);
  if (i === undefined) return null;
  const dx = at.x - scene.items[i].x, dy = at.y - scene.items[i].y;
  const nodes: { node: Id; x: number; y: number }[] = [], phantoms: { id: Id; x: number; y: number }[] = [];
  const collect = (j: number) => {
    const it = scene.items[j];
    if (it.kind === 'phantom') phantoms.push({ id: it.id, x: it.x + dx, y: it.y + dy });
    else nodes.push({ node: it.id, x: it.x + dx, y: it.y + dy });
    for (const c of it.children) collect(c);
  };
  collect(i);
  const plan = scene.plan.id, moved = subtree(scene, [i]);
  return (st) => combine(st, `Répercuter dans « ${scene.plan.name} »`, [
    ...(nodes.length > 0 ? [(x: State) => moveNodes(x, plan, nodes)] : []),
    ...phantoms.map((ph) => (x: State) => movePhantom(x, ph.id, ph.x, ph.y)),
    ...layoutsFollowing(st, scene, moved, (q) => ({ x: q.x + dx, y: q.y + dy }), 1),
    (x: State) => (to !== null ? include(x, plan, node, to) : exclude(x, plan, node)),
  ]);
}
