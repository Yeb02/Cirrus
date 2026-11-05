import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type CompileRequest, DEFAULT_PREAMBLE, isStandalone, withoutComments } from '@cirrus/core';
import { expect, test } from 'vitest';
import { citedLabels, driverSource, jobBody } from '../src/main/latex/driver.ts';
import { parseLog, readAux } from '../src/main/latex/log.ts';

/**
 * Real logs of pdfTeX 1.40.29 (TinyTeX v2026.11), under the warm driver and the service's environment (max_print_line:
 * no line is cut). Trimmed for size: the TinyTeX path is shortened, and a line is dropped only when its own parentheses
 * close what they open (« (Font) », « (HO) »), so that the stack of open files stays the real one.
 */
const LOGS = join(dirname(fileURLToPath(import.meta.url)), 'latex-logs');
const log = (name: string) => readFileSync(join(LOGS, `${name}.log`), 'utf8');
const SRC = 'job-1-src.tex';

test('parseLog : une erreur dans la source donne sa ligne dans la source', () => {
  expect(parseLog(log('source'), SRC)).toEqual({ error: { message: 'Undefined control sequence.', line: 4, where: 'source' }, pages: 0, warnings: 1 });
  // CRLF, as a log read back on Windows may be.
  expect(parseLog(log('source').replaceAll('\n', '\r\n'), SRC).error).toEqual({ message: 'Undefined control sequence.', line: 4, where: 'source' });
});

test('parseLog : une erreur dans un fichier que la source lit (\\input{annexe}) est de la source, sans ligne', () => {
  expect(parseLog(log('nested'), SRC).error).toEqual({ message: 'Undefined control sequence.', line: null, where: 'source' });
});

test('parseLog : les extraits de boîtes trop pleines, aux parenthèses ouvertes, ne trompent pas la pile des fichiers', () => {
  expect(parseLog(log('overfull'), SRC).error).toEqual({ message: 'Undefined control sequence.', line: 5, where: 'source' });
});

test('parseLog : une erreur pendant le chargement du préambule le dit, avec sa ligne dans le préambule', () => {
  expect(parseLog(log('preamble'), SRC)).toEqual({
    error: { message: 'Le préambule ne compile pas : Undefined control sequence.', line: 4, where: 'preamble' }, pages: 0, warnings: 0,
  });
  // A missing package of the last line: TeX is back in the driver when it fails, so no line of the preamble.
  expect(parseLog(log('missing'), SRC).error).toEqual({
    message: 'Le préambule ne compile pas : LaTeX Error: File `paquetinexistant.sty\' not found.', line: null, where: 'preamble',
  });
});

test('parseLog : sans erreur, le nombre de pages et d’avertissements', () => {
  expect(parseLog(log('pages'), SRC)).toEqual({ error: null, pages: 2, warnings: 6 });
  expect(parseLog('Output written on job-3.pdf (1 page, 12345 bytes).\n', SRC)).toEqual({ error: null, pages: 1, warnings: 0 });
  expect(parseLog('', SRC)).toEqual({ error: null, pages: 0, warnings: 0 });
});

test('parseLog : un document autonome (\\documentclass), sans pilote, est tout entier la source', () => {
  expect(parseLog(log('standalone'), SRC).error).toEqual({ message: 'Undefined control sequence.', line: 3, where: 'source' });
});

// The .aux of real compilations (TinyTeX v2026.11): with hyperref, and with the kernel alone (five fields too, since 2023).
const AUX_HYPERREF = String.raw`\relax
\providecommand\hyper@newdestlabel[2]{}
\providecommand\HyField@AuxAddToFields[1]{}
\providecommand\HyField@AuxAddToCoFields[2]{}
\@writefile{toc}{\contentsline {section}{\numberline {1}Un}{1}{section.1}\protected@file@percent }
\newlabel{sec:un}{{1}{1}{Un}{section.1}{}}
\newlabel{eq:a}{{1}{1}{Un}{equation.1}{}}
\newlabel{b}{{2}{2}{Un}{equation.2}{}}
\gdef \@abspage@last{2}
`;
const AUX_KERNEL = String.raw`\relax
\@writefile{toc}{\contentsline {section}{\numberline {1}Un}{1}{}\protected@file@percent }
\newlabel{sec:un}{{1}{1}{}{section.1}{}}
\newlabel{eq:a}{{1}{1}{}{equation.1}{}}
\gdef \@abspage@last{1}
`;

