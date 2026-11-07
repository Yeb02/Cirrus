import {
  type Anchor, ANCHOR_MAX_RECTS, ANCHOR_MAX_TEXT, ANNOTATION_TITLE_CHARS, type FileRef, type Id, type NodeRec, nodeRow, placedIn, planId, type State,
} from '@cirrus/core';
import type { PageViewport } from 'pdfjs-dist';
import { sameName } from './merge.ts';

/**
 * PDF annotations in the interface (plan 4c, D1 to D4): the index of the base's annotations, which the reader and the
 * lists read, and the geometry between a selection on the screen and an anchor in a page's coordinates. Without the
 * DOM but for the selection's walk (selectionToAnchor), and without pdf.js at run time: App builds the index in the
 * app's first chunk.
 */

/** A node dragged out of a list of annotations, onto the graph (D4: placed there by task 3). */
export const NODE_MIME = 'application/x-cirrus-node';

/** A rectangle of an anchor: [x0, y0, x1, y1] in the page's PDF coordinates (points, y up), x0 < x1 and y0 < y1. */
export type Rect = Anchor['rects'][number];
/** A rectangle of the screen (a DOMRect's sides), or of a viewport's coordinates. */
export interface DOMRectLike { left: number; top: number; right: number; bottom: number }
/** The page an element of the reader is on (from 1), and its viewport at its place in the window, at the zoom shown. */
export interface PageHit { page: number; viewport: PageViewport }

// The index (D4; Global Constraints, « Performance »).

/** An annotation as the lists show it. */
export interface AnnotationEntry {
  /** Its node, as it was at the build: its title, its anchor. */
  readonly node: NodeRec;
  readonly anchor: Anchor;
  /** The plans it is placed in, by name. */
  readonly plans: readonly { id: Id; name: string }[];
}

const NONE: readonly AnnotationEntry[] = Object.freeze([]);
const NO_PLANS: readonly { id: Id; name: string }[] = Object.freeze([]);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const versionKey = (pdf: Id, hash: string) => `${pdf}|${hash}`;

/** In the order of the pages; on a page, the passage starting higher first, then further left, then by identifier. */
function entryOrder(a: AnnotationEntry, b: AnnotationEntry): number {
  const p = a.anchor.rects[0], q = b.anchor.rects[0];
  return a.anchor.page - b.anchor.page || q[3] - p[3] || p[0] - q[0] || compare(a.node.id, b.node.id);
}

/** The plans node `id` is placed in, by name (then identifier). */
function plansOf(s: State, id: Id): readonly { id: Id; name: string }[] {
  const rows = placedIn(s, nodeRow(s, id));
  if (rows.length === 0) return NO_PLANS;
  const out: { id: Id; name: string }[] = [];
  for (const row of rows) {
    const plan = planId(s, row);
    out.push({ id: plan, name: s.plans.get(plan)?.name ?? '' });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'fr') || compare(a.id, b.id));
}

const samePlans = (a: readonly { id: Id; name: string }[], b: readonly { id: Id; name: string }[]) =>
  a.length === b.length && a.every((p, i) => p.id === b[i].id && p.name === b[i].name);
const sameList = (a: readonly AnnotationEntry[], b: readonly AnnotationEntry[]) => a.length === b.length && a.every((e, i) => e === b[i]);

function push<K, V>(m: Map<K, V[]>, k: K, v: V): void {
  const list = m.get(k);
  if (list) list.push(v);
  else m.set(k, [v]);
}

/**
 * The live annotations of the base (D4) — the nodes with an anchor, outside the trash — by PDF, then by version (the
 * anchor's hash, D2), each list in the order of the pages. Derived in the interface, like the LaTeX registry (plan
 * 4b): built again at each change of the state, from the last one (`previous`), only what changed is read again — an
 * annotation whose record and plans are those of before keeps its entry, a list whose entries are the same is the same
 * array, and an index where nothing changed is the last one itself (React then draws nothing again). What it gives is
 * what it read at its build: the state, changed in place since, is not read again.
 */
