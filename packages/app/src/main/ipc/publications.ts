import { type FetchFn, httpsConnect, importPublication, type OpenDeps, systemResolve } from '@cirrus/sources';
import { type LocalStore, storeBytes } from '@cirrus/store';
import type { RenderParams } from '@cirrus/view';
import { ipcMain, net } from 'electron';
import { replayDirOf, replayFetch, replayOpen } from '../publications/replay.ts';
import { requestFetch } from '../publications/request.ts';
import { importPublicationVia } from '../publications/via.ts';
import type { SyncHost } from '../sync/host.ts';

/** What a publication's import reads when the interface asks for it (index.ts). */
interface PublicationsDeps {
  /** The base's folder, whose store keeps the PDF. */
  dir(): string;
  /** The base, null until it is open. */
  store(): LocalStore | null;
  /** The settings the import reads (publicationMaxKb, publicationTimeoutMs, publicationPdfMaxMs, maxImportMb). */
  params(): RenderParams;
  /** The synchronisation, once the base is open: with a server paired and connected, the server imports (plan 5b, D2). */
  sync(): SyncHost | null;
  /** A capture, whose base is a test copy. */
  capture: boolean;
}

/** The publications' IPC (plan 4c): a publication's metadata fetched, and its PDF, when the user imports one. */
export function wirePublications(deps: PublicationsDeps): void {
  /**
   * A publication's network (plan 4c, D5, D6): Electron's stack (its proxy, its certificates), by net.request, whose
   * redirects @cirrus/sources follows by hand. The open web (plan 5b, D3): the system's resolver (every address of a
   * name) and Node's https.request to the address checked, which net.request cannot be told. On a test base out of the
   * user's way (CIRRUS_DATA, in capture mode or with CIRRUS_BACKGROUND=1), CIRRUS_PUBLICATIONS_REPLAY names recorded
   * answers instead, for both (replay.ts): the interface's scenarios and the captures import without the network. Never
   * on the user's own base, where the variable is ignored.
   */
  const publicationsReplay = replayDirOf(process.env, deps.capture);
  if (process.env.CIRRUS_PUBLICATIONS_REPLAY && !publicationsReplay) {
    console.warn('CIRRUS_PUBLICATIONS_REPLAY ignoré : seulement sur une base de test (CIRRUS_DATA), en capture ou en arrière-plan.');
  }
  const publicationsFetch: FetchFn = publicationsReplay ? replayFetch(publicationsReplay) : requestFetch((options) => net.request(options));
  const openNetwork: Pick<OpenDeps, 'resolve' | 'connect'> = publicationsReplay ? replayOpen(publicationsReplay) : { resolve: systemResolve, connect: httpsConnect() };
  // A publication's import (plan 4c, task 4), which the user's import makes (task 5): the only call that reaches the
  // network for it, never at startup nor in the background. The text is checked here whatever the interface did (a
  // string of MAX_IDENTIFIER_CHARS at most: an identifier, a publisher's address, an address of the open web under its
  // guards); the answers within publicationMaxKb and publicationTimeoutMs, the PDF within maxImportMb and
  // publicationPdfMaxMs, stored before any action refers to it; `{ pdf: false }` leaves it out (a PDF dropped in the
  // dialog, task 5). With a server paired and connected, the server makes it, and keeps the PDF (plan 5b, D2:
  // importPublicationVia); without one, or the server failing, this PC does. On the recorded answers, everything stays
  // here: the scripts' server is never asked to reach the network.
  ipcMain.handle('cirrus:publications:fetch', (_e, text: unknown, options: unknown) => {
    if (!deps.store()) return { ok: false, message: 'La base n’est pas ouverte.' };
    const log = (m: string) => console.warn(m);
    return importPublicationVia(text, options, {
      local: (t, o) => {
        const p = deps.params();
        return importPublication(t, {
          fetch: publicationsFetch, store: (name, bytes) => storeBytes(deps.dir(), name, bytes),
          maxKb: p.publicationMaxKb, maxPdfBytes: p.maxImportMb * 2 ** 20, timeoutMs: p.publicationTimeoutMs, pdfMaxMs: p.publicationPdfMaxMs, log,
          open: { ...openNetwork, timeoutMs: p.publicationTimeoutMs, pdfMaxMs: p.publicationPdfMaxMs, log },
        }, o);
      },
      server: () => (publicationsReplay ? null : deps.sync()?.publicationImporter() ?? null),
      params: deps.params,
      log,
    });
  });
}
