import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyOps, CommandError, createNode, createPlan, editNode, emptyState, type FileRef, invertAction, MAX_LABEL_CHARS, type State } from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { filePath, LocalStore } from '@cirrus/store';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { blobRequest, latexRequest } from '../src/main/files.ts';
import { filesBuild, removeFileBuild, renameFileBuild, texSaveBuild } from '../src/renderer/actions.ts';
import { decodeText, delimiterFor, parseDelimited } from '../src/renderer/files/decode.ts';
import { type FileKind, fileKind, fileUrl, formatSize, type ViewRef, viewKey } from '../src/renderer/files/kind.ts';
import { checkFileName, mergeFiles, sameName } from '../src/renderer/files/merge.ts';
import { ViewStates } from '../src/renderer/files/viewState.ts';

// One test base for the whole file, never the user's: each test reloads its state from the store.
let dir: string, store: LocalStore, ids: FixtureIds;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-filelogic-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
});
afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const MDL = 'Minimum Description Length Principle (MDL)';
const filesOf = (s: State, node = ids.nodes.mdl) => s.nodes.get(node)!.files;
const refOf = (name: string, node = ids.nodes.mdl) => filesOf(store.loadState(), node).find((f) => f.name === name)!;
const ref = (name: string, hash = `h-${name}`, size = 1): FileRef => ({ name, hash, size });
const sha = (c: string) => c.repeat(64);
/** Bytes written as escapes, one per character (\xC9 is the byte 0xC9): no editor re-encodes them. */
const bytes = (s: string) => new Uint8Array(Buffer.from(s, 'latin1'));

test('genre d’un fichier : chaque extension des listes, en majuscules aussi, et les noms sans extension', () => {
  const lists: [FileKind, string][] = [
    ['image', 'png jpg jpeg gif webp bmp svg avif ico'],
    ['pdf', 'pdf'],
    ['tex', 'tex'],
    ['table', 'csv tsv'],
    // Perl, Ruby and PHP too (final review): a script is shown in Cirrus, never handed to Windows, which may run it.
    ['text', 'txt md bib py ipynb js mjs ts tsx jsx json yaml yml toml ini cfg c h cpp hpp cc rs go java kt jl r m sh ps1 bat lua sql html css xml log rst pl pm rb php'],
  ];
  for (const [kind, exts] of lists) {
    for (const ext of exts.split(' ')) {
      expect(fileKind(`fichier_é.${ext}`), ext).toBe(kind);
      expect(fileKind(`FICHIER.${ext.toUpperCase()}`), ext).toBe(kind);
    }
  }
  for (const bare of ['Makefile', 'Dockerfile', 'LICENSE', 'README', 'makefile']) expect(fileKind(bare), bare).toBe('text');
  for (const other of ['présentation.pptx', 'données.xlsx', 'archive.tar.gz', 'sans_extension', '.bashrc', 'Makefile.bak']) {
    expect(fileKind(other), other).toBe('other');
  }
});

test('fileUrl : le format du protocole, que le principal relit jusqu’au fichier du magasin', () => {
  expect(fileUrl({ name: 'a b#?%é.txt', hash: sha('0'), size: 3 })).toBe(`cirrus-file://blob/${sha('0')}/a%20b%23%3F%25%C3%A9.txt`);
  const csv = refOf('mesures_compression.csv');
  const answer = blobRequest(dir, fileUrl(csv), null);
  expect(answer).toMatchObject({ status: 200, path: filePath(dir, csv), start: 0, end: csv.size - 1 });
  // A compiled PDF (plan 4b, task 5): the host `latex`, which the main process serves from its cache; its views keep
  // it apart from a blob of the same hash.
  const pdf: ViewRef = { name: 'complexité.pdf', hash: sha('a'), size: 10, store: 'latex' };
  expect(fileUrl(pdf)).toBe(`cirrus-file://latex/${sha('a')}/complexit%C3%A9.pdf`);
  expect(latexRequest(join(dir, 'cache'), fileUrl(pdf), null)).toMatchObject({ status: 404 });
  expect(viewKey(pdf)).not.toBe(viewKey({ ...pdf, store: undefined }));
});

