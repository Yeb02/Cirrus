import type { ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CompileAnswer, type CompileRequest, DEFAULT_PREAMBLE, type LatexStatus } from '@cirrus/core';
import { filePath, importFile } from '@cirrus/store';
import { DEFAULT_PARAMS, type RenderParams } from '@cirrus/view';
import { afterEach, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { PdfCache } from '../src/main/latex/cache.ts';
import { invalidRequest, LatexService } from '../src/main/latex/compiler.ts';
import { findBinaries, type TexBinaries } from '../src/main/latex/tinytex.ts';
import { readPdf } from './latexPdf.ts';

/** Every process the service starts, to check that none is left (and that a cache hit starts none). */
const spawned = vi.hoisted(() => [] as ChildProcess[]);
vi.mock('node:child_process', async (original) => {
  const cp = await original<typeof import('node:child_process')>();
  const spawn = ((...args: unknown[]) => {
    const p = (cp.spawn as (...a: unknown[]) => ChildProcess)(...args);
    spawned.push(p);
    return p;
  }) as typeof cp.spawn;
  return { ...cp, spawn, default: { ...cp, spawn } };
});

// The bench's TinyTeX (or CIRRUS_TINYTEX), read only: the tests never download anything.
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const TEX = process.env.CIRRUS_TINYTEX || join(repo, 'bench', 'latex', 'vendor', 'TinyTeX');
const hasTex = existsSync(join(TEX, 'bin', 'windows', 'pdflatex.exe'));
const ASSETS = join(repo, 'packages', 'fixtures', 'assets');
const texTest = (name: string, fn: () => Promise<void>, timeout = 60_000) =>
  test.skipIf(!hasTex)(hasTex ? name : `${name} (sauté : pas de TinyTeX dans ${TEX})`, fn, timeout);

let bins: TexBinaries | null = null;
beforeAll(async () => { if (hasTex) bins = await findBinaries(TEX); }, 30_000);

// Each test has its own base, its path accented (Review Focus 1): the service's folders are under it.
let base: string;
let svc: LatexService | null = null;
const statuses: LatexStatus[] = [];
beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'cirrus-é-latex-'));
  spawned.length = 0;
  statuses.length = 0;
});
afterEach(async () => {
  await svc?.dispose();
  svc = null;
  rmSync(base, { recursive: true, force: true, maxRetries: 10 });
});

function start(over: Partial<RenderParams> = {}, binaries: () => Promise<TexBinaries | null> = async () => bins): LatexService {
  const params: RenderParams = { ...DEFAULT_PARAMS, ...over };
  svc = new LatexService({
    binaries, root: join(base, 'latex'), store: base, params: () => params, status: (s) => statuses.push(s),
    cache: new PdfCache(join(base, 'latex', 'cache'), () => params.latexCacheMb * 2 ** 20),
  });
  return svc;
}

const req = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  slot: 'summary:n1', mode: 'snippet', source: 'Bonjour $x^2$.', preamble: DEFAULT_PREAMBLE, refs: [], broken: [], doubled: [], cites: [],
  unknownCites: [], known: [], resources: [], ...over,
});
const NODE = '0192f0c3-7a1b-7c2d-8e3f-a1b2c3d4e5f6';
const PUB = '0192f0c3-7a1b-7c2d-8e3f-000000000042';
const MDL = 'Minimum Description Length Principle (MDL)';
const LOOP = '\\loop\\iftrue\\repeat';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

function ok(a: CompileAnswer): Extract<CompileAnswer, { status: 'ok' }> {
  if (a.status !== 'ok') throw new Error(`compilation : ${JSON.stringify(a).slice(0, 3000)}`);
  return a;
}
const pagesOf = async (a: CompileAnswer) => readPdf(join(base, 'latex', 'cache', `${ok(a).pdf.key}.pdf`));
/** \openout to `name` (\detokenize: a file name with « é » or « / » reaches TeX as it is written), then one line. */
const openout = (name: string) => `\\newwrite\\w\\immediate\\openout\\w=\\detokenize{${name}}\\immediate\\write\\w{x}\\immediate\\closeout\\w Fait.`;

// --- without pdfLaTeX ---

