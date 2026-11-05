import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readdirSync, renameSync, rmdirSync, rmSync, statSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

/**
 * The LaTeX distribution (plan 4b, D1): TinyTeX, downloaded the first time it is needed, after the user's consent, into
 * %LOCALAPPDATA%\Cirrus\TinyTeX. The release is pinned and its SHA-256 checked before it is run; missing packages come
 * from TeX Live's repository through tlmgr. Electron stays out of this module: the download's fetch is handed in.
 */

export interface TinyTexRelease { version: string; asset: string; url: string; sha256: string; bytes: number }

/** TinyTeX-1 for Windows, v2026.11 (TeX Live 2026, pdfTeX 1.40.29): the bench's, downloaded and hashed on 2026-11-05. */
export const TINYTEX_RELEASE: TinyTexRelease & { version: 'v2026.11' } = {
  version: 'v2026.11',
  asset: 'TinyTeX-1-windows-v2026.11.exe',
  url: 'https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/TinyTeX-1-windows-v2026.11.exe',
  sha256: '375e8adec0177cd9ec6a1f8c76efe0c22b1a0c260e76a00386bcea52d88e5354',
  bytes: 73_710_178,
};

/** The packages every installation gets: DEFAULT_PREAMBLE's, and pgf for TikZ. Task 7's withPackage reads it (ruling P1). */
export const BASE_PACKAGES: readonly string[] = ['pgf', 'xcolor', 'hyperref', 'amsmath', 'amsfonts', 'amscls', 'lm', 'graphics'];

export interface TexBinaries { root: string; pdflatex: string; tlmgr: string; version: string }

export interface Deps {
  /** Writes `url` to `dest`, calling onBytes with the bytes written so far. */
  download(url: string, dest: string, onBytes: (n: number) => void): Promise<void>;
  /** Runs a program to its end: its exit code, and its output then its errors. Rejects only if it could not run. */
  run(file: string, args: string[]): Promise<{ code: number; out: string }>;
}

export type Progress = { step: 'download'; done: number; total: number } | { step: 'extract' } | { step: 'packages'; names: string[] };

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
const TEX_PATHS = variants(['TEXMFOUTPUT', 'TEXINPUTS', 'TEXMFHOME', 'TEXMFCNF']);
const SANDBOX = { openin_any: 'p', openout_any: 'p', shell_escape: 'f' };
const SANDBOX_VARS = variants(Object.keys(SANDBOX));

function copyEnv(env: Record<string, string | undefined>, drop: RegExp[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && !drop.some((d) => d.test(k))) out[k] = v;
  return out;
}

/**
 * The environment of a TeX process (D4): it reads only its folder, its distribution and what TEXINPUTS names (the
 * compiler sets it), writes only in its folder (names absolute or going up refused) and runs nothing.
 */
export function texEnv(env: Record<string, string | undefined>): Record<string, string> {
  return { ...copyEnv(env, [TEX_PATHS, SANDBOX_VARS]), ...SANDBOX };
}

/** The words a .bat may receive: cmd.exe would read any other character as an operator, a quote or a variable. */
const SHELL_SAFE = /^[A-Za-z0-9._/=-]+$/;

/**
 * The production `run`, hidden window. A .bat goes through cmd.exe (Node refuses to start one alone), its command line
 * built here from checked words, and by `call`: started alone, a batch that ends by `goto :eof`, as tlmgr.bat does,
 * loses its exit code (a failed tlmgr install gave 0). TeX's tools get the environment without the user's own TeX
 * paths, so that a TeX of the system never stands in for TinyTeX's trees.
 */
