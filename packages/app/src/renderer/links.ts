import type { Id, State } from '@cirrus/core';
import { plansShowing } from '@cirrus/view';
import { elsewhere } from './navigation.ts';
import type { Rect } from './ui/panels/geometry.ts';

// A link to a node in a compiled summary, relation or PDF (`\ref`, `\cite`), beyond its click (plan 6b, D5, spec 14):
// hovered, a preview of its node after linkPreviewDelayMs; right-clicked, a menu — open its pop-up, see it in one of its
// plans, or import it into the plan shown.

/** An entry of a link's menu: open its pop-up, see it in this plan, in another (`plan:<id>`), or import it here. */
export type LinkMenuAction = 'open' | 'here' | 'import' | `plan:${string}`;

/**
 * The menu of a link to `node`, the plan `here` shown: « Ouvrir le pop-up » always (the left click's, which says it when
 * the node is gone); a live node, « Voir dans ce plan » if it is here, « Voir dans « P » » for each of its other plans in
 * the order of « Voir dans un autre plan » (`elsewhere`), and « Importer ici » if it is not here.
 */
export function linkMenu(s: State, node: Id, here: Id, tabs: readonly Id[]): { action: LinkMenuAction; label: string }[] {
  const out: { action: LinkMenuAction; label: string }[] = [{ action: 'open', label: 'Ouvrir le pop-up' }];
  const n = s.nodes.get(node);
  if (!n || n.trashedAt !== undefined) return out;
  const isHere = plansShowing(s, 'node', node).includes(here);
  if (isHere) out.push({ action: 'here', label: 'Voir dans ce plan' });
  for (const p of elsewhere(s, 'node', node, here, tabs)) out.push({ action: `plan:${p}`, label: `Voir dans « ${s.plans.get(p)?.name ?? '?'} »` });
  if (!isHere && s.plans.has(here)) out.push({ action: 'import', label: 'Importer ici' });
  return out;
}

/** The link a preview is shown for: its node, and where the link is on the screen. */
export interface LinkHoverTarget { node: Id; rect: Rect }

/**
 * The hover of links (D5): a link entered shows its node's preview after `delay()` ms (linkPreviewDelayMs, read at each
 * entry), unless the pointer leaves it first; leaving it, or entering another, hides what was shown. `dispose` stops a
 * wait and hides: nothing ever shows after it.
 */
export class LinkHover {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private shown = false;

  private readonly delay: () => number;
  private readonly show: (t: LinkHoverTarget | null) => void;

  constructor(delay: () => number, show: (t: LinkHoverTarget | null) => void) {
    this.delay = delay;
    this.show = show;
  }

  enter(node: Id, rect: Rect): void {
    this.leave();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.shown = true;
      this.show({ node, rect });
    }, Math.max(0, this.delay()));
  }

  leave(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    if (!this.shown) return;
    this.shown = false;
    this.show(null);
  }

  dispose(): void {
    this.leave();
  }
}
