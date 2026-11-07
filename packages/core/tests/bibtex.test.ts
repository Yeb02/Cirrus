import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import {
  BIB_MAX_BYTES, BIB_MAX_CHARS, BIB_MAX_ENTRIES, BIB_MAX_PROBLEMS, BIB_MAX_VALUE_CHARS, BIB_NAME_CHARS, BIB_WORK_PER_CHAR, BIB_WORK_SLACK, bibAuthors, type BibEntry, bibFields,
  bibFileName, bibIdentifiers, bibNames, bibShort, bibtexEntry, CiteKeys, citeKey, cleanArxiv, cleanDoi, familyName, latexToUnicode, normalizedTitle,
  parseBibtex, repeatedKeyMessage, safeCiteKey,
} from '../src/bibtex.ts';

const REAL = readFileSync(new URL('./data/reel-50.bib', import.meta.url), 'utf8');
const byKey = (entries: BibEntry[], key: string) => {
  const e = entries.find((x) => x.key === key);
  if (!e) throw new Error(`pas d’entrée ${key}`);
  return e;
};
/** An entry of one line, for the traps. */
const one = (text: string) => parseBibtex(text);

test('parseBibtex : un .bib réel de 50 entrées, sans problème ; macros, mois, concaténations, commentaires', () => {
  const { entries, problems } = parseBibtex(REAL);
  expect(problems).toEqual([]);
  expect(entries).toHaveLength(50);
  // The entry put in a % comment, and the one inside @comment, are not entries.
  expect(entries.some((e) => e.key === 'retire2020' || e.key === 'faux')).toBe(false);
  const shannon = byKey(entries, 'shannon1948');
  expect(shannon.type).toBe('article');
  expect(shannon.line).toBe(REAL.split('\n').findIndex((l) => l.startsWith('@article{shannon1948')) + 1);
  expect(Object.fromEntries(shannon.fields)).toEqual({
    author: 'Shannon, Claude E.', title: 'A Mathematical Theory of Communication', journal: 'Bell System Technical Journal', volume: '27', number: '3',
    pages: '379--423', year: '1948', month: 'July', doi: '10.1002/j.1538-7305.1948.tb01338.x',
  });
  // As BibTeX writes it back: the number bare, the month a macro, the rest braced.
  expect(shannon.raw.get('year')).toBe('1948');
  expect(shannon.raw.get('month')).toBe('jul');
  expect(shannon.raw.get('title')).toBe('{A Mathematical Theory of Communication}');
  // @string macros (a parenthesised one, and one made of others), and « # ».
  expect(byKey(entries, 'Kolmogorov:1965').fields.get('journal')).toBe('Problems of Information Transmission');
  expect(byKey(entries, 'bengio2013representation').fields.get('journal')).toBe('IEEE Transactions on Pattern Analysis and Machine Intelligence');
  expect(byKey(entries, 'DBLP:conf/nips/VaswaniSPUJGKP17').fields.get('booktitle')).toBe('Advances in Neural Information Processing Systems 30');
  expect(byKey(entries, 'krizhevsky2012imagenet').raw.get('booktitle')).toBe('{Advances in Neural Information Processing Systems 25}');
  // Field names in lower case; quoted values; a % comment between two fields.
  expect(byKey(entries, 'DBLP:conf/nips/VaswaniSPUJGKP17').fields.get('archiveprefix')).toBe('arXiv');
  expect(byKey(entries, 'rissanen1978').fields.get('title')).toBe('Modeling by shortest data description');
  const silver = byKey(entries, 'silver2016mastering');
  expect(silver.fields.has('publisher')).toBe(false);
  expect(silver.fields.get('doi')).toBe('10.1038/nature16961');
  // DataCite's key, an address, is read as it is (citeKey sets it aside).
  expect(entries.some((e) => e.key === 'https://doi.org/10.48550/arxiv.1503.02531')).toBe(true);
});

test('parseBibtex : le .bib réel lu en champs de nœud — titres, auteurs « Prénom Nom », années', () => {
  const { entries } = parseBibtex(REAL);
  const fields = (key: string) => bibFields(byKey(entries, key));
  expect(fields('li2008introduction')).toEqual({ title: 'An Introduction to Kolmogorov Complexity and Its Applications', authors: ['Ming Li', 'Paul Vitányi'], year: '2008' });
  expect(fields('godel1931').title).toBe('Über formal unentscheidbare Sätze der Principia Mathematica und verwandter Systeme I');
  expect(fields('godel1931').authors).toEqual(['Kurt Gödel']);
  expect(fields('erdos1959').authors).toEqual(['Paul Erdős', 'Alfréd Rényi']);
  expect(fields('vonneumann1944').authors).toEqual(['John von Neumann', 'Oskar Morgenstern']);
  expect(fields('definetti1937')).toEqual({ title: 'La prévision : ses lois logiques, ses sources subjectives', authors: ['Bruno de Finetti'], year: '1937' });
  expect(fields('vandermaaten2008').authors).toEqual(['Laurens van der Maaten', 'Geoffrey Hinton']);
  expect(fields('DBLP:conf/nips/VaswaniSPUJGKP17').authors).toContain('Łukasz Kaiser');
  expect(fields('devlin2019bert')).toEqual({
    title: 'BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding', authors: ['Jacob Devlin', 'Ming-Wei Chang', 'Kenton Lee', 'Kristina Toutanova'], year: '2019',
  });
  // « and others » is not an author.
  expect(fields('brown2020language').authors).toEqual(['Tom B. Brown', 'Benjamin Mann', 'Nick Ryder', 'Melanie Subbiah', 'Jared Kaplan']);
  expect(fields('openai2023gpt4')).toEqual({ title: 'GPT-4 Technical Report', authors: ['OpenAI'], year: '2023' });
  expect(fields('Kolmogorov:1965').authors).toEqual(['A. N. Kolmogorov']);
  expect(fields('levy1937').title).toBe('Théorie de l\'addition des variables aléatoires');
  expect(fields('belkin2019reconciling').title).toBe('Reconciling modern machine-learning practice and the classical bias–variance trade-off');
  for (const e of entries) {
    const f = bibFields(e);
    expect(f.title, e.key).not.toBe('');
    expect(f.title, e.key).not.toMatch(/[\\{}]/);
    expect(f.year, e.key).toMatch(/^\d{4}$/);
    expect(f.authors.length, e.key).toBeGreaterThan(0);
  }
});