export function runFile(file: string, args: string[]): Promise<{ code: number; out: string }> {
  const bat = /\.(bat|cmd)$/i.test(file);
  const unsafe = bat ? [file, ...args].find((a, i) => (i === 0 ? /["%^]/.test(a) : !SHELL_SAFE.test(a))) : undefined;
  if (unsafe !== undefined) return Promise.reject(new Error(`Argument refusé pour ${basename(file)} : ${unsafe}`));
  const [cmd, argv] = bat ? [process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"call "${file}" ${args.join(' ')}"`]] : [file, args];
  return new Promise((done, fail) => {
    execFile(cmd, argv, {
      windowsHide: true, windowsVerbatimArguments: bat, maxBuffer: 64 * 2 ** 20, env: copyEnv(process.env, [TEX_PATHS]),
    }, (e, stdout, stderr) => {
      // A number is the exit code; anything else (ENOENT, a signal, too much output) means it did not run to its end.
      if (e && typeof e.code !== 'number') fail(e);
      else done({ code: e ? (e.code as number) : 0, out: `${stdout}${stderr}` });
    });
  });
}

/** The production `download`: the response streamed to the file, `fetchFn` being Electron's net.fetch in the app. */
export function fetchDownload(fetchFn: (url: string) => Promise<Response>): Deps['download'] {
  return async (url, dest, onBytes) => {
    const file = await open(dest, 'w');
    try {
      const res = await fetchFn(url);
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      const reader = res.body.getReader();
      for (let n = 0; ;) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.write(value);
        onBytes((n += value.byteLength));
      }
    } catch (e) {
      throw new Error(`Le téléchargement de TinyTeX a échoué (${(e as Error).message}).`);
    } finally {
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

/** The last non-empty line of a tool's output: its reason, most often. */
const lastLine = (out: string) => out.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).at(-1) ?? '';

async function tlmgr(run: Deps['run'], bin: string, args: string[]): Promise<string> {
  const r = await run(bin, args);
  if (r.code !== 0) throw new Error(`tlmgr ${args[0]} a échoué (code ${r.code}) : ${lastLine(r.out)}`);
  return r.out;
}

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
 * <root>.partial, its tlmgr updated (the bundled one refuses a newer repository) and the packages installed, then
 * renamed into place. Any failure leaves neither <root> nor .partial nor .download: a half-done installation never
 * counts as installed. An existing <root> is taken only if empty: another one is the user's, never removed.
 */
export async function provision(
  root: string, deps: Deps, packages: string[], onProgress: (p: Progress) => void, release: TinyTexRelease = TINYTEX_RELEASE,
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
  const names = [...new Set([...BASE_PACKAGES, ...packages])];
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
    onProgress({ step: 'packages', names });
    const tl = join(binDir(staged), 'tlmgr.bat');
    await tlmgr(deps.run, tl, ['update', '--self']);
    await tlmgr(deps.run, tl, ['install', ...names]);
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

/** On `tlmgr search --global --file /<file>`'s output (each package, then its files, indented): the first package with a file ending exactly in /<file>. */
export function packageOf(out: string, file: string): string | null {
  let pkg: string | null = null;
  for (const line of out.split(/\r?\n/)) {
    const head = /^(\S+):$/.exec(line);
    if (head) pkg = head[1];
    else if (pkg !== null && /^\s/.test(line) && line.trim().endsWith(`/${file}`)) return pkg;
  }
  return null;
}

/** TinyTeX's packages, through its tlmgr: one tlmgr runs at a time, each call waiting for the previous ones. */
export class Packages {
  private readonly bins: TexBinaries;
  private readonly run: Deps['run'];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(bins: TexBinaries, run: Deps['run']) {
    this.bins = bins;
    this.run = run;
  }

  /** The installed packages, read from the local database (no network). */
  installed(): Promise<Set<string>> {
    return this.turn(() => this.list());
  }

  /** Installs those of `names` not installed yet; returns them. */
  ensure(names: string[]): Promise<string[]> {
    return this.turn(async () => {
      const have = await this.list();
      const missing = [...new Set(names)].filter((n) => !have.has(n));
      if (missing.length > 0) await this.install(missing);
      return missing;
    });
  }

  /** Installs the package holding `file` (from missingFile); returns it, or null if no package holds that file. */
  installFor(file: string): Promise<string | null> {
    return this.turn(async () => {
      const pkg = packageOf(await tlmgr(this.run, this.bins.tlmgr, ['search', '--global', '--file', `/${file}`]), file);
      if (pkg !== null) await this.install([pkg]);
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
   * TeX Live updates tlmgr itself during the year, and an older one then refuses to install anything: it is updated,
   * and the installation tried once more.
   */
  private async install(names: string[]): Promise<void> {
    const r = await this.run(this.bins.tlmgr, ['install', ...names]);
    if (r.code === 0) return;
    if (!r.out.includes('tlmgr itself needs to be updated')) throw new Error(`tlmgr install a échoué (code ${r.code}) : ${lastLine(r.out)}`);
    await tlmgr(this.run, this.bins.tlmgr, ['update', '--self']);
    await tlmgr(this.run, this.bins.tlmgr, ['install', ...names]);
  }
}
