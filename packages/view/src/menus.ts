import { placementKey, type State } from '@cirrus/core';
import type { Hit } from './hit.ts';
import type { PlanScene } from './scene.ts';
import type { Selection } from './selection.ts';

export type MenuAction =
  | 'connect' | 'exclude' | 'scaleDown' | 'scaleUp' | 'rename' | 'hide' | 'delete' | 'addToLobby'
  | 'copy' | 'paste' | 'newNode' | 'teleport' | 'joinArm' | 'importNode' | 'splitArm' | 'layout' | 'deleteConnection';

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
  deleteConnection: 'Supprimer la connexion…',
};

/**
 * The context menu of what is under the cursor (spec 9.1, 8.5, 11.3): a right click on an element of a selection of
 * several opens the selection menu (copy, hide, − and +); a phantom offers to teleport to its original and to join
 * the arm back; a stub, to import its node; the background, to create a node or paste.
 */
export function menuFor(s: State, scene: PlanScene, hit: Hit, sel: Selection, canPaste: boolean): MenuItem[] {
  const make = (actions: MenuAction[]) => actions.map((action) => ({ action, label: LABELS[action] }));
  if (hit.kind === 'background') return make(canPaste ? ['newNode', 'paste'] : ['newNode']);
  if (hit.kind === 'stub') return make(['importNode']);
  if (hit.kind === 'connection') return make(['splitArm', 'layout', 'deleteConnection']);
  const it = scene.items[hit.item];
  if (it.kind === 'phantom') return make(it.phantom === 'absent' ? ['importNode'] : ['teleport', 'joinArm']);
  if (sel.items.has(it.id) && sel.items.size > 1) return make(['copy', 'hide', 'scaleDown', 'scaleUp', 'delete']);
  const actions: MenuAction[] = ['connect'];
  if (it.parent >= 0) actions.push('exclude');
  actions.push('scaleDown', 'scaleUp', 'rename', 'hide', 'delete');
  const lobby = [...s.plans.values()].find((p) => p.type === 'lobby');
  if (lobby && scene.plan.type !== 'lobby' && !s.placements.has(placementKey(lobby.id, it.id))) actions.push('addToLobby');
  return make(actions);
}
