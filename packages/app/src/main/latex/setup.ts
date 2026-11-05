import type { CompileAnswer, CompileRequest, InstallProgress, LatexStatus } from '@cirrus/core';
import type { RenderParams } from '@cirrus/view';
import type { TexBinaries } from './tinytex.ts';

/**
 * LaTeX on this PC (plan 4b, D1; task 7), in front of the compilations (LatexService): its state, which the interface
 * is told (cirrus:latex:status); TinyTeX's installation, which only `install` starts — the user's consent, so that
 * nothing is downloaded otherwise —; the user's packages (`latexPackages`), ensured at each start; and the package of a
 * file a compilation misses, installed while that compilation waits, then the compilation started once more.
 */

/** What LatexSetup asks of the compilations (LatexService). */
export interface CompileService {
  compile(req: CompileRequest): Promise<CompileAnswer>;
  cancel(slot: string): void;
  /** The prepared pdfLaTeX started again: packages were installed. */
  restart(): void;
}

/** What LatexSetup asks of tlmgr (Packages). */
export interface PackageManager {
  ensure(names: string[]): Promise<{ installed: string[]; failed: { name: string; reason: string }[] }>;
  installFor(file: string): Promise<string | null>;
}

export interface LatexSetupOptions {
  service: CompileService;
  /** pdfLaTeX, or null while LaTeX is not installed (asked again each time). */
  binaries(): Promise<TexBinaries | null>;
  /** TinyTeX installed (provision, into tinyTexRoot), its steps told. */
  provision(onProgress: (p: InstallProgress) => void): Promise<TexBinaries>;
  /** The packages of an installation: one per TinyTeX, whose tlmgr calls wait for each other. */
  packages(bins: TexBinaries): PackageManager;
  params(): RenderParams;
  status(s: LatexStatus): void;
}

/** The distribution in `pdflatex --version`'s first line: « TeX Live 2026 ». */
export function distribution(version: string): string {
  return /\((TeX Live [^)]*)\)/.exec(version)?.[1] ?? version;
}

const notFound = (file: string) => `Paquet LaTeX introuvable pour « ${file} » (hors ligne ?)`;
const INSTALLING: CompileAnswer = { status: 'unavailable', reason: 'installing', message: 'LaTeX est en cours d’installation.' };
const ABSENT: CompileAnswer = { status: 'unavailable', reason: 'absent', message: 'LaTeX n’est pas installé.' };

/** A request in flight; ended by a newer request of its slot, or by its cancellation. */
class Ticket {
  cancelled = false;
  readonly ended: Promise<void>;
  private resolve: () => void = () => {};

  constructor() {
    this.ended = new Promise((r) => { this.resolve = r; });
  }

  end(): void {
    this.cancelled = true;
    this.resolve();
  }
}

/** A lookup that did not run: every request waiting for it had ended (a name being typed). */
const SKIPPED = Symbol('skipped');
type Lookup = { waiting: Set<Ticket>; done: Promise<string | null | typeof SKIPPED> };

export class LatexSetup {
  private readonly opts: LatexSetupOptions;
  private bins: TexBinaries | null = null;
  /** TinyTeX's installation under way, and its last step said. */
  private installing: Promise<void> | null = null;
  private progress: InstallProgress | null = null;
  /** Why the last installation failed, until the next one. */
  private failure: string | null = null;
  /** The missing file whose package is being installed. */
  private looking: string | null = null;
  /** The state last told, as JSON. */
  private told = '';
  private manager: { root: string; packages: PackageManager } | null = null;
  /** The files looked up this session: their package, or null (none holds it, or tlmgr failed); never looked up again. */
  private readonly found = new Map<string, string | null>();
  /** The lookups queued or running, by file, with the requests waiting for them; they run one at a time, in order. */
  private readonly lookups = new Map<string, Lookup>();
  private chain: Promise<unknown> = Promise.resolve();
  private readonly tickets = new Map<string, Ticket>();
  /** The user's packages that `ensure` could not install this session: not tried again before the next start. */
  private readonly unensured = new Set<string>();
  private ensuring: Promise<void> | null = null;

  constructor(opts: LatexSetupOptions) {
    this.opts = opts;
  }