export class AnnotationIndex {
  private readonly entries = new Map<Id, AnnotationEntry>();
  private readonly byPdf = new Map<Id, readonly AnnotationEntry[]>();
  private readonly byVersion = new Map<string, readonly AnnotationEntry[]>();

  private constructor() {}

  static build(s: State, previous?: AnnotationIndex): AnnotationIndex {
    const r = new AnnotationIndex(), lists = new Map<Id, AnnotationEntry[]>();
    let changed = previous === undefined;
    for (const n of s.nodes.values()) {
      const anchor = n.anchor;
      if (anchor === undefined || n.trashedAt !== undefined) continue;
      const plans = plansOf(s, n.id), was = previous?.entries.get(n.id);
      // Records are replaced, never changed in place: the same record is the same annotation.
      const e = was !== undefined && was.node === n && samePlans(was.plans, plans) ? was : { node: n, anchor, plans };
      if (e !== was) changed = true;
      r.entries.set(n.id, e);
      push(lists, anchor.pdf, e);
    }
    if (!changed && previous !== undefined && previous.entries.size === r.entries.size) return previous;
    for (const [pdf, list] of lists) {
      list.sort(entryOrder);
      const before = previous?.byPdf.get(pdf);
      r.byPdf.set(pdf, before !== undefined && sameList(before, list) ? before : list);
      const versions = new Map<string, AnnotationEntry[]>();
      for (const e of list) push(versions, e.anchor.hash, e);
      for (const [hash, v] of versions) {
        const key = versionKey(pdf, hash), was = previous?.byVersion.get(key);
        r.byVersion.set(key, was !== undefined && sameList(was, v) ? was : v);
      }
    }
    return r;
  }

  /** The annotations of PDF node `pdf`, every version, in the order of the pages. */
  of(pdf: Id): readonly AnnotationEntry[] {
    return this.byPdf.get(pdf) ?? NONE;
  }

  /** Those made on the version `hash` of its files (D2): the ones a reader of that version draws. */
  forVersion(pdf: Id, hash: string): readonly AnnotationEntry[] {
    return this.byVersion.get(versionKey(pdf, hash)) ?? NONE;
  }
}

/**
 * The annotations of `entries` (a PDF node's) on one of its files: made on this version of it (its hash, whatever its
 * name now), or on another version under its name — an earlier one, re-imported since (D2). The same array when they
 * all are.
 */
export function ofFile(entries: readonly AnnotationEntry[], file: { name: string; hash: string }): readonly AnnotationEntry[] {
  const kept = entries.filter((e) => e.anchor.hash === file.hash || sameName(e.anchor.file, file.name));
  return kept.length === entries.length ? entries : kept;
}

/** Where an annotation opens: its PDF's file, `earlier` when that file holds another version since (D2); or why it cannot, in French. */
export type AnnotationSource = { file: FileRef; earlier: boolean } | { why: string };

/**
 * The file of its PDF's node an annotation opens in (D2, D4), as the state has it: the one holding its version, by its
 * hash whatever its name now; else the one under its file's name, which holds a later version (re-imported since: the
 * reader then shows the earlier one). What is missing otherwise (Review Focus 4): the PDF's node gone or in the trash,
 * the file no longer in it.
 */
export function annotationSource(s: State, a: Anchor): AnnotationSource {
  const pdf = s.nodes.get(a.pdf);
  if (!pdf) return { why: 'Le PDF de cette annotation n’existe plus.' };
  if (pdf.trashedAt !== undefined) return { why: `Le PDF « ${pdf.title} » est à la corbeille.` };
  const same = pdf.files.find((f) => f.hash === a.hash);
  if (same) return { file: same, earlier: false };
  const named = pdf.files.find((f) => sameName(f.name, a.file));
  return named ? { file: named, earlier: true } : { why: `« ${a.file} » n’est plus dans « ${pdf.title} ».` };
}

/** What the menu of an annotation's line does: open its node's pop-up, or delete it everywhere. */
export type AnnotationAction = 'node' | 'delete';

