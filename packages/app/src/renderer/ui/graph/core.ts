import type { Id, State } from '@cirrus/core';
import type { Camera, FontData, GestureMachine, Hit, Input, PlanScene, RenderParams, SceneIndex, Selection, VisibleSet } from '@cirrus/view';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { Build } from '../../actions.ts';
import type { Gl } from '../../gl/context.ts';
import type { PlanRenderer } from '../../render/PlanRenderer.ts';
import type { EditSession, Result } from '../../session.ts';
import type { BibPart } from './bibImport.ts';
import type { CopyPastePart } from './copyPaste.ts';
import type { HandlesPart } from './layoutHandles.ts';
import type { PlacementPart } from './placement.ts';
import type { PublicationPart } from './publication.ts';
import type { QuestionsPart } from './questions.ts';
import type { RepercussionPart } from './repercussion.ts';
import type { ScenesPart } from './scenes.ts';

/** What draws the graph: one WebGL context for the window's lifetime, its renderer, and the font its boxes are measured with. */
export interface Engine { gl: Gl; renderer: PlanRenderer; font: FontData }
/** The title editor over the graph (spec 12), at a screen point: `done` gets the title typed, null if given up. */
export interface Editor { x: number; y: number; width: number; initial: string; done(title: string | null): void }

/** The visible set of a renderer that has drawn nothing yet: a preview's split made for it is built whole. */
export const NOTHING_SHOWN: VisibleSet = { items: [], groups: [], connections: [], signature: '' };
export const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/**
 * The graph view as its parts see it (ui/graph): GraphView makes it at each render, with that render's functions. The
 * refs hold what the handlers registered once read fresh (the scene shown, the parameters…). The parts are read once a
 * handler runs, never during a render: each is made by its hook in GraphView, after this.
 */
export interface Graph {
  /** The graph's element: the focus, the pointer capture, and the origin of screen coordinates. */
  root: RefObject<HTMLDivElement | null>;
  engine: RefObject<Engine | null>;
  /** The scene the renderer shows: the current plan's. */
  sceneRef: RefObject<PlanScene | null>;
  paramsRef: RefObject<RenderParams>;
  stateRef: RefObject<State>;
  sessionRef: RefObject<EditSession | null>;
  onResultRef: RefObject<(r: Result) => void>;
  onLongNoticeRef: RefObject<(text: string) => void>;
  selectionRef: RefObject<Selection>;
  setSelection: Dispatch<SetStateAction<Selection>>;
  setEditor: Dispatch<SetStateAction<Editor | null>>;
  gestures: RefObject<GestureMachine>;
  /** Whether items are being dragged (spec 9.1): GraphView's drag, previewed by its drawing loop. */
  dragging(): boolean;
  /** Shows a plan in its tab: GraphView's onOpenPlan, as of this render. */
  onOpenPlan(plan: Id): void;
  redraw(): void;
  notify(message: string): void;
  edit(build: Build, onRefused?: () => void, extend?: Id): Promise<Result | null>;
  indexOf(scene: PlanScene): SceneIndex | undefined;
  hitAt(sx: number, sy: number): Hit;
  /** The point of a pointer or drag event on the graph, in screen coordinates. */
  local(ev: { clientX: number; clientY: number }): { sx: number; sy: number };
  restoreScene(): void;
  moveCamera(next: Camera): void;
  feed(input: Input): void;
  /** A gesture, a question, a repercussion or a .bib's import under way (GraphView's busy), and why `what` waits for it. */
  busy(): boolean;
  busyReason(what: string): string;
  scenes: ScenesPart;
  questions: QuestionsPart;
  placement: PlacementPart;
  copyPaste: CopyPastePart;
  bib: BibPart;
  publication: PublicationPart;
  repercussion: RepercussionPart;
  handles: HandlesPart;
}