test('parseBibtex : une entrée abîmée est signalée avec sa ligne, et les suivantes sont lues', () => {
  const text = [
    '@article{a, title = {Bon}, year = 2001}', // 1
    '@article{b, title = {Accolade jamais fermée, year = 2002}', // 2: its brace closes the entry, then « @ » where « , » or « } » was due
    '@article{c, title = {Bon aussi}, year = 2003}', // 3
    '@article{d title = {Virgule manquante}}', // 4
    '@book{e, title = {Encore bon}}', // 5
    '@misc{f, title = {Pas fermée}', // 6: no closing brace before the next entry
    '', // 7
    '@misc{g, title = "Bon, entre guillemets"}', // 8
  ].join('\n');
  const { entries, problems } = parseBibtex(text);
  expect(entries.map((e) => e.key)).toEqual(['a', 'c', 'e', 'g']);
  expect(problems.map((p) => p.line)).toEqual([2, 4, 6]);
  for (const p of problems) expect(p.message).toMatch(/^Entrée « [bdf] » abîmée/);
  // A brace never closed at all: the entry is set aside, the next ones are read all the same.
  const open = parseBibtex('@article{x, title = {Ouverte {jamais}\n@article{y, title = {Lue}}\n@article{z, title = {Lue aussi}}\n');
  expect(open.entries.map((e) => e.key)).toEqual(['y', 'z']);
  expect(open.problems).toEqual([{ line: 1, message: 'Entrée « x » abîmée : l’accolade ouverte ligne 1 n’est jamais fermée.' }]);
  // A quote never closed.
  const quote = parseBibtex('@article{q, title = "Jamais fermé\n\n@article{r, title = {Lue}}\n');
  expect(quote.entries.map((e) => e.key)).toEqual(['r']);
  expect(quote.problems[0]).toEqual({ line: 1, message: 'Entrée « q » abîmée : le guillemet ouvert ligne 1 n’est jamais fermé.' });
  // A closing brace between quotes that closes no group of theirs: the value stops there (BibTeX refuses it too).
  const stray = parseBibtex('@article{s, title = "Une } de trop"}\n@article{t, title = {Lue}}\n');
  expect(stray.entries.map((e) => e.key)).toEqual(['t']);
  expect(stray.problems[0]).toEqual({ line: 1, message: 'Entrée « s » abîmée : l’accolade fermante de la ligne 1 ne ferme rien entre les guillemets.' });
  // The end of the file inside an entry.
  expect(parseBibtex('@article{fin, title = {x},').problems).toEqual([{ line: 1, message: 'Entrée « fin » abîmée : le fichier finit avant la fin de l’entrée.' }]);
  // A closing brace too many ends the entry; what follows it is a comment, as BibTeX reads it.
  expect(one('@article{t, title = {x}}, year = 2000}\n@misc{u}').entries.map((e) => [e.key, [...e.fields.keys()]])).toEqual([['t', ['title']], ['u', []]]);
});

test('parseBibtex : macros, concaténations, mois, nombres ; une macro inconnue reste vide, et le dit', () => {
  const { entries, problems } = parseBibtex([
    '@string{ a = "Al" }', '@string{b = a # "pha"}', '@STRING{c = {Bê} # "ta", d = 7}',
    '@misc{m, title = b # " et " # c, note = d # "e", month = dec, year = 2020, x = inconnue # "!"}',
  ].join('\n'));
  expect(problems).toEqual([{ line: 4, message: 'Entrée « m » : la macro « inconnue » n’est définie nulle part ; elle est laissée vide.' }]);
  const m = entries[0];
  expect(Object.fromEntries(m.fields)).toEqual({ title: 'Alpha et Bêta', note: '7e', month: 'December', year: '2020', x: '!' });
  // Written back: the file's macros resolved, a month or an unknown macro kept as a macro.
  expect(Object.fromEntries(m.raw)).toEqual({ title: '{Alpha et Bêta}', note: '{7e}', month: 'dec', year: '2020', x: 'inconnue # {!}' });
  // A macro is the one defined before its use, as BibTeX reads it; names without case.
  expect(parseBibtex('@misc{n, t = later}\n@string{later = "x"}\n@misc{o, t = LATER}').entries.map((e) => e.fields.get('t'))).toEqual(['', 'x']);
});

test('parseBibtex : un mois écrit en entier, sans casse (Crossref : month=July), est le mois ; réécrit sous sa macro de trois lettres ; un @string du fichier l’emporte', () => {
  const r = parseBibtex('@article{a, month=July}\n@article{b, month = SEPTEMBER}\n@article{c, month = may}');
  expect(r.problems).toEqual([]);
  expect(r.entries.map((e) => [e.fields.get('month'), e.raw.get('month')])).toEqual([['July', 'jul'], ['September', 'sep'], ['May', 'may']]);
  expect(bibtexEntry(r.entries[0], 'a')).toBe('@article{a,\n  month = jul\n}\n');
  const own = parseBibtex('@string{july = "juillet"}\n@article{d, month = July}');
  expect(own.problems).toEqual([]);
  expect([own.entries[0].fields.get('month'), own.entries[0].raw.get('month')]).toEqual(['juillet', '{juillet}']);
});

