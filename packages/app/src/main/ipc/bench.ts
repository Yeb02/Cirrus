import { join } from 'node:path';
import { forceGc } from '@cirrus/fixtures';
import { app, ipcMain } from 'electron';
import { loadPhases, type PassRecord, processMemoryMb, recordRun } from '../bench.ts';
import { benchMarks } from '../benchMode.ts';

// The rendering bench's IPC (CIRRUS_BENCH, scripts/bench.mjs): its memory and its record. Loaded in bench mode only
// (benchMode.ts, plan 9, D8), with @cirrus/fixtures.

/** Every process's private memory, the collections of this one forced first (the interface forced its own). */
const processMemory = () => { forceGc(); return processMemoryMb(app.getAppMetrics()); };

/**
 * The bench's calls (preload: benchMemory, benchDone). `scale`: CIRRUS_BENCH, "<nodes>,<connections>"; `exit` quits once
 * every pdfLaTeX has exited.
 */
export function wireBench(deps: { scale: string; exit(code: number): void }): void {
  ipcMain.handle('cirrus:bench:memory', () => processMemory());
  // The pass is over: its load phases since this process started and every process's memory.
  ipcMain.handle('cirrus:bench:done', (_e, run: Omit<PassRecord, 'phases' | 'processMb'>) => {
    const record: PassRecord = { ...run, phases: loadPhases({ ...benchMarks, ...run.marks }, performance.timeOrigin), processMb: processMemory() };
    const report = recordRun(join(app.getAppPath(), '..', '..', 'docs', 'bancs'), record, process.env.CIRRUS_BENCH_FINAL === '1', deps.scale);
    if (report) console.log(`Rapport écrit : ${report}`);
    deps.exit(0);
  });
}