test('readAux : les labels du .aux, numéro, page et ancre', () => {
  expect(readAux(AUX_HYPERREF)).toEqual([
    { label: 'sec:un', number: '1', page: '1', anchor: 'section.1' },
    { label: 'eq:a', number: '1', page: '1', anchor: 'equation.1' },
    { label: 'b', number: '2', page: '2', anchor: 'equation.2' },
  ]);
  expect(readAux(AUX_KERNEL)).toEqual([
    { label: 'sec:un', number: '1', page: '1', anchor: 'section.1' },
    { label: 'eq:a', number: '1', page: '1', anchor: 'equation.1' },
  ]);
  // Two fields (an older kernel); groups inside a field; a label written twice keeps its last value, in its first place.
  expect(readAux(String.raw`\newlabel{a}{{1}{2}}
\newlabel{thm:é}{{\relax 2.1}{3}{Complexit\IeC {\'e}}{theorem.2.1}{}}
\newlabel{a}{{4}{5}{}{x.4}{}}
`)).toEqual([
    { label: 'a', number: '4', page: '5', anchor: 'x.4' },
    { label: 'thm:é', number: '\\relax 2.1', page: '3', anchor: 'theorem.2.1' },
  ]);
  expect(readAux('')).toEqual([]);
  expect(readAux('\\newlabel{cassé}{{1}')).toEqual([]);
});

const req = (over: Partial<CompileRequest> = {}): CompileRequest => ({
  slot: 'summary:n1', mode: 'page', source: 'x', preamble: DEFAULT_PREAMBLE, refs: [], broken: [], doubled: [], cites: [], doubledCites: [], unknownCites: [],
  known: [], resources: [], ...over,
});
const NODE = '0192f0c3-7a1b-7c2d-8e3f-a1b2c3d4e5f6';

test('driverSource : le préambule par son nom relatif, les macros de l’app, les replis, puis le job lu en \\scrollmode', () => {
  const d = driverSource();
  const order = [
    '\\input{preamble}', '\\def\\cirrus@red', '\\def\\cirrus@link', '\\providecommand\\mathbb', '\\providecommand\\textcolor', '\\providecommand\\href',
    '\\begin{document}', '\\message{CIRRUS-READY}', '\\scrollmode', '\\read16 to \\cirrusjob', '\\nonstopmode', '\\input{\\cirrusjob}', '\\end{document}',
  ];
  const at = order.map((s) => d.indexOf(s));
  expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
  // No absolute path reaches TeX (a drive letter: one letter alone, unlike « cirrus:// »).
  expect(d).not.toMatch(/(?<![A-Za-z])[A-Za-z]:[\\/]/);
});

test('jobBody : les labels connus, puis les références, les cassés, les doublons, les citations, les clés en double et les clés inconnues, puis la source', () => {
  const body = jobBody(req({
    known: [{ label: 'a', number: '1', page: '1', anchor: 'equation.1' }],
    refs: [{ label: 'mdl:enonce', title: 'Minimum Description Length Principle (MDL)', node: NODE }],
    broken: ['absent:label'],
    doubled: [{ label: 'dup', title: 'Titre du doublon', node: NODE }],
    cites: [{ key: 'li2008', text: 'Li et Vitányi, 2008', node: NODE }],
    // A key held by several nodes: the first's citation, in red and linked to it, as a doubled label.
    doubledCites: [{ key: 'deux', text: 'Li, 2008', node: NODE }],
    unknownCites: ['li2009'],
  }), SRC, 9);
  const parts = [
    '\\cirrus@label{\\detokenize{a}}{1}{1}{equation.1}',
    `\\cirrus@label{\\detokenize{mdl:enonce}}{\\cirrus@link{${NODE}}{Minimum Description Length Principle (MDL)}}`,
    '\\cirrus@label{\\detokenize{absent:label}}{\\cirrus@red{absent:label~?}}',
    `\\cirrus@label{\\detokenize{dup}}{\\cirrus@link{${NODE}}{\\cirrus@red{Titre du doublon}}}`,
    `\\cirrus@cite{\\detokenize{li2008}}{\\cirrus@link{${NODE}}{Li et Vitányi, 2008}}`,
    `\\cirrus@cite{\\detokenize{deux}}{\\cirrus@link{${NODE}}{\\cirrus@red{Li, 2008}}}`,
    '\\cirrus@cite{\\detokenize{li2009}}{\\cirrus@red{li2009~?}}',
    `\\input{${SRC}}`,
  ];
  const at = parts.map((s) => body.indexOf(s));
  expect(at.every((i) => i >= 0), JSON.stringify(at)).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);
});

