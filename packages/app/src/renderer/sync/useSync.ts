import type { RenderParams } from '@cirrus/view';
import { useEffect, useRef, useState } from 'react';
import type { FirstSyncChoice, ServerInfo } from '../../main/sync/protocol.ts';
import { SyncedChanges } from '../latex/background.ts';
import { type EditSession, type Opened, openState } from '../session.ts';
import { referencedPdfs } from './downloadAll.ts';
import { SyncSession, type SyncView } from './syncSession.ts';

/** Without a server paired (plan 5a, D8): no veil, no chip, no update screen. */
const NO_SYNC: SyncView = { veil: false, status: { state: 'off' }, chip: null, update: null };

/**
 * The synchronisation in App (plan 5a): what it shows (the veil, the chip: `view`), the server paired (`server`), and
 * its session, made at startup once the state is read (`starting`). `toast` says what it has to say; `params` holds
 * syncConnectTimeoutMs. `received`: what the actions it applied changed, which App's session notes (each action marked
 * by the session as the synchronisation's, never by its label) and LaTeX compiles in the background (plan 5b, D1).
 */
export function useSync(toast: (text: string) => void, params: { readonly current: RenderParams }) {
  const [view, setView] = useState<SyncView>(NO_SYNC);
  const [server, setServer] = useState<ServerInfo | null>(null);
  const sync = useRef<SyncSession | null>(null);
  const [received] = useState(() => new SyncedChanges());
  /** The session that holds the state: « Tout télécharger » counts its PDFs (plan 5b, D8). */
  const edits = useRef<EditSession | null>(null);
  // « Tout télécharger » told at each file's end (D8): into what the block shows, while paired.
  useEffect(() => window.cirrus.onDownloadAll((p) => setServer((i) => (i?.paired ? { ...i, downloadAll: p } : i))), []);

  /**
   * The startup's part, from the moment App begins to load its state. What the main process says of the server after
   * its answer to `ask`, until the session listens: a pairing or a first sync that ends while this page loads, reloaded
   * meanwhile (short review after plan 5a, B2). Messages arrive in the order they were sent: one before the answer is
   * older than it, and dropped. `stop`: the load failed, nothing more is listened to.
   */
  const starting = () => {
    const told: { info: ServerInfo | null } = { info: null };
    const early = window.cirrus.onSyncServer((i) => { told.info = i; });
    return {
      /**
       * The server asked, before the state is read: paired then, it is when the state is read, whose pending writes are
       * then all of them (B2).
       */
      ask: () => window.cirrus.syncServer().then((i) => { told.info = null; return i; }),
      /**
       * The synchronisation (plan 5a) once the session holds the state, `info` the main process's answer: with a server
       * paired, the veil, then the client started once the session holds the pending writes (the function returned,
       * given what the state was read with); the state read again from the base when a reconciliation could not be
       * written.
       */
      attach: (session: EditSession, info: ServerInfo) => {
        const s = new SyncSession({
          bridge: window.cirrus, session, load: () => openState(window.cirrus.load), timeoutMs: () => params.current.syncConnectTimeoutMs,
          toast: (text) => toast(text), onView: setView, onServer: setServer,
        });
        sync.current = s;
        edits.current = session;
        early();
        const since = told.info ?? undefined;
        setServer(since ?? info);
        return (opened: Opened, timeoutMs: number) => {
          void s.open({ paired: info.paired, pc: opened.pc, pending: opened.pending, timeoutMs, waiting: info.waiting, since })
            .catch((e: unknown) => console.error('Synchronisation :', e));
        };
      },
      stop: early,
    };
  };

  /** The PDFs the base refers to now (referencedPdfs): read at each question and each start. */
  const pdfs = () => (edits.current ? referencedPdfs(edits.current.state) : []);
  /**
   * The block « Serveur » (plan 5a): pairing, its first sync (D7), and unpairing; what the main process holds comes
   * through the session (onServer), after each of them and at each mounting of the block (refresh: review of task 5,
   * round 2). Paired, the server's state and « Tout télécharger » (plan 5b, D8).
   */
  const serverBlock = {
    info: server, status: view.status,
    onPair: (url: string, code: string, name: string) => sync.current!.pair(url, code, name),
    onFirst: (choice: FirstSyncChoice) => sync.current!.first(choice),
    onUnpair: () => sync.current!.unpair(),
    refresh: () => sync.current!.server(),
    serverState: { ask: () => window.cirrus.serverStatus(), pollMs: () => params.current.serverStatusPollMs },
    downloadAll: {
      plan: () => window.cirrus.downloadAllPlan(pdfs()),
      start: () => window.cirrus.downloadAllStart(pdfs()),
      stop: () => window.cirrus.downloadAllStop(),
      reserveMb: () => params.current.downloadAllReserveMb,
    },
  };
  /** The chip's click: offline or refused, try again now. */
  const retry = () => sync.current?.retry();
  /** The update screen's « Continuer… »: dismissed for its attempt (SyncSession.dismissUpdate). */
  const dismissUpdate = () => sync.current?.dismissUpdate();
  return { view, serverBlock, retry, dismissUpdate, starting, received };
}
