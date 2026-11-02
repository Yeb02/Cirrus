/// <reference types="vite/client" />

/** What the preload exposes (src/preload/index.ts). */
export interface CirrusBridge {
  /** The state as JSON text (a Snapshot). */
  snapshot(): Promise<string>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(overrides: Record<string, unknown>): Promise<void>;
  /** Writes an edit to the local base; rejects with the reason. */
  commit(action: unknown): Promise<void>;
  /** The bench (CIRRUS_BENCH) is over: the main process records the run and quits. */
  benchDone(run: unknown): Promise<void>;
  /** The first frame is drawn (captures wait for it). */
  ready(): void;
  /** Launch options for visual checks: plan name, view "x,y,zoom", simulated hover "x,y", settings panel open. */
  launch: { plan?: string; view?: string; hover?: string; panel?: boolean; bench?: string; hide?: string; keys?: string; pointer?: string };
}

declare global {
  interface Window {
    cirrus: CirrusBridge;
  }
}
