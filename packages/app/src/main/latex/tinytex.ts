import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { BASE_PACKAGES, type InstallProgress } from '@cirrus/core';
import { killTree } from './kill.ts';
import { LATEX_SOURCES, type TinyTexRelease } from './sources.ts';

/**
 * The LaTeX distribution (plan 4b, D1): TinyTeX, downloaded the first time it is needed, after the user's consent, into
 * %LOCALAPPDATA%\Cirrus\TinyTeX. The release is pinned and its SHA-256 checked before it is run; missing packages come
 * from TeX Live's repository through tlmgr. Where both come from is LATEX_SOURCES' (sources.ts). Electron stays out of
 * this module: the download's fetch is handed in.
 */

export type { TinyTexRelease } from './sources.ts';

/** The pinned TinyTeX release (LATEX_SOURCES.tinytex). */
export const TINYTEX_RELEASE: TinyTexRelease = LATEX_SOURCES.tinytex;

export interface TexBinaries { root: string; pdflatex: string; tlmgr: string; version: string }

export interface Deps {
  /** Writes `url` to `dest`, calling onBytes with the bytes written so far. */
  download(url: string, dest: string, onBytes: (n: number) => void): Promise<void>;
  /** Runs a program to its end: its exit code, and its output then its errors. Rejects only if it could not run, or was stopped. */
  run(file: string, args: string[]): Promise<{ code: number; out: string }>;
}

/** The interface shows it too (LatexStatus): its type lives in @cirrus/core. */
export type Progress = InstallProgress;

/** CIRRUS_TINYTEX if set (a TinyTeX of one's own, the tests' and the captures'), else %LOCALAPPDATA%\Cirrus\TinyTeX. */
export function tinyTexRoot(env: Record<string, string | undefined>): string {
  if (env.CIRRUS_TINYTEX) return env.CIRRUS_TINYTEX;
  if (!env.LOCALAPPDATA) throw new Error('Dossier de LaTeX introuvable : LOCALAPPDATA n’est pas défini.');
  return join(env.LOCALAPPDATA, 'Cirrus', 'TinyTeX');
}

const binDir = (root: string) => join(root, 'bin', 'windows');

/** The distribution in `root`, if its pdflatex.exe and tlmgr.bat are there and pdflatex --version answers. */
export async function findBinaries(root: string, run: Deps['run'] = runFile): Promise<TexBinaries | null> {
  const pdflatex = join(binDir(root), 'pdflatex.exe'), tlmgr = join(binDir(root), 'tlmgr.bat');
  if (!existsSync(pdflatex) || !existsSync(tlmgr)) return null;
  try {
    const r = await run(pdflatex, ['--version']);
    const version = r.out.split(/\r?\n/)[0].trim();
    return r.code === 0 && version !== '' ? { root, pdflatex, tlmgr, version } : null;
  } catch {
    return null;
  }
}

/**
 * The variables kpathsea would read instead of ours: Windows ignores the case of a name, and kpathsea reads VAR.progname
 * and VAR_progname before VAR.
 */
const variants = (names: string[]) => new RegExp(`^(${names.join('|')})([._].*)?$`, 'i');
/** TEXMF_OUTPUT_DIRECTORY (TeX Live 2024) would send every file TeX writes elsewhere. */
const TEX_PATHS = variants(['TEXMFOUTPUT', 'TEXMF_OUTPUT_DIRECTORY', 'TEXINPUTS', 'TEXMFHOME', 'TEXMFCNF']);
// No openin_any: TeX Live 2026 made it a no-op (texmf.cnf), and setting it would pretend to restrict reads.
const SANDBOX = { openout_any: 'p', shell_escape: 'f' };
const SANDBOX_VARS = variants(Object.keys(SANDBOX));

function copyEnv(env: Record<string, string | undefined>, drop: RegExp[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.some((d) => d.test(k))) out[k] = v;
  return out;
}

