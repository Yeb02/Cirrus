import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  type Action, BASE_PACKAGES, type CompileAnswer, type CompileRequest, DEFAULT_PREAMBLE, emptyState, type InstallProgress, type LatexStatus, preambleText,
} from '@cirrus/core';
import { DEFAULT_PARAMS } from '@cirrus/view';
import { afterEach, expect, test, vi } from 'vitest';
import { PdfCache } from '../src/main/latex/cache.ts';
import { LatexService } from '../src/main/latex/compiler.ts';
import { type CompileService, LatexSetup, type PackageManager } from '../src/main/latex/setup.ts';
import { findBinaries, type TexBinaries } from '../src/main/latex/tinytex.ts';
import { preambleBuild } from '../src/renderer/actions.ts';
import { latexStateText, noticeFor, withPackage } from '../src/renderer/latex/install.ts';
import { EditSession } from '../src/renderer/session.ts';
import { focusedChoice } from '../src/renderer/ui/Dialogs.tsx';
import { brokenPreambleQuestion, discardPreambleQuestion, leaveUnsaved, PREAMBLE_SAMPLE, preambleRequest, saveStep } from '../src/renderer/ui/latex/preamble.ts';
import { readPdf } from './latexPdf.ts';
import { sleep } from './support/latex.ts';

// --- the main process's side (LatexSetup), with a fake compile service, a fake TinyTeX and a fake tlmgr

const BINS: TexBinaries = {
  root: 'C:\\TinyTeX', pdflatex: 'C:\\TinyTeX\\bin\\windows\\pdflatex.exe', tlmgr: 'C:\\TinyTeX\\bin\\windows\\tlmgr.bat',
  version: 'pdfTeX 3.141592653-2.6-1.40.29 (TeX Live 2026)',
};
const READY: LatexStatus = { state: 'ready', version: 'TeX Live 2026' };
const ABSENT: CompileAnswer = { status: 'unavailable', reason: 'absent', message: 'LaTeX n’est pas installé.' };

/** A request whose source lists the .sty files it needs: the fake service compiles it once their packages are in. */
const req = (slot: string, source = ''): CompileRequest => ({
  slot, mode: 'snippet', source, preamble: DEFAULT_PREAMBLE, refs: [], broken: [], doubled: [], cites: [], doubledCites: [], unknownCites: [], known: [], resources: [], widthCm: 9,
});
const OK: CompileAnswer = { status: 'ok', pdf: { key: 'a'.repeat(64), size: 100, pages: 1 }, labels: [], log: '', ms: 1, passes: 1, cached: false };
const missing = (file: string): CompileAnswer => ({
  status: 'error', error: { message: `File \`${file}' not found.`, line: 3, where: 'preamble' }, labels: [], log: 'journal', ms: 1, missing: file,
});

/**
 * The setup over fakes: TinyTeX absent until provision puts it there (unless `present`); a service that answers a
 * source missing the first of its .sty whose package is not installed; a tlmgr whose search maps `files` (a package,
 * none, or a failure), taking `slow` ms per installation; `ensure` installing what `known` names.
 */