test('formatSize : base 1024, une décimale sous 100, à la française', () => {
  expect([0, 812, 12_595, 4.5 * 2 ** 20, Math.round(1.2 * 2 ** 30)].map(formatSize)).toEqual(['0 o', '812 o', '12,3 Ko', '4,5 Mo', '1,2 Go']);
  // At the edges: the unit changes at 1024, the decimal goes at 100, and a rounding up to 1024 takes the next unit.
  expect([1023, 1024, 99.96 * 1024, 150 * 1024, 2 ** 20 - 1, 3 * 2 ** 40].map(formatSize)).toEqual(['1023 o', '1,0 Ko', '100 Ko', '150 Ko', '1,0 Mo', '3,0 To']);
});

test('mergeFiles : « rapport.pdf » remplace « Rapport.pdf » à sa place, sous son orthographe ; un nom nouveau va à la fin (Review Focus 1)', () => {
  const m = mergeFiles([ref('a.txt'), ref('Rapport.pdf', sha('1'), 10), ref('z.txt')], [ref('rapport.pdf', sha('2'), 20), ref('b.txt')]);
  expect(m.files).toEqual([ref('a.txt'), ref('rapport.pdf', sha('2'), 20), ref('z.txt'), ref('b.txt')]);
  expect(m).toMatchObject({ added: ['b.txt'], replaced: ['rapport.pdf'], unchanged: [] });
});

test('mergeFiles : un « é » décomposé, venu d’une archive, remplace le composé (Review Focus 1)', () => {
  const composed = 'résumé.pdf', decomposed = 'résumé.pdf';
  expect(composed).not.toBe(decomposed);
  expect(sameName(composed, decomposed)).toBe(true);
  expect(sameName('Énoncé.tex', 'énoncé.TEX')).toBe(true);
  expect(sameName('a.txt', 'b.txt')).toBe(false);
  const m = mergeFiles([ref(composed, sha('1'))], [ref(decomposed, sha('2'))]);
  expect(m.files).toEqual([ref(decomposed, sha('2'))]);
  expect(m.replaced).toEqual([decomposed]);
});

test('mergeFiles : la même empreinte sous le même nom, à la casse près, ne change rien et garde l’orthographe d’avant', () => {
  const existing = [ref('Rapport.pdf', sha('1'), 10), ref('notes.md', sha('3'))];
  const m = mergeFiles(existing, [ref('rapport.pdf', sha('1'), 10), ref('notes.md', sha('3'))]);
  expect(m.files).toEqual(existing);
  expect(m).toMatchObject({ added: [], replaced: [], unchanged: ['Rapport.pdf', 'notes.md'] });
});

test('mergeFiles : deux « a.txt » dans un même dépôt donnent « a.txt » et « a (2).txt » ; un nom déjà pris par le dépôt est sauté', () => {
  const m = mergeFiles([ref('b.txt')], [ref('a.txt', sha('1')), ref('a.txt', sha('2'))]);
  expect(m.files.map((f) => f.name)).toEqual(['b.txt', 'a.txt', 'a (2).txt']);
  expect(m.files[2].hash).toBe(sha('2'));
  expect(m.added).toEqual(['a.txt', 'a (2).txt']);
  // « a (2).txt » is dropped too, so the second « A.txt » takes (3), in its own spelling; no extension, a leading dot.
  const n = mergeFiles([], [ref('a.txt'), ref('A.txt'), ref('a (2).txt'), ref('Makefile'), ref('makefile'), ref('.env'), ref('.env')]);
  expect(n.files.map((f) => f.name)).toEqual(['a.txt', 'A (3).txt', 'a (2).txt', 'Makefile', 'makefile (2)', '.env', '.env (2)']);
  // The renamed one then merges like any other: the same drop again changes nothing.
  const again = mergeFiles(m.files, [ref('a.txt', sha('1')), ref('a.txt', sha('2'))]);
  expect(again).toMatchObject({ files: m.files, added: [], replaced: [], unchanged: ['a.txt', 'a (2).txt'] });
});