/**
 * The environment of a TeX process (D4, as ruled in task 3 and in the final review): for the document, it writes only
 * in its folder (names absolute or going up refused) and runs no command (\write18 refused); it reads what the Windows
 * account can read, TEXINPUTS (the compiler sets it) naming the node's files. TeX Live's own font tools (mktexpk,
 * mktextfm, mf) stay allowed: kpathsea runs them for a missing font, and they write into TinyTeX's texmf-var.
 */
export function texEnv(env: Record<string, string | undefined>): Record<string, string> {
  return { ...copyEnv(env, [TEX_PATHS, SANDBOX_VARS]), ...SANDBOX };
}

/**
 * The words a .bat may receive: cmd.exe would read any other character as an operator, a quote or a variable. « : »
 * means nothing to it inside an argument, and lets a repository's address through (LATEX_SOURCES).
 */
const SHELL_SAFE = /^[A-Za-z0-9._/:=-]+$/;

const seconds = (ms: number) => `${(ms / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 })} s`;

/**
 * The production `run`, hidden window. A .bat goes through cmd.exe (Node refuses to start one alone), its command line
 * built here from checked words, and by `call`: started alone, a batch that ends by `goto :eof`, as tlmgr.bat does,
 * loses its exit code (a failed tlmgr install gave 0). TeX's tools get the environment without the user's own TeX
 * paths, so that a TeX of the system never stands in for TinyTeX's trees. A run longer than `timeoutMs`
 * (latexTlmgrTimeoutMs) is stopped with every process it started, and rejects: « tlmgr ne répond plus (plus de 600 s) :
 * arrêté. ».
 */