test('invalidRequest : une requête bien formée passe ; une forme fausse, une source trop longue, une ressource absente ou un nom qui sort sont refusés', () => {
  const png = importFile(base, join(ASSETS, 'schéma_compression.png'));
  const good = req({
    resources: [png], refs: [{ label: 'a', title: 'A', node: NODE }, { label: 'b', title: 'B', node: null }], broken: ['c'],
    doubled: [{ label: 'd', title: 'D', node: NODE }], cites: [{ key: 'k', text: 'K', node: PUB }], unknownCites: ['u'],
    known: [{ label: 'e', number: '1', page: '1', anchor: 'equation.1' }],
  });
  expect(invalidRequest(good, base, 1000)).toBeNull();
  const bad: [string, unknown][] = [
    ['rien', null], ['un texte', 'x'], ['sans emplacement', { ...good, slot: 3 }], ['un mode inconnu', { ...good, mode: 'pdf' }],
    ['une source trop longue', { ...good, source: 'é'.repeat(501) }], ['un préambule qui n’est pas un texte', { ...good, preamble: null }],
    ['refs pas une liste', { ...good, refs: {} }], ['un ref sans titre', { ...good, refs: [{ label: 'a', node: null }] }],
    ['un nœud qui n’est pas un texte', { ...good, doubled: [{ label: 'd', title: 'D', node: 3 }] }],
    ['un label cassé qui n’est pas un texte', { ...good, broken: [1] }], ['une citation sans nœud', { ...good, cites: [{ key: 'k', text: 'K', node: null }] }],
    ['une clé inconnue qui n’est pas un texte', { ...good, unknownCites: [null] }],
    ['un label connu incomplet', { ...good, known: [{ label: 'e', number: '1', page: '1' }] }],
    ['une ressource absente du magasin', { ...good, resources: [{ ...png, hash: 'f'.repeat(64) }] }],
    ['une empreinte mal formée', { ...good, resources: [{ ...png, hash: '../../x' }] }],
    ...['a/b.png', 'a\\b.png', 'c:x.png', '.', '..', ''].map((name): [string, unknown] => [`le nom ${name}`, { ...good, resources: [{ ...png, name }] }]),
  ];
  for (const [what, x] of bad) expect(invalidRequest(x, base, 1000), what).toEqual(expect.any(String));
});

test('sans pdfLaTeX : unavailable, avec reason « absent », dit par le statut, et rien n’est lancé', async () => {
  const s = start({}, async () => null);
  expect(await s.compile(req())).toEqual({ status: 'unavailable', reason: 'absent', message: 'LaTeX n’est pas installé.' });
  expect(await s.state()).toEqual({ state: 'absent' });
  expect(statuses).toEqual([{ state: 'absent' }]);
  s.warm(DEFAULT_PREAMBLE);
  await sleep(50);
  expect(spawned).toEqual([]);
});

// --- with pdfLaTeX ---

texTest('snippet : la page a la largeur réglée et la hauteur du contenu', async () => {
  const a = ok(await start().compile(req()));
  expect(a).toMatchObject({ passes: 1, cached: false, pdf: { pages: 1 } });
  const [page] = await pagesOf(a);
  expect(Math.abs(page.width - 255.1)).toBeLessThan(1);
  expect(page.height).toBeLessThan(40);
  expect(page.text).toContain('Bonjour');
  expect(await svc!.state()).toEqual({ state: 'ready' });
  expect(statuses).toEqual([{ state: 'ready' }]);
});

texTest('page : un fragment prend les pages du préambule', async () => {
  const pages = await pagesOf(await start().compile(req({ mode: 'page' })));
  expect(pages).toHaveLength(1);
  expect(Math.abs(pages[0].width - 595.3)).toBeLessThan(0.5);
});

texTest('un \\ref vers un autre nœud affiche son titre et mène au nœud', async () => {
  const a = await start().compile(req({ mode: 'page', source: 'Voir \\ref{mdl:enonce}.', refs: [{ label: 'mdl:enonce', title: MDL, node: NODE }] }));
  const [page] = await pagesOf(a);
  expect(page.text).toContain(`Voir ${MDL}.`);
  expect(page.links).toEqual([`cirrus://node/${NODE}`]);
});