test('checkFileName : un message par refus, null pour un nom permis', () => {
  const files = [ref('Rapport.pdf'), ref('notes.md')];
  expect(checkFileName('', files)).toBe('Le nom ne peut pas être vide.');
  for (const c of '<>:"/\\|?*') expect(checkFileName(`a${c}b.txt`, files), c).toBe(`Le caractère « ${c} » n’est pas permis dans un nom de fichier.`);
  expect(checkFileName('a\u0007b.txt', files)).toBe('Le nom ne peut pas contenir de caractère de contrôle.');
  expect(checkFileName('a\tb.txt', files)).toBe('Le nom ne peut pas contenir de caractère de contrôle.');
  for (const n of ['notes.', 'notes ', 'notes.txt..']) expect(checkFileName(n, files), n).toBe('Le nom ne peut pas finir par un point ou un espace.');
  for (const n of ['CON', 'prn.txt', 'Aux.tar.gz', 'nul', 'COM1', 'com9.log', 'LPT1', 'lpt9.md']) {
    expect(checkFileName(n, files), n).toBe(`« ${n} » est un nom réservé par Windows.`);
  }
  expect(checkFileName('rapport.PDF', files)).toBe('Ce nœud a déjà un fichier « Rapport.pdf ».');
  expect(checkFileName('notes.md', files)).toBe('Ce nœud a déjà un fichier « notes.md ».');
  // Renaming a file to itself, its case changed, is allowed.
  expect(checkFileName('rapport.pdf', files, 'Rapport.pdf')).toBeNull();
  for (const n of ['Énoncé détaillé (v2).tex', 'calcul_mdl_séquence_aléatoire.py', 'CONSOLE.txt', 'COM0', 'com10.txt', '.gitignore']) {
    expect(checkFileName(n, files), n).toBeNull();
  }
});

test('filesBuild : un dépôt de trois fichiers, dont un remplacement, forme une seule action ; invertAction rend la liste d’avant', () => {
  const s = store.loadState();
  const before = filesOf(s);
  const incoming = [ref('NOTES_LECTURE.md', sha('a'), 10), ref('figure.svg', sha('b'), 20), ref('données.tsv', sha('c'), 30)];
  const a = filesBuild(s, ids.nodes.mdl, incoming)!(s);
  expect(a.label).toBe(`Ajouter des fichiers à « ${MDL} »`);
  expect(a.ops).toHaveLength(1);
  applyOps(s, a.ops);
  expect(filesOf(s).map((f) => f.name)).toEqual([
    'Enoncé_détaillé.tex', 'calcul_mdl_séquence_aléatoire.py', 'mesures_compression.csv', 'NOTES_LECTURE.md', 'figure.svg', 'données.tsv',
  ]);
  expect(filesOf(s)[3]).toEqual(incoming[0]);
  applyOps(s, invertAction(a).ops);
  expect(filesOf(s)).toEqual(before);
});

test('filesBuild : un seul remplacement s’intitule « Remplacer » ; un dépôt où tout est inchangé ne donne rien', () => {
  const s = store.loadState();
  const [tex, py] = filesOf(s);
  expect(filesBuild(s, ids.nodes.mdl, [{ ...tex, hash: sha('d') }])!(s).label).toBe('Remplacer « Enoncé_détaillé.tex »');
  // A drop where the one change is a replacement is named after it too.
  expect(filesBuild(s, ids.nodes.mdl, [py, { ...tex, hash: sha('d') }])!(s).label).toBe('Remplacer « Enoncé_détaillé.tex »');
  expect(filesBuild(s, ids.nodes.mdl, filesOf(s))).toBeNull();
  expect(filesBuild(s, ids.nodes.mdl, [{ ...tex, name: 'enoncé_DÉTAILLÉ.tex' }])).toBeNull();
  expect(filesBuild(s, ids.nodes.mdl, [])).toBeNull();
});

