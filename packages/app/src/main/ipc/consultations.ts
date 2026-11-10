import { ipcMain } from 'electron';
import type { Consultations } from '../consultations.ts';

/**
 * The consultations' IPC (plan 6a, D6): the interface's batches, written to this PC's consultations.db. A one-way
 * message, not a call: nothing the interface does waits for it or learns of its failure (the file drops a batch it cannot
 * write, with a warning in this process's console). `ipcMain.on` runs the write synchronously on arrival, so a closing's
 * last batch, sent before `cirrus:quit:ready` on the same channel, is on disk before the window is destroyed.
 */
export function wireConsultations(deps: { consultations(): Consultations | null }): void {
  ipcMain.on('cirrus:consultations', (_e, batch: unknown) => { deps.consultations()?.write(batch); });
}
