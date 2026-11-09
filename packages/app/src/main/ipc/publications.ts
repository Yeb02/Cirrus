import { type LocalStore, storeBytes } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import { ipcMain, net } from 'electron';
import { type FetchFn, importPublication, requestFetch } from '../publications/fetch.ts';
import { replayDirOf, replayFetch } from '../publications/replay.ts';

/** What a publication's import reads when the interface asks for it (index.ts). */
interface PublicationsDeps {
  /** The base's folder, whose store keeps the PDF. */
  dir(): string;
  /** The base, null until it is open. */
  store(): LocalStore | null;
  /** The settings the import reads (publicationMaxKb, publicationTimeoutMs, maxImportMb). */
  params(): RenderParams;
  /** A capture, whose base is a test copy. */
  capture: boolean;
}

/** The publications' IPC (plan 4c): a publication's metadata fetched, and an arXiv article's PDF, when the user imports one. */
export function wirePublications(deps: PublicationsDeps): void {
  /**
   * A publication's network (plan 4c, D5, D6): Electron's stack (its proxy, its certificates), by net.request, whose
   * redirects fetch.ts follows by hand. On a test base out of the user's way (CIRRUS_DATA, in capture mode or with
   * CIRRUS_BACKGROUND=1), CIRRUS_PUBLICATIONS_REPLAY names recorded answers instead (replay.ts): the interface's scenarios
   * and the captures import without the network. Never on the user's own base, where the variable is ignored.
   */
  const publicationsReplay = replayDirOf(process.env, deps.capture);
  if (process.env.CIRRUS_PUBLICATIONS_REPLAY && !publicationsReplay) {
    console.warn('CIRRUS_PUBLICATIONS_REPLAY ignoré : seulement sur une base de test (CIRRUS_DATA), en capture ou en arrière-plan.');
  }
  const publicationsFetch: FetchFn = publicationsReplay ? replayFetch(publicationsReplay) : requestFetch((options) => net.request(options));
  // A publication's import (plan 4c, task 4), which the user's import makes (task 5): the only call that reaches the
  // network for it, never at startup nor in the background. The text is checked here whatever the interface did (a
  // string parseIdentifier reads); the answers within publicationMaxKb and publicationTimeoutMs, the PDF within
  // maxImportMb, stored before any action refers to it; `{ pdf: false }` leaves it out (a PDF dropped in the dialog, task 5).
  ipcMain.handle('cirrus:publications:fetch', (_e, text: unknown, options: unknown) => {
    if (!deps.store()) return { ok: false, message: 'La base n’est pas ouverte.' };
    const p = deps.params();
    return importPublication(text, {
      fetch: publicationsFetch, store: (name, bytes) => storeBytes(deps.dir(), name, bytes),
      maxKb: p.publicationMaxKb, maxPdfBytes: p.maxImportMb * 2 ** 20, timeoutMs: p.publicationTimeoutMs,
      log: (m) => console.warn(m),
    }, options);
  });
}
