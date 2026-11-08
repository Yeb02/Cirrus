import { expect, test } from 'vitest';
import {
  type Action, connect, createNode, createPlan, deleteConnection, deleteEverywhere, editConnection, editNode, include, moveNodes, placeNode, removeFromPlan,
  setBranches, setLayout, setRole,
} from '../src/commands.ts';
import { groupOf } from '../src/invariants.ts';
import { fileNameKey, rebaseUnit } from '../src/merge.ts';
import type { FileRef, Id, NodeRec, TagValue } from '../src/model.ts';
import { applyOp, applyOps, canonical, emptyState, placementOf, type State } from '../src/state.ts';
import type { RemoteUnit, Unit } from '../src/sync.ts';

const run = (s: State, a: Action): Action => { applyOps(s, a.ops); return a; };
const created = (a: Action, t: 'node' | 'connection' | 'plan'): Id => (a.ops.find((o) => o.t === t && o.before === null) as { after: { id: Id } }).after.id;
const file = (name: string, c: string, size = 1): FileRef => ({ name, hash: c.repeat(64), size });

/**
 * Plans P and Q; the registry's single-valued key `statut` (`auteur` is not declared); N, M, O placed in P, N in Q too;
 * N's files: note.tex and data.csv; the connection N → M.
 */
function world() {
  const s = emptyState();
  const P = created(run(s, createPlan(s, 'P', 'plan')), 'plan'), Q = created(run(s, createPlan(s, 'Q', 'plan')), 'plan');
  applyOp(s, { t: 'tagKey', before: null, after: { key: 'statut', type: 'text', scope: 'both', multi: false, required: false } });
  const mk = (title: string, x: number) => created(run(s, createNode(s, { plan: P, title, x, y: 0, k: 0 })), 'node');
  const N = mk('N', 0), M = mk('M', 100), O = mk('O', 200);
  run(s, placeNode(s, Q, N, 5, 5, 0));
  run(s, editNode(s, N, { files: [file('note.tex', '0'), file('data.csv', '1')] }));
  const NM = created(run(s, connect(s, { plan: P, members: [{ node: N, role: 'source' }, { node: M, role: 'target' }] })), 'connection');
  return { s, P, Q, N, M, O, NM };
}
type World = ReturnType<typeof world>;

const T0 = Date.UTC(2026, 10, 8, 13, 32);
interface Sides { mine: Action; theirs: Action; mineAt?: number; theirsAt?: number; minePc?: string; theirsPc?: string }

/**
 * Both actions computed on the same state, as the two PCs saw it; the server's (theirs) applied first, then mine rebased
 * onto it and applied: what the PC holds once its replayed write is accepted.
 */
function rebase(s: State, x: Sides) {
  const u: Unit = { unit: 'u-mine', action: x.mine.id, label: x.mine.label, at: x.mineAt ?? T0 + 1000, pc: x.minePc ?? 'pc-a', ops: x.mine.ops };
  const r: RemoteUnit = { unit: 'u-theirs', action: x.theirs.id, label: x.theirs.label, at: x.theirsAt ?? T0, pc: x.theirsPc ?? 'pc-b', ops: x.theirs.ops, seq: x.theirs.ops.length };
  applyOps(s, r.ops);
  const out = rebaseUnit(s, u, [r]);
  if (out.unit) applyOps(s, out.unit.ops);
  return { ...out, u };
}

