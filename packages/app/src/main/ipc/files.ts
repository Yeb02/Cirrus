import type { FileRef } from '@cirrus/core';
import { withOverrides } from '@cirrus/view';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { bibPickOf, readBib } from '../bib.ts';
import { importPaths, openFailure, openTargetFetched, storeText, storeTexts } from '../files.ts';
import { externalUrlAllowed } from '../navigation.ts';
import type { SyncHost } from '../sync/host.ts';

/** What the files' calls read when the interface makes them: by then, the base is open (index.ts). */
export interface FilesDeps {
  /** The base's folder, whose store holds the files. */
  dir(): string;
  /** The synchronisation (plan 5a): with a server paired, a file the store lacks is downloaded. */
  sync(): SyncHost | null;
  /** The settings (maxImportMb). */
  settings(): Record<string, unknown>;
  /** Where the read-only copies opened by the system's applications go (index.ts clears it at the start). */
  copies: string;
  /** A capture, whose base is a test copy. */
  capture: boolean;
  /** A window out of the user's way (captures, the interface's checks): no dialog of the system opens there. */
  background: boolean;
}

/**
 * The files' IPC (plan 4a; plan 4b, D6; plan 4c): files imported into the store, from a drop or the system's dialog;
 * texts stored (a .tex typed, a .bib's entries); a whole .bib read; a file, or a link clicked in a PDF, opened by the
 * system.
 */
export function wireFiles(deps: FilesDeps): void {
  /** The largest file an import takes, in bytes (setting maxImportMb). */
  const maxImportBytes = () => withOverrides(deps.settings()).maxImportMb * 2 ** 20;
  // Files dropped on a node or chosen in the dialog, copied into the store before an action refers to them (plan 4a, D6).
  // The preload passes on only the paths of files dropped in the page (I1 of the review).
  ipcMain.handle('cirrus:files:import', (_e, paths: unknown) =>
    importPaths(deps.dir(), Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : [], maxImportBytes()));
  ipcMain.handle('cirrus:files:pick', async (e) => {
    const chosen = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender)!, { properties: ['openFile', 'multiSelections'] });
    return chosen.canceled ? { refs: [], refused: [] } : importPaths(deps.dir(), chosen.filePaths, maxImportBytes());
  });
  // A .tex typed in its full screen (plan 4b, D6), stored before the action that refers to it; a name or a size refused
  // rejects with its reason, in French.
  ipcMain.handle('cirrus:files:store-text', (_e, name: unknown, text: unknown) => storeText(deps.dir(), name, text, maxImportBytes()));
  // A .bib's entries (plan 4c, task 6), a file each, stored by batches before the action that refers to them: checked here
  // whatever the interface did (a list of STORE_TEXTS_MAX at most, each storeText's checks, maxImportMb in all).
  ipcMain.handle('cirrus:files:store-texts', (_e, items: unknown) => storeTexts(deps.dir(), items, maxImportBytes()));
  /**
   * A whole .bib (plan 4c, D9, task 6), read here only: dropped on the graph's background (the preload passes on only a
   * drop's path), or chosen in the system's dialog by « Importer un fichier .bib… »; BIB_MAX_BYTES at most (readBib). On
   * a test base out of the user's way, CIRRUS_BIB_PICK names the file the menu takes, and in a test's window the dialog
   * never opens (the user, 2026-11-07: nothing in front of the user's work).
   */
  const bibPick = bibPickOf(process.env, deps.capture);
  if (process.env.CIRRUS_BIB_PICK && !bibPick) {
    console.warn('CIRRUS_BIB_PICK ignoré : seulement sur une base de test (CIRRUS_DATA), en capture ou en arrière-plan.');
  }
  ipcMain.handle('cirrus:bib:read', (_e, path: unknown) => readBib(path));
  ipcMain.handle('cirrus:bib:pick', async (e) => {
    if (bibPick) return readBib(bibPick);
    if (deps.background) {
      console.warn('Sélecteur de fichiers non ouvert dans une fenêtre de test : CIRRUS_BIB_PICK nomme le .bib à importer.');
      return null;
    }
    const options = { title: 'Importer un fichier .bib', properties: ['openFile' as const], filters: [{ name: 'BibTeX', extensions: ['bib'] }] };
    const win = BrowserWindow.fromWebContents(e.sender);
    const chosen = await (win ? dialog.showOpenDialog(win, options) : dialog.showOpenDialog(options));
    return chosen.canceled || chosen.filePaths.length === 0 ? null : readBib(chosen.filePaths[0]);
  });
  // A file opened by the system's application, on a read-only copy; a program or a script is shown in the explorer
  // instead, never run (plan 4a, D5). With a server paired, a file the store lacks is downloaded first (plan 5a, R14).
  // Failures reach the user in French, their cause in the console.
  ipcMain.handle('cirrus:files:open', async (_e, ref: FileRef) => {
    const name = typeof ref?.name === 'string' ? ref.name : '';
    try {
      const { path, shown } = await openTargetFetched(deps.dir(), ref, deps.copies, deps.sync()?.blobFetcher() ?? null);
      if (shown === 'folder') shell.showItemInFolder(path);
      else {
        const error = await shell.openPath(path);
        if (error) {
          console.error(`Ouverture de « ${name} » : ${error}`);
          return { ok: false, message: openFailure(name, error) };
        }
      }
      return { ok: true, shown };
    } catch (e) {
      console.error(`Ouverture de « ${name} » :`, e);
      return { ok: false, message: openFailure(name, e) };
    }
  });
  // A link clicked in a PDF (plan 4a, task 6): its address goes to the system's handler (the browser, the mail client)
  // only in http:, https: or mailto: (externalUrlAllowed), checked here whatever the interface did; any other is refused.
  ipcMain.handle('cirrus:open-url', async (_e, url: unknown) => {
    if (typeof url !== 'string' || !externalUrlAllowed(url)) {
      console.warn(`Lien refusé : ${String(url).slice(0, 200)}`);
      return;
    }
    try {
      await shell.openExternal(url);
    } catch (e) {
      console.error(`Ouverture du lien ${url} :`, e);
    }
  });
}