export function runFile(file: string, args: string[], timeoutMs = Infinity): Promise<{ code: number; out: string }> {
  const bat = /\.(bat|cmd)$/i.test(file);
  const unsafe = bat ? [file, ...args].find((a, i) => (i === 0 ? /["%^]/.test(a) : !SHELL_SAFE.test(a))) : undefined;
  if (unsafe !== undefined) return Promise.reject(new Error(`Argument refusé pour ${basename(file)} : ${unsafe}`));
  const [cmd, argv] = bat ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"call "${file}" ${args.join(' ')}"`]] : [file, args];
  return new Promise((done, fail) => {
    let late = false;
    const child = execFile(cmd, argv, {
      windowsHide: true, windowsVerbatimArguments: bat, maxBuffer: 64 * 2 ** 20, env: copyEnv(process.env, [TEX_PATHS]),
    }, (e, stdout, stderr) => {
      clearTimeout(timer);
      if (late) fail(new Error(`${basename(file, extname(file))} ne répond plus (plus de ${seconds(timeoutMs)}) : arrêté.`));
      // A number is the exit code; anything else (ENOENT, a signal, too much output) means it did not run to its end.
      else if (e && typeof e.code !== 'number') fail(e);
      else done({ code: e ? (e.code as number) : 0, out: `${stdout}${stderr}` });
    });
    const timer = Number.isFinite(timeoutMs) ? setTimeout(() => { late = true; void killTree(child); }, timeoutMs) : undefined;
  });
}

/**
 * The production `download`: the response streamed to the file, `fetchFn` being Electron's net.fetch in the app. A
 * connection that brings nothing for `stallMs()` (latexDownloadStallMs) — no response, or no bytes since the last
 * ones — is stopped, its request aborted, and the download fails: « Le téléchargement de TinyTeX a échoué (aucune
 * donnée depuis 60 s). », after which the notice offers « Réessayer » (final review). Without it, a stalled connection
 * kept the installation, and every compilation, waiting until the app was restarted.
 */
export function fetchDownload(
  fetchFn: (url: string, init: { signal: AbortSignal }) => Promise<Response>, stallMs: () => number,
): Deps['download'] {
  return async (url, dest, onBytes) => {
    const file = await open(dest, 'w');
    const abort = new AbortController();
    const ms = stallMs();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stall: (e: Error) => void = () => {};
    const stalled = new Promise<never>((_resolve, reject) => { stall = reject; });
    stalled.catch(() => {});
    /** The watchdog, started again at each piece received. */
    const watch = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        const e = new Error(`aucune donnée depuis ${seconds(ms)}`);
        abort.abort(e);
        stall(e);
      }, ms);
    };
    try {
      watch();
      const res = await Promise.race([fetchFn(url, { signal: abort.signal }), stalled]);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      try {
        for (let n = 0; ;) {
          const { done, value } = await Promise.race([reader.read(), stalled]);
          if (done) break;
          watch();
          await file.write(value);
          onBytes((n += value.byteLength));
        }
      } finally {
        // Not waited for: a stalled source may never answer it.
        void reader.cancel().catch(() => {});
      }
    } catch (e) {
      // Stopped by the watchdog: its reason, whatever the request's own error says.
      const why = abort.signal.aborted ? (abort.signal.reason as Error) : (e as Error);
      throw new Error(`Le téléchargement de TinyTeX a échoué (${why.message}).`);
    } finally {
      clearTimeout(timer);
      await file.close();
    }
  };
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

const remove = (path: string) => rmSync(path, { recursive: true, force: true, maxRetries: 10 });
/** Cleaning up never hides the error that called for it; what is left is cleared by the next run. */
function cleanUp(...paths: string[]): void {
  for (const p of paths) {
    try {
      remove(p);
    } catch (e) {
      console.warn(`Nettoyage de ${p} impossible :`, e);
    }
  }
}

/**
 * tlmgr's lines that name no cause (tlmgr.pl): the closing line of any failed run, after its cause; an action's own;
 * the repository it used; a warning's frame.
 */
const GENERIC = /An error has occurred\. See above messages\. Exiting\.|action \S+ returned an error|please see warning above|: package repository |^=+$/;
const linesOf = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);

/** Why a tlmgr run failed: its last line that names a cause, else its last line. */
function reasonOf(out: string): string {
  const lines = linesOf(out);
  return lines.filter((l) => !GENERIC.test(l)).at(-1) ?? lines.at(-1) ?? '';
}

/** tlmgr's last line about `name` (« package x not present in repository. »), if any. */
function reasonFor(out: string, name: string): string | undefined {
  return linesOf(out).filter((l) => !GENERIC.test(l) && l.split(/\s+/).some((w) => w.replace(/[.,:;]+$/, '') === name)).at(-1);
}

const tlmgrError = (args: string[], r: { code: number; out: string }) => new Error(`tlmgr ${args[0]} a échoué (code ${r.code}) : ${reasonOf(r.out)}`);

/** tlmgr's `args` (the action first, which its error names), after its global options `global`. */
async function tlmgr(run: Deps['run'], bin: string, args: string[], global: string[] = []): Promise<string> {
  const r = await run(bin, [...global, ...args]);
  if (r.code !== 0) throw tlmgrError(args, r);
  return r.out;
}

/**
 * The package names tlmgr may receive: a letter or a digit first, so that none reads as one of its options
 * (`--repository=…`); `latexPackages` holds the same words (WORD, @cirrus/view), and will be synced (plan 5).
 */
const PACKAGE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Windows will not move a folder while a file in it is open: a scanner may still be reading the fresh binaries. */
async function renameRetrying(from: string, to: string): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (attempt >= 20 || !(code === 'EPERM' || code === 'EACCES' || code === 'EBUSY')) throw e;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}

/**
 * Installs TinyTeX into `root` (D1): the pinned release downloaded into <root>.download and checked, extracted into
 * <root>.partial, set on TeX Live's own repository (LATEX_SOURCES.repository: CTAN's mirrors, rather than TinyTeX's),
 * its tlmgr updated (the bundled one refuses a newer repository) and BASE_PACKAGES installed, then renamed into place.
 * Any failure leaves neither <root> nor .partial nor .download: a half-done installation never counts as installed.
 * An existing <root> is taken only if empty: another one is the user's, never removed. The user's packages come
 * after, by Packages.ensure: a name tlmgr does not know never makes LaTeX uninstallable.
 */
export async function provision(
  root: string, deps: Deps, onProgress: (p: Progress) => void, release: TinyTexRelease = TINYTEX_RELEASE,
): Promise<TexBinaries> {
  if (process.platform !== 'win32') throw new Error('LaTeX ne s’installe automatiquement que sous Windows : indique une TinyTeX par CIRRUS_TINYTEX.');
  root = resolve(root);
  if (existsSync(root)) {
    if (!statSync(root).isDirectory() || readdirSync(root).length > 0) {
      throw new Error(`Le dossier ${root} existe déjà mais ne contient pas de TinyTeX qui fonctionne : supprime-le pour réinstaller LaTeX.`);
    }
    rmdirSync(root); // empty, or it fails
  }
  const downloads = `${root}.download`, partial = `${root}.partial`, staged = join(partial, 'TinyTeX');
  try {
    remove(downloads);
    remove(partial);
    mkdirSync(downloads, { recursive: true });
    mkdirSync(partial);
    const exe = join(downloads, release.asset);
    await deps.download(release.url, exe, (done) => onProgress({ step: 'download', done, total: release.bytes }));
    if (statSync(exe).size !== release.bytes || await sha256Of(exe) !== release.sha256) {
      throw new Error('Le téléchargement de TinyTeX est corrompu (empreinte inattendue).');
    }
    onProgress({ step: 'extract' });
    const x = await deps.run(exe, ['-y', `-o${partial}`]);
    if (x.code !== 0) throw new Error(`La décompression de TinyTeX a échoué (code ${x.code}).`);
    onProgress({ step: 'packages', names: [...BASE_PACKAGES] });
    const tl = join(binDir(staged), 'tlmgr.bat');
    await tlmgr(deps.run, tl, ['option', 'repository', LATEX_SOURCES.repository]);
    await tlmgr(deps.run, tl, ['update', '--self']);
    await tlmgr(deps.run, tl, ['install', ...BASE_PACKAGES]);
    const bins = await findBinaries(staged, deps.run);
    if (!bins) throw new Error('L’installation de TinyTeX est incomplète : pdfLaTeX ne répond pas.');
    // The last step, and atomic: <root> appears whole or not at all.
    await renameRetrying(staged, root);
    return { root, pdflatex: join(binDir(root), 'pdflatex.exe'), tlmgr: join(binDir(root), 'tlmgr.bat'), version: bins.version };
  } finally {
    cleanUp(downloads, partial);
  }
}

const PACKAGE_FILE = /^! LaTeX Error: File `([A-Za-z0-9._-]+\.(?:sty|cls|bst|fd|def|clo|cfg|ldf))' not found\./m;

/**
 * The file a package would provide, from pdfLaTeX's log (`! LaTeX Error: File `x.sty' not found.`). A missing
 * `\input{annexe}` is no package; nor is a name cmd.exe could read as a command, since it goes to tlmgr.
 */
export function missingFile(log: string): string | null {
  return PACKAGE_FILE.exec(log)?.[1] ?? null;
}

/**
 * On `tlmgr search --global --file /<file>`'s output (each package, then its files, indented): the first package with
 * a file ending exactly in /<file> under texmf-dist/tex/, where TeX looks; else the first with one anywhere (a
 * documentation or a source tree may carry a copy of another package's file).
 */
export function packageOf(out: string, file: string): string | null {
  let pkg: string | null = null, anywhere: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const head = /^(\S+):$/.exec(line);
    if (head) pkg = head[1];
    else if (pkg !== null && /^\s/.test(line) && line.trim().endsWith(`/${file}`)) {
      if (/^(texmf-dist|RELOC)\/tex\//.test(line.trim())) return pkg;
      anywhere ??= pkg;
    }
  }
  return anywhere;
}

/**
 * TinyTeX's packages, through its tlmgr: one tlmgr runs at a time, each call waiting for the previous ones. Each call
 * that reaches the network names `repository` (LATEX_SOURCES'): a new source reaches the installations made before it.
 */
export class Packages {
  private readonly bins: TexBinaries;
  private readonly run: Deps['run'];
  private readonly global: string[];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(bins: TexBinaries, run: Deps['run'], repository = LATEX_SOURCES.repository) {
    this.bins = bins;
    this.run = run;
    this.global = ['--repository', repository];
  }

  /** The installed packages, read from the local database (no network). */
  installed(): Promise<Set<string>> {
    return this.turn(() => this.list());
  }

  /**
   * Installs those of `names` not installed yet, at best: the user's packages (`latexPackages`), after `provision` and
   * at each start. A name tlmgr does not know, or that it may not receive, fails alone, with its reason; a tlmgr
   * that fails altogether (offline) fails every name with its cause. It throws only if the local list is unreadable.
   */
  ensure(names: string[]): Promise<{ installed: string[]; failed: { name: string; reason: string }[] }> {
    return this.turn(async () => {
      const unique = [...new Set(names)];
      const failed = unique.filter((n) => !PACKAGE_NAME.test(n)).map((name) => ({ name, reason: 'nom de paquet invalide' }));
      const valid = unique.filter((n) => PACKAGE_NAME.test(n));
      if (valid.length === 0) return { installed: [], failed };
      const have = await this.list();
      const missing = valid.filter((n) => !have.has(n));
      if (missing.length === 0) return { installed: [], failed };
      // One batch: tlmgr installs what it knows and names the rest. The list read again tells which went in.
      let r: { code: number; out: string };
      try {
        r = await this.install(missing);
      } catch (e) {
        r = { code: -1, out: (e as Error).message };
      }
      if (r.code === 0) return { installed: missing, failed };
      const now = await this.list().catch(() => have);
      for (const name of missing.filter((n) => !now.has(n))) failed.push({ name, reason: reasonFor(r.out, name) ?? reasonOf(r.out) });
      return { installed: missing.filter((n) => now.has(n)), failed };
    });
  }

  /**
   * Installs the package holding `file` (from missingFile); returns it, or null if no package holds that file (nor
   * one whose name tlmgr may receive). A failure of tlmgr throws, with its cause.
   */
  installFor(file: string): Promise<string | null> {
    return this.turn(async () => {
      const pkg = packageOf(await tlmgr(this.run, this.bins.tlmgr, ['search', '--global', '--file', `/${file}`], this.global), file);
      if (pkg === null || !PACKAGE_NAME.test(pkg)) return null;
      const r = await this.install([pkg]);
      if (r.code !== 0) throw tlmgrError(['install'], r);
      return pkg;
    });
  }

  private turn<T>(f: () => Promise<T>): Promise<T> {
    const p = this.queue.then(f, f);
    this.queue = p.catch(() => {});
    return p;
  }

  private async list(): Promise<Set<string>> {
    const out = await tlmgr(this.run, this.bins.tlmgr, ['info', '--list', '--only-installed', '--data', 'name']);
    return new Set(out.split(/\r?\n/).map((l) => l.trim()).filter((l) => /^\S+$/.test(l)));
  }

  /**
   * `tlmgr install`, its result returned. TeX Live updates tlmgr itself during the year, and an older one then refuses
   * to install anything: it is updated (a failure there throws), and the installation tried once more.
   */
  private async install(names: string[]): Promise<{ code: number; out: string }> {
    const r = await this.run(this.bins.tlmgr, [...this.global, 'install', ...names]);
    if (r.code === 0 || !r.out.includes('tlmgr itself needs to be updated')) return r;
    await tlmgr(this.run, this.bins.tlmgr, ['update', '--self'], this.global);
    return this.run(this.bins.tlmgr, [...this.global, 'install', ...names]);
  }
}