  /** LaTeX's state now: pdfLaTeX looked for again. */
  async state(): Promise<LatexStatus> {
    await this.refresh();
    return this.status();
  }

  /**
   * Installs TinyTeX (cirrus:latex:install), unless it is there: the state goes through `installing` (the download by
   * whole percentages, the extraction, the base packages, then the user's), then `ready`, or `failed` with the reason,
   * which stays until the next attempt. A call while one runs is that one.
   */
  install(): Promise<void> {
    this.installing ??= this.provisionOnce().finally(() => { this.installing = null; });
    return this.installing;
  }

  /**
   * The compilation of `req` (D2), through the service once LaTeX is there. For each file it misses that this request
   * has not looked up yet: its package looked up and installed (one lookup per file at a time, whoever asks; none for a
   * file looked up already this session), the prepared pdfLaTeX started again, and the compilation once more; the
   * answer names the packages installed (`installed`). A file no package holds, or that tlmgr could not look up, is
   * said: « Paquet LaTeX introuvable pour « x.sty » (hors ligne ?) ». A newer request of the slot, or its cancellation,
   * ends it at once, `cancelled`.
   */
  async compile(req: CompileRequest): Promise<CompileAnswer> {
    this.end(req.slot);
    if (this.installing) return INSTALLING;
    const bins = await this.refresh();
    if (this.installing) return INSTALLING;
    if (!bins) return this.failure === null ? ABSENT : { status: 'unavailable', reason: 'failed', message: `L’installation de LaTeX a échoué : ${this.failure}` };
    const ticket = new Ticket();
    this.tickets.set(req.slot, ticket);
    try {
      return await this.compileInstalling(req, bins, ticket);
    } finally {
      if (this.tickets.get(req.slot) === ticket) this.tickets.delete(req.slot);
    }
  }

  /** The slot's request is cancelled, waiting for a package or compiling. */
  cancel(slot: string): void {
    this.end(slot);
    this.opts.service.cancel(slot);
  }

  /**
   * The user's packages (`latexPackages`, D1), installed if missing, in the background, once the window is loaded and
   * pdfLaTeX is there: a name that fails is said in the console, and not tried again before the next start; a tlmgr
   * that cannot answer (offline, too long) too. Packages installed: the prepared pdfLaTeX started again, and `ready`
   * said again, so that the views compile again.
   */
  ensureAtStart(): Promise<void> {
    this.ensuring ??= (async () => {
      const bins = await this.refresh();
      if (!bins || this.installing) return;
      const installed = await this.ensureNames(bins, this.opts.params().latexPackages);
      if (installed.length === 0) return;
      this.opts.service.restart();
      this.tell(true);
    })().finally(() => { this.ensuring = null; });
    return this.ensuring;
  }

  private async provisionOnce(): Promise<void> {
    // There already (a TinyTeX of one's own, or installed since): nothing is downloaded.
    if (await this.refresh()) return;
    this.failure = null;
    let percent = 0;
    this.step({ step: 'download', done: 0, total: 0 });
    const onProgress = (p: InstallProgress) => {
      if (p.step === 'download') {
        const n = p.total > 0 ? Math.floor((100 * p.done) / p.total) : 0;
        if (n === percent) return;
        percent = n;
      }
      this.step(p);
    };
    try {
      const bins = await this.opts.provision(onProgress);
      // The user's packages at best (R2.2): one tlmgr does not know never makes LaTeX uninstallable.
      const names = this.opts.params().latexPackages;
      if (names.length > 0) {
        this.step({ step: 'packages', names: [...names] });
        await this.ensureNames(bins, names);
      }
      this.bins = bins;
    } catch (e) {
      console.error('Installation de LaTeX :', e);
      this.failure = e instanceof Error ? e.message : String(e);
    }
    this.progress = null;
    this.tell();
  }