texTest('titres spéciaux : rien ne casse', async () => {
  const special = '50 % & co_x #1 {a} \\input{x}';
  const a = await start().compile(req({
    mode: 'page', source: 'A : \\ref{t1}. B : \\ref{t2}. C : \\ref{t3}.',
    refs: [
      { label: 't1', title: special, node: NODE }, { label: 't2', title: 'Rasoir d’Occam formalisé', node: NODE },
      { label: 't3', title: '50 % & co_x #1 {a} ~ ^ \\input{x} θ ≤ ∑', node: NODE },
    ],
  }));
  const [page] = await pagesOf(a);
  expect(page.text).toContain(special);
  expect(page.text).toContain('Rasoir d’Occam formalisé');
});

texTest('babel français : les références injectées tiennent', async () => {
  // babel-french's french.ldf (whose « : » is active) is not in the bench's TinyTeX: French comes from babel's locale,
  // and « : » is made a shorthand, active, by babel's own mechanism, as french.ldf does.
  const babel = '\\usepackage[french,provide=*]{babel}\n\\useshorthands*{:}\\defineshorthand{:}{\\thinspace\\string:}\n';
  const preamble = DEFAULT_PREAMBLE.replace('\\usepackage{lmodern}\n', `\\usepackage{lmodern}\n${babel}`);
  const a = await start().compile(req({
    mode: 'page', preamble, source: 'Voir \\ref{eq:x} et \\cite{li:2008}.', refs: [{ label: 'eq:x', title: 'Inégalité de Kraft', node: NODE }],
    cites: [{ key: 'li:2008', text: 'Li et Vitányi, 2008', node: PUB }],
  }));
  const [page] = await pagesOf(a);
  expect(page.text).toContain('Inégalité de Kraft');
  expect(page.text).toContain('Li et Vitányi, 2008');
  expect(page.links).toEqual([`cirrus://node/${NODE}`, `cirrus://node/${PUB}`]);
});

texTest('label cassé et doublon en rouge', async () => {
  const a = await start().compile(req({
    mode: 'page', source: 'Cassé : \\ref{absent:label}. Doublon : \\ref{dup}.', broken: ['absent:label'],
    doubled: [{ label: 'dup', title: 'Titre du doublon', node: NODE }],
  }));
  const [page] = await pagesOf(a);
  expect(page.text).toContain('absent:label ?');
  expect(page.text).toContain('Titre du doublon');
  expect(page.colors).toContain('#ff0000');
});

texTest('\\cite d’une publication', async () => {
  const a = await start().compile(req({ mode: 'page', source: 'Voir \\cite{li2008} et \\cite{li2009}.', cites: [{ key: 'li2008', text: 'Li et Vitányi, 2008', node: PUB }], unknownCites: ['li2009'] }));
  const [page] = await pagesOf(a);
  expect(page.text).toContain('[Li et Vitányi, 2008]');
  expect(page.text).toContain('[li2009 ?]');
  expect(page.links).toEqual([`cirrus://node/${PUB}`]);
});

texTest('numéros internes : seconde passe seulement s’ils changent', async () => {
  const s = start();
  const src = '\\begin{equation}\\label{a}E=mc^2\\end{equation}Voir (\\ref{a}).';
  const first = ok(await s.compile(req({ source: src })));
  expect(first.passes).toBe(2);
  expect(first.labels).toEqual([{ label: 'a', number: '1', page: '1', anchor: 'equation.1' }]);
  expect((await pagesOf(first))[0].text).toContain('Voir (1).');
  const second = ok(await s.compile(req({ source: src.replace('Voir', 'Lire'), known: first.labels })));
  expect(second.passes).toBe(1);
  expect((await pagesOf(second))[0].text).toContain('Lire (1).');
  // A source that defines a label without citing it compiles once.
  expect(ok(await s.compile(req({ source: '\\begin{equation}\\label{b}x\\end{equation}' }))).passes).toBe(1);
});

texTest('cache : la même requête ne recompile pas', async () => {
  const s = start();
  const first = ok(await s.compile(req()));
  const n = spawned.length;
  const again = ok(await s.compile(req({ known: first.labels })));
  expect(again).toMatchObject({ cached: true, pdf: first.pdf, passes: first.passes, labels: first.labels, log: first.log });
  expect(spawned.length).toBe(n);
});

