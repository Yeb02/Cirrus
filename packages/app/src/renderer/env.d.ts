/// <reference types="vite/client" />
import type { CompileAnswer, CompileRequest, FileRef, Id, LatexStatus } from '@cirrus/core';
import type { PublicationResult } from '@cirrus/sources';
import type { BibFile } from '../main/bib.ts';
import type { Consultation } from './consultations.ts';
import type { HistorySummary, ImportResult, OpenResult } from '../main/files.ts';
import type {
  Committed, DownloadAllPlan, DownloadAllProgress, DownloadAllStart, FirstSyncChoice, OpenElsewhere, PairResult, ReconcileOutcome, ServerInfo, ServerStatus, SyncIncoming,
  SyncStatus,
} from '../main/sync/protocol.ts';

/** What the preload exposes (src/preload/index.ts). */
export interface CirrusBridge {
  /**
   * The state to open: the base's snapshot (encodeState), the journal's operations after it (JSON) and the journal
   * number they reach; `fromTables`, the state of the base's tables instead (the snapshot sent first was unusable).
   * With a server paired, every pending write (JSON, plan 5a); this PC's identifier.
   */
  load(fromTables: boolean): Promise<{ data: ArrayBuffer; tail: string; seq: number; pending: string; pc: string }>;
  /** Keeps a snapshot of the state covering the journal up to `seq`, if later than the base's. */
  saveSnapshot(data: ArrayBuffer, seq: number): Promise<void>;
  getSettings(): Promise<Record<string, unknown>>;
  /**
   * The settings changed here since the last call, only those: key: value, null back to the default (plan 5a, task 6:
   * with a server paired, each is shared with it). Resolves with what is now written for those keys, bounded (null: the
   * default; a key that is no setting left out); nothing on the bench, which writes none.
   */
  setSettings(changes: Record<string, unknown>): Promise<Record<string, unknown> | undefined>;
  /**
   * Shared settings received from the server that changed here (task 6), as one batch: key: value (bounded as a
   * settings file is read), null back to the default. Returns the unsubscription.
   */
  onSettingsChanged(fn: (changes: Record<string, unknown>) => void): () => void;
  /**
   * Writes an edit to the local base as the write `unit` (its identifier, uuidv7, plan 5a); resolves with the journal
   * number of its last line and its time (this PC's clock corrected by the server's, D4), rejects with the reason.
   */
  commit(action: unknown, unit: string): Promise<Committed>;
  /**
   * A batch of the interface's consultations (plan 6a, D6), to be written to this PC's consultations.db in one transaction.
   * Sent and forgotten, in order with quitReady (the same channel): a closing's last batch is written before the window
   * goes. The main process checks it strictly, and drops a batch it cannot write, with a warning in its console.
   */
  recordConsultations(events: Consultation[]): void;
  /** Windows' app commands « Précédent » et « Suivant » (plan 6a, D2), as the main process hears them. Returns the unsubscription. */
  onAppCommand(fn: (command: 'browser-backward' | 'browser-forward') => void): () => void;
  /** The window is closing: `fn` saves what it must, then calls quitReady. Returns the unsubscription. */
  onQuit(fn: () => void): () => void;
  /** Ready to close (after the last snapshot): the main process closes the window. */
  quitReady(): void;
  /** A dropped file's path on the disk; '' for a file that is not on it (made in the page, or not a File). */
  pathForFile(file: File): string;
  /**
   * Copies files into the store (plan 4a, D6): their references, and the refused ones with their reason in French. Only
   * the paths pathForFile gave in this page go through; any other comes back refused, « non déposé ».
   */
  importFiles(paths: string[]): Promise<ImportResult>;
  /** The same for files chosen in the system's dialog; empty lists when nothing is chosen. */
  pickFiles(): Promise<ImportResult>;
  /**
   * A text stored as the file `name` (plan 4b, D6: a .tex saved from its full screen), in UTF-8 without a BOM: its
   * reference. Rejects with the reason, in French, for a name checkFileName refuses or a text over maxImportMb.
   */
  storeText(name: string, text: string): Promise<FileRef>;
  /**
   * Texts stored as files in one call (plan 4c, task 6: a .bib's entries), each as storeText stores it, several
   * written at once: their references, in order. STORE_TEXTS_MAX at most, maxImportMb all together; one refused rejects
   * the call with its reason, in French, before any is written.
   */
  storeTexts(items: { name: string; text: string }[]): Promise<FileRef[]>;
  /**
   * A .bib dropped on the graph's background (plan 4c, D9), read by the main process: its bytes, BIB_MAX_BYTES at most,
   * or why not, in French. Only a path pathForFile gave in this page goes through; any other is refused.
   */
  readBib(path: string): Promise<BibFile>;
  /**
   * « Importer un fichier .bib… »: the system's dialog, the .bib chosen read as readBib reads; null when none is chosen.
   * In a test's window (CIRRUS_BACKGROUND, captures) the dialog never opens: CIRRUS_BIB_PICK names the file, on a test
   * base only.
   */
  pickBib(): Promise<BibFile | null>;
  /**
   * « Choisir un PDF… » (plan 5b, D5): the system's dialog, filtered on PDF; the path chosen, which importFiles then takes
   * as a dropped file's, or null when none is chosen. In a test's window (CIRRUS_BACKGROUND, captures) the dialog never
   * opens: CIRRUS_PDF_PICK names the PDF, on a test base only.
   */
  pickPdf(): Promise<string | null>;
  /**
   * Opens a file with the system's application, on a read-only copy; a program or a script is shown in the explorer
   * instead (`shown: 'folder'`). `message`, in French and naming the file, says why it could not be.
   */
  openFile(ref: FileRef): Promise<OpenResult>;
  /**
   * A PDF's link to an address (plan 4a, task 6): opened by the system's handler (the browser, the mail client) if the
   * main process takes its scheme (externalUrlAllowed: http:, https:, mailto:); refused otherwise, said in the console.
   */
  openUrl(url: string): Promise<void>;
  /** A node's history for its pop-up: its first and last change (ms), and the number of actions. */
  historyOf(id: Id): Promise<HistorySummary>;
  /**
   * A LaTeX compilation (plan 4b): from the cache at once (`cached`), or by a pdfLaTeX prepared ahead of time. A newer
   * request of the same slot cancels this one (`cancelled`). The PDF is read at cirrus-file://latex/<pdf.key>/<name>.
   */
  latexCompile(req: CompileRequest): Promise<CompileAnswer>;
  /** The slot's request, waiting or running, is cancelled. */
  latexCancel(slot: string): void;
  /**
   * What a synchronisation changed, compiled in the background (plan 5b, D1): no answer, the PDFs land in the cache,
   * where a view opened later finds them (`cached`). Under slots of their own, they never cancel a view's.
   */
  latexBackground(reqs: CompileRequest[]): void;
  /** Prepares pdfLaTeX with this preamble (after loading, and when the preamble changes). */
  latexWarm(preamble: string): void;
  /** LaTeX's state on this PC; onLatexStatus is told each change, and `ready` again once packages are installed. Returns the unsubscription. */
  latexStatus(): Promise<LatexStatus>;
  onLatexStatus(cb: (s: LatexStatus) => void): () => void;
  /**
   * Installs TinyTeX (D1, task 7), the user having asked: the only call that downloads it. Resolves once done; how it
   * went is told by onLatexStatus (`ready`, or `failed` with its reason). A call while one runs does nothing more.
   */
  latexInstall(): Promise<void>;
  /**
   * Imports a publication (plan 4c, D5, D6), the user having asked: the only call that reaches the network for it.
   * `text`: a DOI, an arXiv identifier, or a link to either (parseIdentifier, which `id` gives back). Its CSL-JSON and
   * its BibTeX entry, and for an arXiv article its PDF, already in the store (`pdf`), or why not (`pdfMessage`, in
   * French: the publication comes without it). Else `message`, in French (« Identifiant non reconnu. », « Publication
   * introuvable. », « Pas de connexion. », « Réponse inattendue du serveur de DOI. »…), and nothing was stored.
   * `{ pdf: false }`: an arXiv article's PDF is not downloaded (a PDF dropped in the import dialog, which the node keeps).
   */
  publicationFetch(text: string, options?: { pdf?: boolean }): Promise<PublicationResult>;
  /**
   * The synchronisation (plan 5a, task 4). syncStart: the interface holds its state and pending writes; the client
   * starts if a server is paired (its status). syncRetry: the chip's « Réessayer ». syncReconciled: the answer to
   * onSyncIncoming's message `id`, a reconciliation written by the base (its journal number) or why none (null).
   * syncPending: every pending write (JSON). syncServer: the server paired, or what to propose. syncPair, syncUnpair:
   * the block « Serveur »; syncFirst: its answer to the first pairing's offer (task 5, D7: send this PC's base, take the
   * server's, or give up). onSyncVeil: waking up, the veil rises. onSyncServer: what the block shows, at each change of
   * the pairing (short review after plan 5a, B2: a page reloaded while a pairing ended learns so that it is paired).
   */
  syncStart(): Promise<SyncStatus>;
  syncRetry(): void;
  syncReconciled(id: number, outcome: ReconcileOutcome): Promise<number | null>;
  syncPending(): Promise<string>;
  syncServer(): Promise<ServerInfo>;
  syncPair(url: string, code: string, name: string): Promise<PairResult>;
  syncFirst(choice: FirstSyncChoice): Promise<PairResult>;
  syncUnpair(): Promise<void>;
  onSyncIncoming(fn: (m: SyncIncoming) => void): () => void;
  onSyncStatus(fn: (s: SyncStatus) => void): () => void;
  onSyncVeil(fn: () => void): () => void;
  onSyncServer(fn: (info: ServerInfo) => void): () => void;
  /**
   * « .tex ouvert ailleurs » (plan 5b, task 5, D6). texOpened: a .tex's full screen opened, told to the server; the first
   * other PC that has it open (its name, since when), or null — none, not paired, offline. texClosed: that full screen
   * closed.
   */
  texOpened(node: Id, name: string): Promise<OpenElsewhere | null>;
  texClosed(node: Id, name: string): void;
  /**
   * The server's state and « Tout télécharger » (plan 5b, D8). serverStatus: the latency, the throughput and the
   * server's space, as the main process measures and asks them (GET /status, while connected), asked by the block
   * « Serveur » every serverStatusPollMs while it is shown. downloadAllPlan: of the PDFs the interface counted
   * (referencedPdfs), those missing on this PC, their bytes, and the free space of its disk. downloadAllStart: started,
   * or why not; onDownloadAll is then told where it is, at each file's end, and how it ended. downloadAllStop: « Arrêter ».
   */
  serverStatus(): Promise<ServerStatus>;
  downloadAllPlan(refs: FileRef[]): Promise<DownloadAllPlan>;
  downloadAllStart(refs: FileRef[]): Promise<DownloadAllStart>;
  downloadAllStop(): void;
  onDownloadAll(fn: (p: DownloadAllProgress) => void): () => void;
  /** Bench: every process's private memory now (Mo), the main process's collections forced first. */
  benchMemory(): Promise<{ browser: number; tab: number; gpu: number }>;
  /** The bench pass (CIRRUS_BENCH) is over: the main process adds its load phases and memory, records the run and quits. */
  benchDone(run: unknown): Promise<void>;
  /** The first frame is drawn (captures wait for it). */
  ready(): void;
  /**
   * Launch options for visual checks: plan name, view "x,y,zoom", simulated hover "x,y", settings panel open; `bench`:
   * the bench pass's label; `capture`: a capture is taken (CIRRUS_CAPTURE); `import`: "sx,sy|path", files dropped there
   * once the first frame is drawn (CIRRUS_IMPORT, capture mode only); `app`: the app's name and version, « Cirrus 0.1.0 »
   * (plan 9, D3).
   */
  launch: {
    plan?: string; view?: string; hover?: string; panel?: boolean; bench?: string; capture?: boolean; hide?: string; keys?: string; pointer?: string;
    click?: string; import?: string; app?: string;
  };
}

declare global {
  interface Window {
    cirrus: CirrusBridge;
  }
}
