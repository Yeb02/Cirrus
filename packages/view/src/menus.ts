import { type Id, placementKey, type State } from '@cirrus/core';
import type { Hit } from './hit.ts';
import { partOf, type PlanScene } from './scene.ts';
import type { Selection } from './selection.ts';

export type MenuAction =
  | 'connect' | 'exclude' | 'scaleDown' | 'scaleUp' | 'rename' | 'hide' | 'delete' | 'addToLobby'
  | 'copy' | 'paste' | 'newNode' | 'teleport' | 'joinArm' | 'importNode' | 'splitArm' | 'layout' | 'resetLayout' | 'deleteConnection';

export interface MenuItem { action: MenuAction; label: string }

const LABELS: Record<MenuAction, string> = {
  connect: 'Ajouter une connexion',
  exclude: 'Exclure du groupe',
  scaleDown: 'Réduire d’un cran (−)',
  scaleUp: 'Agrandir d’un cran (+)',
  rename: 'Renommer',
  hide: 'Cacher dans ce plan',
  delete: 'Supprimer…',
  addToLobby: 'Ajouter au lobby',
  copy: 'Copier',
  paste: 'Coller',
  newNode: 'Nouveau nœud',
  teleport: 'S’y téléporter',
  joinArm: 'Réunir ce bras',
  importNode: 'Importer le nœud dans ce plan',
  splitArm: 'Scinder ce bras',
  layout: 'Disposer la connexion',
  resetLayout: 'Rétablir la disposition automatique',
  deleteConnection: 'Supprimer la connexion…',
};

/**
 * The context menu of what is under the cursor (spec 9.1, 8.5, 11.3): a right click on an element of a selection of
 * several opens the selection menu (copy, hide, − and +); a phantom offers to teleport to its original and to join
 * the arm back; a stub, to import its node; the background, to create a node or paste, after the menu of the open
 * group `under` the cursor if any. On a connection: split the
 * branch clicked if it leads to a node placed here, join the arm back on its far side; a line standing for several
 * connections (a closed group) has no menu.
 */
export function menuFor(s: State, scene: PlanScene, hit: Hit, sel: Selection, canPaste: boolean, under?: Id): MenuItem[] {
  const make = (actions: MenuAction[]) => actions.map((action) => ({ action, label: LABELS[action] }));
  if (hit.kind === 'background') {
    const own = make(canPaste ? ['newNode', 'paste'] : ['newNode']);
    // The background of an open group: that group's menu, then what the background offers (spec 9.1, I11 of the review).
    const g = under === undefined ? undefined : scene.byId.get(under);
    return g === undefined ? own : [...menuFor(s, scene, { kind: 'item', item: g, id: under! }, sel, canPaste), ...own];
  }
  if (hit.kind === 'stub') return make(['importNode']);
  if (hit.kind === 'connection') {
    if (hit.ids.length !== 1) return [];
    const sc = partOf(scene, hit.ids[0]).map((i) => scene.connections[i]).find((c) => c.part === hit.part);
    if (!sc) return [];
    if (sc.part === 'far') return make(['joinArm', 'deleteConnection']);
    const placed = sc.ends.some((e) => e.key === hit.key && !e.dashed && scene.items[e.item].kind !== 'phantom');
    const actions: MenuAction[] = placed ? ['splitArm', 'layout'] : ['layout'];
    if (sc.layout) actions.push('resetLayout');
    actions.push('deleteConnection');
    // Not yet in the lobby: it can be added there, placing itself (spec 7).
    const lobby = [...s.plans.values()].find((p) => p.type === 'lobby');
    const members = s.connections.get(sc.id)?.members ?? [];
    if (lobby && scene.plan.id !== lobby.id && !members.some((m) => s.branches.has({ plan: lobby.id, connection: sc.id, node: m.node }))) actions.push('addToLobby');
    return make(actions);
  }
  const at = scene.byId.get(hit.id);
  if (at === undefined) return [];
  const it = scene.items[at];
  if (it.kind === 'phantom') return make(it.phantom === 'absent' ? ['importNode'] : ['teleport', 'joinArm']);
  if (sel.items.has(it.id) && sel.items.size > 1) return make(['copy', 'hide', 'scaleDown', 'scaleUp', 'delete']);
  const actions: MenuAction[] = ['connect'];
  if (it.parent >= 0) actions.push('exclude');
  actions.push('scaleDown', 'scaleUp', 'rename', 'hide', 'delete');
  const lobby = [...s.plans.values()].find((p) => p.type === 'lobby');
  if (lobby && scene.plan.type !== 'lobby' && !s.placements.has(placementKey(lobby.id, it.id))) actions.push('addToLobby');
  return make(actions);
}
