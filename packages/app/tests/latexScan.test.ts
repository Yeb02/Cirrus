import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { scanTex, type TexMark } from '../src/renderer/latex/scan.ts';

/** The mark of the `nth` occurrence (0-based) of `name` in `text`, on line `line`. */
function at(text: string, name: string, line: number, nth = 0): TexMark {
  let from = -1;
  for (let k = 0; k <= nth; k++) from = text.indexOf(name, from + 1);
  return { name, from, to: from + name.length, line };
}

test('scanTex : les labels, les refs et les citations, leurs positions dans les accolades et leurs lignes', () => {
  const t = 'Voir \\ref{a:b}.\n\\begin{equation}\\label{eq:1}x\\end{equation}\n\\eqref{eq:1}, \\citep{li2008} et \\cref{a:b, c}.';
  const s = scanTex(t);
  expect(s.labels).toEqual([at(t, 'eq:1', 2)]);
  // \cref takes a list: each name, without its spaces.
  const c = t.indexOf(', c}') + 2;
  expect(s.refs).toEqual([at(t, 'a:b', 1), at(t, 'eq:1', 3, 1), at(t, 'a:b', 3, 1), { name: 'c', from: c, to: c + 1, line: 3 }]);
  expect(s.cites).toEqual([at(t, 'li2008', 3)]);
  expect(s.standalone).toBe(false);
});

test('scanTex : un % non échappé commence un commentaire, jusqu’au bout de sa ligne', () => {
  const t = '% \\label{x}\n\\% \\label{y}\n\\\\% \\label{z}\na % \\ref{r}\n\\ref{s}';
  const s = scanTex(t);
  expect(s.labels).toEqual([at(t, 'y', 2)]);
  expect(s.refs).toEqual([at(t, 's', 5)]);
});

test('scanTex : \\cite[p.~3][voir]{a, b} donne deux marques, sans les espaces', () => {
  const t = 'Voir \\cite[p.~3][voir]{a, b}.';
  expect(scanTex(t).cites).toEqual([at(t, 'a', 1), at(t, 'b', 1)]);
  // A bracket inside braces does not close the optional argument; a third optional argument is not read.
  const u = '\\citep[{a]b}]{k}\\cite[x][y][z]{n}';
  expect(scanTex(u).cites).toEqual([at(u, 'k', 1)]);
});

test('scanTex : chaque commande de ref et de citation, et leurs formes étoilées', () => {
  for (const cmd of ['ref', 'eqref', 'pageref', 'autoref', 'cref', 'Cref', 'nameref', 'vref']) {
    for (const star of ['', '*']) expect(scanTex(`\\${cmd}${star}{x}`).refs.map((m) => m.name), cmd + star).toEqual(['x']);
  }
  for (const cmd of ['cite', 'citep', 'citet', 'citealp', 'citealt', 'citeauthor', 'citeyear', 'nocite', 'parencite', 'textcite']) {
    for (const star of ['', '*']) expect(scanTex(`\\${cmd}${star}[p.~1]{k}`).cites.map((m) => m.name), cmd + star).toEqual(['k']);
  }
  const t = '\\eqref*{x}';
  expect(scanTex(t).refs).toEqual([at(t, 'x', 1)]);
  // Spaces after the command, as TeX skips them; another command is not one of these.
  expect(scanTex('\\ref {a} \\ref* {b} \\labelx{c} \\refx{d} \\citex{e} \\Ref{f}')).toMatchObject({
    labels: [], refs: [{ name: 'a' }, { name: 'b' }], cites: [],
  });
});

test('scanTex : les environnements verbatim, Verbatim et lstlisting sont sautés', () => {
  const t = '\\begin{verbatim}\n\\label{v}\n\\end{verbatim}\n\\label{w}';
  expect(scanTex(t).labels).toEqual([at(t, 'w', 4)]);
  for (const env of ['verbatim', 'verbatim*', 'Verbatim', 'lstlisting']) {
    // A % inside does not start a comment: what follows the environment is read.
    const u = `\\begin{${env}}% \\ref{in}\n\\cite{in}\\end{${env}}\\ref{out}`;
    expect(scanTex(u), env).toMatchObject({ refs: [{ name: 'out', line: 2 }], cites: [] });
  }
  // Never closed: the rest of the text is in it.
  expect(scanTex('\\begin{lstlisting}\n\\label{a}').labels).toEqual([]);
  // Another environment is read.
  expect(scanTex('\\begin{align}\\label{b}\\end{align}').labels.map((m) => m.name)).toEqual(['b']);
});

test('scanTex : autonome s’il a un \\documentclass hors d’un commentaire, la règle du principal', () => {
  expect(scanTex('% \\documentclass{article}\nx').standalone).toBe(false);
  // The cases of the main process's isStandalone (latexLog.test.ts).
  const cases: [string, boolean][] = [
    ['\\documentclass{article}\n\\begin{document}x\\end{document}', true],
    ['  \\documentclass[letterpaper]{article}', true],
    ['\\\\% \\documentclass{article}', false],
    ['\\% \\documentclass{article}', true],
    ['\\documentclassx{article}', false],
    ['Bonjour.', false],
  ];
  for (const [t, standalone] of cases) expect(scanTex(t).standalone, t).toBe(standalone);
});

test('scanTex : ce qui n’est pas une marque — accolade jamais fermée, nom vide, paramètre de macro, \\nocite{*}', () => {
  expect(scanTex('\\ref{a\n\nb').refs).toEqual([]);
  expect(scanTex('\\label{}\\ref{ }\\cite{,}')).toMatchObject({ labels: [], refs: [], cites: [] });
  expect(scanTex('\\newcommand\\r[1]{\\ref{#1}}\\cite{#1,k}').refs).toEqual([]);
  expect(scanTex('\\newcommand\\r[1]{\\ref{#1}}\\cite{#1,k}').cites.map((m) => m.name)).toEqual(['k']);
  expect(scanTex('\\nocite{*}').cites).toEqual([]);
  // A comment inside the braces: not a mark, and the comment is still one.
  expect(scanTex('\\ref{a% \\label{c}\n}\\label{d}').labels.map((m) => m.name)).toEqual(['d']);
  // An escaped brace is part of the name, nested braces too.
  expect(scanTex('\\label{a\\}b}\\label{x{y}z}').labels.map((m) => m.name)).toEqual(['a\\}b', 'x{y}z']);
});

test('scanTex : complexité.tex de la base de test', () => {
  const t = readFileSync(new URL('../../fixtures/assets/complexité.tex', import.meta.url), 'utf8');
  const s = scanTex(t);
  expect(s.labels.map((m) => m.name)).toEqual(['kc:section', 'kc:def']);
  expect(s.refs.map((m) => m.name)).toEqual(['kc:def', 'mdl:enonce', 'ent:def', 'solomonoff', 'absent:label']);
  expect(s.cites.map((m) => [m.name, m.line])).toEqual([['li2008', 8]]);
});