test('filesBuild : le même dépôt, déjà appliqué quand il passe, est refusé « Déjà à jour. » sans rien écrire', () => {
  const s = store.loadState();
  const incoming = [ref('figure.svg', sha('b'), 20)];
  const first = filesBuild(s, ids.nodes.mdl, incoming)!, second = filesBuild(s, ids.nodes.mdl, incoming)!;
  applyOps(s, first(s).ops);
  expect(() => second(s)).toThrow(CommandError);
  expect(() => second(s)).toThrow('Déjà à jour.');
});

test('renameFileBuild : le fichier garde sa place et son empreinte ; invertAction rend l’ancien nom ; les noms refusés le sont à l’exécution', () => {
  const s = store.loadState();
  const before = filesOf(s), py = before[1];
  expect(renameFileBuild(ids.nodes.mdl, py.name, py.name)).toBeNull();
  const a = renameFileBuild(ids.nodes.mdl, py.name, 'calcul_mdl.py')!(s);
  expect(a.label).toBe('Renommer « calcul_mdl_séquence_aléatoire.py »');
  expect(a.ops).toHaveLength(1);
  applyOps(s, a.ops);
  expect(filesOf(s)[1]).toEqual({ ...py, name: 'calcul_mdl.py' });
  applyOps(s, invertAction(a).ops);
  expect(filesOf(s)).toEqual(before);
  // Its case changed only: allowed. Another file's name, a reserved name, a file gone: refused.
  expect(() => renameFileBuild(ids.nodes.mdl, py.name, 'Calcul_MDL_séquence_aléatoire.py')!(s)).not.toThrow();
  expect(() => renameFileBuild(ids.nodes.mdl, py.name, 'NOTES_lecture.md')!(s)).toThrow('Ce nœud a déjà un fichier « notes_lecture.md ».');
  expect(() => renameFileBuild(ids.nodes.mdl, py.name, 'aux.py')!(s)).toThrow(CommandError);
  expect(() => renameFileBuild(ids.nodes.mdl, 'absent.txt', 'b.txt')!(s)).toThrow('« absent.txt » n’est plus dans ce nœud.');
});

test('removeFileBuild : retire le fichier ; invertAction le remet à sa place', () => {
  const s = store.loadState();
  const before = filesOf(s);
  const a = removeFileBuild(ids.nodes.mdl, 'calcul_mdl_séquence_aléatoire.py')!(s);
  expect(a.label).toBe(`Retirer « calcul_mdl_séquence_aléatoire.py » de « ${MDL} »`);
  applyOps(s, a.ops);
  expect(filesOf(s).map((f) => f.name)).toEqual(['Enoncé_détaillé.tex', 'mesures_compression.csv', 'notes_lecture.md']);
  applyOps(s, invertAction(a).ops);
  expect(filesOf(s)).toEqual(before);
  expect(() => removeFileBuild(ids.nodes.mdl, 'absent.txt')!(s)).toThrow(CommandError);
});

test('decodeText : « Éléments;Durée » en Windows-1252 est relu exactement, € ’ œ compris (Review Focus 4)', () => {
  expect(decodeText(bytes('\xC9l\xE9ments;Dur\xE9e'))).toEqual({ text: 'Éléments;Durée', encoding: 'windows-1252' });
  expect(decodeText(bytes('Co\xFBt (\x80) ; l\x92\x9Cuvre'))).toEqual({ text: 'Coût (€) ; l’œuvre', encoding: 'windows-1252' });
  expect(decodeText(new TextEncoder().encode('Éléments;Durée'))).toEqual({ text: 'Éléments;Durée', encoding: 'utf-8' });
  expect(decodeText(new Uint8Array())).toEqual({ text: '', encoding: 'utf-8' });
});

