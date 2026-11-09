import type { Id } from '@cirrus/core';
import type { FontData, GestureMachine, Hit, Input, PlanScene, RenderParams, Selection, VisibleSet } from '@cirrus/view';
import type { RefObject } from 'react';
import type { Build } from '../../actions.ts';
import type { Gl } from '../../gl/context.ts';
import type { PlanRenderer } from '../../render/PlanRenderer.ts';
import type { Result } from '../../session.ts';
import type { HandlesPart } from './layoutHandles.ts';
import type { ScenesPart } from './scenes.ts';

/** What draws the graph: one WebGL context for the window's lifetime, its renderer, and the font its boxes are measured with. */
export interface Engine { gl: Gl; renderer: PlanRenderer; font: FontData }

/** The visible set of a renderer that has drawn nothing yet: a preview's split made for it is built whole. */
export const NOTHING_SHOWN: VisibleSet = { items: [], groups: [], connections: [], signature: '' };

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
  selectionRef: RefObject<Selection>;
  gestures: RefObject<GestureMachine>;
  redraw(): void;
  edit(build: Build, onRefused?: () => void, extend?: Id): Promise<Result | null>;
  hitAt(sx: number, sy: number): Hit;
  restoreScene(): void;
  feed(input: Input): void;
  scenes: ScenesPart;
  handles: HandlesPart;
}
