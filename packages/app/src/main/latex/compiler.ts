import { type ChildProcess, spawn } from 'node:child_process';
import { copyFileSync, existsSync, linkSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { type CompileAnswer, type CompiledPdf, type CompileRequest, type FileRef, isStandalone, type KnownLabel, type TexError } from '@cirrus/core';
import { filePath } from '@cirrus/store';
import { PARAM_SPECS, type RenderParams } from '@cirrus/view';
import { plainName } from '../files.ts';
import type { PdfCache } from './cache.ts';
import { citedLabels, driverSource, jobBody } from './driver.ts';
import { killTree } from './kill.ts';
import { parseLog, readAux } from './log.ts';
import { missingFile, texEnv, type TexBinaries } from './tinytex.ts';

/**
 * LaTeX's compilations, in the main process (plan 4b, D2, D4): pdfLaTeX prepared ahead of time, the preamble loaded,
 * as on the bench (bench/latex/src/warmCompiler.ts); the PDFs in a local cache. Each process has its folders,
 * <root>/work/p<n> (its current directory: the driver, the preamble, the jobs) and <root>/links/p<n> (the node's files,
 * hard links to the store, which TEXINPUTS names); both are removed once it is done, and emptied at the service's
 * start. TeX writes, for the document, only in its work folder, and runs no command of it: openout_any=p, shell escape
 * off (texEnv). kpathsea may still run TeX Live's font tools (mktexpk, mktextfm, mf) for a missing font, which write
 * into TinyTeX's texmf-var (final review, I2): a pdfLaTeX is always stopped with them (killTree). TeX can read what
 * the Windows account can read: TeX Live 2026 made openin_any a no-op (ruling of task 3). LaTeX's state, its
 * installation and its missing packages are LatexSetup's (setup.ts, task 7), which stands in front of this service.
 */

export interface LatexServiceOptions {
  /** pdfLaTeX, or null while LaTeX is not installed (asked again at each compilation). */
  binaries: () => Promise<TexBinaries | null>;
  /** <base>/latex. */
  root: string;
  /** The store's folder, for the node's files. */
  store: string;
  cache: PdfCache;
  params: () => RenderParams;
}

/** The folders of one process: work/p<n>, its current directory, where its job is job-<n>; links/p<n>. */
interface Dirs { n: number; work: string; links: string }

/** A pdfLaTeX prepared with `preamble`: `ready` once the driver waits for its job's name. */
interface Warm {
  dirs: Dirs;
  preamble: string;
  child: ChildProcess;
  exited: Promise<number | null>;
  ready: boolean;
  /** Given a job: the job then removes its folders. */
  taken: boolean;
  /** Stopped on purpose (replaced, or its siblings failed): its exit says nothing. */
  dead: boolean;
  /**
   * Started for this waiter only, its preamble no longer the pool's then; detached (null) once given to it, or once the
   * waiter is given another process or settled, when it is stopped.
   */
  waiter: Waiter | null;
}

/** A request in flight. */
interface Job {
  req: CompileRequest;
  t0: number;
  done: boolean;
  resolve(a: CompileAnswer): void;
  waiter: Waiter | null;
  running: ChildProcess | null;
}

/** A job waiting for a process prepared with `preamble`; null if it is settled meanwhile. */
interface Waiter { job: Job; preamble: string; give(w: Warm | null): void; own: Warm | null }

/** A preamble that does not load: said again to each request until warm() or another preamble. */
interface Failure { error: TexError; log: string; missing?: string }

type Outcome =
  | { ok: true; pdf: string; pages: number; labels: KnownLabel[]; log: string; aux: string }
  | { ok: false; answer: CompileAnswer };

/** The variables the service sets itself, and their variants (kpathsea reads VAR.progname and VAR_progname first). */
const OWN_VARS = /^(TEXINPUTS|max_print_line|error_line|half_error_line)([._].*)?$/i;
/** A standalone document asks for another pass (LaTeX's labels, hyperref's outlines, longtable, biblatex). */
const RERUN = /Rerun to get|[Rr]erun LaTeX|Please rerun/;
const HASH = /^[0-9a-f]{64}$/;

const tooLong = (ms: number) => `Compilation trop longue (plus de ${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s) : arrêtée.`;
/** What a second pass of a standalone document would read differently: its labels, citations and tables. */
const crossRefs = (aux: string) => aux.split(/\r?\n/).filter((l) => /^\\(?:newlabel|bibcite|@writefile)\b/.test(l)).join('\n');

/** Whether a label the source both defines and refers to got another number, page or anchor than the hint gave it. */
function renumbered(cited: Set<string>, known: KnownLabel[], labels: KnownLabel[]): boolean {
  const hint = new Map(known.map((k) => [k.label, k]));
  return labels.some((l) => {
    const k = hint.get(l.label);
    return cited.has(l.label) && (!k || k.number !== l.number || k.page !== l.page || k.anchor !== l.anchor);
  });
}

function read(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export class LatexService {
  private readonly opts: LatexServiceOptions;
  private counter = 0;
  private disposed = false;
  private bins: TexBinaries | null = null;
  /** The pool's preamble: the last one asked for. */
  private preamble: string | null = null;
  /** The pool: prepared or preparing with `preamble`, not taken yet. */
  private idle: Warm[] = [];
  private failure: Failure | null = null;
  /** After a failure that may not happen again (too slow, not started): no new process until the next request. */
  private resting = false;
  /** A top-up of the pool is scheduled. */
  private filling = false;
  private queue: Waiter[] = [];
  /** The request in flight of each slot. */
  private readonly jobs = new Map<string, Job>();
  /** Every pdfLaTeX not exited yet. */
  private readonly live = new Set<{ child: ChildProcess; exited: Promise<number | null> }>();

  constructor(opts: LatexServiceOptions) {
    this.opts = opts;
    for (const d of ['work', 'links']) {
      try {
        rmSync(join(opts.root, d), { recursive: true, force: true, maxRetries: 3 });
        mkdirSync(join(opts.root, d), { recursive: true });
      } catch (e) {
        console.warn(`Dossier LaTeX ${join(opts.root, d)} non vidé :`, e);
      }
    }
  }

  /**
   * A compilation (D2, D7): from the cache at once if its key is there, without any process. Otherwise the slot's
   * previous request is cancelled, and this one waits, in order of arrival, for a pdfLaTeX prepared with its preamble
   * (the pool takes the last preamble asked for); a standalone document is compiled as it is, cold. A second pass follows
   * once at most, when this source's own labels it refers to got other numbers than `known`.
   */
  compile(req: CompileRequest): Promise<CompileAnswer> {
    const t0 = performance.now();
    if (this.disposed) return Promise.resolve({ status: 'cancelled' });
    this.cancel(req.slot);
    return new Promise<CompileAnswer>((resolve) => {
      const job: Job = { req, t0, done: false, resolve, waiter: null, running: null };
      this.jobs.set(req.slot, job);
      this.run(job).catch((e: unknown) => {
        console.error('Compilation LaTeX :', e);
        this.settle(job, this.error(job, { message: `La compilation a échoué : ${(e as Error).message}`, line: null, where: 'source' }));
      });
    });
  }

  /** The slot's request, waiting or running, is answered `cancelled`, its pdfLaTeX killed. */
  cancel(slot: string): void {
    const job = this.jobs.get(slot);
    if (job) this.settle(job, { status: 'cancelled' });
  }

  /** Prepares the pool with `preamble` (after the interface loads, or the preamble changes); again after a failure. */
  warm(preamble: string): void {
    if (this.disposed) return;
    void this.texBinaries().then((bins) => {
      if (!bins || this.disposed) return;
      if (preamble !== this.preamble || this.failure || this.resting) this.switchPool(preamble);
      else this.dispatch();
    });
  }

  /**
   * Prepares the pool again, with its preamble, its failure forgotten: packages were just installed (task 7), and a
   * prepared pdfLaTeX knows only the files kpathsea listed when it started. Requests running keep their process.
   */
  restart(): void {
    if (this.disposed || this.preamble === null) return;
    this.switchPool(this.preamble);
  }

  /**
   * Kills every pdfLaTeX, with what each started (killTree), and waits for their exit (closing the app: none survives
   * it); the requests are cancelled.
   */
  async dispose(): Promise<void> {
    this.disposed = true;
    for (const job of [...this.jobs.values()]) this.settle(job, { status: 'cancelled' });
    for (const w of this.idle) w.dead = true;
    this.idle = [];
    const all = [...this.live];
    await Promise.all(all.map(async (p) => {
      await killTree(p.child);
      await p.exited;
    }));
  }

  private async texBinaries(): Promise<TexBinaries | null> {
    let bins: TexBinaries | null = null;
    try {
      bins = await this.opts.binaries();
    } catch (e) {
      console.error('Recherche de pdfLaTeX :', e);
    }
    this.bins = bins;
    return bins;
  }

  private async run(job: Job): Promise<void> {
    const bins = await this.texBinaries();
    if (job.done) return;
    if (!bins) return this.settle(job, { status: 'unavailable', reason: 'absent', message: 'LaTeX n’est pas installé.' });
    const key = this.opts.cache.key(job.req, bins.version);
    const hit = this.opts.cache.get(key);
    if (hit) return this.settle(job, { status: 'ok', ...hit, ms: this.ms(job), cached: true });
    if (isStandalone(job.req.source)) return this.runStandalone(job, bins, key);
    if (job.req.preamble !== this.preamble || this.resting) this.switchPool(job.req.preamble);
    else if (this.failure) return this.settle(job, this.failed(job, this.failure));
    return this.runFragment(job, key);
  }

  private async runFragment(job: Job, key: string): Promise<void> {
    const cited = citedLabels(job.req.source);
    let req = job.req;
    for (let pass = 1; ; pass++) {
      const warm = await this.take(job, req.preamble, pass > 1);
      if (!warm) return;
      try {
        const out = await this.runWarm(job, warm, req);
        if (job.done) return;
        if (!out.ok) return this.settle(job, out.answer);
        if (pass === 1 && renumbered(cited, req.known, out.labels)) {
          req = { ...req, known: out.labels };
          continue;
        }
        return this.succeed(job, key, out, pass);
      } finally {
        this.clean(warm.dirs, warm.exited);
      }
    }
  }

  /** A standalone document (\documentclass), compiled as it is, cold, in folders of its own; again once if it asks. */
  private async runStandalone(job: Job, bins: TexBinaries, key: string): Promise<void> {
    const dirs = this.newDirs();
    const src = `job-${dirs.n}-src.tex`, aux = join(dirs.work, `job-${dirs.n}.aux`);
    let exited: Promise<unknown> = Promise.resolve();
    try {
      this.link(dirs, job.req.resources);
      writeFileSync(join(dirs.work, src), job.req.source, 'utf8');
      for (let pass = 1; ; pass++) {
        if (job.done) return;
        const before = read(aux);
        const t = this.spawnTex(bins, dirs, [src]);
        exited = t.exited;
        t.child.stdout?.resume();
        t.child.stdin?.end();
        job.running = t.child;
        const out = await this.finish(job, t.child, t.exited, dirs, src);
        if (job.done) return;
        if (!out.ok) return this.settle(job, out.answer);
        if (pass === 1 && (RERUN.test(out.log) || crossRefs(out.aux) !== crossRefs(before))) continue;
        return this.succeed(job, key, out, pass);
      }
    } finally {
      this.clean(dirs, exited);
    }
  }

  /** Hands the job to a prepared process: the node's files linked, the source and the body written, then the body's name. */
  private async runWarm(job: Job, warm: Warm, req: CompileRequest): Promise<Outcome> {
    const { n, work } = warm.dirs;
    const src = `job-${n}-src.tex`, body = `job-${n}-body.tex`;
    if (job.done) {
      void killTree(warm.child);
      return { ok: false, answer: { status: 'cancelled' } };
    }
    try {
      this.link(warm.dirs, req.resources);
      writeFileSync(join(work, src), req.source, 'utf8');
      writeFileSync(join(work, body), jobBody(req, src), 'utf8');
    } catch (e) {
      void killTree(warm.child);
      return { ok: false, answer: this.error(job, { message: `La compilation n’a pas pu être préparée : ${(e as Error).message}`, line: null, where: 'source' }) };
    }
    job.running = warm.child;
    warm.child.stdin?.write(`${body}\n`);
    return this.finish(job, warm.child, warm.exited, warm.dirs, src);
  }

  /**
   * Waits for the process's exit, latexTimeoutMs at most (then killed with what it started), then reads its log, its .aux
   * and its PDF.
   */
  private async finish(job: Job, child: ChildProcess, exited: Promise<number | null>, dirs: Dirs, src: string): Promise<Outcome> {
    const timeoutMs = this.opts.params().latexTimeoutMs;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      void killTree(child);
    }, timeoutMs);
    const code = await exited;
    clearTimeout(timer);
    job.running = null;
    if (job.done) return { ok: false, answer: { status: 'cancelled' } };
    // Both at once: reading a file pdfLaTeX just closed takes a few milliseconds each (measured, task 3).
    const [log, aux] = await Promise.all([`job-${dirs.n}.log`, `job-${dirs.n}.aux`].map((f) => readFile(join(dirs.work, f), 'utf8').catch(() => '')));
    if (job.done) return { ok: false, answer: { status: 'cancelled' } };
    const labels = readAux(aux);
    if (timedOut) return { ok: false, answer: this.error(job, { message: tooLong(timeoutMs), line: null, where: 'source' }, log, labels) };
    const parsed = parseLog(log, src);
    if (parsed.error) return { ok: false, answer: this.error(job, parsed.error, log, labels, missingFile(log)) };
    const pdf = join(dirs.work, `job-${dirs.n}.pdf`);
    if (code !== 0 || !existsSync(pdf)) {
      const message = code === 0 ? 'La compilation n’a produit aucune page.' : `pdfLaTeX s’est arrêté sans PDF (code ${code}).`;
      return { ok: false, answer: this.error(job, { message, line: null, where: 'source' }, log, labels) };
    }
    return { ok: true, pdf, pages: parsed.pages, labels, log, aux };
  }

  private succeed(job: Job, key: string, out: Extract<Outcome, { ok: true }>, passes: number): void {
    const log = this.tail(out.log);
    let pdf: CompiledPdf;
    try {
      pdf = this.opts.cache.put(key, out.pdf, { pages: out.pages, labels: out.labels, log, passes });
    } catch (e) {
      console.error('Cache LaTeX :', e);
      return this.settle(job, this.error(job, { message: `Le PDF compilé n’a pas pu être gardé : ${(e as Error).message}`, line: null, where: 'source' }, out.log, out.labels));
    }
    this.settle(job, { status: 'ok', pdf, labels: out.labels, log, ms: this.ms(job), passes, cached: false });
  }

  // --- the pool ---

  private take(job: Job, preamble: string, front: boolean): Promise<Warm | null> {
    return new Promise((give) => {
      const w: Waiter = { job, preamble, give, own: null };
      job.waiter = w;
      if (front) this.queue.unshift(w);
      else this.queue.push(w);
      this.dispatch();
    });
  }

  /**
   * Gives each waiter, in order, a ready process of its preamble: the one started for it alone (a waiter queued before
   * the preamble changed), once ready, whatever the pool's preamble has become since; else the pool's. Then tops the pool
   * up to latexWarmProcesses, at the next turn of the event loop: starting a process takes about 10 ms of this thread,
   * which the job just given should not wait for (measured).
   */
  private dispatch(): void {
    if (this.disposed) return;
    for (const w of [...this.queue]) {
      let warm: Warm | null = w.own?.ready ? w.own : null;
      if (!warm && w.preamble === this.preamble) {
        const i = this.idle.findIndex((x) => x.ready);
        if (i >= 0) warm = this.idle.splice(i, 1)[0];
      } else if (!warm && !w.own && this.bins) {
        w.own = this.start(this.bins, w.preamble, w);
        if (!w.own) {
          this.settle(w.job, this.unprepared(w.job));
          continue;
        }
      }
      if (warm) this.hand(w, warm);
    }
    if (this.filling) return;
    this.filling = true;
    setImmediate(() => {
      this.filling = false;
      this.fill();
    });
  }

  /** Gives `warm` to the waiter. Its own process, if it got another, is stopped and detached: it is nobody's any more. */
  private hand(w: Waiter, warm: Warm): void {
    this.queue.splice(this.queue.indexOf(w), 1);
    w.job.waiter = null;
    if (w.own !== warm) this.drop(w);
    w.own = null;
    warm.waiter = null;
    warm.taken = true;
    w.give(warm);
  }

  /** Stops the waiter's own process, if any, and detaches it: its exit or its failure no longer concerns the waiter's job. */
  private drop(w: Waiter): void {
    const own = w.own;
    if (!own) return;
    w.own = null;
    own.waiter = null;
    this.retire(own);
  }

  private fill(): void {
    if (this.disposed || this.preamble === null || this.failure || this.resting || !this.bins) return;
    const n = this.opts.params().latexWarmProcesses;
    while (this.idle.length > n) this.retire(this.idle.pop()!);
    while (this.idle.length < n) {
      const w = this.start(this.bins, this.preamble, null);
      if (w) {
        this.idle.push(w);
        continue;
      }
      // No folder for it (disk full, folder refused): the waiting requests are told, the next one tries again.
      this.resting = true;
      for (const x of this.queue.filter((q) => q.preamble === this.preamble)) this.settle(x.job, this.unprepared(x.job));
      return;
    }
  }

  /** prepare(), or null if its folders cannot be made (said in the console). */
  private start(bins: TexBinaries, preamble: string, waiter: Waiter | null): Warm | null {
    try {
      return this.prepare(bins, preamble, waiter);
    } catch (e) {
      console.error('pdfLaTeX n’a pas pu être préparé :', e);
      return null;
    }
  }

  private unprepared(job: Job): CompileAnswer {
    return this.error(job, { message: 'pdfLaTeX n’a pas pu être préparé : son dossier de travail n’a pas pu être créé.', line: null, where: 'source' });
  }

  /** The last preamble wins: the pool's processes are replaced. */
  private switchPool(preamble: string): void {
    for (const w of this.idle) this.retire(w);
    this.idle = [];
    this.preamble = preamble;
    this.failure = null;
    this.resting = false;
    this.dispatch();
  }

  private retire(w: Warm): void {
    w.dead = true;
    void killTree(w.child);
  }

  /**
   * Starts pdfLaTeX on the driver: ready when it says CIRRUS-READY. One that exits before (the preamble does not load)
   * or takes longer than latexTimeoutMs to load it fails, with the preamble's error.
   */
  private prepare(bins: TexBinaries, preamble: string, waiter: Waiter | null): Warm {
    const dirs = this.newDirs();
    writeFileSync(join(dirs.work, 'driver.tex'), driverSource(), 'utf8');
    writeFileSync(join(dirs.work, 'preamble.tex'), preamble, 'utf8');
    const { child, exited } = this.spawnTex(bins, dirs, ['driver.tex']);
    const warm: Warm = { dirs, preamble, child, exited, ready: false, taken: false, dead: false, waiter };
    const timeoutMs = this.opts.params().latexTimeoutMs;
    let out = '';
    const onData = (d: Buffer) => {
      out += d.toString('latin1');
      if (!out.includes('CIRRUS-READY')) return;
      child.stdout!.off('data', onData);
      child.stdout!.resume(); // drained, so that pdfLaTeX never waits on a full pipe
      clearTimeout(timer);
      warm.ready = true;
      this.dispatch();
    };
    child.stdout!.on('data', onData);
    const timer = setTimeout(() => {
      if (warm.ready || warm.dead) return;
      this.retire(warm);
      this.prepFailed(warm, { error: { message: tooLong(timeoutMs), line: null, where: 'preamble' }, log: '' }, false);
    }, timeoutMs);
    void exited.then((code) => {
      clearTimeout(timer);
      if (warm.taken) return;
      this.idle = this.idle.filter((x) => x !== warm);
      this.clean(dirs, exited);
      if (warm.ready || warm.dead) return;
      const log = read(join(dirs.work, `job-${dirs.n}.log`));
      const parsed = parseLog(log, `job-${dirs.n}-src.tex`).error;
      const error = parsed ?? { message: `Le préambule ne compile pas : pdfLaTeX s’est arrêté (code ${code}).`, line: null, where: 'preamble' as const };
      const missing = missingFile(log) ?? undefined;
      // An exit with a log is the preamble's doing, the same each time; without one, pdfLaTeX did not start.
      this.prepFailed(warm, { error, log, ...(missing ? { missing } : {}) }, log !== '');
    });
    return warm;
  }

  /**
   * A process that could not load its preamble. One started for a waiter fails that waiter, unless the pool has its
   * preamble again: the pool then serves it, or fails it with the same error. Otherwise the requests waiting for the
   * pool's preamble fail, when the failure is that preamble's (the pool stops, and the next requests get it at once) or
   * when no other process may still load it.
   */
  private prepFailed(warm: Warm, f: Failure, deterministic: boolean): void {
    this.idle = this.idle.filter((x) => x !== warm);
    const w = warm.waiter;
    if (w) {
      warm.waiter = null;
      if (w.own === warm) w.own = null;
      if (w.preamble !== this.preamble) this.settle(w.job, this.failed(w.job, f));
      else this.dispatch();
      return;
    }
    if (warm.preamble !== this.preamble) return;
    if (deterministic) {
      this.failure = f;
      for (const w of this.idle) this.retire(w);
      this.idle = [];
    } else if (this.idle.length > 0) return;
    else this.resting = true;
    for (const w of this.queue.filter((x) => x.preamble === warm.preamble)) this.settle(w.job, this.failed(w.job, f));
  }

  // --- processes, folders, answers ---

  private newDirs(): Dirs {
    const n = ++this.counter;
    const dirs = { n, work: join(this.opts.root, 'work', `p${n}`), links: join(this.opts.root, 'links', `p${n}`) };
    mkdirSync(dirs.work, { recursive: true });
    mkdirSync(dirs.links, { recursive: true });
    return dirs;
  }

  /**
   * pdfLaTeX in `dirs.work`, under texEnv's environment. TEXINPUTS names the links folder by a relative path (the final
   * « ; » keeps the distribution's): an absolute one is not found under an accented base path, kpathsea reading the
   * environment in the ANSI code page (measured, task 3). max_print_line keeps the log's lines whole (parseLog).
   */
  private spawnTex(bins: TexBinaries, dirs: Dirs, args: string[]): { child: ChildProcess; exited: Promise<number | null> } {
    const env = texEnv(process.env);
    for (const k of Object.keys(env)) if (OWN_VARS.test(k)) delete env[k];
    Object.assign(env, { TEXINPUTS: `../../links/p${dirs.n};`, max_print_line: '100000', error_line: '254', half_error_line: '238' });
    const child = spawn(bins.pdflatex, ['-no-shell-escape', '-interaction=nonstopmode', '-halt-on-error', `-jobname=job-${dirs.n}`, ...args], {
      cwd: dirs.work, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    });
    // Writing to a process that is gone: its outcome already says why.
    child.stdin?.on('error', () => {});
    child.stderr?.resume();
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', (e) => {
        console.error('pdfLaTeX :', e);
        resolve(null);
      });
    });
    const entry = { child, exited };
    this.live.add(entry);
    void exited.then(() => this.live.delete(entry));
    return entry;
  }

  /**
   * The node's files under their names, each a hard link to the store (a copy if the link fails: another volume). A name
   * already there is unlinked first: copying onto a link would write into the store's file.
   */
  private link(dirs: Dirs, resources: FileRef[]): void {
    for (const r of resources) {
      if (!plainName(r.name)) continue;
      const from = filePath(this.opts.store, r), to = join(dirs.links, r.name);
      rmSync(to, { force: true });
      try {
        linkSync(from, to);
      } catch {
        copyFileSync(from, to);
      }
    }
  }

  /** Removes a process's folders once it has exited (Windows keeps a running process's folder). */
  private clean(dirs: Dirs, exited: Promise<unknown>): void {
    void exited.then(async () => {
      for (const d of [dirs.work, dirs.links]) {
        try {
          await rm(d, { recursive: true, force: true, maxRetries: 5 });
        } catch (e) {
          console.warn(`Dossier LaTeX ${d} non effacé :`, e);
        }
      }
    });
  }

  private settle(job: Job, a: CompileAnswer): void {
    if (job.done) return;
    job.done = true;
    if (this.jobs.get(job.req.slot) === job) this.jobs.delete(job.req.slot);
    const w = job.waiter;
    if (w) {
      job.waiter = null;
      this.queue = this.queue.filter((x) => x !== w);
      this.drop(w);
      w.give(null);
    }
    if (job.running) void killTree(job.running);
    job.resolve(a);
  }

  private ms(job: Job): number {
    return Math.round(performance.now() - job.t0);
  }

  /** The end of a log, latexLogMaxKb at most, cut between two characters. */
  private tail(log: string): string {
    const max = this.opts.params().latexLogMaxKb * 1024;
    const bytes = Buffer.from(log, 'utf8');
    if (bytes.length <= max) return log;
    let start = bytes.length - max;
    while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++;
    return bytes.subarray(start).toString('utf8');
  }

  private error(job: Job, error: TexError, log = '', labels: KnownLabel[] = [], missing?: string | null): CompileAnswer {
    return { status: 'error', error, labels, log: this.tail(log), ms: this.ms(job), ...(missing ? { missing } : {}) };
  }

  private failed(job: Job, f: Failure): CompileAnswer {
    return this.error(job, f.error, f.log, [], f.missing);
  }
}