function world(o: {
  present?: boolean; provision?: (p: (x: InstallProgress) => void) => Promise<void>; packages?: string[];
  files?: Record<string, string | null | Error>; slow?: number; known?: string[]; offline?: boolean;
} = {}) {
  let present = o.present ?? false;
  const statuses: LatexStatus[] = [];
  const calls = { provision: 0, ensure: [] as string[][], installFor: [] as string[], compile: [] as string[], restart: 0, cancel: [] as string[] };
  const installed = new Set<string>();
  const files = o.files ?? { 'x.sty': 'x' };
  const service: CompileService = {
    async compile(r) {
      calls.compile.push(r.slot);
      const needed = r.source.split(/\s+/).filter((f) => f.endsWith('.sty'));
      const absent = needed.find((f) => !installed.has(f.slice(0, -'.sty'.length)));
      return absent ? missing(absent) : OK;
    },
    cancel: (slot) => { calls.cancel.push(slot); },
    restart: () => { calls.restart++; },
  };
  const packages: PackageManager = {
    async ensure(names) {
      calls.ensure.push(names);
      if (o.offline) throw new Error('tlmgr info a échoué (code 1) : base locale illisible');
      const fresh = names.filter((n) => (o.known ?? []).includes(n) && !installed.has(n));
      for (const n of fresh) installed.add(n);
      return { installed: fresh, failed: names.filter((n) => !(o.known ?? []).includes(n)).map((name) => ({ name, reason: `package ${name} not present in repository.` })) };
    },
    async installFor(file) {
      calls.installFor.push(file);
      if (o.slow) await sleep(o.slow);
      const r = files[file];
      if (r instanceof Error) throw r;
      if (r) installed.add(r);
      return r ?? null;
    },
  };
  const setup = new LatexSetup({
    service, binaries: async () => (present ? BINS : null),
    provision: async (onProgress) => {
      calls.provision++;
      await (o.provision ?? (async () => {}))(onProgress);
      present = true;
      return BINS;
    },
    packages: () => packages, params: () => ({ ...DEFAULT_PARAMS, latexPackages: o.packages ?? [] }), status: (s) => { statuses.push(s); },
  });
  return { setup, statuses, calls, installed };
}

afterEach(() => { vi.restoreAllMocks(); });

test('latexInstall : sans LaTeX « absent », puis l’installation et ses statuts dans l’ordre, jusqu’à « ready » ; rien n’est téléchargé sans elle', async () => {
  const w = world({
    packages: ['tikz-cd'], known: ['tikz-cd'],
    provision: async (p) => {
      // Each step of provision; the download only said when its percentage changes.
      p({ step: 'download', done: 0, total: 1000 });
      p({ step: 'download', done: 400, total: 1000 });
      p({ step: 'download', done: 401, total: 1000 });
      p({ step: 'download', done: 1000, total: 1000 });
      p({ step: 'extract' });
      p({ step: 'packages', names: [...BASE_PACKAGES] });
    },
  });
  expect(await w.setup.state()).toEqual({ state: 'absent' });
  expect(await w.setup.compile(req('summary:n1'))).toEqual(ABSENT);
  await w.setup.ensureAtStart();
  expect([w.calls.provision, w.calls.ensure, w.calls.compile]).toEqual([0, [], []]);
  await w.setup.install();
  expect(w.statuses).toEqual([
    { state: 'absent' },
    { state: 'installing', progress: { step: 'download', done: 0, total: 0 } },
    { state: 'installing', progress: { step: 'download', done: 400, total: 1000 } },
    { state: 'installing', progress: { step: 'download', done: 1000, total: 1000 } },
    { state: 'installing', progress: { step: 'extract' } },
    { state: 'installing', progress: { step: 'packages', names: [...BASE_PACKAGES] } },
    // The user's packages (latexPackages), by ensure, at best.
    { state: 'installing', progress: { step: 'packages', names: ['tikz-cd'] } },
    READY,
  ]);
  expect(w.calls.ensure).toEqual([['tikz-cd']]);
  expect(await w.setup.compile(req('summary:n1'))).toEqual(OK);
  // Installed: a second request downloads nothing.
  await w.setup.install();
  expect(w.calls.provision).toBe(1);
});

test('latexInstall : un second appel pendant l’installation est sans effet ; une compilation y répond « installing »', async () => {
  let release = () => {};
  const w = world({ provision: () => new Promise<void>((r) => { release = r; }) });
  const first = w.setup.install(), second = w.setup.install();
  for (let i = 0; i < 20 && w.calls.provision === 0; i++) await sleep(5);
  expect(w.calls.provision).toBe(1);
  expect(await w.setup.compile(req('summary:n1'))).toEqual({ status: 'unavailable', reason: 'installing', message: 'LaTeX est en cours d’installation.' });
  expect(await w.setup.state()).toMatchObject({ state: 'installing' });
  w.setup.install();
  release();
  await Promise.all([first, second]);
  expect(w.calls.provision).toBe(1);
  expect(await w.setup.state()).toEqual(READY);
});

