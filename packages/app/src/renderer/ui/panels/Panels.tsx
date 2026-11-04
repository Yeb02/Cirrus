import type { Action, FileRef, Id, NodeRec, State } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Build } from '../../actions.ts';
import { sameName } from '../../files/merge.ts';
import { NodePopup } from '../NodePopup.tsx';
import { clampRect, placeAt, type Rect } from './geometry.ts';

/** What a floating panel shows: a node's pop-up, or a preview of one of its files (task 5). */
export type PanelTarget = { kind: 'node'; node: Id } | { kind: 'file'; node: Id; name: string };

/** `rect`: in client pixels (plan 4a, D7); `z`: its depth among the panels, the highest in front. */
export interface Panel { id: number; target: PanelTarget; rect: Rect; pinned: boolean; z: number }

/**
 * What a panel's target is now, or null when it is gone (Review Focus 5): a node absent or in the trash, a file no longer
 * in its node — deleted, removed, or its addition undone. A file is found by sameName, so a new version dropped in
 * another case keeps its preview.
 */
export function resolveTarget(s: State, t: PanelTarget): { node: NodeRec; file?: FileRef } | null {
  const node = s.nodes.get(t.node);
  if (!node || node.trashedAt !== undefined) return null;
  if (t.kind === 'node') return { node };
  const file = node.files.find((f) => sameName(f.name, t.name));
  return file ? { node, file } : null;
}

/** The depth above every panel. */
const front = (panels: Panel[]) => panels.reduce((z, p) => Math.max(z, p.z), 0) + 1;
const isNode = (p: Panel, node: Id) => p.target.kind === 'node' && p.target.node === node;

/**
 * A node's pop-up opened (plan 4a): the loose panels close, the pinned ones stay. A node whose pop-up is open already
 * gets no second one: that one comes in front, where it is; else a new loose one opens at `rect`, in front.
 */
export function withNode(panels: Panel[], node: Id, rect: Rect, id: number): Panel[] {
  const z = front(panels), own = panels.find((p) => isNode(p, node));
  const kept = panels.filter((p) => p.pinned || p === own);
  return own ? kept.map((p) => (p === own ? { ...p, z } : p)) : [...kept, { id, target: { kind: 'node', node }, rect, pinned: false, z }];
}

/** A panel clicked comes in front; already there, the same list. */
export function inFront(panels: Panel[], id: number): Panel[] {
  const p = panels.find((x) => x.id === id);
  if (!p || panels.every((x) => x === p || x.z < p.z)) return panels;
  const z = front(panels);
  return panels.map((x) => (x === p ? { ...x, z } : x));
}

/** A click outside every panel: the loose ones close. */
export function withoutLoose(panels: Panel[]): Panel[] {
  return panels.every((p) => p.pinned) ? panels : panels.filter((p) => p.pinned);
}

/** Escape: the top-most loose panel closes. */
export function withoutTopLoose(panels: Panel[]): Panel[] {
  let top: Panel | null = null;
  for (const p of panels) if (!p.pinned && (!top || p.z > top.z)) top = p;
  return top ? panels.filter((p) => p !== top) : panels;
}

/** What App asks of the panels; task 5 adds openFile(node, name, near). */
export interface PanelsHandle {
  /** A click on a node (GraphView), at this point of the window. */
  openNode(node: Id, client: { x: number; y: number }): void;
  /** A click on the graph's background. */
  closeLoose(): void;
}

/**
 * The floating panels of the window (plan 4a, D7), over every tab: pinned, they stay from one tab to the next; loose,
 * a click outside every panel or Escape closes them. A click on a panel brings it in front. Edits go through `onEdit`
 * (the session); a plan named in a pop-up opens in its tab.
 */
export function Panels(props: {
  ref?: Ref<PanelsHandle>;
  /** The state, changed in place: `rev` counts the actions, `action` is the last one (App's Shown). */
  state: State; rev: number; action: Action | null; params: RenderParams;
  onEdit(build: Build): void; onOpenPlan(plan: Id): void;
}) {
  const [panels, setPanels] = useState<Panel[]>([]);
  const layer = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const paramsRef = useRef(props.params);
  paramsRef.current = props.params;
  /** Where panels may be: the window under the tabs (the layer covers it). */
  const bounds = (): Rect => {
    const r = layer.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  };
  useImperativeHandle(props.ref, () => ({
    openNode: (node, client) => {
      const p = paramsRef.current, id = nextId.current++;
      const rect = placeAt(client, { w: p.popupWidthPx, h: p.popupHeightPx }, bounds(), p.panelGapPx);
      setPanels((ps) => withNode(ps, node, rect, id));
    },
    closeLoose: () => setPanels(withoutLoose),
  }), []);
  useEffect(() => {
    // Escape that nothing took (a gesture of the graph, a menu, a field of a panel prevent its default) closes the top-most loose panel.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented) setPanels(withoutTopLoose); };
    // A press outside the panels closes the loose ones, outside the graph: there, a press may begin a drag, and the graph
    // reports its clicks itself (openNode, closeLoose).
    const away = (e: PointerEvent) => { if (!(e.target as Element | null)?.closest?.('.panel, .graph')) setPanels(withoutLoose); };
    // A smaller window: each panel kept usable in it.
    const resize = () => {
      const b = bounds(), min = paramsRef.current.panelMinPx;
      setPanels((ps) => ps.map((p) => {
        const r = clampRect(p.rect, b, min);
        return r.x === p.rect.x && r.y === p.rect.y && r.w === p.rect.w && r.h === p.rect.h ? p : { ...p, rect: r };
      }));
    };
    window.addEventListener('keydown', key);
    window.addEventListener('pointerdown', away, true);
    window.addEventListener('resize', resize);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener('pointerdown', away, true);
      window.removeEventListener('resize', resize);
    };
  }, []);

  const change = (id: number, f: (p: Panel) => Panel) => setPanels((ps) => ps.map((p) => (p.id === id ? f(p) : p)));
  return (
    <div className="panels" ref={layer}>
      {panels.map((p) => {
        const frame = {
          rect: p.rect, z: p.z, pinned: p.pinned, min: props.params.panelMinPx, bounds,
          onRect: (rect: Rect) => change(p.id, (x) => ({ ...x, rect })),
          onFront: () => setPanels((ps) => inFront(ps, p.id)),
          onPin: () => change(p.id, (x) => ({ ...x, pinned: !x.pinned })),
          onClose: () => setPanels((ps) => ps.filter((x) => x.id !== p.id)),
        };
        if (p.target.kind !== 'node') return null;
        return (
          <NodePopup
            key={p.id} frame={frame} id={p.target.node} found={resolveTarget(props.state, p.target)?.node ?? null}
            state={props.state} rev={props.rev} action={props.action} params={props.params} onEdit={props.onEdit} onOpenPlan={props.onOpenPlan}
          />
        );
      })}
    </div>
  );
}
