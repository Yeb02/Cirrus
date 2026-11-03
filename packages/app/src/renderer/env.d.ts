/// <reference types="vite/client" />

/** What the preload exposes (src/preload/index.ts). */
export interface CirrusBridge {
  /**
   * The state to open: the base's snapshot (encodeState), the journal's operations after it (JSON) and the journal
   * number they reach; `fromTables`, the state of the base's tables instead (the snapshot sent first was unusable).
   */
  load(fromTables: boolean): Promise<{ data: ArrayBuffer; tail: string; seq: number }>;
  /** Keeps a snapshot of the state covering the journal up to `seq`, if later than the base's. */
  saveSnapshot(data: ArrayBuffer, seq: number): Promise<void>;
  getSettings(): Promise<Record<string, unknown>>;
  setSettings(overrides: Record<string, unknown>): Promise<void>;
  /** Writes an edit to the local base; resolves with the journal number of its last line, rejects with the reason. */
  commit(action: unknown): Promise<number>;
  /** The window is closing: `fn` saves what it must, then calls quitReady. Returns the unsubscription. */
  onQuit(fn: () => void): () => void;
  /** Ready to close (after the last snapshot): the main process closes the window. */
  quitReady(): void;
  /** Bench: every process's private memory now (Mo), the main process's collections forced first. */
  benchMemory(): Promise<{ browser: number; tab: number; gpu: number }>;
  /** The bench pass (CIRRUS_BENCH) is over: the main process adds its load phases and memory, records the run and quits. */
  benchDone(run: unknown): Promise<void>;
  /** The first frame is drawn (captures wait for it). */
  ready(): void;
  /**
   * Launch options for visual checks: plan name, view "x,y,zoom", simulated hover "x,y", settings panel open; `bench`:
   * the bench pass's label; `capture`: a capture is taken (CIRRUS_CAPTURE).
   */
  launch: {
    plan?: string; view?: string; hover?: string; panel?: boolean; bench?: string; capture?: boolean; hide?: string; keys?: string; pointer?: string;
    click?: string;
  };
}

declare global {
  interface Window {
    cirrus: CirrusBridge;
  }
}