const isText = (v: unknown): v is string => typeof v === 'string';
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const listOf = (v: unknown, item: (x: unknown) => boolean) => Array.isArray(v) && v.every(item);
const isRef = (x: unknown) => isRecord(x) && isText(x.label) && isText(x.title) && (x.node === null || isText(x.node));
const isCite = (x: unknown) => isRecord(x) && isText(x.key) && isText(x.text) && isText(x.node);

/** What cirrus:latex:compile answers a request it refuses (its cause in the console). */
export const INVALID_REQUEST: CompileAnswer = {
  status: 'error', error: { message: 'Requête de compilation invalide.', line: null, where: 'source' }, labels: [], log: '', ms: 0,
};

/** latexSnippetWidthCm's bounds: a snippet's width outside them never reaches TeX. */
const WIDTH = PARAM_SPECS.find((p) => p.key === 'latexSnippetWidthCm')!;

/**
 * Why a request from the interface is refused, or null: every field of the form CompileRequest says, a source of
 * `maxSourceBytes` at most (textViewMaxMb), a snippet's width within latexSnippetWidthCm's bounds (none for a page),
 * resources of plain names whose hash is in the store.
 */
export function invalidRequest(x: unknown, store: string, maxSourceBytes: number): string | null {
  if (!isRecord(x)) return 'pas un objet';
  if (!isText(x.slot) || x.slot === '') return 'emplacement';
  if (x.mode !== 'snippet' && x.mode !== 'page') return 'mode';
  if (!isText(x.source)) return 'source';
  if (Buffer.byteLength(x.source, 'utf8') > maxSourceBytes) return `source de plus de ${maxSourceBytes} octets`;
  if (!isText(x.preamble)) return 'préambule';
  if (x.mode === 'page' ? x.widthCm !== null : typeof x.widthCm !== 'number' || !(x.widthCm >= WIDTH.min! && x.widthCm <= WIDTH.max!)) return 'largeur';
  if (!listOf(x.refs, isRef)) return 'refs';
  if (!listOf(x.broken, isText)) return 'broken';
  if (!listOf(x.doubled, isRef)) return 'doubled';
  if (!listOf(x.cites, isCite)) return 'cites';
  if (!listOf(x.doubledCites, isCite)) return 'doubledCites';
  if (!listOf(x.unknownCites, isText)) return 'unknownCites';
  if (!listOf(x.known, (k) => isRecord(k) && isText(k.label) && isText(k.number) && isText(k.page) && isText(k.anchor))) return 'known';
  if (!Array.isArray(x.resources)) return 'resources';
  for (const r of x.resources as unknown[]) {
    if (!isRecord(r) || !isText(r.name) || !isText(r.hash) || typeof r.size !== 'number') return 'ressource mal formée';
    if (!plainName(r.name)) return `nom de ressource refusé : ${r.name.slice(0, 200)}`;
    if (!HASH.test(r.hash)) return `empreinte refusée : ${r.hash.slice(0, 200)}`;
    try {
      if (!statSync(filePath(store, { name: r.name, hash: r.hash, size: r.size })).isFile()) return `ressource absente du magasin : ${r.hash}`;
    } catch {
      return `ressource absente du magasin : ${r.hash}`;
    }
  }
  return null;
}
