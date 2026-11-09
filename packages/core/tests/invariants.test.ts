import { expect, test } from 'vitest';
import {
  type Action, addMember, CommandError, connect, createNode, createPlan, deleteEverywhere, editConnection, editNode, exclude, include, moveNodes, placeNode,
  removeFromPlan, removeMember, restoreNode, setBranches, setRole,
} from '../src/commands.ts';
import { invertAction } from '../src/history.ts';
import type { ConnectionKind, ConnectionRec, Id, NodeRec, PlanType, Role, TagKeyDef, TagValue } from '../src/model.ts';
import type { Op } from '../src/ops.ts';
import { ancestors, checkState, groupOf, touchedBy, type Violation } from '../src/invariants.ts';
import { applyOp, applyOps, emptyState, type State } from '../src/state.ts';
import { rng } from './helpers.ts';

const node = (id: Id): NodeRec => ({ id, title: id, summary: '', tags: [], files: [] });

function base(): State {
  const s = emptyState();
  const plans: [Id, PlanType][] = [['p1', 'plan'], ['p2', 'plan'], ['doc', 'document']];
  for (const [id, type] of plans) applyOp(s, { t: 'plan', before: null, after: { id, name: id, type } });
  for (const id of ['A', 'G', 'H']) {
    applyOp(s, { t: 'node', before: null, after: node(id) });
    for (const plan of ['p1', 'p2']) applyOp(s, { t: 'placement', before: null, after: { plan, node: id, x: 0, y: 0, k: 0 } });
  }
  return s;
}

function connection(s: State, c: ConnectionRec, plan: Id): void {
  applyOp(s, { t: 'connection', before: s.connections.get(c.id) ?? null, after: c });
  for (const m of c.members) applyOp(s, { t: 'branch', key: { plan, connection: c.id, node: m.node }, before: false, after: true });
}

function inclusion(s: State, member: Id, group: Id, plan: Id): void {
  const id = `inc-${member}-${group}`;
  const c: ConnectionRec = { id, kind: 'inclusion', title: '', relation: '', tags: [], members: [{ node: member, role: 'source' }, { node: group, role: 'target' }] };
  if (s.connections.has(id)) {
    for (const m of c.members) applyOp(s, { t: 'branch', key: { plan, connection: id, node: m.node }, before: false, after: true });
  } else connection(s, c, plan);
}

const codes = (s: State) => checkState(s).map((v) => v.code);

test('connexion à un seul membre refusée', () => {
  const s = base();
  connection(s, { id: 'c', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: 'A', role: 'source' }] }, 'p1');
  expect(codes(s)).toContain('members');
});

test('second groupe direct dans le même plan refusé (Review Focus 4)', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'A', 'H', 'p1');
  expect(codes(s)).toContain('twoGroups');
});

test("boucle d'inclusion refusée (Review Focus 4)", () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'G', 'A', 'p1');
  expect(codes(s)).toContain('cycle');
});

test('deux groupes différents dans deux plans différents acceptés', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'A', 'H', 'p2');
  expect(codes(s)).toEqual([]);
});

test('nœud jeté encore placé refusé', () => {
  const s = base();
  applyOp(s, { t: 'node', before: node('A'), after: { ...node('A'), trashedAt: 1 } });
  expect(codes(s)).toContain('trashedPlaced');
});

test('connexion de structure hors plan document refusée', () => {
  const s = base();
  connection(s, { id: 'st', kind: 'structure', title: '', relation: '', tags: [{ key: 'partie', value: 1 }], members: [{ node: 'G', role: 'source' }, { node: 'A', role: 'target' }] }, 'p1');
  expect(codes(s)).toContain('structureOutsideDocument');
});

test("branche vers un nœud qui n'est pas membre de la connexion refusée", () => {
  const s = base();
  connection(s, { id: 'k', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: 'A', role: 'source' }, { node: 'G', role: 'target' }] }, 'p1');
  applyOp(s, { t: 'branch', key: { plan: 'p1', connection: 'k', node: 'H' }, before: false, after: true });
  expect(codes(s)).toContain('branchNotMember');
});

test('la vérification limitée aux objets touchés trouve les mêmes violations que la vérification complète', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'A', 'H', 'p1');
  inclusion(s, 'G', 'H', 'p2');
  inclusion(s, 'H', 'G', 'p2');
  connection(s, { id: 'st', kind: 'structure', title: '', relation: '', tags: [], members: [{ node: 'G', role: 'source' }, { node: 'A', role: 'target' }] }, 'p1');
  connection(s, { id: 'k', kind: 'knowledge', title: '', relation: '', tags: [], members: [{ node: 'A', role: 'source' }, { node: 'G', role: 'target' }] }, 'p1');
  applyOp(s, { t: 'branch', key: { plan: 'p2', connection: 'k', node: 'H' }, before: false, after: true });
  const keys = (vs: { code: string; subject: string }[]) => vs.map((v) => `${v.code}|${v.subject}`).sort();
  expect(keys(checkState(s, new Set(['inc-A-H', 'inc-H-G', 'st', 'k', 'H'])))).toEqual(keys(checkState(s)));
  expect(keys(checkState(s))).toEqual(['branchNotMember|k', 'cycle|G', 'cycle|H', 'structureOutsideDocument|st', 'twoGroups|A']);
});

