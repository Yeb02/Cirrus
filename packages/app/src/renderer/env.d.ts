/// <reference types="vite/client" />
import type { Snapshot } from '@cirrus/core';

/** What the preload exposes (src/preload/index.ts). */
export interface CirrusBridge {
  snapshot(): Promise<Snapshot>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(overrides: Record<string, unknown>): Promise<void>;
  /** The first frame is drawn (captures wait for it). */
  ready(): void;
  /** Launch options for visual checks: plan name, view "x,y,zoom", simulated hover "x,y", settings panel open. */
  launch: { plan?: string; view?: string; hover?: string; panel?: boolean };
}

declare global {
  interface Window {
    cirrus: CirrusBridge;
  }
}