test('parseBibtex : accolades imbriquées, entrée entre parenthèses, sans clé, champ en double, clé en double', () => {
  const nested = one('@article(p, title = {Un {titre {très} imbriqué} ici}, author = "Nom, {Pré}nom")');
  expect(nested.problems).toEqual([]);
  expect(nested.entries[0].fields.get('title')).toBe('Un {titre {très} imbriqué} ici');
  expect(nested.entries[0].fields.get('author')).toBe('Nom, {Pré}nom');
  // No key: the first word is a field.
  expect(one('@misc{title = {Sans clé}}').entries[0]).toMatchObject({ key: '', type: 'misc' });
  expect(one('@misc{title = {Sans clé}}').entries[0].fields.get('title')).toBe('Sans clé');
  const twice = parseBibtex('@misc{k, title = {Premier}, TITLE = {Second}}\n@misc{K, title = {Autre}}');
  expect(twice.entries.map((e) => e.fields.get('title'))).toEqual(['Premier', 'Autre']);
  expect(twice.problems).toEqual([
    { line: 1, message: 'Entrée « k » : le champ « title » est en double ; le premier est gardé.' },
    { line: 2, message: 'Entrée « K » : la clé est déjà celle de l’entrée de la ligne 1.' },
  ]);
  // The entry knows it (`repeats`), and the message said of it (task 6, revue M2: the import says it once).
  expect(twice.entries.map((e) => e.repeats)).toEqual([undefined, 1]);
  expect(repeatedKeyMessage(twice.entries[1])).toBe(twice.problems[1].message);
  // Neither @comment nor @preamble are entries; an @ in a word (an address) starts none.
  expect(parseBibtex('Écrire à auteur@exemple.fr\n@comment(x {y})\n@preamble{"\\def\\x{1}"}\n@misc{v}').entries.map((e) => e.key)).toEqual(['v']);
  // Windows line ends: the lines counted the same.
  expect(parseBibtex('@misc{a}\r\n\r\n@misc{b c}\r\n').problems.map((p) => p.line)).toEqual([3]);
  expect(parseBibtex('')).toEqual({ entries: [], problems: [], omitted: 0, stopped: null });
  expect(parseBibtex('﻿@misc{bom}').entries[0].key).toBe('bom');
});

test('parseBibtex : hostile — clés et champs d’objet, imbrication profonde, binaire, macros qui doublent ; jamais au-delà des plafonds', () => {
  // Names an object would inherit or be changed by: plain fields and keys.
  const proto = one('@misc{__proto__, __proto__ = {a}, constructor = {b}, toString = {c}}');
  expect(proto.entries[0].key).toBe('__proto__');
  expect(proto.entries[0].fields.get('__proto__')).toBe('a');
  expect(({} as Record<string, unknown>).a).toBeUndefined();
  // 100 000 nested braces: no recursion, no stack overflow.
  const deep = '{'.repeat(100_000) + 'x' + '}'.repeat(100_000);
  expect(one(`@misc{deep, title = ${deep}}`).entries[0].fields.get('title')!.length).toBe(199_999);
  expect(latexToUnicode(deep)).toBe('x');
  expect(latexToUnicode(`\\'${'{'.repeat(50_000)}e${'}'.repeat(50_000)}`)).toBe('é');
  // Binary garbage: problems at most, never an exception.
  const bytes = Array.from({ length: 50_000 }, (_, i) => String.fromCharCode((i * 7919) % 256)).join('');
  expect(() => parseBibtex(`${bytes}@misc{${bytes}`)).not.toThrow();
  // Macros that double at each definition: refused past BIB_MAX_VALUE_CHARS, quickly, and said.
  const bomb = ['@string{m0 = "xxxxxxxxxxxxxxxx"}'];
  for (let i = 1; i <= 40; i++) bomb.push(`@string{m${i} = m${i - 1} # m${i - 1}}`);
  bomb.push('@misc{boum, title = m40}', '@misc{apres, title = {Lue}}');
  const t0 = performance.now();
  const r = parseBibtex(bomb.join('\n'));
  expect(performance.now() - t0).toBeLessThan(2000);
  expect(r.entries.map((e) => e.key)).toEqual(['boum', 'apres']);
  for (const e of r.entries) for (const v of e.fields.values()) expect(v.length).toBeLessThanOrEqual(BIB_MAX_VALUE_CHARS);
  expect(r.problems.some((p) => /^Macro « m\d+ » abîmée : .*plus de [\d\u00a0\u202f ]+ caractères/.test(p.message))).toBe(true);
  // A field repeating a large macro in every entry: the whole is bounded too (4 times the text, plus a value's cap).
  const big = `@string{g = "${'g'.repeat(500_000)}"}\n` + Array.from({ length: 200 }, (_, i) => `@misc{e${i}, a = g, b = g}`).join('\n');
  const many = parseBibtex(big);
  const total = many.entries.reduce((n, e) => n + [...e.fields.values()].reduce((m, v) => m + v.length, 0), 0);
  expect(total).toBeLessThanOrEqual(4 * big.length + BIB_MAX_VALUE_CHARS);
  expect(many.problems.length).toBeGreaterThan(0);
  // As many problems as broken entries, up to BIB_MAX_PROBLEMS, then one that counts the others.
  const broken = parseBibtex(Array.from({ length: 1000 }, (_, i) => `@misc{b${i} title}`).join('\n'));
  expect(broken.problems).toHaveLength(BIB_MAX_PROBLEMS + 1);
  expect(broken.problems.at(-1)).toEqual({ line: BIB_MAX_PROBLEMS + 1, message: `Et ${1000 - BIB_MAX_PROBLEMS} autres problèmes.` });
});

