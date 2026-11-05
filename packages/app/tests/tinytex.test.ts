import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BASE_PACKAGES } from '@cirrus/core';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { LATEX_SOURCES } from '../src/main/latex/sources.ts';
import {
  type Deps, findBinaries, missingFile, packageOf, Packages, type Progress, provision, runFile, texEnv, type TexBinaries, TINYTEX_RELEASE, tinyTexRoot,
} from '../src/main/latex/tinytex.ts';

// The bench's TinyTeX, read only (pdflatex --version, tlmgr info): the tests never download anything.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BENCH_TEX = process.env.CIRRUS_TINYTEX || join(repo, 'bench', 'latex', 'vendor', 'TinyTeX');
const hasTex = existsSync(join(BENCH_TEX, 'bin', 'windows', 'pdflatex.exe'));
const withTex = (name: string) => (hasTex ? name : `${name} (sauté : pas de TinyTeX dans ${BENCH_TEX})`);

let parent: string;
beforeEach(() => { parent = mkdtempSync(join(tmpdir(), 'cirrus-tinytex-')); });
afterEach(() => { rmSync(parent, { recursive: true, force: true }); });

test('TINYTEX_RELEASE : l’asset TinyTeX-1 Windows épinglé de la version v2026.11', () => {
  expect(TINYTEX_RELEASE.version).toBe('v2026.11');
  expect(TINYTEX_RELEASE.asset).toBe('TinyTeX-1-windows-v2026.11.exe');
  expect(TINYTEX_RELEASE.url).toBe(`https://github.com/rstudio/tinytex-releases/releases/download/v2026.11/${TINYTEX_RELEASE.asset}`);
  expect(TINYTEX_RELEASE.sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(TINYTEX_RELEASE.bytes).toBeGreaterThan(50e6);
  // In @cirrus/core since task 7: the interface's withPackage reads it too.
  expect(BASE_PACKAGES).toEqual(['pgf', 'xcolor', 'hyperref', 'amsmath', 'amsfonts', 'amscls', 'lm', 'graphics']);
});

test('LATEX_SOURCES : l’installateur de TinyTeX et le dépôt des paquets, en un seul endroit ; aucun autre module du principal ne nomme d’adresse ni de dépôt', () => {
  expect(LATEX_SOURCES).toEqual({ tinytex: TINYTEX_RELEASE, repository: 'ctan' });
  expect(TINYTEX_RELEASE).toBe(LATEX_SOURCES.tinytex);
  const main = join(repo, 'packages', 'app', 'src', 'main');
  const files = (readdirSync(main, { recursive: true }) as string[]).filter((f) => f.endsWith('.ts')).map((f) => join(main, f));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    if (f.endsWith(join('latex', 'sources.ts'))) continue;
    const text = readFileSync(f, 'utf8');
    expect(text, relative(main, f)).not.toMatch(/['"`]https?:\/\//);
    expect(text, relative(main, f)).not.toMatch(/['"`]ctan['"`]/);
  }
});

test('tinyTexRoot : CIRRUS_TINYTEX, sinon LOCALAPPDATA\\Cirrus\\TinyTeX, sinon une erreur', () => {
  expect(tinyTexRoot({ CIRRUS_TINYTEX: 'D:\\tex\\TinyTeX', LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toBe('D:\\tex\\TinyTeX');
  expect(tinyTexRoot({ LOCALAPPDATA: 'C:\\Users\\a\\AppData\\Local' })).toBe(join('C:\\Users\\a\\AppData\\Local', 'Cirrus', 'TinyTeX'));
  expect(tinyTexRoot({ CIRRUS_TINYTEX: '', LOCALAPPDATA: 'C:\\L' })).toBe(join('C:\\L', 'Cirrus', 'TinyTeX'));
  expect(() => tinyTexRoot({})).toThrow('Dossier de LaTeX introuvable : LOCALAPPDATA n’est pas défini.');
});

test('findBinaries : null pour un dossier vide ou sans pdflatex qui réponde', async () => {
  expect(await findBinaries(parent)).toBeNull();
  expect(await findBinaries(join(parent, 'absent'))).toBeNull();
  // Both files present, but not a program: pdflatex --version does not answer.
  mkdirSync(join(parent, 'bin', 'windows'), { recursive: true });
  writeFileSync(join(parent, 'bin', 'windows', 'pdflatex.exe'), 'pas un programme');
  writeFileSync(join(parent, 'bin', 'windows', 'tlmgr.bat'), '@echo off');
  expect(await findBinaries(parent)).toBeNull();
});

test.skipIf(!hasTex)(withTex('findBinaries : les chemins et la version de la TinyTeX du banc'), async () => {
  const bins = await findBinaries(BENCH_TEX);
  expect(bins).toEqual({
    root: BENCH_TEX,
    pdflatex: join(BENCH_TEX, 'bin', 'windows', 'pdflatex.exe'),
    tlmgr: join(BENCH_TEX, 'bin', 'windows', 'tlmgr.bat'),
    version: expect.stringContaining('TeX Live 2026'),
  });
  expect(bins!.version).toMatch(/^pdfTeX \S+ \(TeX Live 2026\)$/);
}, 30_000);

test('texEnv : TeX n’écrit que dans son dossier et n’exécute rien (D4) ; PATH est gardé', () => {
  const env = texEnv({
    PATH: 'C:\\Windows', TEXMFOUTPUT: 'C:\\', TEXINPUTS: 'C:\\//', TEXMFHOME: 'C:\\texmf', TEXMFCNF: 'C:\\cnf', HOME: undefined,
    // TeX Live 2024's output directory: TeX would write its .log, .aux, .pdf and \openout files there.
    TEXMF_OUTPUT_DIRECTORY: 'C:\\ailleurs', texmf_output_directory_pdflatex: 'C:\\ailleurs',
    // Windows reads its variables whatever their case, and kpathsea reads VAR.progname and VAR_progname before VAR.
    OPENOUT_ANY: 'a', 'openout_any.pdflatex': 'a', TEXINPUTS_pdflatex: 'C:\\//', shell_escape: 't',
  });
  // No openin_any: TeX Live 2026 made it a no-op (texmf.cnf), so setting it would only pretend to restrict reads.
  expect(env).toEqual({ PATH: 'C:\\Windows', openout_any: 'p', shell_escape: 'f' });
});

test('runFile : un .bat dans un dossier à espace, ses arguments et son code de sortie ; un argument dangereux est refusé', async () => {
  const dir = join(parent, 'dossier à espace');
  mkdirSync(dir);
  const bat = join(dir, 'outil.bat');
  writeFileSync(bat, '@echo off\r\necho args=%*\r\nexit /b 3\r\n');
  const r = await runFile(bat, ['install', 'tikz-cd', '/x.sty', '--data']);
  expect(r.code).toBe(3);
  expect(r.out.trim()).toBe('args=install tikz-cd /x.sty --data');
  // The .bat runs through cmd.exe, which would read these as commands or variables.
  for (const arg of ['a&calc', 'a|b', 'a b', '%PATH%', 'a"b', 'a^b', 'a>b']) {
    await expect(runFile(bat, [arg]), arg).rejects.toThrow(/refusé/);
  }
  await expect(runFile(join(parent, 'absent.exe'), [])).rejects.toThrow();
  // A repository's address (LATEX_SOURCES, plan 5/9's server): « : » means nothing to cmd.exe in an argument.
  expect((await runFile(bat, ['--repository', 'https://serveur.example/tlnet'])).out.trim()).toBe('args=--repository https://serveur.example/tlnet');
});

test('runFile : un programme qui dépasse son délai est arrêté avec ses descendants, et l’échec le dit en français', async () => {
  // The batch starts another cmd.exe, which would write `marque.txt` after about 2 s: killing the batch alone would
  // leave it running (Windows does not kill a process's children with it).
  const bat = join(parent, 'tlmgr.bat'), late = join(parent, 'attente.bat'), mark = join(parent, 'marque.txt');
  writeFileSync(late, `@echo off\r\nping -n 3 127.0.0.1 >nul\r\necho fini>"${mark}"\r\n`);
  writeFileSync(bat, `@echo off\r\ncmd /d /c "${late}"\r\nexit /b 0\r\n`);
  const t0 = performance.now();
  await expect(runFile(bat, ['install', 'x'], 500)).rejects.toThrow(/^tlmgr ne répond plus \(plus de 0,5 s\) : arrêté\.$/);
  expect(performance.now() - t0).toBeLessThan(1800);
  await new Promise((r) => setTimeout(r, 3000));
  expect(existsSync(mark)).toBe(false);
  // Within its time, it runs to its end.
  expect((await runFile(late, [], 20_000)).code).toBe(0);
  expect(existsSync(mark)).toBe(true);
}, 30_000);

test('runFile : l’échec d’un .bat qui finit comme tlmgr.bat (goto :eof après le programme) n’est pas un succès', async () => {
  // tlmgr.bat runs tlmgr.pl, then `if not exist "%tlupdater%" goto :eof`: started alone by cmd /c, the batch's exit
  // code was lost (0 for a failed tlmgr install, seen on TinyTeX v2026.11).
  const bat = join(parent, 'comme tlmgr.bat');
  writeFileSync(bat, '@echo off\r\nsetlocal enableextensions\r\ncmd /c exit 25\r\nif not exist "%~dp0absent" goto :eof\r\necho jamais\r\n');
  expect((await runFile(bat, ['install', 'x'])).code).not.toBe(0);
  writeFileSync(bat, '@echo off\r\nsetlocal enableextensions\r\ncmd /c exit 0\r\nif not exist "%~dp0absent" goto :eof\r\necho jamais\r\n');
  expect((await runFile(bat, ['install', 'x'])).code).toBe(0);
});

// --- provision, with fake dependencies ---

const CONTENT = Buffer.from('un faux TinyTeX auto-extractible');
const RELEASE = {
  version: 'test', asset: 'TinyTeX-1-windows-test.exe', url: 'https://example.invalid/TinyTeX-1-windows-test.exe',
  sha256: createHash('sha256').update(CONTENT).digest('hex'), bytes: CONTENT.length,
};
const VERSION_OUT = 'pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)\nkpathsea version 6.4.2\n';
// tlmgr's real lines (tlmgr.pl): the repository it uses, and the closing line of any failed action, after its cause.
const REPO = 'tlmgr.pl: package repository https://mirrors.ctan.org/systems/texlive/tlnet (verified)';
const TRAILER = 'tlmgr.pl: An error has occurred. See above messages. Exiting.';
const failure = (cause: string) => ({ code: 1, out: `${REPO}\n${cause}\ntlmgr.pl: action install returned an error; continuing.\n${TRAILER}\n` });

/** Fake deps: the extractor writes <o>/TinyTeX/bin/windows/{pdflatex.exe,tlmgr.bat}; `fail` makes one step fail. */
function fakeDeps(root: string, fail?: 'download' | 'extract' | 'option' | 'update' | 'install' | 'throw') {
  const calls: [string, string[]][] = [];
  const deps: Deps = {
    async download(url, dest, onBytes) {
      calls.push(['download', [url, dest]]);
      if (fail === 'download') throw new Error('réseau coupé');
      writeFileSync(dest, CONTENT.subarray(0, 10));
      onBytes(10);
      writeFileSync(dest, CONTENT);
      onBytes(CONTENT.length);
    },
    async run(file, args) {
      calls.push([file, args]);
      if (args[0] === '-y') {
        const out = args[1].slice(2);
        // A leftover of an earlier run is gone, and nothing is in place yet.
        expect(readdirSync(out)).toEqual([]);
        mkdirSync(join(out, 'TinyTeX', 'bin', 'windows'), { recursive: true });
        writeFileSync(join(out, 'TinyTeX', 'bin', 'windows', 'pdflatex.exe'), '');
        writeFileSync(join(out, 'TinyTeX', 'bin', 'windows', 'tlmgr.bat'), '');
        return { code: fail === 'extract' ? 2 : 0, out: '' };
      }
      expect(existsSync(root)).toBe(false);
      if (file.endsWith('tlmgr.bat')) {
        if (fail === 'throw') throw new Error('spawn EPERM');
        return args[0] === fail ? failure(`tlmgr.pl ${fail}: cause simulée de l’échec`) : { code: 0, out: `${REPO}\n` };
      }
      if (file.endsWith('pdflatex.exe') && args[0] === '--version') return { code: 0, out: VERSION_OUT };
      throw new Error(`appel inattendu : ${file} ${args.join(' ')}`);
    },
  };
  return { calls, deps };
}
const leftovers = (root: string) => [root, `${root}.partial`, `${root}.download`].filter((p) => existsSync(p));

test('provision : télécharge, vérifie, extrait, prend le dépôt de TeX Live, installe les paquets de base, puis renomme (dans cet ordre)', async () => {
  const root = join(parent, 'TinyTeX');
  // A folder created in advance, empty, and the leftovers of an earlier failed run.
  mkdirSync(root);
  mkdirSync(join(`${root}.partial`, 'TinyTeX'), { recursive: true });
  mkdirSync(`${root}.download`);
  writeFileSync(join(`${root}.download`, RELEASE.asset), 'moitié');
  const { calls, deps } = fakeDeps(root);
  const progress: Progress[] = [];
  const bins = await provision(root, deps, (p) => progress.push(p), RELEASE);
  const exe = join(`${root}.download`, RELEASE.asset), staged = join(`${root}.partial`, 'TinyTeX', 'bin', 'windows');
  expect(calls).toEqual([
    ['download', [RELEASE.url, exe]],
    [exe, ['-y', `-o${root}.partial`]],
    [join(staged, 'tlmgr.bat'), ['option', 'repository', 'ctan']],
    [join(staged, 'tlmgr.bat'), ['update', '--self']],
    [join(staged, 'tlmgr.bat'), ['install', ...BASE_PACKAGES]],
    [join(staged, 'pdflatex.exe'), ['--version']],
  ]);
  expect(progress).toEqual([
    { step: 'download', done: 10, total: RELEASE.bytes }, { step: 'download', done: CONTENT.length, total: RELEASE.bytes },
    { step: 'extract' }, { step: 'packages', names: [...BASE_PACKAGES] },
  ]);
  const bin = join(root, 'bin', 'windows');
  expect(bins).toEqual({ root, pdflatex: join(bin, 'pdflatex.exe'), tlmgr: join(bin, 'tlmgr.bat'), version: VERSION_OUT.split('\n')[0] });
  expect(existsSync(join(bin, 'pdflatex.exe'))).toBe(true);
  expect(leftovers(root)).toEqual([root]);
});

test('provision : une empreinte ou une taille fausse lève le message, n’extrait rien et ne laisse rien', async () => {
  const root = join(parent, 'TinyTeX');
  for (const release of [{ ...RELEASE, sha256: '0'.repeat(64) }, { ...RELEASE, bytes: RELEASE.bytes + 1 }]) {
    const { calls, deps } = fakeDeps(root);
    await expect(provision(root, deps, () => {}, release)).rejects.toThrow('Le téléchargement de TinyTeX est corrompu (empreinte inattendue).');
    expect(calls.map((c) => c[0])).toEqual(['download']);
    expect(leftovers(root)).toEqual([]);
  }
});

test('provision : un échec du téléchargement, de l’extraction ou de tlmgr ne laisse rien, et l’erreur de tlmgr en dit la cause', async () => {
  const root = join(parent, 'TinyTeX');
  const cases = [
    ['download', /réseau coupé/], ['extract', /décompression de TinyTeX a échoué \(code 2\)/],
    ['option', /^tlmgr option a échoué \(code 1\) : tlmgr\.pl option: cause simulée de l’échec$/],
    ['update', /^tlmgr update a échoué \(code 1\) : tlmgr\.pl update: cause simulée de l’échec$/],
    ['install', /^tlmgr install a échoué \(code 1\) : tlmgr\.pl install: cause simulée de l’échec$/],
    ['throw', /spawn EPERM/],
  ] as const;
  for (const [fail, message] of cases) {
    const { deps } = fakeDeps(root, fail);
    await expect(provision(root, deps, () => {}, RELEASE), fail).rejects.toThrow(message);
    expect(leftovers(root), fail).toEqual([]);
  }
});

test('provision : un dossier déjà là et non vide est refusé avant tout téléchargement, et laissé tel quel', async () => {
  const root = join(parent, 'TinyTeX');
  mkdirSync(root);
  writeFileSync(join(root, 'à moi.txt'), 'garde-moi');
  const { calls, deps } = fakeDeps(root);
  await expect(provision(root, deps, () => {}, RELEASE)).rejects.toThrow(/existe déjà/);
  expect(calls).toEqual([]);
  expect(readdirSync(root)).toEqual(['à moi.txt']);
});

test('provision : hors de Windows, rien n’est téléchargé', async () => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'linux' });
  try {
    const { calls, deps } = fakeDeps(join(parent, 'TinyTeX'));
    await expect(provision(join(parent, 'TinyTeX'), deps, () => {}, RELEASE))
      .rejects.toThrow('LaTeX ne s’installe automatiquement que sous Windows : indique une TinyTeX par CIRRUS_TINYTEX.');
    expect(calls).toEqual([]);
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
});

// --- missing files and packages ---

// Extracts of real pdfLaTeX logs (TinyTeX v2026.11, -interaction=nonstopmode -halt-on-error).
const LOG_STY = `\\belowcaptionskip=\\skip50
\\bibindent=\\dimen150
)

! LaTeX Error: File \`paquetinexistant.sty' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: sty)

Enter file name:
! Emergency stop.
<read *>
`;
const LOG_CLS = `(./cls.tex
LaTeX2e <2026-06-01>
L3 programming layer <2026-09-09>

! LaTeX Error: File \`classeinexistante.cls' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: cls)
`;
const LOG_INPUT = `LaTeX Font Info:    ... okay on input line 2.

! LaTeX Error: File \`annexe.tex' not found.

Type X to quit or <RETURN> to proceed,
or enter new name. (Default extension: tex)

Enter file name:
! Emergency stop.
<read *>

l.3 \\input{annexe}
`;

test('missingFile : un .sty ou un .cls absent, pas un \\input absent', () => {
  expect(missingFile(LOG_STY)).toBe('paquetinexistant.sty');
  expect(missingFile(LOG_CLS)).toBe('classeinexistante.cls');
  expect(missingFile(LOG_STY.replaceAll('\n', '\r\n'))).toBe('paquetinexistant.sty');
  expect(missingFile(LOG_INPUT)).toBeNull();
  for (const ext of ['bst', 'fd', 'def', 'clo', 'cfg', 'ldf']) expect(missingFile(`! LaTeX Error: File \`x.${ext}' not found.`)).toBe(`x.${ext}`);
  expect(missingFile('! LaTeX Error: File `x.png\' not found.')).toBeNull();
  // The name goes to tlmgr: one that cmd.exe would read as a command is no package.
  expect(missingFile('! LaTeX Error: File `a&calc.sty\' not found.')).toBeNull();
  expect(missingFile('tout va bien')).toBeNull();
});

// The output of tlmgr search --global --file (tlmgr.pl, format_search_tlpdb_result): each package, then its files.
const SEARCH = `tlmgr.pl: package repository https://mirrors.ctan.org/systems/texlive/tlnet (verified)
tikz-cd:
\ttexmf-dist/tex/latex/tikz-cd/tikz-cd.sty
xfoo:
\ttexmf-dist/tex/latex/xfoo/xfoo.sty
\ttexmf-dist/tex/latex/xfoo/foo.sty.bak
foo:
\ttexmf-dist/doc/latex/foo/README
\ttexmf-dist/tex/latex/foo/foo.sty
`;

test('packageOf : le premier paquet dont un fichier finit exactement par /<fichier>', () => {
  expect(packageOf(SEARCH, 'tikz-cd.sty')).toBe('tikz-cd');
  expect(packageOf(SEARCH, 'foo.sty')).toBe('foo');
  expect(packageOf(SEARCH.replaceAll('\n', '\r\n'), 'foo.sty')).toBe('foo');
  expect(packageOf(SEARCH, 'bar.sty')).toBeNull();
  expect(packageOf('', 'foo.sty')).toBeNull();
});

test('packageOf : parmi les chemins exacts, un fichier sous texmf-dist/tex/ l’emporte sur la documentation ou les sources', () => {
  // A package's documentation or sources may carry a copy of another's .sty (an example, a .dtx's output).
  const out = `${SEARCH.split('\n')[0]}
exemples:
\ttexmf-dist/doc/latex/exemples/foo.sty
sources:
\ttexmf-dist/source/latex/sources/foo.sty
foo:
\ttexmf-dist/tex/latex/foo/foo.sty
`;
  expect(packageOf(out, 'foo.sty')).toBe('foo');
  // Without one under tex/, the first exact match.
  expect(packageOf(out.split('foo:')[0], 'foo.sty')).toBe('exemples');
});

// --- Packages, with a fake tlmgr ---

const BINS: TexBinaries = { root: 'C:\\TinyTeX', pdflatex: 'C:\\TinyTeX\\bin\\windows\\pdflatex.exe', tlmgr: 'C:\\TinyTeX\\bin\\windows\\tlmgr.bat', version: 'pdfTeX' };
const LIST = 'début info --list --only-installed --data name';

/**
 * A tlmgr with amsmath and hyperref installed, whose repository knows tikz-cd, siunitx, foo and xfoo, and which takes
 * 10 ms per call. Like the real one, it installs what it knows of a batch, says which names it does not know, and
 * then fails with its closing line. `answer` overrides a call. A call to the network names its repository first
 * (`--repository`, LATEX_SOURCES): `raw` keeps the calls as they came, the rest sees them without it.
 */
function fakeTlmgr(answer: (args: string[]) => { code: number; out: string } | undefined = () => undefined) {
  const events: string[] = [], raw: string[][] = [];
  const have = new Set(['amsmath', 'hyperref']), known = new Set(['tikz-cd', 'siunitx', 'foo', 'xfoo']);
  let active = 0;
  const run: Deps['run'] = async (file, given) => {
    expect(file).toBe(BINS.tlmgr);
    raw.push(given);
    const args = given[0] === '--repository' ? given.slice(2) : given;
    active++;
    events.push(`début ${args.join(' ')}`);
    if (active > 1) throw new Error('deux tlmgr à la fois');
    await new Promise((r) => setTimeout(r, 10));
    events.push(`fin ${args[0]}`);
    active--;
    const a = answer(args);
    if (a) return a;
    if (args[0] === 'info') return { code: 0, out: [...have].map((n) => `${n}\n`).join('') };
    if (args[0] === 'search') return { code: 0, out: SEARCH };
    if (args[0] === 'install') {
      const names = args.slice(1), unknown = names.filter((n) => !known.has(n));
      const done = names.filter((n) => known.has(n)).map((n, i) => { have.add(n); return `[${i + 1}/${names.length}, ??:??/??:??] install: ${n} [12k]\n`; });
      if (unknown.length === 0) return { code: 0, out: `${done.join('')}${REPO}\n` };
      return { code: 1, out: `${done.join('')}${REPO}\n${unknown.map((n) => `tlmgr.pl install: package ${n} not present in repository.\n`).join('')}${TRAILER}\n` };
    }
    return { code: 0, out: '' };
  };
  return { events, run, have, raw };
}

test('Packages : chaque appel au réseau nomme le dépôt de LATEX_SOURCES ; la liste locale, non', async () => {
  let updated = false;
  const tl = fakeTlmgr((args) => {
    if (args[0] === 'update') { updated = true; return { code: 0, out: '' }; }
    if (args[0] === 'install' && !updated) return { code: 1, out: 'tlmgr itself needs to be updated.\n' };
    return undefined;
  });
  const p = new Packages(BINS, tl.run);
  await p.ensure(['tikz-cd']);
  await p.installFor('foo.sty');
  const repo = ['--repository', LATEX_SOURCES.repository];
  expect(tl.raw).toEqual([
    ['info', '--list', '--only-installed', '--data', 'name'], [...repo, 'install', 'tikz-cd'], [...repo, 'update', '--self'], [...repo, 'install', 'tikz-cd'],
    [...repo, 'search', '--global', '--file', '/foo.sty'], [...repo, 'install', 'foo'],
  ]);
  // Another repository (plan 5/9's server) is given as it is.
  const other = fakeTlmgr();
  await new Packages(BINS, other.run, 'https://serveur.example/tlnet').installFor('tikz-cd.sty');
  expect(other.raw[0]).toEqual(['--repository', 'https://serveur.example/tlnet', 'search', '--global', '--file', '/tikz-cd.sty']);
});

test('Packages.ensure n’installe que les absents, et rend ceux qu’il a installés', async () => {
  const { events, run } = fakeTlmgr();
  const p = new Packages(BINS, run);
  expect(await p.installed()).toEqual(new Set(['amsmath', 'hyperref']));
  expect(await p.ensure(['hyperref', 'tikz-cd', 'siunitx', 'tikz-cd'])).toEqual({ installed: ['tikz-cd', 'siunitx'], failed: [] });
  expect(await p.ensure(['amsmath', 'tikz-cd'])).toEqual({ installed: [], failed: [] });
  expect(events.filter((e) => e.startsWith('début'))).toEqual([LIST, LIST, 'début install tikz-cd siunitx', LIST]);
});

test('Packages.ensure : un nom inconnu parmi d’autres n’empêche pas les autres, et sa raison vient de tlmgr', async () => {
  const { events, run } = fakeTlmgr();
  const p = new Packages(BINS, run);
  expect(await p.ensure(['tikz-cd', 'tikzcd-faute', 'siunitx'])).toEqual({
    installed: ['tikz-cd', 'siunitx'],
    failed: [{ name: 'tikzcd-faute', reason: 'tlmgr.pl install: package tikzcd-faute not present in repository.' }],
  });
  // One batch, then the list again to see which went in.
  expect(events.filter((e) => e.startsWith('début'))).toEqual([LIST, 'début install tikz-cd tikzcd-faute siunitx', LIST]);
  // Offline: nothing goes in, each name fails with tlmgr's cause, and the call does not throw.
  const off = fakeTlmgr((args) => (args[0] === 'install' ? failure('tlmgr.pl: cannot download https://mirrors.ctan.org/systems/texlive/tlnet/tlpkg/texlive.tlpdb.sha512') : undefined));
  expect(await new Packages(BINS, off.run).ensure(['tikz-cd', 'siunitx'])).toEqual({
    installed: [],
    failed: ['tikz-cd', 'siunitx'].map((name) => ({ name, reason: 'tlmgr.pl: cannot download https://mirrors.ctan.org/systems/texlive/tlnet/tlpkg/texlive.tlpdb.sha512' })),
  });
});

test('Packages.ensure : un nom qui commencerait comme une option de tlmgr n’atteint jamais tlmgr', async () => {
  const { events, run } = fakeTlmgr();
  expect(await new Packages(BINS, run).ensure(['--repository=http://ailleurs.example', '-a', 'tikz-cd', '.cache', ''])).toEqual({
    installed: ['tikz-cd'],
    failed: ['--repository=http://ailleurs.example', '-a', '.cache', ''].map((name) => ({ name, reason: 'nom de paquet invalide' })),
  });
  expect(events.filter((e) => e.startsWith('début'))).toEqual([LIST, 'début install tikz-cd']);
  // Only invalid names: no tlmgr at all.
  const none = fakeTlmgr();
  expect((await new Packages(BINS, none.run).ensure(['-a'])).failed).toEqual([{ name: '-a', reason: 'nom de paquet invalide' }]);
  expect(none.events).toEqual([]);
});

test('Packages : une TinyTeX installée n’est jamais effacée à cause d’un paquet de l’utilisateur', async () => {
  const root = join(parent, 'TinyTeX');
  const bins = await provision(root, fakeDeps(root).deps, () => {}, RELEASE);
  const tl = fakeTlmgr();
  const p = new Packages(BINS, tl.run);
  expect((await p.ensure(['inconnu-xyz'])).failed).toEqual([{ name: 'inconnu-xyz', reason: 'tlmgr.pl install: package inconnu-xyz not present in repository.' }]);
  expect(existsSync(bins.pdflatex)).toBe(true);
  expect(leftovers(root)).toEqual([root]);
});

test('Packages.installFor : search puis install, ou null sans paquet qui contienne le fichier ; un échec en dit la cause', async () => {
  const { events, run } = fakeTlmgr();
  const p = new Packages(BINS, run);
  expect(await p.installFor('tikz-cd.sty')).toBe('tikz-cd');
  expect(await p.installFor('bar.sty')).toBeNull();
  expect(events.filter((e) => e.startsWith('début'))).toEqual([
    'début search --global --file /tikz-cd.sty', 'début install tikz-cd', 'début search --global --file /bar.sty',
  ]);
  // Offline: search fails, and so does the call, with tlmgr's cause rather than its closing line.
  const off = new Packages(BINS, fakeTlmgr((args) => (args[0] === 'search' ? failure('tlmgr.pl: cannot contact mirror') : undefined)).run);
  await expect(off.installFor('tikz-cd.sty')).rejects.toThrow(/^tlmgr search a échoué \(code 1\) : tlmgr\.pl: cannot contact mirror$/);
  const broken = new Packages(BINS, fakeTlmgr((args) => (args[0] === 'install' ? failure('tlmgr.pl install: checksum of tikz-cd does not match') : undefined)).run);
  await expect(broken.installFor('tikz-cd.sty')).rejects.toThrow(/^tlmgr install a échoué \(code 1\) : tlmgr\.pl install: checksum of tikz-cd does not match$/);
  // A package name from the repository that would read as an option is not installed.
  const odd = new Packages(BINS, fakeTlmgr((args) => (args[0] === 'search' ? { code: 0, out: '-x:\n\ttexmf-dist/tex/latex/x/odd.sty\n' } : undefined)).run);
  expect(await odd.installFor('odd.sty')).toBeNull();
});

test('Packages : deux appels simultanés passent l’un après l’autre, et un échec ne bloque pas les suivants', async () => {
  const { events, run } = fakeTlmgr((args) => (args.join(' ') === 'search --global --file /bar.sty' ? failure('tlmgr.pl: cannot contact mirror') : undefined));
  const p = new Packages(BINS, run);
  const [a, b, c] = await Promise.allSettled([p.ensure(['tikz-cd']), p.installFor('bar.sty'), p.ensure(['siunitx'])]);
  expect(a).toEqual({ status: 'fulfilled', value: { installed: ['tikz-cd'], failed: [] } });
  expect(b.status).toBe('rejected');
  expect(c).toEqual({ status: 'fulfilled', value: { installed: ['siunitx'], failed: [] } });
  expect(events).toEqual([
    LIST, 'fin info', 'début install tikz-cd', 'fin install',
    'début search --global --file /bar.sty', 'fin search',
    LIST, 'fin info', 'début install siunitx', 'fin install',
  ]);
});

test('Packages : un tlmgr à mettre à jour (dépôt plus récent) est mis à jour, puis l’installation reprend une fois', async () => {
  let updated = false;
  const outdated = { code: 1, out: `${REPO}\n${'='.repeat(79)}\ntlmgr itself needs to be updated.\nPlease do this via either\n  tlmgr update --self\n${'='.repeat(79)}\ntlmgr.pl: Terminating; please see warning above!\n` };
  const { events, run } = fakeTlmgr((args) => {
    if (args[0] === 'update') { updated = true; return { code: 0, out: '' }; }
    if (args[0] === 'install' && !updated) return outdated;
    return undefined;
  });
  const p = new Packages(BINS, run);
  expect(await p.installFor('tikz-cd.sty')).toBe('tikz-cd');
  expect(events.filter((e) => e.startsWith('début'))).toEqual([
    'début search --global --file /tikz-cd.sty', 'début install tikz-cd', 'début update --self', 'début install tikz-cd',
  ]);
  // The same for ensure; and a tlmgr that cannot update itself makes the names fail with that cause, without throwing.
  updated = false;
  expect(await p.ensure(['siunitx'])).toEqual({ installed: ['siunitx'], failed: [] });
  const stuck = fakeTlmgr((args) => (args[0] === 'install' ? outdated : args[0] === 'update' ? failure('tlmgr.pl: cannot contact mirror') : undefined));
  expect(await new Packages(BINS, stuck.run).ensure(['siunitx'])).toEqual({
    installed: [], failed: [{ name: 'siunitx', reason: 'tlmgr update a échoué (code 1) : tlmgr.pl: cannot contact mirror' }],
  });
});

test.skipIf(!hasTex)(withTex('Packages.installed, sur la TinyTeX du banc et sans réseau, contient hyperref'), async () => {
  const bins = await findBinaries(BENCH_TEX);
  const names = await new Packages(bins!, runFile).installed();
  expect(names.has('hyperref')).toBe(true);
  expect(names.has('amsmath')).toBe(true);
}, 60_000);