texTest('annulation par l’emplacement', async () => {
  const s = start({ latexTimeoutMs: 60_000 });
  ok(await s.compile(req({ slot: 'chauffe' })));
  const slow = s.compile(req({ slot: 's', source: LOOP }));
  await sleep(400);
  const fast = await s.compile(req({ slot: 's', source: 'Vite.' }));
  expect(await slow).toEqual({ status: 'cancelled' });
  expect(fast.status).toBe('ok');
  // cancel() alone, too.
  const again = s.compile(req({ slot: 's', source: `${LOOP} ` }));
  await sleep(300);
  s.cancel('s');
  expect(await again).toEqual({ status: 'cancelled' });
});

texTest('délai : une boucle infinie est arrêtée', async () => {
  const s = start({ latexTimeoutMs: 2000 });
  ok(await s.compile(req({ slot: 'chauffe' })));
  const t0 = performance.now();
  const a = await s.compile(req({ source: LOOP }));
  expect(performance.now() - t0).toBeLessThan(4000);
  expect(a).toMatchObject({ status: 'error', error: { message: 'Compilation trop longue (plus de 2 s) : arrêtée.', line: null, where: 'source' } });
});

texTest('préambule invalide : dit, et vite', async () => {
  const s = start();
  const preamble = '\\documentclass{article}\n\\usepackage{amsmath}\n\\badmacro\n';
  const t0 = performance.now();
  const a = await s.compile(req({ preamble }));
  expect(performance.now() - t0).toBeLessThan(DEFAULT_PARAMS.latexTimeoutMs / 2);
  expect(a).toMatchObject({ status: 'error', error: { message: 'Le préambule ne compile pas : Undefined control sequence.', line: 3, where: 'preamble' } });
  // Said again at once, without starting another pdfLaTeX; another preamble is tried.
  const n = spawned.length;
  expect(await s.compile(req({ slot: 'autre', preamble }))).toMatchObject({ status: 'error', error: { where: 'preamble' } });
  expect(spawned.length).toBe(n);
  ok(await s.compile(req({ slot: 'autre' })));
});