  private async compileInstalling(req: CompileRequest, bins: TexBinaries, ticket: Ticket): Promise<CompileAnswer> {
    const installed: string[] = [], tried = new Set<string>();
    let a = await this.opts.service.compile(req);
    while (a.status === 'error' && a.missing !== undefined && !tried.has(a.missing)) {
      const file = a.missing;
      tried.add(file);
      const pkg = await Promise.race([this.lookup(bins, file, ticket), ticket.ended.then(() => null)]);
      if (ticket.cancelled) return { status: 'cancelled' };
      if (pkg === null) {
        a = { ...a, error: { ...a.error, message: notFound(file) } };
        break;
      }
      if (!installed.includes(pkg)) installed.push(pkg);
      a = await this.opts.service.compile(req);
    }
    return installed.length > 0 && (a.status === 'ok' || a.status === 'error') ? { ...a, installed } : a;
  }

  /** The package of `file`: from this session's lookups, else from the one queued or running for it, else a new one. */
  private async lookup(bins: TexBinaries, file: string, ticket: Ticket): Promise<string | null> {
    for (;;) {
      if (this.found.has(file)) return this.found.get(file)!;
      let l = this.lookups.get(file);
      if (!l) {
        const waiting = new Set<Ticket>();
        l = { waiting, done: this.chain.then(() => this.installFor(bins, file, waiting)) };
        this.lookups.set(file, l);
        this.chain = l.done.catch(() => {});
      }
      l.waiting.add(ticket);
      const r = await l.done;
      if (r !== SKIPPED) return r;
      // Skipped as this request joined it: looked up for this one.
      if (ticket.cancelled) return null;
    }
  }

  /** A lookup's turn: skipped if no request waits for it any more (a name typed on), else tlmgr's search and install. */
  private async installFor(bins: TexBinaries, file: string, waiting: Set<Ticket>): Promise<string | null | typeof SKIPPED> {
    try {
      if (![...waiting].some((t) => !t.cancelled)) return SKIPPED;
      this.looking = file;
      this.tell();
      let pkg: string | null = null;
      try {
        pkg = await this.packagesOf(bins).installFor(file);
      } catch (e) {
        console.warn(`Paquet LaTeX pour « ${file} » :`, e);
      }
      this.found.set(file, pkg);
      if (pkg !== null) this.opts.service.restart();
      return pkg;
    } finally {
      this.lookups.delete(file);
      this.looking = null;
      this.tell();
    }
  }

  /** `names` not tried in vain this session, ensured; those that fail said in the console. The ones installed. */
  private async ensureNames(bins: TexBinaries, names: string[]): Promise<string[]> {
    const wanted = names.filter((n) => !this.unensured.has(n));
    if (wanted.length === 0) return [];
    try {
      const r = await this.packagesOf(bins).ensure(wanted);
      for (const f of r.failed) {
        this.unensured.add(f.name);
        console.warn(`Paquet LaTeX « ${f.name} » non installé : ${f.reason}`);
      }
      return r.installed;
    } catch (e) {
      console.warn('Paquets LaTeX non vérifiés :', e);
      return [];
    }
  }

  private packagesOf(bins: TexBinaries): PackageManager {
    let m = this.manager;
    if (!m || m.root !== bins.root) m = this.manager = { root: bins.root, packages: this.opts.packages(bins) };
    return m.packages;
  }

  private end(slot: string): void {
    const t = this.tickets.get(slot);
    if (!t) return;
    this.tickets.delete(slot);
    t.end();
  }

  private async refresh(): Promise<TexBinaries | null> {
    try {
      this.bins = await this.opts.binaries();
    } catch (e) {
      console.error('Recherche de pdfLaTeX :', e);
      this.bins = null;
    }
    this.tell();
    return this.bins;
  }

  private step(p: InstallProgress): void {
    this.progress = p;
    this.tell();
  }

  private status(): LatexStatus {
    if (this.progress) return { state: 'installing', progress: this.progress };
    if (this.looking !== null) return { state: 'installing', progress: { step: 'package', name: this.looking } };
    if (this.bins) return { state: 'ready', version: distribution(this.bins.version) };
    return this.failure === null ? { state: 'absent' } : { state: 'failed', message: this.failure };
  }

  /** The state, told when it changed; `again`, even unchanged (packages installed: the views compile again). */
  private tell(again = false): void {
    const s = this.status(), key = JSON.stringify(s);
    if (key === this.told && !again) return;
    this.told = key;
    this.opts.status(s);
  }
}