test('decodeText : UTF-16LE, UTF-16BE et UTF-8 par leur BOM, qui n’est pas gardé (Review Focus 4)', () => {
  const text = 'Éléments;Durée\r\nnœud;3,5\r\n';
  const le = Buffer.from(text, 'utf16le'), be = Buffer.from(le).swap16();
  expect(decodeText(new Uint8Array([0xff, 0xfe, ...le]))).toEqual({ text, encoding: 'utf-16le' });
  expect(decodeText(new Uint8Array([0xfe, 0xff, ...be]))).toEqual({ text, encoding: 'utf-16be' });
  expect(decodeText(new Uint8Array([0xef, 0xbb, 0xbf, ...Buffer.from(text, 'utf8')]))).toEqual({ text, encoding: 'utf-8' });
  // Without its BOM, UTF-16 is full of zero bytes: binary.
  expect(decodeText(new Uint8Array(le))).toEqual({ binary: true });
});

test('decodeText : un PNG renommé en .txt est un binaire ; un octet nul au-delà de 8 Ko ne compte pas (Review Focus 4)', () => {
  const png = readFileSync(filePath(dir, refOf('schéma_compression.png', ids.nodes.compression)));
  expect(fileKind('schéma_compression.txt')).toBe('text');
  expect(decodeText(png)).toEqual({ binary: true });
  const late = new Uint8Array(8192 + 10).fill(0x61);
  late[8192 + 5] = 0;
  expect(decodeText(late)).toMatchObject({ encoding: 'utf-8' });
  late[8191] = 0;
  expect(decodeText(late)).toEqual({ binary: true });
});

test('decodeText : une lecture tronquée qui coupe un caractère reste en UTF-8, le caractère coupé laissé de côté', () => {
  const cut = new TextEncoder().encode('Durée').subarray(0, 4); // D u r, then the first byte of « é »
  expect(decodeText(cut, true)).toEqual({ text: 'Dur', encoding: 'utf-8' });
  // A whole file ending so is not UTF-8.
  expect(decodeText(cut)).toEqual({ text: 'DurÃ', encoding: 'windows-1252' });
  const le = Buffer.from('Durée', 'utf16le');
  expect(decodeText(new Uint8Array([0xff, 0xfe, ...le.subarray(0, 9)]), true)).toEqual({ text: 'Duré', encoding: 'utf-16le' });
});

test('decodeText : un texte UTF-8 où traîne un octet d’un autre encodage reste en UTF-8, un U+FFFD à sa place (revue finale)', () => {
  const utf8 = (s: string) => [...new TextEncoder().encode(s)];
  // A « é » of Windows-1252 in the middle, as two tools writing to one log leave it.
  const text = utf8('Durée de la séance — résumé : « déjà vu »');
  expect(decodeText(new Uint8Array([...text.slice(0, 10), 0xe9, ...text.slice(10)])))
    .toEqual({ text: 'Durée de �la séance — résumé : « déjà vu »', encoding: 'utf-8' });
  // At the end of a whole file, as the review found it.
  expect(decodeText(new Uint8Array([...utf8('Durée … résumé '), 0xe9]))).toEqual({ text: 'Durée … résumé �', encoding: 'utf-8' });
  // A U+FFFD the text holds itself is a valid sequence, not an invalid one.
  expect(decodeText(new Uint8Array([...utf8('��� é '), 0xe9]))).toEqual({ text: '��� é �', encoding: 'utf-8' });
});