// Review Focus 2, as decided after TeX Live 2026 made openin_any a no-op: TeX writes only in its folder and runs nothing.
texTest('TeX n’écrit pas dans les fichiers du nœud', async () => {
  const png = importFile(base, join(ASSETS, 'schéma_compression.png'));
  const before = sha(filePath(base, png));
  const s = start();
  // By its name: written in the work folder, beside the link, which stays as it was.
  ok(await s.compile(req({ resources: [png], source: openout('schéma_compression.png') })));
  // By the links folder: refused. The k-th compilation of a service runs in p<k>, so each attempt aims at its own folder.
  for (const k of [2, 3, 4, 5]) {
    const a = await s.compile(req({ slot: `s${k}`, resources: [png], source: openout(`../../links/p${k}/schéma_compression.png`) }));
    expect(a.status === 'error' && a.error.message, `p${k}`).toMatch(/I can't write on file/);
  }
  expect(sha(filePath(base, png))).toBe(before);
});

texTest('TeX n’écrit pas hors de son dossier', async () => {
  const s = start();
  const outside = join(tmpdir(), `cirrus-dehors-${randomBytes(6).toString('hex')}.txt`);
  for (const target of [outside.replace(/\\/g, '/'), '../dehors', '../../dehors']) {
    const a = await s.compile(req({ slot: target, source: openout(target) }));
    expect(a.status === 'error' && a.error.message, target).toMatch(/I can't write on file/);
  }
  expect(existsSync(outside)).toBe(false);
  for (const p of [join(base, 'latex', 'work', 'dehors.tex'), join(base, 'latex', 'dehors.tex')]) expect(existsSync(p), p).toBe(false);
});

texTest('TeX n’écrit pas hors de son dossier : TEXMF_OUTPUT_DIRECTORY du parent est ignoré', async () => {
  const elsewhere = mkdtempSync(join(tmpdir(), 'cirrus-ailleurs-'));
  process.env.TEXMF_OUTPUT_DIRECTORY = elsewhere;
  try {
    ok(await start().compile(req({ source: openout('trace.txt') })));
    expect(readdirSync(elsewhere)).toEqual([]);
  } finally {
    delete process.env.TEXMF_OUTPUT_DIRECTORY;
    rmSync(elsewhere, { recursive: true, force: true, maxRetries: 10 });
  }
});

texTest('aucune commande', async () => {
  const target = join(tmpdir(), `cirrus-pwned-${randomBytes(6).toString('hex')}.txt`);
  const a = await start().compile(req({ source: `\\immediate\\write18{cmd /c echo x > ${target.replace(/\\/g, '/')}}Rien.` }));
  expect(a.status).toBe('ok');
  await sleep(300);
  expect(existsSync(target)).toBe(false);
});

texTest('fichiers du nœud sous leur nom', async () => {
  const png = importFile(base, join(ASSETS, 'schéma_compression.png'));
  const a = await start().compile(req({ mode: 'page', resources: [png], source: '\\includegraphics[width=2cm]{schéma_compression.png}' }));
  expect((await pagesOf(a))[0].images).toBe(1);
});

texTest('\\documentclass : compilé tel quel', async () => {
  // geometry gives pdfTeX the paper's size (the kernel alone leaves TinyTeX's A4); the default preamble's is A4.
  const a = ok(await start().compile(req({
    source: '% Un document autonome.\n\\documentclass[letterpaper]{article}\n\\usepackage{geometry}\n\\begin{document}\nBonjour.\n\\end{document}\n',
  })));
  const [page] = await pagesOf(a);
  expect(Math.abs(page.width - 612)).toBeLessThan(0.5);
  expect(page.text).toContain('Bonjour.');
  expect(a.passes).toBe(1);
  // Its labels and its table of contents take a second pass.
  const toc = ok(await svc!.compile(req({ slot: 'toc', source: '\\documentclass{article}\n\\begin{document}\n\\tableofcontents\n\\section{Un}\\label{un}Voir \\ref{un}.\n\\end{document}\n' })));
  expect(toc.passes).toBe(2);
  expect((await pagesOf(toc))[0].text).toMatch(/Contents 1 Un 1 1 Un Voir 1\./);
});

texTest('fichier manquant', async () => {
  const a = await start().compile(req({ preamble: `${DEFAULT_PREAMBLE}\\usepackage{paquetinexistant}\n` }));
  expect(a).toMatchObject({ status: 'error', missing: 'paquetinexistant.sty', error: { where: 'preamble' } });
});

texTest('fermeture : aucun pdfLaTeX ne reste', async () => {
  const s = start({ latexTimeoutMs: 60_000 });
  ok(await s.compile(req()));
  const running = s.compile(req({ slot: 'boucle', source: LOOP }));
  await sleep(300);
  expect(spawned.length).toBeGreaterThan(1);
  await s.dispose();
  svc = null;
  expect(await running).toEqual({ status: 'cancelled' });
  for (const p of spawned) {
    expect(p.exitCode !== null || p.signalCode !== null, `pid ${p.pid}`).toBe(true);
    expect(() => process.kill(p.pid!, 0), `pid ${p.pid}`).toThrow();
  }
  expect(await s.compile(req({ slot: 'après' }))).toEqual({ status: 'cancelled' });
});

texTest('complexité.tex préchauffé : p50 de 20 compilations sous trois fois la mesure (registre, tâche 3)', async () => {
  const png = importFile(base, join(ASSETS, 'schéma_compression.png'));
  const source = readFileSync(join(ASSETS, 'complexité.tex'), 'utf8');
  const s = start();
  const kolmogorov = req({
    slot: 'file:kolmogorov:complexité.tex', mode: 'page', source, resources: [png],
    refs: [
      { label: 'mdl:enonce', title: MDL, node: NODE }, { label: 'ent:def', title: 'Entropie de Shannon', node: NODE },
      { label: 'solomonoff', title: 'Induction de Solomonoff', node: NODE },
    ],
    broken: ['absent:label'], cites: [{ key: 'li2008', text: 'Li et Vitányi, 2008', node: PUB }],
  });
  const first = ok(await s.compile(kolmogorov));
  const ms: number[] = [];
  for (let i = 0; i < 20; i++) {
    await sleep(1200); // the pool prepared again: a warm compilation, not a wait for one
    const a = ok(await s.compile({ ...kolmogorov, source: `${source}% ${i}\n`, known: first.labels }));
    expect(a.passes).toBe(1);
    ms.push(a.ms);
  }
  ms.sort((x, y) => x - y);
  const p50 = (ms[9] + ms[10]) / 2;
  console.log(`complexité.tex préchauffé : p50 ${p50.toFixed(0)} ms sur 20 (min ${ms[0].toFixed(0)}, max ${ms[19].toFixed(0)})`);
  // Three times the measure (138 ms, registry of task 3).
  expect(p50).toBeLessThan(420);
}, 120_000);
