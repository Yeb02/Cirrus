import type { Id, State } from '@cirrus/core';
import { plansShowing, type RenderParams } from '@cirrus/view';
import { lazy, type ReactNode, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { loading } from '../../files/read.ts';
import { LinkHover, type LinkHoverTarget, linkMenu, type LinkMenuAction } from '../../links.ts';
import { type LatexRegistry, slotOf } from '../../latex/registry.ts';
import { buildRequest } from '../../latex/request.ts';
import { knownLabels } from '../../latex/scheduler.ts';
import { useCompiled } from '../../latex/useCompiled.ts';
import { ContextMenu } from '../ContextMenu.tsx';
import type { Rect } from '../panels/geometry.ts';
import { type LinkActions, LinkActionsContext } from './linkActions.ts';

const LatexSnippet = lazy(() => loading(import('./LatexSnippet.tsx')).then((m) => ({ default: m.LatexSnippet })));

const rectOf = (el: Element): Rect => {
  const r = el.getBoundingClientRect();
  return { x: r.left, y: r.top, w: r.width, h: r.height };
};

interface LayerProps {
  state: State; params: RenderParams; registry: LatexRegistry | null;
  /** The plan shown, and the open tabs (the order of « Voir dans… »). */
  here: Id; tabs: readonly Id[];
  /** « Ouvrir le pop-up »: the left click's (App.nodeLink), beside the link. */
  onOpen(node: Id, near: Rect): void;
  /** « Voir dans ce plan », « Voir dans « P » »: a jump (App.showIn). */
  onShowIn(node: Id, plan: Id): void;
  /** « Importer ici »: the node's title follows the cursor over the graph (GraphHandle.importHere). */
  onImport(node: Id): void;
  children: ReactNode;
}

/**
 * The hover and the right click of the links to nodes in the pop-ups below it (plan 6b, D5): a link hovered
 * linkPreviewDelayMs shows its node's preview (LinkPreview), gone when the pointer leaves the link, at any press, wheel,
 * scroll or key; right-clicked, its menu (linkMenu).
 */
export function LinkLayer(props: LayerProps) {
  const [preview, setPreview] = useState<LinkHoverTarget | null>(null);
  const [menu, setMenu] = useState<{ node: Id; x: number; y: number; near: Rect } | null>(null);
  const delay = useRef(props.params.linkPreviewDelayMs);
  delay.current = props.params.linkPreviewDelayMs;
  const hover = useRef<LinkHover | null>(null);
  hover.current ??= new LinkHover(() => delay.current, setPreview);
  useEffect(() => () => hover.current?.dispose(), []);
  // A preview shown goes at any press, wheel, scroll (its pop-up's, which moves the link) or key.
  useEffect(() => {
    if (!preview) return;
    const leave = () => hover.current?.leave();
    const events = ['pointerdown', 'wheel', 'scroll', 'keydown'] as const;
    for (const e of events) window.addEventListener(e, leave, true);
    return () => { for (const e of events) window.removeEventListener(e, leave, true); };
  }, [preview]);
  const actions = useMemo<LinkActions>(() => ({
    hover: (node, el) => { if (node === null || el === null) hover.current?.leave(); else hover.current?.enter(node, rectOf(el)); },
    menu: (node, x, y, el) => setMenu({ node, x, y, near: rectOf(el) }),
  }), []);
  const pick = (m: NonNullable<typeof menu>, a: LinkMenuAction) => {
    setMenu(null);
    if (a === 'open') props.onOpen(m.node, m.near);
    else if (a === 'here') props.onShowIn(m.node, props.here);
    else if (a === 'import') props.onImport(m.node);
    else props.onShowIn(m.node, a.slice('plan:'.length));
  };
  return (
    <LinkActionsContext.Provider value={actions}>
      {props.children}
      {preview && <LinkPreview target={preview} state={props.state} params={props.params} registry={props.registry} here={props.here} />}
      {menu && (
        <div className="link-menu">
          <ContextMenu
            x={menu.x} y={menu.y} items={linkMenu(props.state, menu.node, props.here, props.tabs)}
            onPick={(a) => pick(menu, a)} onClose={() => setMenu(null)}
          />
        </div>
      )}
    </LinkActionsContext.Provider>
  );
}

/**
 * A node's preview beside the link hovered (D5): its title, its plans, its summary compiled (the main process's cache
 * answers a summary already shown at once), its source meanwhile. Under the link, or above it when the window has no
 * room below (linkPreviewBelowShare), linkPreviewGapPx from it; never taken by the pointer. Opening a node from a
 * preview is for later (spec 14).
 */
function LinkPreview(props: { target: LinkHoverTarget; state: State; params: RenderParams; registry: LatexRegistry | null; here: Id }) {
  const { target, state, params, registry } = props;
  const n = state.nodes.get(target.node);
  const summary = n?.trashedAt === undefined ? n?.summary ?? '' : '';
  const origin = useMemo(() => ({ kind: 'summary' as const, node: target.node }), [target.node]);
  const req = useMemo(() => (registry === null || summary.trim() === '' ? null
    : buildRequest({ origin, source: summary, s: state, registry, known: knownLabels(slotOf(origin)), widthCm: params.latexSnippetWidthCm })), [summary, registry, origin, state, params.latexSnippetWidthCm]);
  const view = useCompiled(req, 0);
  if (!n) return null;
  const gone = n.trashedAt !== undefined;
  const plans = gone ? [] : plansShowing(state, 'node', target.node).map((p) => (p === props.here ? 'ce plan' : state.plans.get(p)?.name ?? '?'));
  const gap = params.linkPreviewGapPx;
  const width = Math.min(params.popupWidthPx, window.innerWidth - 2 * gap);
  const left = Math.max(gap, Math.min(target.rect.x, window.innerWidth - width - gap));
  const below = target.rect.y + target.rect.h + gap;
  const place = below < window.innerHeight * params.linkPreviewBelowShare ? { top: below } : { bottom: window.innerHeight - target.rect.y + gap };
  const source = summary.trim() !== '' && <p className="link-preview-source">{summary}</p>;
  return (
    <div className="link-preview" style={{ left, width, ...place }}>
      <div className="link-preview-title">{n.title || 'Sans titre'}</div>
      <div className="link-preview-plans">{gone ? 'à la corbeille' : plans.length > 0 ? plans.join(' · ') : 'aucun plan'}</div>
      {view.pdf
        ? <Suspense fallback={source}><LatexSnippet pdf={view.pdf} params={params} onNodeLink={() => {}} fallback={source} /></Suspense>
        : source}
    </div>
  );
}