test('decodeText : un vrai texte Windows-1252 reste en Windows-1252, même si deux de ses octets forment par hasard un caractère UTF-8 (revue finale)', () => {
  // « voilà », a non-breaking space and « » »: E0 A0 BB, valid UTF-8 (U+083B), among six invalid sequences.
  expect(decodeText(bytes('R\xE9sum\xE9 de la s\xE9ance \x96 d\xE9j\xE0 vu, voil\xE0\xA0\xBB')))
    .toEqual({ text: 'Résumé de la séance – déjà vu, voilà »', encoding: 'windows-1252' });
  // The threshold: UTF-8 while its valid multi-byte sequences are at least twice its invalid ones (UTF8_VALID_PER_INVALID).
  const utf8 = (s: string) => [...new TextEncoder().encode(s)];
  expect(decodeText(new Uint8Array([...utf8('éèàù'), 0xe9, 0x20, 0xe9]))).toEqual({ text: 'éèàù� �', encoding: 'utf-8' });
  expect(decodeText(new Uint8Array([...utf8('éèà'), 0xe9, 0x20, 0xe9]))).toEqual({ text: 'Ã©Ã¨Ã é é', encoding: 'windows-1252' });
  // Too few accents to tell: one valid sequence for one invalid is read as Windows-1252.
  expect(decodeText(new Uint8Array([...utf8('Café'), 0xe9]))).toEqual({ text: 'CafÃ©é', encoding: 'windows-1252' });
  // Past 64 invalid sequences (UTF8_EVIDENCE), the count stops the first time the valid ones are too few: a text that
  // starts in Windows-1252 is read so, however much UTF-8 follows; one in UTF-8 throughout its stray bytes stays UTF-8.
  const latin = [...bytes('caf\xE9 ')], accents = utf8('été ');
  const start1252 = new Uint8Array([...Array.from({ length: 100 }, () => latin).flat(), ...Array.from({ length: 1000 }, () => accents).flat()]);
  expect(decodeText(start1252)).toMatchObject({ encoding: 'windows-1252' });
  const stray = new Uint8Array([...Array.from({ length: 1000 }, () => accents).flat(), ...Array.from({ length: 100 }, () => latin).flat()]);
  const decoded = decodeText(stray) as { text: string; encoding: string };
  expect(decoded.encoding).toBe('utf-8');
  expect(decoded.text.match(/�/g)?.length).toBe(100);
});

test('le CSV de la base de test, en Windows-1252, se lit lisiblement, en colonnes (Review Focus 4)', () => {
  const csv = readFileSync(filePath(dir, refOf('mesures_compression.csv')));
  const decoded = decodeText(csv);
  expect(decoded).toMatchObject({ encoding: 'windows-1252' });
  const table = parseDelimited((decoded as { text: string }).text, 1000);
  expect(table.delimiter).toBe(';');
  expect(table.truncated).toBe(false);
  expect(table.rows[0]).toEqual(['Éléments', 'Durée (s)', 'Taux de compression', 'Méthode', 'Coût (€)', 'Remarque']);
  expect(table.rows.every((r) => r.length === 6)).toBe(true);
  expect(table.rows.flat()).toContain('fenêtre de 32 Ko; dictionnaire figé');
  expect(table.rows.flat()).toContain('l’œuvre d’une nuit');
});

test('parseDelimited : guillemets à la RFC 4180, guillemets doublés, retour à la ligne dans un champ, CRLF ou LF', () => {
  const t = parseDelimited('a;"b;c ""d""\r\ne";f\r\ng;h\n"";\n', 100, ';');
  expect(t).toEqual({ rows: [['a', 'b;c "d"\r\ne', 'f'], ['g', 'h'], ['', '']], delimiter: ';', truncated: false });
  // No line break at the end, an empty line kept, a quote inside an unquoted field kept as is.
  expect(parseDelimited('x,y\n\n12" disque,z', 100).rows).toEqual([['x', 'y'], [''], ['12" disque', 'z']]);
  expect(parseDelimited('', 100)).toEqual({ rows: [], delimiter: ',', truncated: false });
});

