import type { Id, Vec2 } from '@cirrus/core';
import type { Camera, Mode, PlanScene } from '@cirrus/view';

/** What a gesture without a held button will do once placed (spec 9.1). */
export type Placing =
  | { kind: 'newNode' }
  | { kind: 'exclude'; base: PlanScene; items: number[]; from: Vec2 }
  /** Drawing a connection from this node (spec 11.1). */
  | { kind: 'connect'; node: Id }
  /** Bringing in a node from a stub (spec 11.3), or into the lobby (spec 7). */
  | { kind: 'import'; node: Id; label?: string }
  /** Pasting the clip (spec 7). */
  | { kind: 'paste' }
  /** A node put down by hand in a plan its change of group reaches (spec 10); `extend`: the action it completes. */
  | { kind: 'repercussion'; node: Id; to: Id | null; extend: Id }
  /** Splitting an arm (spec 8.5): the far node's phantom near the bundle, then the centre's near the far node. */
  | { kind: 'split'; step: 1 | 2; connection: Id; node: Id; title: string; home: Camera; near?: Vec2 }
  /** A .bib's block of publications (plan 4c, D9): what it brings is the graph's `bib` (BibImport). */
  | { kind: 'bib' };
export const MODE: Record<Placing['kind'], Mode> = {
  newNode: 'place', exclude: 'exclude', connect: 'connect', import: 'place', paste: 'paste', split: 'split', repercussion: 'place', bib: 'paste',
};
/** A gesture to begin once another plan is shown (« ajouter au lobby », a repercussion's plans); `frame`: the item to frame. */
export type PendingPlace = { plan: Id; what: Placing; text: string; at: { x: number; y: number }; frame?: Id };
