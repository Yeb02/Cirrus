import type { CompileRequest, LatexStatus } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import { BrowserWindow, ipcMain } from 'electron';
import { INVALID_REQUEST, invalidRequest, type LatexService } from '../latex/compiler.ts';
import type { LatexSetup } from '../latex/setup.ts';

/** What LaTeX's calls read when the interface makes them: once the base is open, the service and its setup (index.ts). */
interface LatexDeps {
  /** The base's folder, whose store holds a compilation's resources. */
  dir(): string;
  /** The settings LaTeX reads (textViewMaxMb). */
  params(): RenderParams;
  /** LaTeX's compilations (plan 4b). */
  latex(): LatexService | null;
  /** In front of them, LaTeX's state and installation (task 7). */
  setup(): LatexSetup | null;
}

/**
 * LaTeX's IPC (plan 4b): compilations, their cancelling, those of the background (plan 5b), the preamble's warm-up,
 * LaTeX's state and its installation.
 */
export function wireLatex(deps: LatexDeps): void {
  // LaTeX (plan 4b, D2, D8): the interface sends what the source needs; the request's form is checked here whatever the
  // interface did (strings, lists, a source of textViewMaxMb at most, resources of plain names present in the store).
  ipcMain.handle('cirrus:latex:compile', (_e, req: unknown) => {
    const why = invalidRequest(req, deps.dir(), deps.params().textViewMaxMb * 2 ** 20);
    const latexSetup = deps.setup();
    if (why !== null || !latexSetup) {
      console.warn(`Compilation LaTeX refusée : ${why ?? 'base non ouverte'}`);
      return INVALID_REQUEST;
    }
    return latexSetup.compile(req as CompileRequest);
  });
  ipcMain.on('cirrus:latex:cancel', (_e, slot: unknown) => { if (typeof slot === 'string') deps.setup()?.cancel(slot); });
  // What a synchronisation changed, compiled in the background (plan 5b, D1): no answer, the PDFs land in the cache.
  // Checked as a compilation is, latexBackgroundMax at most (the service keeps no more); those refused are left out, said
  // in one line (a file received but not downloaded yet refuses each source of its node).
  ipcMain.on('cirrus:latex:background', (_e, reqs: unknown) => {
    const latex = deps.latex();
    if (!Array.isArray(reqs) || !latex) return;
    const p = deps.params(), kept: CompileRequest[] = [], refused: string[] = [];
    for (const req of reqs.slice(0, p.latexBackgroundMax)) {
      const why = invalidRequest(req, deps.dir(), p.textViewMaxMb * 2 ** 20);
      if (why === null) kept.push(req as CompileRequest);
      else refused.push(why);
    }
    if (refused.length > 0) console.warn(`Compilations LaTeX de fond refusées : ${refused.length}, dont : ${refused[0]}`);
    latex.background(kept);
  });
  ipcMain.on('cirrus:latex:warm', (_e, preamble: unknown) => { if (typeof preamble === 'string') deps.latex()?.warm(preamble); });
  ipcMain.handle('cirrus:latex:status:get', () => deps.setup()?.state() ?? { state: 'absent' });
  // TinyTeX's installation (D1, task 7): only this call, which the user's « Installer » makes, downloads it.
  ipcMain.handle('cirrus:latex:install', () => deps.setup()?.install());
}

/** LaTeX's state, told to every window open at each change (cirrus:latex:status, task 7). */
export function tellLatexStatus(s: LatexStatus): void {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send('cirrus:latex:status', s);
}
