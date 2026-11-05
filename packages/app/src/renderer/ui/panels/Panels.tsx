import type { Action, FileRef, Id, NodeRec, State } from '@cirrus/core';
import type { RenderParams, SceneItem } from '@cirrus/view';
import { type Ref, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { Build } from '../../actions.ts';
import { sameName } from '../../files/merge.ts';
import type { NodeFiles } from '../../files/nodeFiles.ts';
import type { ViewStates } from '../../files/viewState.ts';
import type { LatexRegistry } from '../../latex/registry.ts';
import { NodePopup } from '../NodePopup.tsx';
import { PanelBoundary } from '../PanelBoundary.tsx';
import { FilePreview } from './FilePreview.tsx';
import { FloatingPanel } from './FloatingPanel.tsx';
import { clampRect, placeAt, placeBeside, type Rect } from './geometry.ts';

/** What a floating panel shows: a node's pop-up, or a preview of one of its files (task 5), the file by its name. */
export type PanelTarget = { kind: 'node'; node: Id } | { kind: 'file'; node: Id; name: string };

/** `rect`: in client pixels (plan 4a, D7); `z`: its depth among the panels, the highest in front. */
export interface Panel { id: number; target: PanelTarget; rect: Rect; pinned: boolean; z: number }

/**
 * What a panel's target is now, or null when it is gone (Review Focus 5): a node absent or in the trash, a file no longer
 * in its node — deleted, removed, renamed, or its addition undone. A file is found by its name only (sameName: a new
 * version dropped in another case keeps its preview), never by its content: a file removed while the node holds a
 * twin of the same content is gone, its full screen closes (ruling I1 of the task 5 review).
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

/**
 * A node's pop-up opened by a link (plan 4b, task 6: a \ref or a \cite compiled, clicked in a summary, a relation or a
 * PDF): loose, in front, at `rect`; no panel closes — the one the link was clicked in is being read. A node whose
 * pop-up is open already, pinned or not, gets no second one: that one comes in front, where it is.
 */
export function withLinked(panels: Panel[], node: Id, rect: Rect, id: number): Panel[] {
  const z = front(panels), own = panels.find((p) => isNode(p, node));
  return own ? panels.map((p) => (p === own ? { ...p, z } : p)) : [...panels, { id, target: { kind: 'node', node }, rect, pinned: false, z }];
}

const isFile = (p: Panel, node: Id, name: string) => p.target.kind === 'file' && p.target.node === node && sameName(p.target.name, name);

/**
 * A file's preview opened (plan 4a, task 5): the other loose previews close — clicking file after file shows one at a
 * time —, the pop-ups and the pinned ones stay. A file already previewed gets no second one: that one comes in front,
 * where it is; else a new loose one opens at `rect`, in front.
 */
export function withFile(panels: Panel[], node: Id, name: string, rect: Rect, id: number): Panel[] {
  const z = front(panels), own = panels.find((p) => isFile(p, node, name));
  const kept = panels.filter((p) => p === own || p.pinned || p.target.kind !== 'file');
  if (own) return kept.map((p) => (p === own ? { ...p, z } : p));
  return [...kept, { id, target: { kind: 'file', node, name }, rect, pinned: false, z }];
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

/** The panels a rule closes: those of `before` that `after` no longer has. */
export function closedIds(before: Panel[], after: Panel[]): number[] {
  const kept = new Set(after.map((p) => p.id));
  return before.filter((p) => !kept.has(p.id)).map((p) => p.id);
}

/**
 * The node whose pop-up a click in the graph opens (spec 8.5, 9.1): a node or a group clicked without Ctrl, or the far
 * node a phantom of a split arm stands for, as the original would. An absent phantom (it brings its node in), a centre
 * phantom (its connection's pop-up), a Ctrl+click, and whatever is no item (background, connection, stub) open none:
 * those clicks close the loose panels instead.
 */
export function nodeOpenedBy(item: Pick<SceneItem, 'kind' | 'id' | 'node' | 'phantom'> | undefined, ctrl: boolean): Id | null {
  if (ctrl || !item) return null;
  if (item.kind !== 'phantom') return item.id;
  return item.phantom === 'node' ? item.node : null;
}

/** Where a node's pop-up opens (placeAt): at its settings' size, never under panelMinPx, kept usable in `bounds`. */
export function openingRect(
  at: { x: number; y: number }, p: Pick<RenderParams, 'popupWidthPx' | 'popupHeightPx' | 'panelMinPx' | 'panelGapPx'>, bounds: Rect,
): Rect {
  const size = { w: Math.max(p.panelMinPx, p.popupWidthPx), h: Math.max(p.panelMinPx, p.popupHeightPx) };
  return clampRect(placeAt(at, size, bounds, p.panelGapPx), bounds, p.panelMinPx);
}

/** Where a file's preview opens (placeBeside): beside the panel `near`, at its settings' size, never under panelMinPx. */
export function previewRect(
  near: Rect, p: Pick<RenderParams, 'previewWidthPx' | 'previewHeightPx' | 'panelMinPx' | 'panelGapPx'>, bounds: Rect,
): Rect {
  const size = { w: Math.max(p.panelMinPx, p.previewWidthPx), h: Math.max(p.panelMinPx, p.previewHeightPx) };
  return clampRect(placeBeside(near, size, bounds, p.panelGapPx), bounds, p.panelMinPx);
}

/** Where a linked node's pop-up opens (withLinked): beside the panel `near` the link was clicked in, at a pop-up's size. */
export function linkedRect(
  near: Rect, p: Pick<RenderParams, 'popupWidthPx' | 'popupHeightPx' | 'panelMinPx' | 'panelGapPx'>, bounds: Rect,
): Rect {
  const size = { w: Math.max(p.panelMinPx, p.popupWidthPx), h: Math.max(p.panelMinPx, p.popupHeightPx) };
  return clampRect(placeBeside(near, size, bounds, p.panelGapPx), bounds, p.panelMinPx);
}

/** What App asks of the panels. */
export interface PanelsHandle {
  /** A click on a node (GraphView), at this point of the window. */
  openNode(node: Id, client: { x: number; y: number }): void;
  /** A file's preview, beside the panel `near` (its node's pop-up). */
  openFile(node: Id, name: string, near: Rect): void;
  /** A node's pop-up a link leads to, beside the panel `near` it was clicked in (withLinked). */
  openLinked(node: Id, near: Rect): void;
  /** Any other click in the graph. */
  closeLoose(): void;
}

const NODE_GONE = 'Ce nœud n’existe plus.', FILE_GONE = 'Ce fichier n’est plus dans le nœud.';
/** What a panel that failed says, in its body (PanelBoundary); its cause is in the console. */
const POPUP_FAILED = 'Ce pop-up n’a pas pu s’afficher.', PREVIEW_FAILED = 'Cet aperçu n’a pas pu s’afficher.';

/**
 * The floating panels of the window (plan 4a, D7), over every tab: pinned, they stay from one tab to the next; loose,
 * a click outside every panel or Escape closes them. A click on a panel brings it in front. Edits go through `onEdit`
 * (the session), which resolves with whether they were written; a plan named in a pop-up opens in its tab; a node's
 * files are imported and opened by `files` (App). A file clicked in a pop-up opens its preview beside it, or its full
 * screen (`onFullScreen`, App's). While a file is in full screen (`fullHash`, its content), the panels are under it:
 * Escape and a press there are its own, and a preview of that file leaves its view to it. Each panel has its own
 * PanelBoundary: one that fails says so in its frame, which still moves and closes; the others and the window stay.
 * The previews of .tex are compiled with the state and `registry` (plan 4b, App's: null until built), and so are the
 * pop-ups' summaries; a link to a node clicked in a panel goes to `onNodeLink`, with that panel's place (App's: it
 * opens the node's pop-up beside it, openLinked).
 */
export function Panels(props: {
  ref?: Ref<PanelsHandle>;
  /** The state, changed in place: `rev` counts the actions, `action` is the last one (App's Shown). */
  state: State; rev: number; action: Action | null; params: RenderParams;
  onEdit(build: Build): Promise<boolean>; onOpenPlan(plan: Id): void; files: NodeFiles;
  views: ViewStates; fullHash: string | null; onFullScreen(node: Id, name: string): void; registry: LatexRegistry | null;
  onNodeLink(node: Id, near: Rect): void;
}) {
  const [panels, setPanels] = useState<Panel[]>([]);
  const panelsRef = useRef(panels);
  panelsRef.current = panels;
  const layer = useRef<HTMLDivElement>(null);
  const nextId = useRef(1);
  const paramsRef = useRef(props.params);
  paramsRef.current = props.params;
  const covered = useRef(false);
  covered.current = props.fullHash !== null;
  /** Where panels may be: the window under the tabs (the layer covers it). */
  const bounds = (): Rect => {
    const r = layer.current?.getBoundingClientRect();
    return r ? { x: r.left, y: r.top, w: r.width, h: r.height } : { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  };
  /**
   * Every change that may close panels goes through here. A field being typed in a panel the rule closes is left first,
   * so that its blur saves what it holds: removed while focused, it would never blur (React does not dispatch events
   * during a commit, and a press's own focus change comes after its listeners: I1 of the review).
   */
  const apply = (rule: (ps: Panel[]) => Panel[]) => {
    const closing = closedIds(panelsRef.current, rule(panelsRef.current));
    const focused = document.activeElement as HTMLElement | null;
    const host = focused?.closest?.<HTMLElement>('.panel[data-panel]');
    if (focused && host && closing.includes(Number(host.dataset.panel))) focused.blur();
    setPanels(rule);
  };
  const openFile = (node: Id, name: string, near: Rect) => {
    const id = nextId.current++, rect = previewRect(near, paramsRef.current, bounds());
    apply((ps) => withFile(ps, node, name, rect, id));
  };
  useImperativeHandle(props.ref, () => ({
    openNode: (node, client) => {
      const id = nextId.current++, rect = openingRect(client, paramsRef.current, bounds());
      apply((ps) => withNode(ps, node, rect, id));
    },
    openFile,
    openLinked: (node, near) => {
      const id = nextId.current++, rect = linkedRect(near, paramsRef.current, bounds());
      apply((ps) => withLinked(ps, node, rect, id));
    },
    closeLoose: () => apply(withoutLoose),
  }), []);
  useEffect(() => {
    // Escape that nothing took (a gesture of the graph, a menu, a field of a panel prevent its default) closes the top-most
    // loose panel; not under a full screen, whose Escape it is.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !e.defaultPrevented && !covered.current) apply(withoutTopLoose); };
    // A press outside the panels closes the loose ones, outside the graph: there, a press may begin a drag, and the graph
    // reports its clicks itself (openNode, closeLoose). A press in a full screen is its own.
    const away = (e: PointerEvent) => { if (!covered.current && !(e.target as Element | null)?.closest?.('.panel, .graph')) apply(withoutLoose); };
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
          id: p.id, rect: p.rect, z: p.z, pinned: p.pinned, min: props.params.panelMinPx, bounds,
          onRect: (rect: Rect) => change(p.id, (x) => ({ ...x, rect })),
          onFront: () => setPanels((ps) => inFront(ps, p.id)),
          onPin: () => change(p.id, (x) => ({ ...x, pinned: !x.pinned })),
          onClose: () => apply((ps) => ps.filter((x) => x.id !== p.id)),
        };
        const node = p.target.node;
        /** The panel in place of one that failed (PanelBoundary): its frame, its title, and why. */
        const failed = (className: string, title: string, text: string) => (
          <FloatingPanel frame={frame} className={className} title={<span className="title gone" title={title}>{title}</span>}>
            <p className="dim gone">{text}</p>
          </FloatingPanel>
        );
        if (p.target.kind === 'file') {
          const file = resolveTarget(props.state, p.target)?.file ?? null, name = p.target.name;
          return (
            <PanelBoundary key={p.id} what={`Aperçu de « ${name} »`} fallback={failed('file-preview', name, PREVIEW_FAILED)}>
              <FilePreview
                frame={frame} node={node} found={file} gone={resolveTarget(props.state, { kind: 'node', node }) ? FILE_GONE : NODE_GONE}
                covered={file !== null && file.hash === props.fullHash} params={props.params} views={props.views}
                latex={{ state: props.state, registry: props.registry }}
                onFull={() => { if (file) props.onFullScreen(node, file.name); }} onNodeLink={(id) => props.onNodeLink(id, p.rect)}
              />
            </PanelBoundary>
          );
        }
        const title = props.state.nodes.get(node)?.title ?? '';
        return (
          <PanelBoundary key={p.id} what={`Pop-up de « ${title} »`} fallback={failed('node-popup', title, POPUP_FAILED)}>
            <NodePopup
              frame={frame} id={node} found={resolveTarget(props.state, p.target)?.node ?? null}
              state={props.state} rev={props.rev} action={props.action} params={props.params} onEdit={props.onEdit} onOpenPlan={props.onOpenPlan}
              files={props.files} registry={props.registry} onNodeLink={(id) => props.onNodeLink(id, p.rect)}
              onOpenFile={(name, how) => (how === 'full' ? props.onFullScreen(node, name) : openFile(node, name, p.rect))}
            />
          </PanelBoundary>
        );
      })}
    </div>
  );
}
