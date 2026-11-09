import type { FileRef } from '@cirrus/core';
import { DEFAULT_PARAMS as P } from '@cirrus/view';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, test } from 'vitest';
import { choosePdf, type ImportDeps, type PdfDeps, readPdf, takePdfPath } from '../src/renderer/publications/build.ts';
import type { PdfClues } from '../src/renderer/publications/pdfClues.ts';
import { PublicationDialog } from '../src/renderer/ui/PublicationDialog.tsx';

// The PDF the import dialog takes (plan 4c, D8; plan 5b, D5): dropped on it, dropped on the graph's background, chosen
// by « Choisir un PDF… », or given by an address (`{ kind: 'pdf' }`). All four read it the same way.

const ATTENTION: FileRef = { name: 'attention.pdf', hash: 'a'.repeat(64), size: 2000 };
const NOTE: FileRef = { name: 'publication.pdf', hash: 'b'.repeat(64), size: 640 };
const STAMPED: PdfClues = { text: 'Attention Is All You Need\narXiv:1706.03762v7  [cs.CL]  2 Aug 2023', meta: {}, title: 'Attention Is All You Need' };
const PLAIN: PdfClues = { text: 'Un extrait sans identifiant.', meta: {}, title: null };

/** The dialog's deps over fakes: the store's answer, pdf.js's, each call recorded. */
function pdfDeps(over: Partial<PdfDeps> & { clues?: PdfClues | Error; stored?: FileRef | null } = {}) {
  const calls = { imported: [] as string[][], read: [] as FileRef[] };
  const { clues = STAMPED, stored = ATTENTION, ...rest } = over;
  const d: PdfDeps = {
    importFiles: async (paths) => {
      calls.imported.push(paths);
      return stored === null ? { refs: [], refused: [{ name: 'attention.pdf', reason: 'plus de 200 Mo' }] } : { refs: [stored], refused: [] };
    },
    readClues: async (ref) => {
      calls.read.push(ref);
      if (clues instanceof Error) throw clues;
      return clues;
    },
    unreadable: async (name) => `« ${name} » n’a pas pu être lu : le fichier est abîmé.`,
    open: () => true,
    log: () => {},
    ...rest,
  };
  return { d, calls };
}

test('takePdfPath : un PDF lâché entre au magasin, puis ses premières pages donnent son identifiant arXiv', async () => {
  const { d, calls } = pdfDeps();
  expect(await takePdfPath('C:\\docs\\attention.pdf', d)).toEqual({ kind: 'read', ref: ATTENTION, title: 'Attention Is All You Need', found: { arxiv: '1706.03762v7' }, unreadable: '' });
  expect(calls.imported).toEqual([['C:\\docs\\attention.pdf']]);
  expect(calls.read).toEqual([ATTENTION]);
});

test('takePdfPath : sans identifiant, le titre de ses métadonnées, sinon le nom du fichier ; un PDF illisible le dit, et se crée tout de même', async () => {
  expect(await takePdfPath('C:\\docs\\extrait.PDF', pdfDeps({ stored: { ...ATTENTION, name: 'extrait.PDF' }, clues: PLAIN }).d)).toEqual({
    kind: 'read', ref: { ...ATTENTION, name: 'extrait.PDF' }, title: 'extrait', found: null, unreadable: '',
  });
  expect(await takePdfPath('/home/moi/extrait.pdf', pdfDeps({ clues: { ...PLAIN, title: 'Un extrait' } }).d)).toMatchObject({ title: 'Un extrait', found: null });
  expect(await takePdfPath('C:\\docs\\attention.pdf', pdfDeps({ clues: new Error('Invalid PDF structure.') }).d)).toEqual({
    kind: 'read', ref: ATTENTION, title: 'attention', found: null, unreadable: '« attention.pdf » n’a pas pu être lu : le fichier est abîmé. ',
  });
});

test('takePdfPath : ce qui n’est pas un PDF, un fichier refusé par le magasin, un rejet du magasin sont dits en français, sans lecture', async () => {
  const notPdf = pdfDeps();
  expect(await takePdfPath('C:\\docs\\bibliographie.bib', notPdf.d)).toEqual({ kind: 'failed', message: '« bibliographie.bib » n’est pas un PDF.' });
  expect(notPdf.calls.imported).toEqual([]);
  const refused = pdfDeps({ stored: null });
  expect(await takePdfPath('C:\\docs\\attention.pdf', refused.d)).toEqual({ kind: 'failed', message: '1 fichier non importé : attention.pdf (plus de 200 Mo)' });
  expect(refused.calls.read).toEqual([]);
  const logged: unknown[] = [];
  const rejected = pdfDeps({ importFiles: () => Promise.reject(new Error('EBUSY')), log: (what, e) => logged.push([what, e]) });
  expect(await takePdfPath('C:\\docs\\attention.pdf', rejected.d)).toEqual({ kind: 'failed', message: '« attention.pdf » n’a pas pu être importé.' });
  expect(logged).toHaveLength(1);
  expect(rejected.calls.read).toEqual([]);
});

