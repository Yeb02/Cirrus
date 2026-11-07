// Adds to a test base built by make-fixture.ts a long PDF annotated 50 times, for the measures of plan 4c, task 7
// (packages/app/scripts/mesures-annotations.mjs): node scripts/add-reading.ts <dossier>
// The PDF, 25 pages of 40 lines, is the file of two new nodes of the lobby: « Lecture de mesure (50 annotations) »
// at (−700, −300), two passages of each page annotated on it, one action each, as the app makes them; « Lecture de
// mesure (sans annotation) » at (−700, −140), the same file, none. Never on the user's base (final review, M6): the
// folder must hold a test base, made by make-fixture.ts, outside %APPDATA%\@cirrus\app\base (testBaseRefusal); its
// lock is taken as the app takes it, so that no Cirrus has it open meanwhile.
import { resolve } from 'node:path';
import { type Action, ANNOTATION_TITLE_CHARS, annotationTitle, applyOps, createAnnotation, createNode, type Id } from '@cirrus/core';
import { LocalStore, lockBase, storeBytes } from '@cirrus/store';
import { passage, type PdfLine, type PdfPageSpec, writePdf } from '../src/pdf.ts';
import { FIXTURE_PC, testBaseRefusal } from '../src/testBase.ts';

const target = process.argv[2];
if (!target) {
  console.error('Usage : node scripts/add-reading.ts <dossier d’une base de test>');
  process.exit(1);
}
const dir = resolve(process.env.INIT_CWD ?? process.cwd(), target);
const refusal = testBaseRefusal(dir);
if (refusal !== null) {
  console.error(refusal);
  process.exit(1);
}
const lock = lockBase(dir);
if (!lock) {
  console.error(`${dir} est ouverte par Cirrus (une fenêtre, une capture, le banc) : ferme-la d’abord.`);
  process.exit(1);
}

const PAGES = 25, LINES = 40;
const pad = (n: number) => String(n).padStart(2, '0');
// Words of French text whose characters Helvetica's table of pdf.ts knows (passage measures them).
const WORDS = [
  'la', 'le', 'des', 'une', 'chaîne', 'mesure', 'complexité', 'programme', 'modèle', 'données', 'compression', 'code',
  'préfixe', 'machine', 'universelle', 'longueur', 'description', 'probabilité', 'hypothèse', 'induction', 'théorème',
  'borne', 'entropie', 'source', 'symbole', 'suite', 'aléatoire', 'règle', 'principe', 'minimum', 'côté', 'reçoit',
  'façon', 'sûr', 'où', 'à', 'est', 'et', 'par', 'pour', 'avec', 'plus', 'court', 'calcul', 'invariant', 'constante',
];
let seed = 7;
const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
/** A body line: its number first and last, `(07) … 07.`, so that a passage starts and ends on a line of its own. */
function bodyLine(n: number): string {
  const words: string[] = [];
  for (let len = 0; len < 58;) {
    const w = WORDS[Math.floor(random() * WORDS.length)];
    words.push(w);
    len += w.length + 1;
  }
  return `(${pad(n)}) ${words.join(' ')} ${pad(n)}.`;
}
const pages: PdfPageSpec[] = Array.from({ length: PAGES }, (_, p) => {
  const lines: PdfLine[] = [{ x: 72, y: 780, size: 14, text: `Page ${p + 1} de la lecture de mesure`, bold: true }];
  for (let l = 1; l <= LINES; l++) lines.push({ x: 72, y: 760 - 15 * l, size: 11, text: bodyLine(l) });
  lines.push({ x: 595 / 2 - 3, y: 40, size: 10, text: String(p + 1) });
  return { width: 595, height: 842, lines };
});

const store = LocalStore.open(dir, { pc: FIXTURE_PC });
try {
  const s = store.loadState();
  const run = (a: Action): Action => { store.commit(a); applyOps(s, a.ops); return a; };
  const created = (a: Action): Id => (run(a).ops.find((o) => o.t === 'node' && o.before === null) as { after: { id: Id } }).after.id;
  const lobby = [...s.plans.values()].find((p) => p.type === 'lobby')!.id;
  const ref = storeBytes(dir, 'lecture_de_mesure.pdf', writePdf(pages));
  const annotated = created(createNode(s, { plan: lobby, title: 'Lecture de mesure (50 annotations)', x: -700, y: -300, k: 0, files: [ref] }));
  created(createNode(s, { plan: lobby, title: 'Lecture de mesure (sans annotation)', x: -700, y: -140, k: 0, files: [ref] }));
  let rects = 0;
  for (let p = 1; p <= PAGES; p++) {
    // Two passages a page, of one to three lines, at places that move from page to page.
    for (const [from, k] of [[3 + (p % 7), 1 + (p % 3)], [18 + (p % 11), 1 + ((p + 1) % 3)]]) {
      const { text, rects: r } = passage(pages[p - 1], `(${pad(from)})`, ` ${pad(from + k - 1)}.`);
      rects += r.length;
      created(createAnnotation(s, { pdf: annotated, file: ref.name, hash: ref.hash, page: p, rects: r, text }, annotationTitle(text, ANNOTATION_TITLE_CHARS)));
    }
  }
  console.log(`Ajouté à ${dir} : « lecture_de_mesure.pdf » (${PAGES} pages, ${ref.size} octets), 50 annotations, ${rects} rectangles.`);
} finally {
  store.close();
  lock.release();
}