test('parseBibtex : hostile — des @comment( jamais fermés, des accents qui s’empilent, trop d’entrées ; linéaire et borné', () => {
  // Each unclosed @comment( looked for its end once, not to the end of the file at each one.
  const comments = Array.from({ length: 20_000 }, () => '@comment( ( ouvert').join('\n') + '\n@misc{fin}';
  let t0 = performance.now();
  const c = parseBibtex(comments);
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(c.entries.map((e) => e.key)).toEqual(['fin']);
  expect(c.problems[0]).toEqual({ line: 1, message: 'Commentaire abîmé : la parenthèse ouverte n’est jamais fermée.' });
  // Accents of two classes, alternated by the hundred thousand (NFC would reorder them for ever): 8 at most on a letter.
  const stacked = 'a' + String.raw`\'\c `.repeat(100_000) + 'b', raw = 'a' + '\u0301\u0327'.repeat(200_000);
  t0 = performance.now();
  const out = latexToUnicode(stacked);
  expect([...out.normalize('NFD')].filter((ch) => /\p{M}/u.test(ch)).length).toBeLessThanOrEqual(8);
  expect(out.startsWith('ab')).toBe(true);
  expect(latexToUnicode(raw).length).toBeLessThanOrEqual(9);
  expect(normalizedTitle(raw + ' Titre')).toBe('a titre');
  expect(performance.now() - t0).toBeLessThan(1000);
  // BIB_MAX_ENTRIES entries at most, the others said.
  const many = parseBibtex(Array.from({ length: BIB_MAX_ENTRIES + 3 }, (_, i) => `@misc{e${i}}`).join('\n'));
  expect(many.entries).toHaveLength(BIB_MAX_ENTRIES);
  expect(many.problems).toEqual([{ line: BIB_MAX_ENTRIES + 1, message: `Le fichier compte plus de ${(BIB_MAX_ENTRIES).toLocaleString('fr-FR')} entrées : les suivantes ne sont pas lues.` }]);
});

test('parseBibtex : des guillemets jamais fermés qui sautent des groupes d’accolades (revue I1) ; linéaire, une valeur ou un @preamble', () => {
  for (const head of ['@a{k,t="{\n', '@preamble{"{\n']) {
    const text = head.repeat(10_000) + '}'.repeat(20_000) + 'x'.repeat(1_000_000);
    const t0 = performance.now();
    const r = parseBibtex(text);
    expect(performance.now() - t0, head).toBeLessThan(1000);
    expect(r.entries, head).toEqual([]);
    expect(r.problems.length, head).toBe(BIB_MAX_PROBLEMS + 1);
  }
});

test('parseBibtex : une longue queue que chaque entrée abîmée relit (re-revue N1) ; la lecture s’arrête au plafond de travail, ce qui est lu est gardé', () => {
  const head = '@a(k,t={\n'.repeat(1230) + '%}\n'.repeat(1230) + '#';
  for (const tail of ['x'.repeat(2_000_000), '"' + 'x'.repeat(2_000_000)]) {
    const t0 = performance.now();
    const r = parseBibtex(head + tail);
    expect(performance.now() - t0, tail.slice(0, 2)).toBeLessThan(1000);
    expect(r.problems.at(-1)!.message, tail.slice(0, 2)).toMatch(/^Le fichier est trop abîmé pour être lu en entier : la lecture s’arrête ligne \d+\.$/);
  }
  // Entries read before the cap are kept; a real file never comes near it (the real one, 40 times over).
  const kept = parseBibtex('@misc{avant, title = {Lue}}\n' + head + 'x'.repeat(2_000_000));
  expect(kept.entries.map((e) => e.key)).toEqual(['avant']);
  const real = parseBibtex(Array.from({ length: 40 }, () => REAL).join('\n'));
  expect(real.entries).toHaveLength(2000);
  expect(real.problems.some((p) => p.message.startsWith('Le fichier est trop abîmé'))).toBe(false);
  expect(BIB_WORK_PER_CHAR).toBe(8);
  expect(BIB_WORK_SLACK).toBe(1 << 20);
});

test('parseBibtex : 2 000 entrées, dont des accolades jamais fermées, en moins d’une seconde', () => {
  const text = Array.from({ length: 2000 }, (_, i) => (i % 100 === 7
    ? `@article{casse${i},\n  title = {Jamais fermée,\n  year = {2000}\n`
    : `@article{auteur${i},\n  author = {Nom${i}, Pr{\\'e}nom and von Autre, Jean},\n  title = {Un {titre} n°${i} -- avec des {\\"u}mlauts},\n  journal = {Revue},\n  year = ${1900 + (i % 120)},\n  month = mar\n}\n`)).join('\n');
  const t0 = performance.now();
  const { entries, problems } = parseBibtex(text);
  const ms = performance.now() - t0;
  expect(entries).toHaveLength(1980);
  expect(problems).toHaveLength(20);
  expect(ms).toBeLessThan(1000);
});

test('parseBibtex : un texte de plus de BIB_MAX_CHARS caractères n’est pas lu, le problème dit sa taille et la borne ; à la borne, il est lu (tâche 6, M8)', () => {
  expect(BIB_MAX_CHARS).toBe(16 * 2 ** 20);
  // A file larger than this cannot be such a text, whatever its encoding: UTF-16 with its BOM, two bytes a character.
  expect(BIB_MAX_BYTES).toBe(2 * BIB_MAX_CHARS + 2);
  const head = '@misc{a, title = {Lue}}\n';
  const over = head + ' '.repeat(BIB_MAX_CHARS + 1 - head.length);
  expect(over.length).toBe(BIB_MAX_CHARS + 1);
  const r = parseBibtex(over);
  expect(r.entries).toEqual([]);
  const message = `Le fichier fait ${(BIB_MAX_CHARS + 1).toLocaleString('fr-FR')} caractères, plus que les ${BIB_MAX_CHARS.toLocaleString('fr-FR')} qu’un .bib peut compter : il n’est pas lu.`;
  expect(r.problems).toEqual([{ line: 1, message }]);
  expect(r.stopped).toEqual({ line: 1, message });
  expect(r.omitted).toBe(0);
  const at = parseBibtex(over.slice(0, BIB_MAX_CHARS));
  expect(at.entries.map((e) => e.key)).toEqual(['a']);
  expect(at.problems).toEqual([]);
  expect(at.stopped).toBeNull();
});