test('latexInstall : un échec donne « failed » et sa raison en français, qui reste ; réessayer est possible', async () => {
  let fail = true;
  const w = world({
    provision: async (p) => {
      p({ step: 'extract' });
      if (fail) throw new Error('Le téléchargement de TinyTeX a échoué (HTTP 503).');
    },
  });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  await w.setup.install();
  const failed: LatexStatus = { state: 'failed', message: 'Le téléchargement de TinyTeX a échoué (HTTP 503).' };
  expect(w.statuses.at(-1)).toEqual(failed);
  expect(await w.setup.state()).toEqual(failed);
  expect(await w.setup.compile(req('summary:n1'))).toEqual({
    status: 'unavailable', reason: 'failed', message: 'L’installation de LaTeX a échoué : Le téléchargement de TinyTeX a échoué (HTTP 503).',
  });
  fail = false;
  await w.setup.install();
  expect(w.calls.provision).toBe(2);
  expect(w.statuses.slice(-3)).toEqual([{ state: 'installing', progress: { step: 'download', done: 0, total: 0 } }, { state: 'installing', progress: { step: 'extract' } }, READY]);
});

test('paquet manquant : installFor rend « x » ; les pdfLaTeX préparés sont refaits, la compilation repart une fois, la réponse porte installed', async () => {
  const w = world({ present: true });
  expect(await w.setup.compile(req('summary:n1', 'x.sty'))).toEqual({ ...OK, installed: ['x'] });
  expect(w.calls.installFor).toEqual(['x.sty']);
  expect(w.calls.compile).toEqual(['summary:n1', 'summary:n1']);
  expect(w.calls.restart).toBe(1);
  expect(w.statuses).toEqual([READY, { state: 'installing', progress: { step: 'package', name: 'x.sty' } }, READY]);
});

test('paquet manquant : sans paquet qui le contienne, le message, et ce fichier n’est plus cherché de la session ; tlmgr en échec (hors ligne), cherché à nouveau après latexLookupRetryMs, sans boucle d’ici là (revue finale)', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const files: Record<string, string | null | Error> = { 'y.sty': null, 'z.sty': new Error('tlmgr search a échoué (code 1) : tlmgr.pl: cannot contact mirror') };
    const w = world({ present: true, files });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const f of ['y.sty', 'z.sty']) {
      const a = await w.setup.compile(req('summary:n1', f));
      expect(a, f).toEqual({ ...missing(f), error: { message: `Paquet LaTeX introuvable pour « ${f} » (hors ligne ?)`, line: 3, where: 'preamble' } });
    }
    // Asked again at once — the views compile again at each « ready » (latexChanged), which a lookup's end tells —:
    // neither is looked up again, so that a failing tlmgr is not run in a loop.
    for (const f of ['y.sty', 'z.sty']) {
      expect(await w.setup.compile(req('summary:n2', f)), f).toMatchObject({ status: 'error', error: { message: `Paquet LaTeX introuvable pour « ${f} » (hors ligne ?)` } });
    }
    expect(w.calls.installFor).toEqual(['y.sty', 'z.sty']);
    // latexLookupRetryMs later, the network back: z.sty is looked up again by the next compilation, and installed;
    // y.sty, which no package holds, never is.
    vi.setSystemTime(Date.now() + DEFAULT_PARAMS.latexLookupRetryMs - 1);
    await w.setup.compile(req('summary:n2', 'z.sty'));
    expect(w.calls.installFor).toEqual(['y.sty', 'z.sty']);
    vi.setSystemTime(Date.now() + 1);
    files['z.sty'] = 'z';
    expect(await w.setup.compile(req('summary:n2', 'z.sty'))).toEqual({ ...OK, installed: ['z'] });
    expect(await w.setup.compile(req('summary:n2', 'y.sty'))).toMatchObject({ status: 'error' });
    expect(w.calls.installFor).toEqual(['y.sty', 'z.sty', 'z.sty']);
    expect(w.calls.restart).toBe(1);
  } finally {
    vi.useRealTimers();
  }
});

test('paquet manquant : demandé par deux compilations à la fois, il n’est installé qu’une fois', async () => {
  const w = world({ present: true, slow: 30 });
  const [a, b] = await Promise.all([w.setup.compile(req('summary:n1', 'x.sty')), w.setup.compile(req('relation:c1', 'x.sty'))]);
  expect(a).toEqual({ ...OK, installed: ['x'] });
  expect(b).toEqual({ ...OK, installed: ['x'] });
  expect(w.calls.installFor).toEqual(['x.sty']);
  expect(w.calls.restart).toBe(1);
});