test('jobBody : un titre passe par titleToTex ; un label refusé par safeLabel, ou porteur de ^^, est omis ; un nœud mal formé n’a pas de lien', () => {
  const body = jobBody(req({
    refs: [
      { label: 'ok', title: '50 % & co_x #1 {a} \\input{x}', node: NODE },
      { label: 'a}b', title: 'Jamais', node: NODE }, { label: 'x^^7b', title: 'Jamais', node: NODE }, { label: '', title: 'Jamais', node: NODE },
      { label: 'sans-lien', title: 'Sans lien', node: 'a b}' }, { label: 'nul', title: 'Nul', node: null },
    ],
    broken: ['c%d'], cites: [{ key: 'k#1', text: 'Jamais', node: NODE }], doubledCites: [{ key: 'x^^7b', text: 'Jamais', node: NODE }], unknownCites: ['u{'],
    known: [{ label: 'k', number: '1}', page: '1', anchor: 'x' }, { label: 'k2', number: '#1', page: '1', anchor: 'x' }],
  }), SRC, 9);
  expect(body).toContain(`\\cirrus@link{${NODE}}{50 \\% \\& co\\_x \\#1 \\{a\\} \\textbackslash{}input\\{x\\}}`);
  expect(body).not.toContain('Jamais');
  expect(body).not.toMatch(/c%d|u\{|k#1|\{k\}|\{k2\}/);
  expect(body).toContain('\\cirrus@label{\\detokenize{sans-lien}}{Sans lien}');
  expect(body).toContain('\\cirrus@label{\\detokenize{nul}}{Nul}');
});

test('jobBody : en mode snippet, la source composée dans une boîte de la largeur réglée, émise seule sur une page à sa taille', () => {
  const body = jobBody(req({ mode: 'snippet' }), SRC, 9.5);
  for (const s of ['\\hsize=9.5cm', '\\parindent=0pt', `\\input{${SRC}}`, '\\pdfpagewidth=\\wd', '\\pdfpageheight=', '\\shipout']) expect(body, s).toContain(s);
  const page = jobBody(req({ mode: 'page' }), SRC, 9.5);
  expect(page).toContain(`\\input{${SRC}}`);
  expect(page).not.toContain('\\shipout');
  expect(page).not.toContain('\\hsize');
});

test('les scans de la source : commentaires, \\documentclass, labels cités', () => {
  expect(withoutComments('a % b\n\\% c % d\n\\\\% e\nf')).toBe('a \n\\% c \n\\\\\nf');
  expect(isStandalone('\\documentclass{article}\n\\begin{document}x\\end{document}')).toBe(true);
  expect(isStandalone('  \\documentclass[letterpaper]{article}')).toBe(true);
  expect(isStandalone('% \\documentclass{article}\nx')).toBe(false);
  expect(isStandalone('\\\\% \\documentclass{article}')).toBe(false);
  expect(isStandalone('\\% \\documentclass{article}')).toBe(true);
  expect(isStandalone('\\documentclassx{article}')).toBe(false);
  expect(isStandalone('Bonjour.')).toBe(false);
  expect(citedLabels('\\ref{a} \\eqref{b} \\pageref{c} \\cref{d, e} \\autoref*{f} % \\ref{g}\n\\label{h}')).toEqual(new Set(['a', 'b', 'c', 'd', 'e', 'f']));
});