test('parseBibtex : `omitted` compte les problèmes non listés, `stopped` dit pourquoi la lecture s’est arrêtée avant la fin (tâche 6)', () => {
  const real = parseBibtex(REAL);
  expect([real.omitted, real.stopped]).toEqual([0, null]);
  const broken = parseBibtex(Array.from({ length: 1000 }, (_, i) => `@misc{b${i} title}`).join('\n'));
  expect([broken.omitted, broken.stopped]).toEqual([1000 - BIB_MAX_PROBLEMS, null]);
  const many = parseBibtex(Array.from({ length: BIB_MAX_ENTRIES + 3 }, (_, i) => `@misc{e${i}}`).join('\n'));
  expect(many.stopped).toEqual(many.problems.at(-1));
  expect(many.omitted).toBe(0);
  const head = '@a(k,t={\n'.repeat(1230) + '%}\n'.repeat(1230) + '#';
  const tired = parseBibtex(Array.from({ length: 300 }, (_, i) => `@misc{b${i} title}`).join('\n') + '\n' + head + 'x'.repeat(2_000_000));
  expect(tired.stopped).toEqual(tired.problems.at(-1));
  expect(tired.stopped!.message).toMatch(/^Le fichier est trop abîmé/);
  // The listed problems, then the one that counts the others, then the stop.
  expect(tired.omitted).toBeGreaterThan(0);
  expect(tired.problems).toHaveLength(BIB_MAX_PROBLEMS + 2);
  expect(tired.problems.at(-2)!.message).toBe(`Et ${tired.omitted.toLocaleString('fr-FR')} autres problèmes.`);
});

test('parseBibtex : un nom tiré du fichier est coupé dans les messages — macro, clé, type, champ de 200 000 caractères (re-revue, sonde pct-string)', () => {
  expect(BIB_NAME_CHARS).toBe(80);
  expect(bibShort('Vitányi')).toBe('Vitányi');
  expect(bibShort('x'.repeat(BIB_NAME_CHARS))).toBe('x'.repeat(BIB_NAME_CHARS));
  expect(bibShort('x'.repeat(BIB_NAME_CHARS + 1))).toBe(`${'x'.repeat(BIB_NAME_CHARS)}…`);
  // Not inside a pair of UTF-16 units: an accent of the astral planes is kept whole or left out.
  expect(bibShort(`${'x'.repeat(BIB_NAME_CHARS - 1)}𝔄b`)).toBe(`${'x'.repeat(BIB_NAME_CHARS - 1)}…`);
  const long = (c: string) => c.repeat(200_000);
  const cases = [
    `@string{a = ${long('m')}}`, // a macro defined nowhere, cited by a macro
    `@misc{k, title = ${long('m')}}`, // and by a field
    `@string{${long('m')} x}`, // a macro's name, then no « = »
    `@misc{${long('k')} title = {x}}`, // a key, then no « , »
    `@misc{${long('k')}, title = {x}}\n@misc{${long('k')}, title = {y}}`, // a key twice
    `@${long('t')} x`, // a type without « { »
    `@misc{k, ${long('f')} {x}}`, // a field's name without « = »
    `@misc{k, ${long('f')} = {x}, ${long('f')} = {y}}`, // a field twice
    `@misc{k, ${long('f')} = {x} y = {z}}`, // no « , » after it
  ];
  for (const text of cases) {
    const { problems } = parseBibtex(text);
    expect(problems.length, text.slice(0, 12)).toBeGreaterThan(0);
    for (const p of problems) {
      expect(p.message.length, text.slice(0, 12)).toBeLessThan(4 * BIB_NAME_CHARS + 200);
      expect(p.message, text.slice(0, 12)).toContain('…');
    }
  }
});

test('latexToUnicode : accents, lettres, tirets, espaces insécables, accolades de protection, mode mathématique', () => {
  const cases: [string, string][] = [
    ['Vit{\\\'a}nyi', 'Vitányi'], ['\\\'e', 'é'], ['\\\'{e}', 'é'], ['{\\\'e}', 'é'], ['\\\' e', 'é'], ['\\"o', 'ö'], ['\\"{O}', 'Ö'], ['\\`a', 'à'], ['\\^o', 'ô'],
    ['\\~n', 'ñ'], ['\\=a', 'ā'], ['\\.z', 'ż'], ['\\c{c}', 'ç'], ['\\c c', 'ç'], ['\\v{s}', 'š'], ['\\H{o}', 'ő'], ['Erd{\\H{o}}s', 'Erdős'], ['\\u{g}', 'ğ'],
    ['\\k{a}', 'ą'], ['\\r{a}', 'å'], ['\\d{s}', 'ṣ'], ['\\\'\\i', 'í'], ['\\"{\\i}', 'ï'], ['{\\o}', 'ø'], ['\\O', 'Ø'], ['{\\ae}', 'æ'], ['\\AE', 'Æ'], ['\\oe', 'œ'],
    ['\\aa', 'å'], ['{\\ss}', 'ß'], ['{\\l}', 'ł'], ['\\L{}ukasz', 'Łukasz'], ['\\o rsted', 'ørsted'], ['1--2', '1–2'], ['a---b', 'a—b'], ['A.~N. Kolmogorov', 'A. N. Kolmogorov'],
    ['{BERT}: {P}re-training', 'BERT: Pre-training'], ['\\emph{très} \\textbf{gras}', 'très gras'], ['50\\% \\& \\$5 \\#1 a\\_b \\{x\\}', '50% & $5 #1 a_b {x}'],
    ['$\\alpha$-divergence', 'α-divergence'], ['$O(n^2)$', 'O(n^2)'], ['``guillemets\'\'', '“guillemets”'], ["Occam's", "Occam's"], ['  plusieurs\n  lignes\t ici ', 'plusieurs lignes ici'],
    ['\\inconnue{texte}', 'texte'], ['\\constructor \\toString \\valueOf', ''], ['fin\\', 'fin'], ['accent seul \\\'', 'accent seul'], ['contrôle\u0000\u0007ici', 'contrôle ici'],
    ['de\u0301ja\u0300', 'd\u00e9j\u00e0'], ['\\\\ ligne', 'ligne'], ['\\textendash{} \\ldots', '– …'],
  ];
  for (const [tex, text] of cases) expect(latexToUnicode(tex), tex).toBe(text);
});