const tags = (s: State, id: Id): TagValue[] => s.nodes.get(id)!.tags;
const files = (s: State, id: Id): string[] => s.nodes.get(id)!.files.map((f) => `${f.name}=${f.hash[0]}`);
/** « (conflit du AAAA-MM-JJ HHhMM) » in the local time of the PC replaying (R4). */
const stamp = (at: number) => {
  const d = new Date(at), p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}h${p(d.getMinutes())}`;
};

interface Case { name: string; check: (w: World) => void }

const CASES: Case[] = [
  {
    name: 'deux champs différents du même nœud : chacun garde le sien',
    check: ({ s, N }) => {
      const out = rebase(s, { mine: editNode(s, N, { title: 'N renommé' }), theirs: editNode(s, N, { summary: 'résumé' }) });
      expect([s.nodes.get(N)!.title, s.nodes.get(N)!.summary]).toEqual(['N renommé', 'résumé']);
      expect(out.unit!.ops[0].before).toEqual(expect.objectContaining({ title: 'N', summary: 'résumé' }));
    },
  },
  {
    name: 'le même champ : le plus récent gagne, le mien',
    check: ({ s, N }) => {
      rebase(s, { mine: editNode(s, N, { title: 'à moi' }), theirs: editNode(s, N, { title: 'à lui' }), mineAt: T0 + 2, theirsAt: T0 + 1 });
      expect(s.nodes.get(N)!.title).toBe('à moi');
    },
  },
  {
    name: 'le même champ : le plus récent gagne, le leur ; mon écriture ne change plus rien et disparaît',
    check: ({ s, N }) => {
      const out = rebase(s, { mine: editNode(s, N, { title: 'à moi' }), theirs: editNode(s, N, { title: 'à lui' }), mineAt: T0 + 1, theirsAt: T0 + 2 });
      expect(s.nodes.get(N)!.title).toBe('à lui');
      expect(out.unit).toBeNull();
    },
  },
  {
    name: 'le même champ à la même heure : l’identifiant de PC le plus grand gagne',
    check: ({ s, N }) => {
      const mine = editNode(s, N, { title: 'pc-c' }), theirs = editNode(s, N, { title: 'pc-b' });
      rebase(s, { mine, theirs, mineAt: T0, theirsAt: T0, minePc: 'pc-c', theirsPc: 'pc-b' });
      expect(s.nodes.get(N)!.title).toBe('pc-c');
      const again = world();
      rebase(again.s, { mine: editNode(again.s, again.N, { title: 'pc-a' }), theirs: editNode(again.s, again.N, { title: 'pc-b' }), mineAt: T0, theirsAt: T0, minePc: 'pc-a', theirsPc: 'pc-b' });
      expect(again.s.nodes.get(again.N)!.title).toBe('pc-b');
    },
  },
  {
    name: 'tags : un mot ajouté de chaque côté, un retiré d’un côté : ensemble, les ajouts et les retraits des deux comptent',
    check: ({ s, N }) => {
      run(s, editNode(s, N, { tags: [{ key: 'vieux' }, { key: 'gardé' }] }));
      const mine = editNode(s, N, { tags: [{ key: 'gardé' }, { key: 'lu' }] });
      const theirs = editNode(s, N, { tags: [{ key: 'vieux' }, { key: 'gardé' }, { key: 'important' }] });
      rebase(s, { mine, theirs });
      expect(tags(s, N)).toEqual([{ key: 'gardé' }, { key: 'important' }, { key: 'lu' }]);
    },
  },
  {
    name: 'tags : une clé à une seule valeur, déclarée au registre, se fusionne par clé (le plus récent gagne)',
    check: ({ s, N }) => {
      run(s, editNode(s, N, { tags: [{ key: 'statut', value: 'brouillon' }, { key: 'lu' }] }));
      const mine = editNode(s, N, { tags: [{ key: 'statut', value: 'relu' }, { key: 'lu' }] });
      const theirs = editNode(s, N, { tags: [{ key: 'lu' }, { key: 'statut', value: 'publié' }] });
      rebase(s, { mine, theirs, mineAt: T0 + 2, theirsAt: T0 + 1 });
      expect(tags(s, N)).toEqual([{ key: 'lu' }, { key: 'statut', value: 'relu' }]);
    },
  },
  {
    name: 'tags : une clé absente du registre (auteur) se fusionne comme un ensemble',
    check: ({ s, N }) => {
      run(s, editNode(s, N, { tags: [{ key: 'auteur', value: 'Li' }] }));
      const mine = editNode(s, N, { tags: [{ key: 'auteur', value: 'Li' }, { key: 'auteur', value: 'Vitányi' }] });
      const theirs = editNode(s, N, { tags: [{ key: 'auteur', value: 'Li' }, { key: 'auteur', value: 'Kolmogorov' }] });
      rebase(s, { mine, theirs, mineAt: T0 + 1, theirsAt: T0 + 2 });
      expect(tags(s, N)).toEqual([{ key: 'auteur', value: 'Li' }, { key: 'auteur', value: 'Kolmogorov' }, { key: 'auteur', value: 'Vitányi' }]);
    },
  },
  {
    name: 'un .tex changé des deux côtés : le plus récent garde le nom, l’autre version devient la copie de conflit, datée de son écriture',
    check: ({ s, N }) => {
      const mine = editNode(s, N, { files: [file('note.tex', 'a'), file('data.csv', '1')] });
      const theirs = editNode(s, N, { files: [file('note.tex', 'b'), file('data.csv', '1')] });
      const out = rebase(s, { mine, theirs, mineAt: T0 + 60_000, theirsAt: T0 + 120_000 });
      const copy = `note (conflit du ${stamp(T0 + 60_000)}).tex`;
      expect(files(s, N)).toEqual(['note.tex=b', 'data.csv=1', `${copy}=a`]);
      expect(out.conflictCopies).toEqual([copy]);
      // The other way round, the server's version is kept beside mine, dated from its own write.
      const w = world();
      const out2 = rebase(w.s, {
        mine: editNode(w.s, w.N, { files: [file('note.tex', 'a'), file('data.csv', '1')] }),
        theirs: editNode(w.s, w.N, { files: [file('note.tex', 'b'), file('data.csv', '1')] }), mineAt: T0 + 120_000, theirsAt: T0 + 60_000,
      });
      expect(files(w.s, w.N)).toEqual(['note.tex=a', 'data.csv=1', `note (conflit du ${stamp(T0 + 60_000)}).tex=b`]);
      expect(out2.conflictCopies).toEqual([`note (conflit du ${stamp(T0 + 60_000)}).tex`]);
    },
  },
  {
    name: 'une copie de conflit dont le nom est pris reçoit « (2) », comme au réimport',
    check: ({ s, N }) => {
      const taken = `note (conflit du ${stamp(T0)}).tex`;
      run(s, editNode(s, N, { files: [file('note.tex', '0'), file(taken, '9')] }));
      const out = rebase(s, {
        mine: editNode(s, N, { files: [file('note.tex', 'a'), file(taken, '9')] }), theirs: editNode(s, N, { files: [file('note.tex', 'b'), file(taken, '9')] }),
        mineAt: T0, theirsAt: T0 + 1,
      });
      expect(out.conflictCopies).toEqual([`note (conflit du ${stamp(T0)}) (2).tex`]);
      expect(files(s, N)).toEqual(['note.tex=b', `${taken}=9`, `note (conflit du ${stamp(T0)}) (2).tex=a`]);
    },
  },
  {
    name: 'un autre fichier changé des deux côtés : le plus récent gagne, sans copie ; les noms se comparent sans la casse ni la forme Unicode',
    check: ({ s, N }) => {
      const nfd = 'Énoncé.CSV', nfc = 'énoncé.csv';
      expect(fileNameKey(nfd)).toBe(fileNameKey(nfc));
      run(s, editNode(s, N, { files: [file(nfc, '2')] }));
      const out = rebase(s, { mine: editNode(s, N, { files: [file(nfd, 'a')] }), theirs: editNode(s, N, { files: [file(nfc, 'b')] }), mineAt: T0 + 2, theirsAt: T0 + 1 });
      expect(files(s, N)).toEqual([`${nfd}=a`]);
      expect(out.conflictCopies).toEqual([]);
    },
  },
  {
    name: 'fichiers : un ajouté de chaque côté, un supprimé d’un côté et modifié de l’autre (la modification gagne)',
    check: ({ s, N }) => {
      const mine = editNode(s, N, { files: [file('note.tex', '0'), file('data.csv', 'c'), file('a.txt', 'a')] });
      const theirs = editNode(s, N, { files: [file('note.tex', '0'), file('b.txt', 'b')] });
      rebase(s, { mine, theirs, mineAt: T0, theirsAt: T0 + 1 });
      // Theirs in their order, then what only mine has, in mine's order.
      expect(files(s, N)).toEqual(['note.tex=0', 'b.txt=b', 'data.csv=c', 'a.txt=a']);
    },
  },
  {
    name: 'membres d’une connexion : fusionnés par nœud, le rôle de chacun est un champ',
    check: ({ s, N, M, NM }) => {
      rebase(s, { mine: setRole(s, NM, N, 'associate'), theirs: setRole(s, NM, M, 'source') });
      expect(s.connections.get(NM)!.members).toEqual([{ node: N, role: 'associate' }, { node: M, role: 'source' }]);
      const w = world();
      rebase(w.s, { mine: setRole(w.s, w.NM, w.N, 'associate'), theirs: setRole(w.s, w.NM, w.N, 'target'), mineAt: T0, theirsAt: T0 + 1 });
      expect(w.s.connections.get(w.NM)!.members[0]).toEqual({ node: w.N, role: 'target' });
    },
  },
  {
    name: 'connexion : son titre et un membre ajouté d’un côté, sa relation de l’autre',
    check: ({ s, P, O, NM }) => {
      const theirs = editConnection(s, NM, { relation: 'cite' });
      const c = s.connections.get(NM)!;
      const mine: Action = { id: 'a', label: 'Ajouter', ops: [
        { t: 'connection', before: c, after: { ...c, title: 'lien', members: [...c.members, { node: O, role: 'associate' }] } },
        { t: 'branch', key: { plan: P, connection: NM, node: O }, before: false, after: true },
      ] };
      rebase(s, { mine, theirs });
      expect(s.connections.get(NM)).toEqual(expect.objectContaining({ title: 'lien', relation: 'cite' }));
      expect(s.connections.get(NM)!.members.map((m) => m.node)).toContain(O);
      expect(s.branches.has({ plan: P, connection: NM, node: O })).toBe(true);
    },
  },
  {
    name: 'un nœud jeté d’un côté et renommé de l’autre revient renommé, avec ses placements et ses branches',
    check: ({ s, P, Q, N, O }) => {
      run(s, include(s, P, N, O));
      run(s, removeFromPlan(s, Q, N));
      const before = placementOf(s, P, N)!;
      const theirs = removeFromPlan(s, P, N);
      expect(theirs.ops.some((o) => o.t === 'node' && o.after?.trashedAt !== undefined)).toBe(true);
      rebase(s, { mine: editNode(s, N, { title: 'N renommé' }), theirs, mineAt: T0, theirsAt: T0 + 1 });
      expect(s.nodes.get(N)!.title).toBe('N renommé');
      expect(s.nodes.get(N)!.trashedAt).toBeUndefined();
      expect(placementOf(s, P, N)).toEqual(before);
      expect(placementOf(s, Q, N)).toBeUndefined();
      expect(groupOf(s, P, N)).toBe(O);
    },
  },
  {
    name: 'une connexion jetée d’un côté et modifiée de l’autre revient avec ses branches',
    check: ({ s, P, N, M, NM }) => {
      rebase(s, { mine: editConnection(s, NM, { title: 'gardée' }), theirs: deleteConnection(s, NM), mineAt: T0, theirsAt: T0 + 1 });
      expect(s.connections.get(NM)!.title).toBe('gardée');
      expect(s.connections.get(NM)!.trashedAt).toBeUndefined();
      expect([N, M].map((node) => s.branches.has({ plan: P, connection: NM, node }))).toEqual([true, true]);
    },
  },
  {
    name: 'mon écriture qui jette un nœud modifié entre-temps ailleurs perd cette suppression, ses placements et ses branches',
    check: ({ s, P, Q, N, NM }) => {
      const theirs = editNode(s, N, { title: 'renommé ailleurs' });
      const out = rebase(s, { mine: deleteEverywhere(s, N), theirs, mineAt: T0 + 1, theirsAt: T0 });
      expect(out.unit).toBeNull();
      expect(s.nodes.get(N)!.title).toBe('renommé ailleurs');
      expect(s.nodes.get(N)!.trashedAt).toBeUndefined();
      expect([placementOf(s, P, N), placementOf(s, Q, N)].every(Boolean)).toBe(true);
      expect(s.connections.get(NM)!.trashedAt).toBeUndefined();
      expect(s.branches.has({ plan: P, connection: NM, node: N })).toBe(true);
    },
  },
  {
    name: 'un placement est un seul champ : le plus récent gagne ; retiré d’un côté, déplacé de l’autre, le déplacement gagne',
    check: ({ s, P, N }) => {
      rebase(s, { mine: moveNodes(s, P, [{ node: N, x: 1, y: 1 }]), theirs: moveNodes(s, P, [{ node: N, x: 2, y: 2 }]), mineAt: T0, theirsAt: T0 + 1 });
      expect(placementOf(s, P, N)).toEqual(expect.objectContaining({ x: 2, y: 2 }));
      const w = world();
      rebase(w.s, { mine: moveNodes(w.s, w.Q, [{ node: w.N, x: 7, y: 7 }]), theirs: removeFromPlan(w.s, w.Q, w.N), mineAt: T0, theirsAt: T0 + 1 });
      expect(placementOf(w.s, w.Q, w.N)).toEqual(expect.objectContaining({ x: 7, y: 7 }));
    },
  },
  {
    name: 'une branche : sa présence est un champ',
    check: ({ s, Q, N, M, NM }) => {
      rebase(s, { mine: setBranches(s, NM, [{ plan: Q, node: N }], true), theirs: setBranches(s, NM, [{ plan: Q, node: M }], true) });
      expect([N, M].map((node) => s.branches.has({ plan: Q, connection: NM, node }))).toEqual([true, true]);
    },
  },
  {
    name: 'une forme de connexion est un seul champ : le plus récent gagne',
    check: ({ s, P, NM }) => {
      const shape = (x: number) => ({ marker: { x, y: 0 }, handles: {} });
      rebase(s, { mine: setLayout(s, P, NM, shape(1)), theirs: setLayout(s, P, NM, shape(2)), mineAt: T0 + 1, theirsAt: T0 });
      expect(s.connLayouts.get(`${P}|${NM}`)!.marker).toEqual({ x: 1, y: 0 });
    },
  },
  {
    name: 'une écriture que les changements reçus ne touchent pas revient telle quelle ; une écriture déjà faite ailleurs disparaît',
    check: ({ s, N, M }) => {
      const mine = editNode(s, N, { title: 'N2' });
      const out = rebase(s, { mine, theirs: editNode(s, M, { title: 'M2' }) });
      expect(out.unit).toBe(out.u);
      const w = world();
      expect(rebase(w.s, { mine: editNode(w.s, w.N, { title: 'pareil' }), theirs: editNode(w.s, w.N, { title: 'pareil' }) }).unit).toBeNull();
    },
  },
];

test.each(CASES)('fusion (D4) : $name', ({ check }) => check(world()));

test('la fusion ne lit que les enregistrements touchés : un nœud absent de l’écriture n’est jamais réécrit', () => {
  const { s, N, O } = world();
  const before = canonical(s.nodes.get(O));
  const out = rebase(s, { mine: editNode(s, N, { title: 'x' }), theirs: editNode(s, N, { summary: 'y' }) });
  expect(out.unit!.ops.every((op) => op.t !== 'node' || (op.after as NodeRec).id === N)).toBe(true);
  expect(canonical(s.nodes.get(O))).toBe(before);
});