test('paquet manquant : la recherche d’une requête remplacée avant son tour n’a pas lieu (un nom en cours de frappe)', async () => {
  const w = world({ present: true, slow: 30, files: { 'a.sty': 'a', 't.sty': null, 'tikz-cd.sty': 'tikz-cd' } });
  const other = w.setup.compile(req('summary:n1', 'a.sty'));
  await sleep(5);
  const typing = w.setup.compile(req('preamble', 't.sty'));
  await sleep(5);
  const typed = w.setup.compile(req('preamble', 'tikz-cd.sty'));
  expect(await typing).toEqual({ status: 'cancelled' });
  expect(await typed).toEqual({ ...OK, installed: ['tikz-cd'] });
  expect(await other).toEqual({ ...OK, installed: ['a'] });
  expect(w.calls.installFor).toEqual(['a.sty', 'tikz-cd.sty']);
  // Never looked up, it is not remembered as missing: asked again, it is looked up.
  await w.setup.compile(req('preamble', 't.sty'));
  expect(w.calls.installFor).toEqual(['a.sty', 'tikz-cd.sty', 't.sty']);
  // A request cancelled during its lookup (the scheduler's latexCancel) is answered at once.
  const slow = w.setup.compile(req('summary:n3', 'b.sty'));
  await sleep(5);
  w.setup.cancel('summary:n3');
  expect(await slow).toEqual({ status: 'cancelled' });
  expect(w.calls.cancel).toEqual(['summary:n3']);
});

test('paquets manquants en chaîne : chacun s’installe, la compilation repartant après chacun', async () => {
  const w = world({ present: true, files: { 'a.sty': 'a', 'b.sty': 'b' } });
  expect(await w.setup.compile(req('summary:n1', 'a.sty b.sty'))).toEqual({ ...OK, installed: ['a', 'b'] });
  expect(w.calls.compile).toHaveLength(3);
  expect(w.calls.restart).toBe(2);
});

test('au démarrage : ensure(latexPackages) ; un nom en échec n’est pas retenté de la session ; hors ligne, la console seule', async () => {
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const w = world({ present: true, packages: ['tikz-cd', 'faute'], known: ['tikz-cd'] });
  await w.setup.ensureAtStart();
  expect(w.calls.ensure).toEqual([['tikz-cd', 'faute']]);
  // Installed: the prepared pdfLaTeX redone, and « ready » said again, so that the views compile again.
  expect(w.calls.restart).toBe(1);
  expect(w.statuses).toEqual([READY, READY]);
  expect(warn).toHaveBeenCalledWith('Paquet LaTeX « faute » non installé : package faute not present in repository.');
  // The window loaded again: the failed name is not tried again before the next start.
  await w.setup.ensureAtStart();
  expect(w.calls.ensure).toEqual([['tikz-cd', 'faute'], ['tikz-cd']]);
  expect(w.calls.restart).toBe(1);
  const off = world({ present: true, packages: ['tikz-cd'], offline: true });
  await off.setup.ensureAtStart();
  expect(off.calls.ensure).toEqual([['tikz-cd']]);
  expect(warn).toHaveBeenLastCalledWith('Paquets LaTeX non vérifiés :', expect.any(Error));
});

// --- the interface's side

test('withPackage : un ajout à latexPackages ; un paquet déjà là, ou que provision installe, rend null', () => {
  const p = { ...DEFAULT_PARAMS, latexPackages: ['siunitx'] };
  expect(withPackage(p, 'tikz-cd')?.latexPackages).toEqual(['siunitx', 'tikz-cd']);
  expect(p.latexPackages).toEqual(['siunitx']);
  expect(withPackage(p, 'siunitx')).toBeNull();
  for (const name of BASE_PACKAGES) expect(withPackage(p, name), name).toBeNull();
  // A word the setting refuses (WORD) would make the whole list invalid: never added.
  expect(withPackage(p, '-x')).toBeNull();
});

