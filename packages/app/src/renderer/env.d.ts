/// <reference types="vite/client" />
import type { FileRef, Id } from '@cirrus/core';
import type { HistorySummary, ImportResult, OpenResult } from '../main/files.ts';

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
  /** A dropped file's path on the disk; '' for a file that is not on it (made in the page, or not a File). */
  pathForFile(file: File): string;
  /**
   * Copies files into the store (plan 4a, D6): their references, and the refused ones with their reason in French. Only
   * the paths pathForFile gave in this page go through; any other comes back refused, « non déposé ».
   */
  importFiles(paths: string[]): Promise<ImportResult>;
  /** The same for files chosen in the system's dialog; empty lists when nothing is chosen. */
  pickFiles(): Promise<ImportResult>;
  /**
   * Opens a file with the system's application, on a read-only copy; a program or a script is shown in the explorer
   * instead (`shown: 'folder'`). `message`, in French and naming the file, says why it could not be.
   */
  openFile(ref: FileRef): Promise<OpenResult>;
  /**
   * A PDF's link to an address (plan 4a, task 6): opened by the system's handler (the browser, the mail client) if the
   * main process takes its scheme (externalUrlAllowed: http:, https:, mailto:); refused otherwise, said in the console.
   */
  openUrl(url: string): Promise<void>;
  /** A node's history for its pop-up: its first and last change (ms), and the number of actions. */
  historyOf(id: Id): Promise<HistorySummary>;
  /** Bench: every process's private memory now (Mo), the main process's collections forced first. */
  benchMemory(): Promise<{ browser: number; tab: number; gpu: number }>;
  /** The bench pass (CIRRUS_BENCH) is over: the main process adds its load phases and memory, records the run and quits. */
  benchDone(run: unknown): Promise<void>;
  /** The first frame is drawn (captures wait for it). */
  ready(): void;
  /**
   * Launch options for visual checks: plan name, view "x,y,zoom", simulated hover "x,y", settings panel open; `bench`:
   * the bench pass's label; `capture`: a capture is taken (CIRRUS_CAPTURE); `import`: "sx,sy|path", files dropped there
   * once the first frame is drawn (CIRRUS_IMPORT, capture mode only).
   */
  launch: {
    plan?: string; view?: string; hover?: string; panel?: boolean; bench?: string; capture?: boolean; hide?: string; keys?: string; pointer?: string;
    click?: string; import?: string;
  };
}

declare global {
  interface Window {
    cirrus: CirrusBridge;
  }
}
