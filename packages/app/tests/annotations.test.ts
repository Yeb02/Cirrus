import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  type Action, type Anchor, ANCHOR_MAX_RECTS, ANCHOR_MAX_TEXT, applyOps, createAnnotation, deleteEverywhere, editNode, type FileRef, invertAction, moveNodes,
  placeNode, removeFromPlan, type State,
} from '@cirrus/core';
import { buildFixture, type FixtureIds } from '@cirrus/fixtures';
import { LocalStore } from '@cirrus/store';
import { getDocument, type PageViewport, type PDFPageProxy } from 'pdfjs-dist/legacy/build/pdf.mjs';
import { afterAll, beforeAll, expect, test } from 'vitest';
import {
  anchorRefusal, AnnotationIndex, annotationSource, type DOMRectLike, mergeLines, ofFile, type PageHit, pdfRects, rectsOnScreen, selectionToAnchor, titleChars,
} from '../src/renderer/files/annotations.ts';

/** CSS pixels per point (pdf.ts's, which loads pdf.js's browser build): zoom 1 shows a page at its real size. */
const CSS_PER_PT = 96 / 72;

// One test base for the whole file, never the user's: each test reads its state from the store again. The chapter's
// first page (A4, 595 × 842 points) gives pdf.js's own viewports.
let dir: string, store: LocalStore, ids: FixtureIds, page: PDFPageProxy, destroy: () => Promise<void>;
beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'cirrus-annotations-'));
  store = LocalStore.open(dir, { pc: 'test' });
  ids = buildFixture(store, dir);
  const bytes = new Uint8Array(readFileSync(new URL('../../fixtures/assets/Li_Vitányi_chapitre_1.pdf', import.meta.url)));
  const task = getDocument({ data: bytes, useSystemFonts: false });
  page = await (await task.promise).getPage(1);
  destroy = () => task.destroy();
});
afterAll(async () => {
  await destroy();
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

const run = (s: State, a: Action) => applyOps(s, a.ops);
/** The page at `zoom` (rotated by `rotation`), its top left at (x, y) of the window: what the reader's pageOf gives. */
const viewport = (zoom: number, rotation = 0, x = 37.5, y = 120): PageViewport =>
  page.getViewport({ scale: zoom * CSS_PER_PT, rotation, offsetX: x, offsetY: y });
const box = (left: number, top: number, right: number, bottom: number): DOMRectLike => ({ left, top, right, bottom });

test('coordonnées : un aller-retour entre l’écran et la page PDF, à trois zooms et sur une page tournée', () => {
  for (const zoom of [0.6, 1.5, 4]) {
    for (const rotation of [0, 90]) {
      const vp = viewport(zoom, rotation);
      // Two lines of the screen, inside the page drawn there (its width and height follow the rotation).
      const s = zoom * CSS_PER_PT, at = (u: number, v: number) => [37.5 + u * vp.width, 120 + v * vp.height] as const;
      const [l1, t1] = at(0.2, 0.3), [l2, t2] = at(0.1, 0.3);
      const screen = [box(l1, t1, l1 + 180 * s, t1 + 12 * s), box(l2, t2 + 16 * s, l2 + 300 * s, t2 + 28 * s)];
      const rects = pdfRects(screen, vp);
      expect(rects, `zoom ${zoom}, ${rotation}°`).toHaveLength(2);
      // In the page's points: the same size at any zoom; a line across the screen runs along y on a page turned by 90°.
      for (const [x0, y0, x1, y1] of rects) {
        expect(x1).toBeGreaterThan(x0);
        expect(y1).toBeGreaterThan(y0);
        expect(rotation === 0 ? y1 - y0 : x1 - x0).toBeCloseTo(12, 2);
      }
      // y up: the first line, higher on the screen, has the higher y (on the upright page).
      if (rotation === 0) expect(rects[0][1]).toBeGreaterThan(rects[1][1]);
      const back = rectsOnScreen({ rects } as Anchor, vp);
      back.forEach((r, i) => {
        for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(r[side], `${side}, zoom ${zoom}, ${rotation}°`).toBeCloseTo(screen[i][side], 2);
      });
      // And from the page: the rectangles come back as they were (to a thousandth of a point).
      expect(pdfRects(rectsOnScreen({ rects } as Anchor, vp), vp)).toEqual(rects);
    }
  }
});

test('coordonnées : les rectangles de la base de test tombent à leur place à chaque zoom, à l’échelle du zoom', () => {
  const rects: Anchor['rects'] = [[309.42, 581, 500.172, 594.8], [72, 565, 499.536, 578.8]];
  const at1 = rectsOnScreen({ rects } as Anchor, viewport(1, 0, 0, 0));
  // 842 points high: y = 594.8 is 247.2 points from the top.
  expect(at1[0].top).toBeCloseTo(247.2 * CSS_PER_PT, 6);
  expect(at1[0].left).toBeCloseTo(309.42 * CSS_PER_PT, 6);
  for (const zoom of [0.5, 2, 5]) {
    const r = rectsOnScreen({ rects } as Anchor, viewport(zoom, 0, 0, 0));
    r.forEach((x, i) => {
      for (const side of ['left', 'top', 'right', 'bottom'] as const) expect(x[side]).toBeCloseTo(at1[i][side] * zoom, 6);
    });
  }
});

test('lignes : les morceaux d’une ligne sont fusionnés, deux lignes donnent deux rectangles, deux colonnes ne se rejoignent pas', () => {
  // Line 1 in two runs, the box of its first run counted twice (an element and its text); line 2 in one run; a
  // superscript inside line 2; an empty rectangle (a line break) is ignored.
  const lines = mergeLines([
    box(100, 50, 220, 64), box(100, 50, 220, 64), box(223, 51, 300, 64.5),
    box(80, 70, 290, 84), box(291, 68, 297, 75), box(300, 70, 300, 84),
  ]);
  expect(lines).toEqual([box(100, 50, 300, 64.5), box(80, 68, 297, 84)]);
  // On the same height, two columns apart by more than a line's height: two rectangles.
  expect(mergeLines([box(0, 0, 200, 14), box(240, 0, 440, 14)])).toHaveLength(2);
});

// A DOM in miniature for the selection: elements and text nodes in a tree, each text laid out on one line from
// `left`, `w` pixels a character; a range between two points of it.
interface FakeNode {
  nodeType: number; tagName?: string; data?: string; length?: number; page?: number; parentNode: FakeNode | null; childNodes: FakeNode[];
  readonly firstChild: FakeNode | null; readonly nextSibling: FakeNode | null; at?: { left: number; top: number; w: number; h: number };
}
function node(fields: Partial<FakeNode>, children: FakeNode[] = []): FakeNode {
  const n: FakeNode = {
    nodeType: 1, parentNode: null, childNodes: children, ...fields,
    get firstChild() { return n.childNodes[0] ?? null; },
    get nextSibling() { const sib = n.parentNode?.childNodes; return sib ? sib[sib.indexOf(n) + 1] ?? null : null; },
  };
  for (const c of children) c.parentNode = n;
  return n;
}
const span = (data: string, left: number, top: number, w = 6, h = 14) =>
  node({ tagName: 'SPAN' }, [node({ nodeType: 3, data, length: data.length, at: { left, top, w, h } })]);
const br = () => node({ tagName: 'BR' });
const textOf = (sp: FakeNode) => sp.childNodes[0];
function selection(start: [FakeNode, number], end: [FakeNode, number]): Selection {
  const range = {
    startContainer: start[0], startOffset: start[1], endContainer: end[0], endOffset: end[1],
    cloneRange() {
      let from: [FakeNode, number] = start, to: [FakeNode, number] = end;
      return {
        setStart(n: FakeNode, o: number) { from = [n, o]; },
        setEnd(n: FakeNode, o: number) { to = [n, o]; },
        getClientRects() {
          const t = from[0], a = from[1], b = to[1];
          if (t !== to[0] || !t.at || b <= a) return [];
          return [box(t.at.left + a * t.at.w, t.at.top, t.at.left + b * t.at.w, t.at.top + t.at.h)];
        },
      };
    },
  };
  return { rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as unknown as Selection;
}
/** The page of an element, as the reader finds it: its `.pdf-page` ancestor, at its place in the window. */
const pageOf = (vps: Map<number, PageViewport>) => (el: Element): PageHit | null => {
  for (let n: FakeNode | null = el as unknown as FakeNode; n; n = n.parentNode) if (n.page !== undefined) return { page: n.page, viewport: vps.get(n.page)! };
  return null;
};
const FILE = { name: 'Li_Vitányi_chapitre_1.pdf', hash: 'b'.repeat(64) };

test('sélection : deux lignes en trois morceaux donnent deux rectangles fusionnés, et leur texte joint par un saut de ligne', () => {
  const a1 = span('La complexité ', 100, 200), a2 = span('de Kolmogorov d’une', 184, 200), b1 = span('chaîne est la longueur.', 60, 220);
  node({ tagName: 'DIV', page: 1 }, [node({ tagName: 'DIV' }, [a1, a2, br(), b1, br()])]);
  const vp = viewport(1, 0, 0, 0);
  const a = selectionToAnchor(selection([textOf(a1), 3], [textOf(b1), 23]), pageOf(new Map([[1, vp]])), 'pdf-node', FILE)!;
  expect(a).toMatchObject({ pdf: 'pdf-node', file: FILE.name, hash: FILE.hash, page: 1 });
  expect(a.text).toBe('complexité de Kolmogorov d’une\nchaîne est la longueur.');
  expect(a.rects).toHaveLength(2);
  expect(a.rects).toEqual(pdfRects([box(118, 200, 184 + 19 * 6, 214), box(60, 220, 60 + 23 * 6, 234)], vp));
});

test('sélection : celle qui passe d’une page à l’autre est coupée à la fin de la première ; une sélection vide n’annote rien', () => {
  const p1a = span('dernière ligne de la page', 70, 900), p2a = span('première ligne suivante', 70, 1300), p2b = span('et une autre', 70, 1320);
  const page1 = node({ tagName: 'DIV', page: 1 }, [node({ tagName: 'DIV' }, [p1a, br(), node({ tagName: 'DIV' })])]);
  const page2 = node({ tagName: 'DIV', page: 2 }, [node({ tagName: 'DIV' }, [p2a, br(), p2b])]);
  node({ tagName: 'DIV' }, [page1, page2]);
  const vps = new Map([[1, viewport(1.2, 0, 10, 0)], [2, viewport(1.2, 0, 10, 1200)]]);
  const a = selectionToAnchor(selection([textOf(p1a), 9], [textOf(p2b), 6]), pageOf(vps), 'pdf-node', FILE)!;
  expect(a.page).toBe(1);
  expect(a.text).toBe('ligne de la page');
  expect(a.rects).toEqual(pdfRects([box(70 + 9 * 6, 900, 70 + 25 * 6, 914)], vps.get(1)!));
  // Started past the end of page 1's text (its end of content, an element): the passage is on page 2.
  const end = page1.childNodes[0].childNodes[2];
  const b = selectionToAnchor(selection([end, 0], [textOf(p2a), 8]), pageOf(vps), 'pdf-node', FILE)!;
  expect([b.page, b.text]).toEqual([2, 'première']);
  // Only blanks, or nothing: no annotation.
  const blank = span('   ', 70, 600);
  node({ tagName: 'DIV', page: 1 }, [node({ tagName: 'DIV' }, [blank])]);
  expect(selectionToAnchor(selection([textOf(blank), 0], [textOf(blank), 3]), pageOf(vps), 'pdf-node', FILE)).toBeNull();
  const none = { rangeCount: 0, isCollapsed: true } as unknown as Selection;
  expect(selectionToAnchor(none, pageOf(vps), 'pdf-node', FILE)).toBeNull();
  // Outside every page: none either.
  const stray = span('hors du lecteur', 0, 0);
  node({ tagName: 'DIV' }, [stray]);
  expect(selectionToAnchor(selection([textOf(stray), 0], [textOf(stray), 4]), pageOf(vps), 'pdf-node', FILE)).toBeNull();
});

test('un passage trop long est refusé avec sa raison, en français ; le titre compte au moins un caractère entier', () => {
  const ok: Anchor = { pdf: 'p', file: 'a.pdf', hash: 'c'.repeat(64), page: 1, rects: [[0, 0, 1, 1]], text: 'x' };
  expect(anchorRefusal(ok)).toBeNull();
  expect(anchorRefusal({ ...ok, text: 'x'.repeat(ANCHOR_MAX_TEXT) })).toBeNull();
  // The numbers the French way (a narrow no-break space between thousands).
  const fr = (n: number) => n.toLocaleString('fr-FR');
  expect(anchorRefusal({ ...ok, text: 'x'.repeat(ANCHOR_MAX_TEXT + 1) })).toBe(`Ce passage est trop long pour être annoté : ${fr(20_001)} caractères, au plus ${fr(20_000)}.`);
  const many = Array.from({ length: ANCHOR_MAX_RECTS + 1 }, (): Anchor['rects'][number] => [0, 0, 1, 1]);
  expect(anchorRefusal({ ...ok, rects: many })).toBe('Ce passage est trop long pour être annoté : 501 lignes, au plus 500.');
  expect([titleChars(80), titleChars(0), titleChars(-3), titleChars(2.6), titleChars(Number.NaN)]).toEqual([80, 1, 1, 3, 80]);
});

const fileOf = (s: State, name: string): FileRef => s.nodes.get(ids.nodes.publication)!.files.find((f) => f.name === name)!;
const CHAPTER = 'Li_Vitányi_chapitre_1.pdf';

test('index : les annotations d’un PDF dans l’ordre des pages, et celles de chaque version', () => {
  const s = store.loadState();
  const index = AnnotationIndex.build(s);
  const all = index.of(ids.nodes.publication);
  // Page 1's two start at the same place of the page (one per version): by identifier.
  expect(all.map((e) => e.node.id)).toEqual([...[ids.nodes.annotationEarlier, ids.nodes.annotationPage1].sort(), ids.nodes.annotationPage2]);
  expect(all.map((e) => e.anchor.page)).toEqual([1, 1, 2]);
  const chapter = fileOf(s, CHAPTER), earlier = s.nodes.get(ids.nodes.annotationEarlier)!.anchor!.hash;
  expect(earlier).not.toBe(chapter.hash);
  expect(index.forVersion(ids.nodes.publication, chapter.hash).map((e) => e.node.id)).toEqual([ids.nodes.annotationPage1, ids.nodes.annotationPage2]);
  expect(index.forVersion(ids.nodes.publication, earlier).map((e) => e.node.id)).toEqual([ids.nodes.annotationEarlier]);
  // The plans each one is in: page 1's in « Lecture », the other two in none.
  expect(all.find((e) => e.node.id === ids.nodes.annotationPage1)!.plans).toEqual([{ id: ids.plans.lecture, name: 'Lecture' }]);
  expect(all.find((e) => e.node.id === ids.nodes.annotationPage2)!.plans).toEqual([]);
  // A node without annotations, or another hash: none.
  expect(index.of(ids.nodes.mdl)).toEqual([]);
  expect(index.forVersion(ids.nodes.publication, 'd'.repeat(64))).toEqual([]);
  // The margin of the chapter's reader: its annotations, every version, by name or by hash; none of the other PDF.
  expect(ofFile(all, chapter).map((e) => e.node.id)).toEqual(all.map((e) => e.node.id));
  expect(ofFile(all, fileOf(s, 'Li_Vitányi_extrait.pdf'))).toEqual([]);
  expect(ofFile(all, { ...chapter, name: 'renommé.pdf' }).map((e) => e.node.id)).toEqual([ids.nodes.annotationPage1, ids.nodes.annotationPage2]);
});

test('annotationSource : le fichier du PDF qui porte sa version — par son empreinte, ou une version précédente sous son nom — ou ce qui manque (Review Focus 4)', () => {
  const s = store.loadState(), pdf = ids.nodes.publication;
  const anchorOf = (id: string) => s.nodes.get(id)!.anchor!;
  const page1 = anchorOf(ids.nodes.annotationPage1), earlier = anchorOf(ids.nodes.annotationEarlier), chapter = fileOf(s, CHAPTER);
  expect(annotationSource(s, page1)).toEqual({ file: chapter, earlier: false });
  expect(annotationSource(s, earlier)).toEqual({ file: chapter, earlier: true });
  // The chapter renamed: its version is found by its hash, under its new name; the earlier one, under the old name, no longer.
  run(s, editNode(s, pdf, { files: s.nodes.get(pdf)!.files.map((f) => (f.name === CHAPTER ? { ...f, name: 'Chapitre 1.pdf' } : f)) }));
  expect(annotationSource(s, page1)).toEqual({ file: { ...chapter, name: 'Chapitre 1.pdf' }, earlier: false });
  expect(annotationSource(s, earlier)).toEqual({ why: `« ${CHAPTER} » n’est plus dans « An Introduction to Kolmogorov Complexity and Its Applications ».` });
  // The PDF's node in the trash, or gone.
  run(s, deleteEverywhere(s, pdf));
  expect(annotationSource(s, page1)).toEqual({ why: 'Le PDF « An Introduction to Kolmogorov Complexity and Its Applications » est à la corbeille.' });
  expect(annotationSource(s, { ...page1, pdf: 'jamais-vu' })).toEqual({ why: 'Le PDF de cette annotation n’existe plus.' });
});

test('index : une annotation à la corbeille ou annulée n’y est plus ; le PDF à la corbeille garde les siennes', () => {
  const s = store.loadState();
  run(s, deleteEverywhere(s, ids.nodes.annotationPage2));
  expect(AnnotationIndex.build(s).of(ids.nodes.publication).map((e) => e.node.id)).not.toContain(ids.nodes.annotationPage2);
  run(s, deleteEverywhere(s, ids.nodes.publication));
  expect(AnnotationIndex.build(s).of(ids.nodes.publication)).toHaveLength(2);
});

test('index : une reconstruction après une modification ne relit que ce qui a changé', () => {
  const s = store.loadState();
  const i0 = AnnotationIndex.build(s);
  const entry = (i: AnnotationIndex, id: string) => i.of(ids.nodes.publication).find((e) => e.node.id === id)!;
  const chapter = fileOf(s, CHAPTER), earlier = s.nodes.get(ids.nodes.annotationEarlier)!.anchor!.hash;
  // Nothing that touches an annotation (a node moved): the same index.
  run(s, moveNodes(s, ids.plans.lobby, [{ node: ids.nodes.mdl, x: 5 }]));
  expect(AnnotationIndex.build(s, i0)).toBe(i0);
  // Page 2's renamed: its entry is read again; the others, and the earlier version's list, are those of before.
  run(s, editNode(s, ids.nodes.annotationPage2, { title: 'Codes préfixes' }));
  const i1 = AnnotationIndex.build(s, i0);
  expect(i1).not.toBe(i0);
  expect(entry(i1, ids.nodes.annotationPage2).node.title).toBe('Codes préfixes');
  expect(entry(i1, ids.nodes.annotationPage1)).toBe(entry(i0, ids.nodes.annotationPage1));
  expect(entry(i1, ids.nodes.annotationEarlier)).toBe(entry(i0, ids.nodes.annotationEarlier));
  expect(i1.forVersion(ids.nodes.publication, earlier)).toBe(i0.forVersion(ids.nodes.publication, earlier));
  expect(i1.forVersion(ids.nodes.publication, chapter.hash)).not.toBe(i0.forVersion(ids.nodes.publication, chapter.hash));
  // Placed in a plan: its plans change, its entry with them.
  const placed = placeNode(s, ids.plans.lobby, ids.nodes.annotationEarlier, 0, 0, 0);
  run(s, placed);
  const i2 = AnnotationIndex.build(s, i1);
  expect(entry(i2, ids.nodes.annotationEarlier).plans.map((p) => p.id)).toEqual([ids.plans.lobby]);
  expect(entry(i2, ids.nodes.annotationPage1)).toBe(entry(i1, ids.nodes.annotationPage1));
  // Removed « here only » from its last plan: in no plan again, and still listed under its PDF (controller's ruling,
  // task 3: an annotation leaving its last plan does not go to the trash).
  run(s, removeFromPlan(s, ids.plans.lobby, ids.nodes.annotationEarlier));
  const back = AnnotationIndex.build(s, i2);
  expect(s.nodes.get(ids.nodes.annotationEarlier)!.trashedAt).toBeUndefined();
  expect(entry(back, ids.nodes.annotationEarlier).plans).toEqual([]);
  expect(back.forVersion(ids.nodes.publication, earlier).map((e) => e.node.id)).toEqual([ids.nodes.annotationEarlier]);
  // A new one, then its creation undone: in the list, then gone; the earlier version's list is not read again.
  const made = createAnnotation(s, { pdf: ids.nodes.publication, file: CHAPTER, hash: chapter.hash, page: 3, rects: [[72, 700, 300, 712]], text: 'K(x)' }, 'K(x)');
  run(s, made);
  const i3 = AnnotationIndex.build(s, back);
  expect(i3.of(ids.nodes.publication).map((e) => e.anchor.page)).toEqual([1, 1, 2, 3]);
  expect(i3.forVersion(ids.nodes.publication, earlier)).toBe(back.forVersion(ids.nodes.publication, earlier));
  run(s, invertAction(made));
  const i4 = AnnotationIndex.build(s, i3);
  expect(i4.of(ids.nodes.publication).map((e) => e.anchor.page)).toEqual([1, 1, 2]);
  expect(i4.forVersion(ids.nodes.publication, chapter.hash)).toEqual(i1.forVersion(ids.nodes.publication, chapter.hash));
});
