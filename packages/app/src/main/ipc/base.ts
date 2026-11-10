import { type Action, type Id, OpConflictError } from '@cirrus/core';
import type { LocalStore } from '@cirrus/store';
import { ipcMain } from 'electron';
import { keepSnapshot, loadPayload, saveSnapshot } from '../base.ts';
import { historySummary } from '../files.ts';
import { markNow } from '../benchMode.ts';
import type { SyncHost } from '../sync/host.ts';

/** What the base's calls read when the interface makes them: by then, the base is open (index.ts). */
interface BaseDeps {
  store(): LocalStore | null;
  /** The synchronisation (plan 5a): with no server paired, it does nothing. */
  sync(): SyncHost | null;
  /** This PC's identifier (pc.json): it signs the writes. */
  pc(): string;
  /** The settings: the defaults, or on the bench CIRRUS_BENCH_SETTINGS. */
  settings(): Record<string, unknown>;
  /** The interface wrote settings: what reads them here reads them from the file again (task 6). */
  settingsWritten(): void;
  /** The bench: its settings are never written. */
  bench: boolean;
}

/**
 * The base's IPC: its state sent to the interface, and the interface's snapshot (plan 3c); its edits (spec 4: only this
 * process writes); a node's history; the settings (spec 19; shared with a server paired, plan 5a, task 6).
 */
export function wireBase(deps: BaseDeps): void {
  // The state as one ArrayBuffer (plan 3c, decision 5): the base's snapshot and the journal after it, or, without a
  // usable snapshot (or when the interface could not use it: fromTables), the state of the tables, kept as the new
  // snapshot once sent. An ArrayBuffer crosses IPC and the context bridge at the speed of memory. With a server paired,
  // every pending write too (plan 5a, R5), and always this PC's identifier, which signs them.
  ipcMain.handle('cirrus:load', (_e, fromTables: unknown) => {
    const { payload, rebuilt } = loadPayload(deps.store()!, fromTables === true, deps.sync()?.paired() === true);
    markNow('dataSent');
    if (rebuilt) setImmediate(() => keepSnapshot(deps.store()!, payload.data, payload.seq));
    return { ...payload, pc: deps.pc() };
  });
  // The interface's snapshot, at rest and at closing: checked, kept if later than the stored one.
  ipcMain.handle('cirrus:snapshot:save', (_e, data: unknown, seq: unknown) => { saveSnapshot(deps.store()!, data, seq); });
  ipcMain.handle('cirrus:settings:get', () => deps.settings());
  // The settings changed in Réglages, only those (key: value, null back to the default): settings.json, and with a server
  // paired, shared with it (task 6, D9). The answer: what is written for those keys, which the interface adopts.
  ipcMain.handle('cirrus:settings:set', (_e, changes: unknown) => {
    deps.settingsWritten();
    return deps.bench ? undefined : deps.sync()?.setSettings(changes);
  });
  ipcMain.handle('cirrus:history', (_e, id: Id) => historySummary(deps.store()!.historyOf(id)));
  // An edit computed by the interface (spec 4: only this process writes), each "before" checked against the base, as
  // the write `unit` the interface named (plan 5a), at this PC's time corrected by the server's (D4). A conflicting
  // record refuses it. Returns the journal number of its last line, and that time.
  ipcMain.handle('cirrus:commit', (_e, action: Action, unit: unknown) => {
    try {
      return deps.sync()!.commit(action, unit);
    } catch (e) {
      if (e instanceof OpConflictError) throw new Error('La base a changé : action refusée.');
      throw e;
    }
  });
}