test('takePdfPath, readPdf : un dialogue fermé pendant l’enregistrement ou la lecture laisse tomber le résultat', async () => {
  let open = true;
  const storing = pdfDeps({ importFiles: async () => { open = false; return { refs: [ATTENTION], refused: [] }; }, open: () => open });
  expect(await takePdfPath('C:\\docs\\attention.pdf', storing.d)).toEqual({ kind: 'dropped' });
  expect(storing.calls.read).toEqual([]);
  open = true;
  const reading = pdfDeps({ readClues: async () => { open = false; return STAMPED; }, open: () => open });
  expect(await takePdfPath('C:\\docs\\attention.pdf', reading.d)).toEqual({ kind: 'dropped' });
  open = true;
  const failing = pdfDeps({ readClues: async () => { open = false; throw new Error('x'); }, open: () => open });
  expect(await readPdf(ATTENTION, failing.d)).toEqual({ kind: 'dropped' });
});

test('readPdf (plan 5b, D3) : le PDF qu’une adresse a mené au magasin est lu comme un PDF lâché, sans repasser par le magasin', async () => {
  const dropped = pdfDeps();
  const fromAddress = pdfDeps();
  const a = await takePdfPath('C:\\docs\\attention.pdf', dropped.d);
  const b = await readPdf(ATTENTION, fromAddress.d);
  expect(b).toEqual(a);
  expect(fromAddress.calls.imported).toEqual([]);
  expect(fromAddress.calls.read).toEqual([ATTENTION]);
  // Sans identifiant : « Créer le nœud », sous le nom de son fichier.
  expect(await readPdf(NOTE, pdfDeps({ clues: PLAIN }).d)).toEqual({ kind: 'read', ref: NOTE, title: 'publication', found: null, unreadable: '' });
});

test('choosePdf (plan 5b, D5) : « Choisir un PDF… » annulé ne fait rien ; un PDF choisi est pris comme un PDF lâché', async () => {
  const told: string[] = [];
  const cancelled = pdfDeps();
  expect(await choosePdf(async () => null, cancelled.d, (path) => told.push(path))).toBeNull();
  expect(cancelled.calls.imported).toEqual([]);
  expect(cancelled.calls.read).toEqual([]);
  expect(told).toEqual([]);
  const chosen = pdfDeps();
  expect(await choosePdf(async () => 'C:\\docs\\attention.pdf', chosen.d, (path) => told.push(path))).toEqual(await takePdfPath('C:\\docs\\attention.pdf', pdfDeps().d));
  expect(chosen.calls.imported).toEqual([['C:\\docs\\attention.pdf']]);
  expect(told).toEqual(['C:\\docs\\attention.pdf']);
  // The dialog closed while the system's dialog was open: nothing is taken.
  const closed = pdfDeps({ open: () => false });
  expect(await choosePdf(async () => 'C:\\docs\\attention.pdf', closed.d)).toBeNull();
  expect(closed.calls.imported).toEqual([]);
  // Le sélecteur qui échoue : rien n’est pris non plus, la cause à la console.
  const logged: unknown[] = [];
  const broken = pdfDeps({ log: (what, e) => logged.push([what, e]) });
  expect(await choosePdf(() => Promise.reject(new Error('dialogue fermé')), broken.d)).toEqual({ kind: 'failed', message: 'Le sélecteur de fichiers n’a pas pu s’ouvrir.' });
  expect(logged).toHaveLength(1);
  expect(broken.calls.imported).toEqual([]);
});

/** The import dialog's props, nothing reached: its markup at its first render. */
const importDeps: Omit<ImportDeps, 'open'> = {
  state: () => { throw new Error('non attendu'); },
  fetch: () => Promise.reject(new Error('non attendu')),
  storeText: () => Promise.reject(new Error('non attendu')),
  put: () => Promise.reject(new Error('non attendu')),
  maxAuthors: () => 20,
};
const dialog = (initialPdf?: string) => renderToStaticMarkup(createElement(PublicationDialog, {
  params: P, deps: importDeps, onNotify: () => {}, onClose: () => {}, ...(initialPdf === undefined ? {} : { initialPdf }),
}));

test('PublicationDialog (plan 5b, D5) : le champ accepte une adresse, « Choisir un PDF… » est proposé', () => {
  const markup = dialog();
  expect(markup).toContain('placeholder="DOI, identifiant arXiv ou adresse d’un article"');
  expect(markup).toContain('>Choisir un PDF…</button>');
  expect(markup).not.toMatch(/<button[^>]*disabled[^>]*>Choisir un PDF…/);
});

test('PublicationDialog (revue finale du plan 5b, M1) : le champ ne coupe rien de ce qui est collé (aucun maxlength) : une adresse trop longue est refusée, dite', () => {
  expect(dialog()).not.toMatch(/maxlength/i);
});

test('PublicationDialog (plan 5b, D5) : ouvert par un PDF lâché sur le fond, il lit ce PDF d’emblée, comme un dépôt sur lui — rien d’autre à faire, rien à importer encore', () => {
  const idle = dialog();
  const opened = dialog('C:\\docs\\attention.pdf');
  expect(idle).not.toContain('Lecture de');
  expect(opened).toContain('Lecture de « attention.pdf »…');
  // Under way: the buttons wait, and none of the results (« Créer le nœud ») is offered before it is read.
  expect(opened).toMatch(/<button[^>]*disabled[^>]*>Choisir un PDF…/);
  expect(opened).not.toContain('Créer le nœud');
});