test('bibAuthors : « Prénom Nom », « Nom, Prénom », particules, suffixe, {Groupe de travail}, « and others »', () => {
  expect(bibAuthors('Li, Ming and Vit{\\\'a}nyi, Paul')).toEqual(['Ming Li', 'Paul Vitányi']);
  expect(bibAuthors('Ming Li and Paul Vit{\\\'a}nyi')).toEqual(['Ming Li', 'Paul Vitányi']);
  expect(bibAuthors('von Neumann, John')).toEqual(['John von Neumann']);
  expect(bibAuthors('John von Neumann')).toEqual(['John von Neumann']);
  expect(bibAuthors('Ludwig van Beethoven AND Jean de La Fontaine')).toEqual(['Ludwig van Beethoven', 'Jean de La Fontaine']);
  expect(bibAuthors('King, Jr., Martin Luther')).toEqual(['Martin Luther King Jr.']);
  expect(bibAuthors('{Groupe de travail}')).toEqual(['Groupe de travail']);
  expect(bibAuthors('{Groupe de travail} and Durand, Marie')).toEqual(['Groupe de travail', 'Marie Durand']);
  expect(bibAuthors('{Barnes and Noble} and Smith, J.')).toEqual(['Barnes and Noble', 'J. Smith']);
  expect(bibAuthors('Brown, Tom and others')).toEqual(['Tom Brown']);
  expect(bibAuthors('Durand,  Marie   and\n  Martin,Pierre')).toEqual(['Marie Durand', 'Pierre Martin']);
  expect(bibAuthors('{\\\'E}mile Zola')).toEqual(['Émile Zola']);
  expect(bibAuthors('')).toEqual([]);
  expect(bibAuthors(' and  and ')).toEqual([]);
  expect(bibNames('Jean de La Fontaine')[0]).toEqual({ first: 'Jean', von: 'de', last: 'La Fontaine', jr: '' });
  expect(bibNames('de la Vallée Poussin, Charles')[0]).toEqual({ first: 'Charles', von: 'de la', last: 'Vallée Poussin', jr: '' });
  expect(bibNames('von Neumann, John')[0]).toEqual({ first: 'John', von: 'von', last: 'Neumann', jr: '' });
  // A thousand authors, read in one pass.
  expect(bibAuthors(Array.from({ length: 1000 }, (_, i) => `Nom${i}, P.`).join(' and '))).toHaveLength(1000);
});

const entry = (text: string) => parseBibtex(text).entries[0];

test('citeKey : la clé de l’entrée si elle est sûre, sinon nom du premier auteur et année, puis b, c… aux collisions', () => {
  const taken = new Set(['li2008', 'Vaswani2017']);
  expect(citeKey(entry('@book{Li_2008, author = {Li, Ming}, year = 2008}'), taken)).toBe('Li_2008');
  // DataCite's key is an address: neither a file name nor a \cite key.
  const datacite = entry('@misc{https://doi.org/10.48550/arxiv.1706.03762, author = {Vaswani, Ashish and Shazeer, Noam}, title = {Attention Is All You Need}, year = {2017}}');
  expect(citeKey(datacite, new Set())).toBe('vaswani2017');
  // A generated key avoids the taken ones whatever their case: b, c… then aa.
  expect(citeKey(datacite, taken)).toBe('vaswani2017b');
  expect(citeKey(datacite, new Set(['vaswani2017', 'vaswani2017b']))).toBe('vaswani2017c');
  const all = new Set(['vaswani2017', ...'bcdefghijklmnopqrstuvwxyz'.split('').map((c) => `vaswani2017${c}`)]);
  expect(citeKey(datacite, all)).toBe('vaswani2017aa');
  // The entry's own key, taken: a generated one; taken whatever its case, as BibTeX compares keys (revue M1).
  expect(citeKey(entry('@book{li2008, author = {Li, Ming}, year = 2008}'), taken)).toBe('li2008b');
  expect(citeKey(entry('@misc{LI2008, author = {Li, M.}, year = 2008}'), new Set(['li2008']))).toBe('li2008b');
  expect(citeKey(entry('@book{DBLP:books/li2008, author = {Vit{\\\'a}nyi, Paul}, year = 2008}'), new Set(['dblp:books/LI2008']))).toBe('vitanyi2008');
  expect(citeKey(entry('@book{x, author = {von Neumann, John and Morgenstern, Oskar}, year = 1944}'), new Set(['x']))).toBe('neumann1944');
  expect(citeKey(entry('@misc{, author = {{OpenAI}}, date = {2023-03-15}}'), new Set())).toBe('openai2023');
  // Without an author, the title's first word; without either, « publication »; without a year, nothing after.
  expect(citeKey(entry('@misc{, title = {{\\"U}ber formal unentscheidbare S{\\"a}tze}}'), new Set())).toBe('uber');
  expect(citeKey(entry('@misc{}'), new Set())).toBe('publication');
  // A name Windows reserves is the file's affair only (bibFileName, final review R1): the key keeps it, made or own.
  expect(citeKey(entry('@misc{, author = {Con, A.}}'), new Set())).toBe('con');
  expect(citeKey(entry('@misc{aux, author = {Aux, A.}}'), new Set())).toBe('aux');
});

test('citeKey (revue finale, R1 révisé) : la clé propre que BibTeX et LaTeX lisent est gardée — DBLP, « Auteur:Année » — ; une adresse est remplacée ; l’entrée réécrite sous elle se relit telle quelle', () => {
  const { entries } = parseBibtex(REAL);
  const dblp = byKey(entries, 'DBLP:conf/nips/VaswaniSPUJGKP17'), kolmogorov = byKey(entries, 'Kolmogorov:1965');
  expect(citeKey(dblp, new Set())).toBe('DBLP:conf/nips/VaswaniSPUJGKP17');
  expect(citeKey(kolmogorov, new Set())).toBe('Kolmogorov:1965');
  expect(citeKey(entry('@article{Hinton:2006, author = {Hinton, Geoffrey E.}, year = 2006}'), new Set())).toBe('Hinton:2006');
  // DataCite's key, an address: refused, its first author and year instead.
  expect(citeKey(byKey(entries, 'https://doi.org/10.48550/arxiv.1503.02531'), new Set())).toBe('hinton2015');
  // Taken (without case): made, as any own key.
  expect(citeKey(dblp, new Set(['dblp:conf/nips/vaswanispujgkp17']))).toBe('vaswani2017');
  // Written under its key and read again: the same key, the same fields.
  for (const e of [dblp, kolmogorov]) {
    const back = parseBibtex(bibtexEntry(e, citeKey(e, new Set())));
    expect(back.problems).toEqual([]);
    expect(back.entries[0].key).toBe(e.key);
    expect(back.entries[0].fields).toEqual(e.fields);
  }
});