test('preambleBuild : « Modifier le préambule LaTeX », que Ctrl+Z annule', async () => {
  const s = emptyState();
  let seq = 0;
  const session = new EditSession(s, async (a: Action) => ({ seq: (seq += a.ops.length), at: 0 }), () => {});
  const text = '\\documentclass{article}\n\\usepackage{tikz-cd}\n';
  const r = await session.run(preambleBuild(text)!);
  expect(r).toMatchObject({ ok: true, action: { label: 'Modifier le préambule LaTeX' } });
  expect(preambleText(session.state)).toBe(text);
  expect((await session.undo()).ok).toBe(true);
  expect(preambleText(session.state)).toBe(DEFAULT_PREAMBLE);
  expect((await session.redo()).ok).toBe(true);
  expect(preambleText(session.state)).toBe(text);
});

test('LatexNotice : ce qu’elle dit de chaque état, une fois par session pour l’absence', () => {
  const fresh = { dismissed: false, justInstalled: false };
  expect(noticeFor(null, fresh)).toBeNull();
  expect(noticeFor({ state: 'absent' }, fresh)).toEqual({
    // The pinned installer's size (LATEX_SOURCES: 73,7 Mo), rounded (final review, M4).
    text: 'LaTeX n’est pas installé : les résumés et les .tex s’affichent en source. Cirrus peut installer TinyTeX (environ 74 Mo à télécharger).',
    actions: ['install', 'later'],
  });
  expect(noticeFor({ state: 'absent' }, { ...fresh, dismissed: true })).toBeNull();
  const installing = (progress: Extract<LatexStatus, { state: 'installing' }>['progress']) => noticeFor({ state: 'installing', progress }, { ...fresh, dismissed: true });
  expect(installing({ step: 'download', done: 37_400, total: 100_000 })).toEqual({ text: 'Installation de LaTeX : 37 %', actions: [] });
  expect(installing({ step: 'download', done: 0, total: 0 })).toEqual({ text: 'Installation de LaTeX : 0 %', actions: [] });
  expect(installing({ step: 'extract' })).toEqual({ text: 'Installation de LaTeX : décompression…', actions: [] });
  expect(installing({ step: 'packages', names: ['pgf'] })).toEqual({ text: 'Installation des paquets…', actions: [] });
  expect(installing({ step: 'package', name: 'tikz-cd.sty' })).toEqual({ text: 'Installation du paquet LaTeX « tikz-cd.sty »…', actions: [] });
  expect(noticeFor(READY, fresh)).toBeNull();
  expect(noticeFor(READY, { ...fresh, justInstalled: true })).toEqual({ text: 'LaTeX est installé.', actions: [] });
  expect(noticeFor({ state: 'failed', message: 'réseau coupé' }, fresh)).toEqual({ text: 'L’installation de LaTeX a échoué : réseau coupé', actions: ['retry', 'later'] });
  expect(noticeFor({ state: 'failed', message: 'réseau coupé' }, { ...fresh, dismissed: true })).toBeNull();
});

test('réglages, section « LaTeX » : l’état de LaTeX', () => {
  expect(latexStateText(READY)).toBe('LaTeX : prêt (TeX Live 2026)');
  expect(latexStateText({ state: 'absent' })).toBe('LaTeX : absent');
  expect(latexStateText({ state: 'installing', progress: { step: 'extract' } })).toBe('LaTeX : installation…');
  expect(latexStateText({ state: 'failed', message: 'x' })).toBe('LaTeX : l’installation a échoué');
  expect(latexStateText(null)).toBe('LaTeX : …');
});

