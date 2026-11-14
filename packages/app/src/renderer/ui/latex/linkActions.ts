import type { Id } from '@cirrus/core';
import { createContext } from 'react';

/**
 * What a link to a node does besides its click (plan 6b, D5), given by the layer around the pop-ups (LinkLayer): its
 * hover (`node` null: left) and its right click. Without it (a full screen), a link only has its click and its title.
 */
export interface LinkActions {
  hover(node: Id | null, el: Element | null): void;
  menu(node: Id, x: number, y: number, el: Element): void;
}

export const LinkActionsContext = createContext<LinkActions | null>(null);