test('parseDelimited : le point-virgule d’un CSV français à décimales avec virgule, la virgule et la tabulation sinon', () => {
  const french = 'Éléments;Durée (s);Taux\r\n1000;0,012;2,31\r\n10000;0,118;2,47\r\n100000;1,2;2,5\r\n';
  const t = parseDelimited(french, 100);
  expect(t.delimiter).toBe(';');
  expect(t.rows[1]).toEqual(['1000', '0,012', '2,31']);
  // Without a header, the decimals as many as the separators on every line: still the semicolon.
  expect(parseDelimited('0,5;1,5\n2,5;3,5\n', 100).delimiter).toBe(';');
  expect(parseDelimited('nom,valeur,note\nx,1.5,"a; b"\ny,2.5,c\n', 100).delimiter).toBe(',');
  expect(parseDelimited('nom\tvaleur\nx\t1,5\ny\t2,5\n', 100).delimiter).toBe('\t');
  // A separator inside quotes does not count.
  expect(parseDelimited('"a;b",c\n"d;e",f\n"g;h",i\n', 100).delimiter).toBe(',');
  // A .tsv is read with tabs, whatever its lines look like.
  expect(delimiterFor('export.TSV')).toBe('\t');
  expect(delimiterFor('mesures.csv')).toBeUndefined();
  expect(parseDelimited('a;b\tc\n', 100, '\t').rows).toEqual([['a;b', 'c']]);
});

test('parseDelimited : au-delà de maxRows, truncated', () => {
  const text = 'a;1\nb;2\nc;3\nd;4\n';
  expect(parseDelimited(text, 2)).toEqual({ rows: [['a', '1'], ['b', '2']], delimiter: ';', truncated: true });
  expect(parseDelimited(text, 4).truncated).toBe(false);
  expect(parseDelimited(text, 5).rows).toHaveLength(4);
});

/** The best of seven runs, after two to warm up (the machine may be shared: what else it does only adds). */
function cost<T>(fn: () => T): { ms: number; out: T } {
  let out = fn();
  out = fn();
  let best = Infinity;
  for (let i = 0; i < 7; i++) {
    const t = performance.now();
    out = fn();
    best = Math.min(best, performance.now() - t);
  }
  return { ms: best, out };
}

// Measured 46–49 ms (Node 26, best of seven, three runs): the ceiling is about three times that (registry, task 2).
test('parseDelimited : 100 000 lignes de 8 colonnes en 150 ms au plus', () => {
  const lines: string[] = [];
  for (let i = 0; i < 100_000; i++) lines.push(`${i};nœud ${i};${i % 97},5;"texte; ${i}";${i * 3};é${i % 13};${i % 7};fin`);
  const text = lines.join('\r\n') + '\r\n';
  const r = cost(() => parseDelimited(text, 100_000));
  expect(r.out.rows).toHaveLength(100_000);
  expect(r.out).toMatchObject({ delimiter: ';', truncated: false });
  const i = 99_999;
  expect(r.out.rows[i]).toEqual([String(i), `nœud ${i}`, `${i % 97},5`, `texte; ${i}`, String(i * 3), `é${i % 13}`, String(i % 7), 'fin']);
  if (process.env.CIRRUS_COSTS) console.log(`parseDelimited, 100 000 lignes de 8 colonnes (${(text.length / 1e6).toFixed(1)} M caractères) : ${r.ms.toFixed(1)} ms`);
  expect(r.ms).toBeLessThanOrEqual(150);
}, 60_000);

/** A Storage over a map; `broken`: every access throws, as a full or forbidden storage does. */
function memoryStorage(broken = false): { storage: Storage; data: Map<string, string> } {
  const data = new Map<string, string>();
  const check = () => { if (broken) throw new Error('stockage refusé'); };
  const storage = {
    get length() { check(); return data.size; },
    clear() { check(); data.clear(); },
    getItem(k: string) { check(); return data.get(k) ?? null; },
    key(i: number) { check(); return [...data.keys()][i] ?? null; },
    removeItem(k: string) { check(); data.delete(k); },
    setItem(k: string, v: string) { check(); data.set(k, String(v)); },
  };
  return { storage: storage as Storage, data };
}

