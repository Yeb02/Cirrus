import { type Id, phantomsOf } from '@cirrus/core';
import { type Hit, type MenuAction, PART_FAR, partEnds, partOf, worldToScreen } from '@cirrus/view';
import { joinBuild, layoutBuild, lobbyConnectionBuild, renameBuild, scaleBuild } from '../../actions.ts';
import { elsewhere } from '../../navigation.ts';
import { BIB_WAITING } from './bibImport.ts';
import type { Graph } from './core.ts';
import { OBJECT_GONE } from './jumps.ts';

/**
 * A menu choice (spec 9.1): on the element clicked, or on the whole selection when it belongs to it. The focus comes
 * back to the graph, as after the title editor or a question: the item pressed had it, and went with the menu. The
 * next Escape is then the graph's, and cancels the gesture the choice started instead of closing a loose pop-up (I1
 * of the final review); a title editor or a question opened by the choice takes it next.
 */
export function pickMenuAction(graph: Graph, action: MenuAction, hit: Hit, at: { x: number; y: number }): void {
  const {
    root, engine, sceneRef, paramsRef, stateRef, selectionRef, setSelection, setEditor, gestures, onOpenPlan, onTagRegistry, redraw, notify, edit, tabsRef,
  } = graph;
  const { placement, copyPaste, questions, bib, publication, jumps } = graph;
  root.current?.focus({ preventScroll: true });
  const e = engine.current, sc = sceneRef.current;
  if (!e || !sc) return;
  // A menu left open while a .bib put down waits for its .bib: nothing it offers begins (review of task 6, M4).
  if (bib.bibWaiting()) { notify(BIB_WAITING); return; }
  const p = paramsRef.current, sel = selectionRef.current;
  // The menu may have stayed open across a rebuild: what it was opened on is found again by id (I9 of the review).
  const clicked = hit.kind === 'item' ? sc.byId.get(hit.id) ?? -1 : -1;
  const line = hit.kind === 'connection' && hit.ids.length === 1 ? hit.ids[0] : null;
  const clickedId = clicked >= 0 ? sc.items[clicked].id : null;
  const targets = clickedId && sel.items.has(clickedId)
    ? [...sel.items].flatMap((id) => { const i = sc.byId.get(id); return i === undefined ? [] : [i]; })
    : clicked >= 0 ? [clicked] : [];
  switch (action) {
    case 'newNode':
      placement.placing.current = { kind: 'newNode' };
      placement.setGhost({ x: at.x, y: at.y, text: 'Nouveau nœud' });
      gestures.current.start('place');
      break;
    case 'importPublication':
      publication.openPublication(sc.plan.id, e.renderer.camera, at);
      break;
    case 'importBib':
      bib.chooseBib(sc.plan.id, at);
      break;
    case 'tagRegistry':
      onTagRegistry();
      break;
    case 'rename': {
      if (clicked < 0) break;
      const it = sc.items[clicked], sp = worldToScreen(e.renderer.camera, it.x, it.y);
      setEditor({ x: sp.x, y: sp.y, width: Math.max(140, 2 * it.halfW * e.renderer.camera.zoom), initial: it.title, done: (title) => { if (title !== null && title.trim() !== it.title) edit(renameBuild(it.id, title)); } });
      break;
    }
    case 'exclude':
      if (clicked < 0) break;
      placement.placing.current = { kind: 'exclude', base: sc, items: [clicked], from: { x: sc.items[clicked].x, y: sc.items[clicked].y } };
      placement.setGhost({ x: at.x, y: at.y, text: sc.items[clicked].title });
      gestures.current.start('exclude');
      break;
    case 'scaleDown':
    case 'scaleUp':
      edit(scaleBuild(sc, targets, action === 'scaleUp' ? 1 : -1, p));
      break;
    case 'hide':
      questions.askHide(sc, targets);
      break;
    case 'delete':
      questions.askDelete(sc, targets);
      break;
    case 'copy':
      copyPaste.copy(sc, targets);
      break;
    case 'paste':
      copyPaste.startPaste(at);
      break;
    case 'layout':
    case 'resetLayout': {
      // Selected, a connection shows its handles; « rétablir » forgets this plan's layout (spec 8.5).
      if (line === null) break;
      const id = line;
      if (action === 'resetLayout') edit(layoutBuild(sc.plan.id, id, null));
      else {
        setSelection({ items: new Set(), connections: new Set([id]) });
        notify('Tirez le marqueur, la poignée de rotation ou les poignées des branches.');
      }
      break;
    }
    case 'deleteConnection': {
      if (line !== null) questions.askDeleteConnection(sc.plan.id, line);
      break;
    }
    case 'addToLobby': {
      // A connection places itself; a node follows the cursor in the lobby until a click (spec 7).
      const lobby = [...stateRef.current.plans.values()].find((x) => x.type === 'lobby');
      if (!lobby) break;
      if (hit.kind === 'connection') {
        if (line !== null) edit(lobbyConnectionBuild(lobby.id, line));
        break;
      }
      if (clicked < 0) break;
      const it = sc.items[clicked];
      placement.pendingPlace.current = { plan: lobby.id, what: { kind: 'import', node: it.node, label: 'Ajouter au lobby' }, text: it.title, at };
      onOpenPlan(lobby.id);
      break;
    }
    case 'connect':
      // A straight line follows the cursor from the node; 1-to-1 connections show their centre, a target too (spec 11.1).
      if (clicked < 0) break;
      e.renderer.setCoresShown(true);
      placement.startPlacing({ kind: 'connect', node: sc.items[clicked].node }, null, at);
      placement.aimLine(at.x, at.y);
      break;
    case 'splitArm': {
      const far = hit.kind === 'connection' && hit.key !== null ? sc.byId.get(hit.key) : undefined;
      if (line === null || far === undefined) break;
      const it = sc.items[far];
      placement.startPlacing({ kind: 'split', step: 1, connection: line, node: it.id, title: it.title, home: e.renderer.camera }, `fantôme : ${it.title}`, at);
      break;
    }
    case 'joinArm': {
      if (clicked >= 0 && sc.items[clicked].kind === 'phantom') {
        const it = sc.items[clicked];
        edit(joinBuild(sc.plan.id, it.connection!, it.node));
      } else if (hit.kind === 'connection' && line !== null) {
        const far = partOf(sc, line).find((i) => sc.part[i] === PART_FAR);
        if (far !== undefined) edit(joinBuild(sc.plan.id, line, partEnds(sc, far)[0].key));
      }
      break;
    }
    case 'teleport': {
      // To the original (spec 8.5): the far node; for the centre, the far node's phantom by the bundle. A jump for
      // « précédent » et « suivant » (plan 6a, D2): the place left is pushed. The view is centred on the original, at the
      // zoom it has, not framed as the other jumps frame (the spec says « amène la vue sur l’original »; the centre's
      // destination is a phantom, which the revealer cannot frame).
      if (clicked < 0) break;
      const it = sc.items[clicked];
      // The centre's: the far node's phantom of the same arm, among its connection's phantoms.
      const twin = phantomsOf(stateRef.current, it.connection!).find((id) => {
        const ph = stateRef.current.phantoms.get(id);
        return ph?.plan === sc.plan.id && ph.of.kind === 'node' && ph.of.node === it.node;
      });
      const dest = it.phantom === 'node' ? sc.byId.get(it.node) ?? -1 : twin === undefined ? -1 : sc.byId.get(twin) ?? -1;
      if (dest < 0) { notify('L’original n’est pas dans ce plan.'); break; }
      jumps.moveTo({ ...e.renderer.camera, x: sc.items[dest].x, y: sc.items[dest].y });
      break;
    }
    case 'seeElsewhere': {
      // The plans it is shown in other than this one (plan 6a, D3): one, a jump there; several, a question lists them.
      const target = line !== null ? { kind: 'connection' as const, id: line } : clickedId !== null ? { kind: 'node' as const, id: clickedId } : null;
      if (!target) break;
      const plans = elsewhere(stateRef.current, target.kind, target.id, sc.plan.id, tabsRef.current);
      const go = (plan: Id) => { if (!jumps.reveal({ plan, id: target.id, kind: target.kind })) notify(OBJECT_GONE); };
      if (plans.length === 0) notify('Cet objet n’est dans aucun autre plan.');
      else if (plans.length === 1) go(plans[0]);
      else questions.askPlan('Dans quel plan le voir ?', plans, go);
      break;
    }
    case 'importNode': {
      const st = hit.kind === 'stub' ? hit : undefined;
      const node = st ? st.node : clicked >= 0 ? sc.items[clicked].node : null;
      if (node) placement.startPlacing({ kind: 'import', node }, st ? st.title : sc.items[clicked].title, at);
      break;
    }
    default:
      break;
  }
  redraw();
}
