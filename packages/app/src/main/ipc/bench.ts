import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { forceGc } from '@cirrus/fixtures';
import { app, type BrowserWindow, ipcMain } from 'electron';
import { loadPhases, type PassRecord, type Phase, processMemoryMb, recordRun } from '../bench.ts';

// The measuring runs' IPC: the rendering bench (CIRRUS_BENCH, scripts/bench.mjs), its load marks and its record, and the
// captures (CIRRUS_CAPTURE=<png>), taken once the interface says it is ready.

/** The main process's load marks, in absolute time like the interface's. */
const benchMarks: Partial<Record<Phase, number>> = {};
export const markNow = (name: Phase) => { if (benchMarks[name] === undefined) benchMarks[name] = performance.timeOrigin + performance.now(); };

/** Every process's private memory, the collections of this one forced first (the interface forced its own). */
const processMemory = () => { forceGc(); return processMemoryMb(app.getAppMetrics()); };

/**
 * The bench's calls (preload: benchMemory, benchDone). `scale`: CIRRUS_BENCH, "<nodes>,<connections>"; `exit` quits once
 * every pdfLaTeX has exited.
 */
export function wireBench(deps: { scale: string | undefined; exit(code: number): void }): void {
  ipcMain.handle('cirrus:bench:memory', () => processMemory());
  // The pass is over: its load phases since this process started and every process's memory.
  ipcMain.handle('cirrus:bench:done', (_e, run: Omit<PassRecord, 'phases' | 'processMb'>) => {
    const record: PassRecord = { ...run, phases: loadPhases({ ...benchMarks, ...run.marks }, performance.timeOrigin), processMb: processMemory() };
    const report = recordRun(join(app.getAppPath(), '..', '..', 'docs', 'bancs'), record, process.env.CIRRUS_BENCH_FINAL === '1', deps.scale!);
    if (report) console.log(`Rapport écrit : ${report}`);
    deps.exit(0);
  });
}

/**
 * A capture (CIRRUS_CAPTURE=<png>): the window's image, written to `capture` once the interface is ready (cirrus:ready:
 * its first frame drawn, its visual checks done), then the app quits (`exit`); with no word after 30 s, the image as
 * it is, and the app quits with an error.
 */
export function captureWhenReady(win: BrowserWindow, capture: string, exit: (code: number) => void): void {
  let done = false;
  const shoot = (code: number) => {
    if (done) return;
    done = true;
    void win.webContents.capturePage().then((img) => {
      mkdirSync(dirname(capture), { recursive: true });
      writeFileSync(capture, img.toPNG());
      console.log(`Capture écrite : ${capture}`);
      exit(code);
    });
  };
  ipcMain.once('cirrus:ready', () => setTimeout(() => shoot(0), 500));
  setTimeout(() => { console.error('Pas d’image après 30 s : capture de l’état actuel.'); shoot(1); }, 30_000);
}
