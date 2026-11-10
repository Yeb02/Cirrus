import type { Phase } from './bench.ts';

/**
 * What of the rendering bench (CIRRUS_BENCH, scripts/bench.mjs) the app holds outside bench mode (plan 9, D8): the main
 * process's load marks, which cost a number each, and the gate to the rest. The bench's IPC (ipc/bench.ts) and its base
 * (bench.ts), which import @cirrus/fixtures, are loaded by a dynamic import in bench mode only: electron-vite puts them
 * in chunks of their own, which a normal run never loads.
 */

/** The main process's load marks, in absolute time like the interface's. */
export const benchMarks: Partial<Record<Phase, number>> = {};
export const markNow = (name: Phase) => { if (benchMarks[name] === undefined) benchMarks[name] = performance.timeOrigin + performance.now(); };

/** What the bench's IPC module gives (ipc/bench.ts). */
interface BenchIpc {
  wireBench(deps: { scale: string; exit(code: number): void }): void;
}

/**
 * The bench's calls (preload: benchMemory, benchDone), wired in bench mode only (`scale`: CIRRUS_BENCH,
 * "<nodes>,<connections>"), their module loaded then (`load`); `exit` quits once every pdfLaTeX has exited. Resolves
 * with whether they were wired.
 */
export async function wireBenchMode(scale: string | undefined, exit: (code: number) => void, load: () => Promise<BenchIpc>): Promise<boolean> {
  if (!scale) return false;
  (await load()).wireBench({ scale, exit });
  return true;
}