test('préambule : l’aperçu compile PREAMBLE_SAMPLE avec le brouillon, sous l’emplacement « preamble », en mode page', () => {
  expect(preambleRequest('\\documentclass{article}\n')).toEqual({
    slot: 'preamble', mode: 'page', source: PREAMBLE_SAMPLE, preamble: '\\documentclass{article}\n', refs: [], broken: [], doubled: [], cites: [],
    doubledCites: [], unknownCites: [], known: [], resources: [], widthCm: null,
  });
  // An accented paragraph, a numbered equation cited by \eqref, a list and a link.
  expect(PREAMBLE_SAMPLE).toMatch(/[éèàç]/);
  expect(PREAMBLE_SAMPLE).toMatch(/\\begin\{equation\}[^]*\\label\{([^}]+)\}[^]*\\end\{equation\}/);
  expect(PREAMBLE_SAMPLE).toContain('\\eqref{');
  expect(PREAMBLE_SAMPLE).toMatch(/\\begin\{itemize\}[^]*\\item[^]*\\end\{itemize\}/);
  expect(PREAMBLE_SAMPLE).toContain('\\href{');
});

test('préambule : Enregistrer ferme s’il est inchangé, attend la compilation en cours, demande s’il ne compile pas', () => {
  const error = { message: 'Undefined control sequence.', line: 2, where: 'preamble' as const };
  expect(saveStep('P', 'P', { pending: false, error: null })).toBe('close');
  expect(saveStep('P2', 'P', { pending: true, error: null })).toBe('wait');
  expect(saveStep('P2', 'P', { pending: false, error })).toBe('ask');
  expect(saveStep('P2', 'P', { pending: false, error: null })).toBe('save');
  let saved = 0, closed = 0;
  const broken = brokenPreambleQuestion(() => { saved++; });
  expect([broken.text, broken.choices, focusedChoice(broken)]).toEqual(['Le préambule ne compile pas. L’enregistrer quand même ?', [{ value: 'save', label: 'Enregistrer quand même' }], -1]);
  broken.answer(null);
  broken.answer('save');
  const discard = discardPreambleQuestion(() => { closed++; });
  expect([discard.text, discard.choices, focusedChoice(discard)]).toEqual(['Abandonner les modifications du préambule ?', [{ value: 'drop', label: 'Abandonner' }], -1]);
  discard.answer(null);
  discard.answer('drop');
  expect([saved, closed]).toEqual([1, 1]);
});

test('préambule : le quitter sans l’enregistrer remet les pdfLaTeX préparés sur le préambule enregistré, puis ferme (revue finale)', () => {
  // The draft's compilations took the main process's pool to the draft's preamble: the next summary would wait for a
  // cold pdfLaTeX.
  const events: string[] = [];
  leaveUnsaved('\\documentclass{article}\n', (p) => events.push(`préparer ${p}`), () => events.push('fermer'));
  expect(events).toEqual(['préparer \\documentclass{article}\n', 'fermer']);
});

// --- PREAMBLE_SAMPLE compiled for real, by the bench's TinyTeX (read only; never a download)

const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEX = process.env.CIRRUS_TINYTEX || join(repo, 'bench', 'latex', 'vendor', 'TinyTeX');
const hasTex = existsSync(join(TEX, 'bin', 'windows', 'pdflatex.exe'));

test.skipIf(!hasTex)(hasTex ? 'PREAMBLE_SAMPLE compile sous DEFAULT_PREAMBLE : accents, équation numérotée citée, liste, lien' : `PREAMBLE_SAMPLE compile (sauté : pas de TinyTeX dans ${TEX})`, async () => {
  const bins = await findBinaries(TEX);
  const base = mkdtempSync(join(tmpdir(), 'cirrus-préambule-'));
  const svc = new LatexService({
    binaries: async () => bins, root: join(base, 'latex'), store: base, params: () => DEFAULT_PARAMS,
    cache: new PdfCache(join(base, 'latex', 'cache'), () => DEFAULT_PARAMS.latexCacheMb * 2 ** 20),
  });
  try {
    const a = await svc.compile(preambleRequest(DEFAULT_PREAMBLE));
    if (a.status !== 'ok') throw new Error(JSON.stringify(a).slice(0, 2000));
    const [page] = await readPdf(join(base, 'latex', 'cache', `${a.pdf.key}.pdf`));
    const text = page.text.replace(/\s+/g, ' ');
    expect(text).toContain('accentué');
    expect(text).toContain('(1)');
    expect(text).not.toContain('??');
    expect(text).toContain('CTAN');
  } finally {
    await svc.dispose();
    rmSync(base, { recursive: true, force: true, maxRetries: 10 });
  }
}, 60_000);