test('citeKey et CiteKeys (tâche 6) : les mêmes clés qu’avec un Set ; pour des milliers d’entrées, une clé coûte une recherche, même quand toutes ont la même base', () => {
  const keys = new CiteKeys(['li2008', 'Vaswani2017']);
  expect(keys.has('LI2008')).toBe(true);
  const datacite = entry('@misc{https://doi.org/10.48550/arxiv.1706.03762, author = {Vaswani, Ashish}, year = {2017}}');
  expect(citeKey(datacite, keys)).toBe('vaswani2017b');
  keys.add('vaswani2017b');
  expect(citeKey(datacite, keys)).toBe('vaswani2017c');
  // A key returned but not taken is returned again; one taken meanwhile by other means is skipped.
  expect(citeKey(datacite, keys)).toBe('vaswani2017c');
  keys.add('VASWANI2017C');
  keys.add('vaswani2017d');
  expect(citeKey(datacite, keys)).toBe('vaswani2017e');
  expect(citeKey(entry('@book{li2008, author = {Li, Ming}, year = 2008}'), keys)).toBe('li2008b');
  // A reserved key (a .bib's own keys, revue M3) is avoided by the keys made, never by the entry whose own key it is.
  const reserved = new CiteKeys();
  reserved.reserve('LI2008');
  expect(reserved.has('li2008')).toBe(false);
  expect(citeKey(entry('@misc{https://example.org/x1, author = {Li, M.}, year = 2008}'), reserved)).toBe('li2008b');
  expect(citeKey(entry('@misc{li2008, author = {Li, M.}, year = 2008}'), reserved)).toBe('li2008');
  // 50 000 entries, all of the same base (no author, no year, the same first word), or each of its own: linear.
  for (const make of [(i: number) => `@misc{, title = {The ${i}}}`, (i: number) => `@misc{k${i}, author = {Nom${i}, A.}, year = 2000}`]) {
    const read = parseBibtex(Array.from({ length: BIB_MAX_ENTRIES }, (_, i) => make(i)).join('\n'));
    const taken = new CiteKeys(), seen = new Set<string>();
    const t0 = performance.now();
    for (const e of read.entries) {
      const k = citeKey(e, taken);
      taken.add(k);
      seen.add(k.toLowerCase());
    }
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(seen.size).toBe(BIB_MAX_ENTRIES);
  }
});

test('safeCiteKey (revue finale, R1 révisé) : une clé que BibTeX et LaTeX lisent — ASCII imprimable, sans blanc ni \\ { } % # , ~ " \' ( ) =, sans « :// » ni « ^^ », 200 au plus', () => {
  const kept = [
    'li2008', 'Li_2008', 'smith-2020', 'smith.2020', 'a+b', 'x1', 'DBLP:conf/nips/VaswaniSPUJGKP17', 'Hinton:2006', 'DBLP:journals/ppi/Kolmogorov65',
    'con', 'AUX', 'nul.x', 'com1', '-a', '.a', 'a@b', 'a;b', 'a!b?', 'a<b>|c*', 'x'.repeat(200),
  ];
  for (const k of kept) expect(safeCiteKey(k), k).toBe(true);
  const refused = [
    '', 'https://doi.org/10.1/x', 'http://x', 'doi://y', 'a b', 'a\tb', 'a\nb', 'a,b', 'a{b', 'a}b', 'a%b', 'a#b', 'a\\b', 'a~b', 'a"b', 'a\'b', 'a(b', 'a)b',
    'a=b', 'é2008', 'Gödel1931', 'a\u007fb', 'a b', 'a^^7bb', 'x'.repeat(201),
  ];
  for (const k of refused) expect(safeCiteKey(k), k).toBe(false);
});

test('familyName (revue finale, R2 révisé) : le nom de famille d’un auteur « Prénom Nom » (ou « Nom, Prénom »), sans casse, accents ni ponctuation, comme bibNames le lit', () => {
  const cases: [string, string | null][] = [
    ['Ming Li', 'li'], ['Li, Ming', 'li'], ['M. Li', 'li'], ['LI, M.', 'li'], ['Paul Vitányi', 'vitanyi'], ['Paul Vitanyi', 'vitanyi'],
    ['Laurens van der Maaten', 'maaten'], ['van der Maaten, Laurens', 'maaten'], ['John von Neumann', 'neumann'],
    ['Martin Luther King Jr.', 'king'], ['King, Jr., Martin Luther', 'king'], ['Cathy O’Neil', 'oneil'], ['Cathy O\'Neil', 'oneil'],
    ['Jean-Pierre Dupont', 'dupont'], ['A. Smith-Jones', 'smithjones'], ['OpenAI', 'openai'], ['Łukasz Kaiser', 'kaiser'], ['Kurt Gödel', 'godel'],
    ['', null], ['  ', null], ['---', null],
  ];
  for (const [name, family] of cases) expect(familyName(name), name).toBe(family);
});

test('bibFileName (revue finale, R1 révisé) : le nom de « <clé>.bib », seul nettoyé — < > : " / \\ | ? * deviennent _, un nom réservé de Windows évité', () => {
  expect(bibFileName('DBLP:conf/nips/VaswaniSPUJGKP17')).toBe('DBLP_conf_nips_VaswaniSPUJGKP17.bib');
  expect(bibFileName('Hinton:2006')).toBe('Hinton_2006.bib');
  expect(bibFileName('li2008')).toBe('li2008.bib');
  expect(bibFileName('a<b>c|d?e*f')).toBe('a_b_c_d_e_f.bib');
  // A name Windows reserves before its first dot: « _ » after it, whatever its case.
  expect(['con', 'AUX', 'nul.x', 'com1', 'LPT9', 'prn'].map(bibFileName)).toEqual(['con_.bib', 'AUX_.bib', 'nul_.x.bib', 'com1_.bib', 'LPT9_.bib', 'prn_.bib']);
  // Not reserved: kept.
  expect(['console', 'com0', 'auxiliaire.x', 'nul_'].map(bibFileName)).toEqual(['console.bib', 'com0.bib', 'auxiliaire.x.bib', 'nul_.bib']);
});