/**
 * The menu of an annotation's line (final review, I2: right click, in a reader's margin or a PDF's pop-up), as the
 * file's menu is (fileMenu): « Ouvrir sa fiche » — its node's pop-up, to rename it, write its summary, tag it —, not
 * in the modal full screen (`canOpenNode` false); then its deletion everywhere, « Supprimer partout » when it is in a
 * plan, which it leaves too (its line names it), « Supprimer » otherwise.
 */
export function annotationMenu(entry: AnnotationEntry, canOpenNode: boolean): { action: AnnotationAction; label: string }[] {
  return [
    ...(canOpenNode ? [{ action: 'node' as const, label: 'Ouvrir sa fiche' }] : []),
    { action: 'delete', label: entry.plans.length > 0 ? 'Supprimer partout' : 'Supprimer' },
  ];
}

// The geometry (D3; Review Focus 3).

/**
 * The rectangles of the screen in lines (D3: one per line): two are on one line when they overlap over half the height
 * of the lower one and are no further apart than a line's height — words and runs join, a superscript joins its line,
 * two columns stay apart. In the order the lines first appear; empty rectangles (a line break's) are left out.
 */
export function mergeLines(rects: Iterable<DOMRectLike>): DOMRectLike[] {
  const lines: DOMRectLike[] = [];
  for (const r of rects) {
    if (!(r.right > r.left && r.bottom > r.top)) continue;
    const h = r.bottom - r.top;
    const line = lines.find((l) => {
      const lh = l.bottom - l.top, overlap = Math.min(l.bottom, r.bottom) - Math.max(l.top, r.top);
      const gap = Math.max(l.left, r.left) - Math.min(l.right, r.right);
      return overlap >= Math.min(lh, h) / 2 && gap <= Math.max(lh, h);
    });
    if (!line) lines.push({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
    else {
      line.left = Math.min(line.left, r.left);
      line.top = Math.min(line.top, r.top);
      line.right = Math.max(line.right, r.right);
      line.bottom = Math.max(line.bottom, r.bottom);
    }
  }
  return lines;
}

/** A coordinate of an anchor, to a thousandth of a point (invisible at any zoom; the record stays short). */
const round = (v: number) => Math.round(v * 1000) / 1000;

/**
 * Rectangles of the screen, merged in lines (mergeLines), in the page's PDF coordinates (D1): `viewport` is the page's
 * at its place and zoom (pageOf), its rotation included — a rotation by a quarter turn keeps a rectangle a rectangle.
 */
export function pdfRects(rects: Iterable<DOMRectLike>, viewport: PageViewport): Rect[] {
  return mergeLines(rects).map((r): Rect => {
    const [ax, ay] = viewport.convertToPdfPoint(r.left, r.top) as number[], [bx, by] = viewport.convertToPdfPoint(r.right, r.bottom) as number[];
    return [round(Math.min(ax, bx)), round(Math.min(ay, by)), round(Math.max(ax, bx)), round(Math.max(ay, by))];
  });
}

/** An anchor's rectangles in `viewport`'s coordinates (a page's, at a zoom and a place): where its highlight is drawn. */
export function rectsOnScreen(anchor: Pick<Anchor, 'rects'>, viewport: PageViewport): DOMRectLike[] {
  return anchor.rects.map(([x0, y0, x1, y1]) => {
    const [ax, ay] = viewport.convertToViewportPoint(x0, y0) as number[], [bx, by] = viewport.convertToViewportPoint(x1, y1) as number[];
    return { left: Math.min(ax, bx), top: Math.min(ay, by), right: Math.max(ax, bx), bottom: Math.max(ay, by) };
  });
}

// The selection's walk: by the nodes' links only (no TreeWalker), so that a test can give a DOM in miniature.

const TEXT = 3, ELEMENT = 1;

/** The node after `n`'s subtree, in document order. */
function after(n: Node): Node | null {
  for (let x: Node | null = n; x !== null; x = x.parentNode) if (x.nextSibling !== null) return x.nextSibling;
  return null;
}
/** The first node at a range's boundary (container, offset), or after it. */
const boundary = (container: Node, offset: number): Node | null =>
  container.nodeType === TEXT ? container : container.childNodes[offset] ?? after(container);

/** What a range covers in document order: each text's part, and each line break (pdf.js ends a line with a <br>). */
function* covered(r: Range): Generator<{ text: Text; from: number; to: number } | { br: Element }> {
  const stop = r.endContainer.nodeType === TEXT ? null : boundary(r.endContainer, r.endOffset);
  for (let n = boundary(r.startContainer, r.startOffset); n !== null && n !== stop; n = n.firstChild ?? after(n)) {
    if (n.nodeType === TEXT) {
      const t = n as Text, from = t === r.startContainer ? r.startOffset : 0, to = t === r.endContainer ? r.endOffset : t.length;
      if (to > from) yield { text: t, from, to };
      if (t === r.endContainer) return;
    } else if (n.nodeType === ELEMENT && (n as Element).tagName === 'BR') yield { br: n as Element };
  }
}

/**
 * The anchor of the passage selected in a reader (D3), or null when nothing is: a selection that is empty or only
 * blanks, or outside the pages. Its page is the first one it covers; it is cut at the end of that page (« une
 * annotation, une page »). Its text: the selected parts of the pages' text, a line break at each end of line, blanks
 * trimmed at both ends. Its rectangles: those of each text part on the screen (not the elements' boxes, a page's end
 * of content among them), merged in lines and brought into the page's coordinates by its viewport (pdfRects).
 * `pageOf`: the page of an element of the reader, at its place in the window; `pdf`, `file`: the PDF's node and the
 * version shown. Bounds (anchorRefusal) are the caller's.
 */
export function selectionToAnchor(
  selection: Selection, pageOf: (el: Element) => PageHit | null, pdf: Id, file: { name: string; hash: string },
): Anchor | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0), part = range.cloneRange(), rects: DOMRectLike[] = [];
  let first: PageHit | null = null, text = '';
  for (const c of covered(range)) {
    const hit = pageOf('br' in c ? c.br : (c.text.parentNode as Element));
    if (first === null) {
      // Before the passage: a line break, or text outside the pages.
      if (hit === null || 'br' in c) continue;
      first = hit;
    } else if (hit === null || hit.page !== first.page) break;
    if ('br' in c) { text += '\n'; continue; }
    const s = c.text.data.slice(c.from, c.to);
    text += s;
    if (s.trim() === '') continue;
    part.setStart(c.text, c.from);
    part.setEnd(c.text, c.to);
    for (const r of Array.from(part.getClientRects())) rects.push(r);
  }
  const passage = text.trim();
  if (first === null || passage === '') return null;
  const out = pdfRects(rects, first.viewport);
  return out.length === 0 ? null : { pdf, file: file.name, hash: file.hash, page: first.page, rects: out, text: passage };
}

/**
 * Why a passage cannot be annotated, in French, or null: more text or more lines than an anchor holds (validAnchor's
 * bounds, in UTF-16 units as it counts them). Refused rather than cut: the user chooses a shorter passage.
 */
export function anchorRefusal(a: Anchor): string | null {
  const fr = (n: number) => n.toLocaleString('fr-FR');
  if (a.text.length > ANCHOR_MAX_TEXT) return `Ce passage est trop long pour être annoté : ${fr(a.text.length)} caractères, au plus ${fr(ANCHOR_MAX_TEXT)}.`;
  if (a.rects.length > ANCHOR_MAX_RECTS) return `Ce passage est trop long pour être annoté : ${fr(a.rects.length)} lignes, au plus ${fr(ANCHOR_MAX_RECTS)}.`;
  return null;
}

/** The setting annotationTitleChars as annotationTitle takes it: a whole number of characters, at least one. */
export function titleChars(n: number): number {
  return Number.isFinite(n) ? Math.max(1, Math.round(n)) : ANNOTATION_TITLE_CHARS;
}