const NODES = Array.from({ length: 12 }, (_, i) => `n${i}`);

/**
 * Twelve nodes in P, some in Q and in the document D, and every rule broken somewhere, written without commands: a
 * connection of one member, a member twice, a branch to a non-member, two groups (P), a loop (Q), a trashed node still
 * placed, a structure outside a document, an enumeration value unknown. A structure in D and a connection tagged with a
 * valid value wait for a plan or a tag key to change.
 */
function broken(): State {
  const s = emptyState();
  for (const [id, type] of [['P', 'plan'], ['Q', 'plan'], ['D', 'document']] as [Id, PlanType][]) applyOp(s, { t: 'plan', before: null, after: { id, name: id, type } });
  applyOp(s, { t: 'tagKey', before: null, after: { key: 'e', type: 'enum', scope: 'both', multi: false, required: false, enumValues: [{ name: 'un', rank: 1 }] } });
  NODES.forEach((id, i) => {
    applyOp(s, { t: 'node', before: null, after: { ...node(id), ...(i === 10 ? { trashedAt: 1 } : {}), ...(i === 11 ? { tags: [{ key: 'e', value: 'deux' }] } : {}) } });
    applyOp(s, { t: 'placement', before: null, after: { plan: 'P', node: id, x: i, y: 0, k: 0 } });
    if (i % 2 === 0 || i === 9) applyOp(s, { t: 'placement', before: null, after: { plan: 'Q', node: id, x: i, y: 1, k: 0 } });
    if (i % 3 === 0) applyOp(s, { t: 'placement', before: null, after: { plan: 'D', node: id, x: i, y: 2, k: 0 } });
  });
  const raw = (id: Id, kind: ConnectionKind, members: [Id, Role][], plan: Id, shown: Id[] = members.map(([n]) => n), tags: TagValue[] = []) => {
    applyOp(s, { t: 'connection', before: null, after: { id, kind, title: '', relation: '', tags, members: members.map(([n, role]) => ({ node: n, role })) } });
    for (const n of new Set(shown)) applyOp(s, { t: 'branch', key: { plan, connection: id, node: n }, before: false, after: true });
  };
  raw('solo', 'knowledge', [['n0', 'source']], 'P');
  raw('dup', 'knowledge', [['n1', 'source'], ['n1', 'target'], ['n2', 'target']], 'P');
  raw('k23', 'knowledge', [['n2', 'source'], ['n3', 'target']], 'P', ['n2', 'n3', 'n4'], [{ key: 'e', value: 'un' }]);
  raw('i56', 'inclusion', [['n5', 'source'], ['n6', 'target']], 'P');
  raw('i57', 'inclusion', [['n5', 'source'], ['n7', 'target']], 'P');
  raw('i89', 'inclusion', [['n8', 'source'], ['n9', 'target']], 'Q');
  raw('i98', 'inclusion', [['n9', 'source'], ['n8', 'target']], 'Q');
  raw('st', 'structure', [['n3', 'source'], ['n4', 'target']], 'P');
  raw('k01', 'knowledge', [['n0', 'source'], ['n1', 'target'], ['n6', 'associate']], 'P', ['n0', 'n1', 'n6', 'n8']);
  raw('i42', 'inclusion', [['n4', 'source'], ['n2', 'target']], 'Q');
  raw('sd', 'structure', [['n0', 'source'], ['n3', 'target']], 'D');
  return s;
}
const BROKEN = ['solo', 'dup', 'k23', 'i56', 'i57', 'i89', 'i98', 'st', 'k01', 'i42'];