test('bibIdentifiers : le DOI et l’identifiant arXiv d’une entrée, sous toutes leurs formes', () => {
  const { entries } = parseBibtex(REAL);
  expect(bibIdentifiers(byKey(entries, 'shannon1948'))).toEqual({ doi: '10.1002/j.1538-7305.1948.tb01338.x' });
  expect(bibIdentifiers(byKey(entries, 'DBLP:conf/nips/VaswaniSPUJGKP17'))).toEqual({ arxiv: '1706.03762' });
  expect(bibIdentifiers(byKey(entries, 'kingma2014auto'))).toEqual({ arxiv: '1312.6114' });
  expect(bibIdentifiers(byKey(entries, 'kingma2015adam'))).toEqual({ arxiv: '1412.6980' });
  expect(bibIdentifiers(byKey(entries, 'hoffmann2022training'))).toEqual({ arxiv: '2203.15556' });
  expect(bibIdentifiers(byKey(entries, 'nakkiran2020deep'))).toEqual({ arxiv: '1912.02292' });
  expect(bibIdentifiers(byKey(entries, 'tishby2000information'))).toEqual({ arxiv: 'physics/0004057' });
  // arXiv's own DOI (DataCite, in upper case) is its arXiv identifier.
  expect(bibIdentifiers(byKey(entries, 'https://doi.org/10.48550/arxiv.1503.02531'))).toEqual({ arxiv: '1503.02531' });
  expect(bibIdentifiers(byKey(entries, 'vapnik1998'))).toEqual({});
  expect(bibIdentifiers(entry('@misc{x, doi = {https://doi.org/10.1000/ABC}, eprint = {2401.01234v3}, archiveprefix = {arXiv}}'))).toEqual({ doi: '10.1000/ABC', arxiv: '2401.01234' });
  expect(bibIdentifiers(entry('@misc{x, doi = {pas un doi}, eprint = {2401.01234}}'))).toEqual({});
  expect(cleanDoi(' doi:10.1007/978-0-387-49820-1 ')).toBe('10.1007/978-0-387-49820-1');
  expect(cleanDoi('10.1234')).toBeNull();
  // The punctuation that ends a sentence is no part of a DOI (re-revue N2): a DOI that differs is now a veto.
  for (const s of ['10.1109/CVPR.2016.90.', '10.1109/CVPR.2016.90,', '10.1109/CVPR.2016.90;', 'https://doi.org/10.1109/CVPR.2016.90.', '10.1109/CVPR.2016.90.;,']) {
    expect(cleanDoi(s), s).toBe('10.1109/CVPR.2016.90');
  }
  expect(cleanDoi('10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C')).toBe('10.1002/(SICI)1097-4636(199706)35:4<477::AID-JBM8>3.0.CO;2-C');
  expect(cleanDoi('10.1234/.')).toBeNull();
  expect(bibIdentifiers(entry('@misc{x, doi = {10.1109/CVPR.2016.90.}}'))).toEqual({ doi: '10.1109/CVPR.2016.90' });
  expect(cleanArxiv('arXiv:1706.03762v7')).toBe('1706.03762');
  expect(cleanArxiv('hep-th/9901001v2')).toBe('hep-th/9901001');
  expect(cleanArxiv('1706.037')).toBeNull();
  // Hostile: a control character, too long a text; fields of a million characters read in linear time.
  expect(cleanDoi('10.1000/a\u0001b')).toBeNull();
  expect(cleanDoi(`10.1000/${'x'.repeat(1000)}`)).toBeNull();
  const t0 = performance.now();
  const huge = entry(`@misc{h, note = {arXiv:${'.'.repeat(400_000)}x}, url = {arxiv${'/abs/x'.repeat(150_000)}}, journal = {${'arXiv:'.repeat(150_000)}}}`);
  expect(bibIdentifiers(huge)).toEqual({});
  expect(performance.now() - t0).toBeLessThan(1000);
  expect(cleanArxiv('pas/arxiv')).toBeNull();
});

test('normalizedTitle : sans casse, accents, ponctuation ni espaces de trop', () => {
  expect(normalizedTitle('An Introduction to Kolmogorov Complexity and Its Applications')).toBe(normalizedTitle('an introduction to KOLMOGOROV complexity, and its applications.'));
  expect(normalizedTitle('  Théorie   de l’addition ')).toBe('theorie de l addition');
  expect(normalizedTitle('Über — Sätze')).toBe('uber satze');
});

test('bibtexEntry : l’entrée réécrite avec sa clé, ses champs comme BibTeX les écrit ; relue, la même', () => {
  const datacite = entry('@misc{https://doi.org/10.48550/arxiv.1706.03762,\n  doi = {10.48550/ARXIV.1706.03762},\n  title = {Attention Is All You Need},\n  year = {2017}\n}');
  expect(bibtexEntry(datacite, 'vaswani2017')).toBe('@misc{vaswani2017,\n  doi = {10.48550/ARXIV.1706.03762},\n  title = {Attention Is All You Need},\n  year = {2017}\n}\n');
  const { entries } = parseBibtex(REAL);
  for (const e of entries) {
    const again = parseBibtex(bibtexEntry(e, 'k'));
    expect(again.problems, e.key).toEqual([]);
    expect(again.entries[0].fields, e.key).toEqual(e.fields);
    expect(again.entries[0].type).toBe(e.type);
  }
  // The month stays a macro: the file read alone still gives its name.
  expect(bibtexEntry(byKey(entries, 'shannon1948'), 'shannon1948')).toContain('  month = jul,\n');
});