test('ViewStates : aller-retour par le stockage, sous cirrus.fileViews', () => {
  const { storage, data } = memoryStorage();
  const views = new ViewStates(storage, 3);
  expect(views.get(sha('1'))).toBeUndefined();
  views.set(sha('1'), { line: 120 });
  views.set(sha('2'), { page: 3, offset: 0.25, zoom: 1.5 });
  expect(views.get(sha('1'))).toEqual({ line: 120 });
  expect([...data.keys()]).toEqual(['cirrus.fileViews']);
  const again = new ViewStates(storage, 3);
  expect(again.get(sha('1'))).toEqual({ line: 120 });
  expect(again.get(sha('2'))).toEqual({ page: 3, offset: 0.25, zoom: 1.5 });
});

test('ViewStates : au-delà de max, le plus anciennement enregistré part', () => {
  const { storage } = memoryStorage();
  const views = new ViewStates(storage, 3);
  for (const c of '1234') views.set(sha(c), { line: Number(c) });
  expect(views.get(sha('1'))).toBeUndefined();
  views.set(sha('2'), { line: 22 }); // saved again: now the most recent
  views.set(sha('5'), { line: 5 });
  expect(views.get(sha('3'))).toBeUndefined();
  for (const c of '245') expect(views.get(sha(c))).toBeDefined();
  // Read back with a smaller max, the oldest go.
  const fewer = new ViewStates(storage, 2);
  expect(fewer.get(sha('4'))).toBeUndefined();
  expect(fewer.get(sha('2'))).toEqual({ line: 22 });
  expect(fewer.get(sha('5'))).toEqual({ line: 5 });
});

test('ViewStates : un stockage qui lève, absent ou abîmé ne casse rien', () => {
  const broken = new ViewStates(memoryStorage(true).storage, 3);
  broken.set(sha('1'), { line: 4 });
  expect(broken.get(sha('1'))).toEqual({ line: 4 });
  const none = new ViewStates(null, 3);
  none.set(sha('1'), { line: 4 });
  expect(none.get(sha('1'))).toEqual({ line: 4 });
  for (const raw of ['{', '{"a":1}', '[["h",{"line":"x"}],["h2",null],[3,{}],"x"]']) {
    const { storage, data } = memoryStorage();
    data.set('cirrus.fileViews', raw);
    const views = new ViewStates(storage, 3);
    expect(views.get('h')).toBeUndefined();
    views.set(sha('1'), { line: 1 });
    expect(new ViewStates(storage, 3).get(sha('1'))).toEqual({ line: 1 });
  }
});

test('R20 : enregistrer un .tex au nom très long donne un libellé dans la borne, coupé comme à la création (revue de la tâche 5, tour 2)', () => {
  const s = emptyState();
  const plan = createPlan(s, 'Thèse', 'plan');
  applyOps(s, plan.ops);
  const P = (plan.ops[0].after as { id: string }).id;
  const node = createNode(s, { plan: P, title: 'Chapitre', x: 0, y: 0, k: 0 });
  applyOps(s, node.ops);
  const X = (node.ops[0].after as { id: string }).id, name = `${'n'.repeat(600)}.tex`;
  applyOps(s, editNode(s, X, { files: [{ name, hash: sha('a'), size: 1 }] }).ops);
  const a = texSaveBuild(s, X, { name, hash: sha('b'), size: 2 })!(s);
  expect(a.label).toHaveLength(MAX_LABEL_CHARS);
  expect(a.label.startsWith('Modifier « nnn')).toBe(true);
  expect(a.label.endsWith('…')).toBe(true);
});