test('checkState(s, touched) égale checkState(s) filtré sur la portée, pour 100 actions tirées au hasard, plans et clés de tag compris', () => {
  const s = broken(), r = rng(7);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
  const nodes = [...NODES], plans = ['P', 'Q', 'D'], roles: Role[] = ['source', 'target', 'associate'];
  // Mostly the connections that break a rule, so that actions often touch what is wrong.
  const conn = () => pick(r() < 0.7 ? BROKEN : [...s.connections.keys()]);
  const members = () => [...new Set(Array.from({ length: 2 + Math.floor(r() * 2) }, () => pick(nodes)))].map((n) => ({ node: n, role: pick(roles) }));
  const commands: (() => Action)[] = [
    () => moveNodes(s, pick(plans), [{ node: pick(nodes), x: Math.floor(r() * 50) }]),
    () => editNode(s, pick(nodes), r() < 0.5 ? { title: `t${Math.floor(r() * 9)}` } : { tags: [{ key: 'e', value: 'un' }] }),
    () => { const a = createNode(s, { plan: pick(plans), title: 'nouveau', x: 0, y: 0, k: 0 }); nodes.push((a.ops[0] as { after: NodeRec }).after.id); return a; },
    () => connect(s, { plan: pick(plans), members: members() }),
    () => include(s, pick(plans), pick(nodes), pick(nodes)),
    () => exclude(s, pick(plans), pick(nodes)),
    () => removeFromPlan(s, pick(plans), pick(nodes)),
    () => placeNode(s, pick(plans), pick(nodes), 1, 1, 0),
    () => (r() < 0.3 ? deleteEverywhere(s, pick(nodes)) : restoreNode(s, pick(nodes), pick(plans), 0, 0, 0)),
    () => setBranches(s, conn(), [{ plan: pick(plans), node: pick(nodes) }], r() < 0.5),
    () => addMember(s, pick(plans), conn(), { node: pick(nodes), role: pick(roles) }),
    () => removeMember(s, conn(), pick(nodes)),
    () => editConnection(s, conn(), { title: 'x' }),
    () => setRole(s, conn(), pick(nodes), pick(roles)),
    () => { const a = createPlan(s, 'nouveau', pick(TYPES)); plans.push((a.ops[0] as { after: { id: Id } }).after.id); return a; },
  ];
  const TYPES: PlanType[] = ['plan', 'document', 'lobby'];
  const edit = (op: Op): Action => ({ id: 'brut', label: 'brut', ops: [op] });
  const enumKey = (key: string, names: string[]): TagKeyDef => ({ key, type: 'enum', scope: 'both', multi: false, required: false, enumValues: names.map((name, i) => ({ name, rank: i + 1 })) });
  // Plans and tag keys written without a command (none makes them but createPlan): renamed, retyped, removed, made
  // again; enumeration values changed. They may break rules, which must all be in their scope.
  const edits: (() => Action)[] = [
    () => {
      const id = pick(['P', 'Q', 'D', 'E']), before = s.plans.get(id) ?? null;
      return edit({ t: 'plan', before, after: before && r() < 0.25 ? null : { id, name: pick(['un', 'deux']), type: pick(TYPES) } });
    },
    () => {
      const key = pick(['e', 'f']), before = s.tagKeys.get(key) ?? null;
      return edit({ t: 'tagKey', before, after: before && r() < 0.25 ? null : enumKey(key, pick([['un'], ['deux'], ['un', 'deux']])) });
    },
  ];
  /** The scope checkState reads: the touched objects, and the members of touched inclusions. */
  const scopeOf = (touched: Set<Id>) => {
    const scope = new Set(touched);
    for (const id of touched) { const c = s.connections.get(id); if (c?.kind === 'inclusion') for (const m of c.members) scope.add(m.node); }
    return scope;
  };
  const keys = (vs: Violation[]) => vs.map((v) => `${v.code}|${v.subject}|${v.message}`).sort();
  let found = 0;
  const codes = new Set<string>();
  const compare = (touched: Set<Id>) => {
    const scope = scopeOf(touched), got = checkState(s, touched);
    expect(keys(got)).toEqual(keys(checkState(s).filter((v) => scope.has(v.subject))));
    found += got.length;
    for (const v of got) codes.add(v.code);
  };
  const key = (v: Violation) => `${v.code}|${v.subject}`;
  let accepted = 0, refused = 0, gained = 0;
  const kinds = new Set<string>();
  while (accepted < 100) {
    const raw = r() < 0.3;
    let a: Action;
    try { a = pick(raw ? edits : commands)(); } catch (e) { if (!(e instanceof CommandError)) throw e; refused++; continue; }
    const before = checkState(s);
    // The scope is read with the action applied, as finish reads it; compared after, then before (undone), then applied again.
    applyOps(s, a.ops);
    const touched = touchedBy(s, a.ops), after = checkState(s);
    compare(touched);
    if (raw) {
      // What an edit of a plan or a tag key breaks is in its scope.
      const had = new Set(before.map(key)), scope = scopeOf(touched);
      for (const v of after) if (!had.has(key(v))) { expect(scope.has(v.subject), key(v)).toBe(true); gained++; }
    }
    applyOps(s, invertAction(a).ops);
    compare(touched);
    applyOps(s, a.ops);
    for (const op of a.ops) kinds.add(op.t);
    accepted++;
  }
  // Every rule was found broken in some scope, many times over; plans and tag keys were drawn, and broke rules.
  expect(codes).toEqual(new Set(['members', 'duplicateMember', 'branchNotMember', 'twoGroups', 'cycle', 'trashedPlaced', 'structureOutsideDocument', 'tag']));
  expect(found).toBeGreaterThan(50);
  expect(refused).toBeGreaterThan(0);
  expect([kinds.has('plan'), kinds.has('tagKey'), gained > 0]).toEqual([true, true, true]);
});

test('groupOf et ancestors suivent la hiérarchie du plan', () => {
  const s = base();
  inclusion(s, 'A', 'G', 'p1');
  inclusion(s, 'G', 'H', 'p1');
  expect(groupOf(s, 'p1', 'A')).toBe('G');
  expect(ancestors(s, 'p1', 'A')).toEqual(['G', 'H']);
  expect(groupOf(s, 'p2', 'A')).toBeUndefined();
});
