import {
  type Action, type BibEntry, type BibFields, bibFields, bibIdentifiers, bibtexEntry, CITE_KEY_TAG, citeKey, cleanArxiv, cleanDoi, CommandError, type FileRef,
  type NodeRec, normalizedTitle, parseBibtex, safeCiteKey, type State, type TagValue, type Vec2, yearIn,
} from '@cirrus/core';
import type { PlanScene, RenderParams, SceneIndex } from '@cirrus/view';
import { cslToFields } from '../../main/publications/csl.ts';
import type { PublicationResult } from '../../main/publications/fetch.ts';
import { parseIdentifier, type PublicationId } from '../../main/publications/identifier.ts';
import { newNodeBuild } from '../actions.ts';
import type { Result } from '../session.ts';

/**
 * A publication's node (plan 4c, D7), from an import: by its identifier (the main process's answer, publicationFetch),
 * from a PDF dropped without one (D8), from a .bib's entry (task 6). Its title, a tag `auteur` per author (« Prénom
 * Nom »), `date_de_publication`, `clé_bibtex`, `doi` or `arxiv`; its folder holds its PDF and its entry, « <key>.bib ».
 * A publication already in the base is not made again: by its DOI, its arXiv identifier, its entry's key, or its title
 * and year (the controller's ruling), the notification naming the node there.
 */

export const AUTHOR_TAG = 'auteur';
export const DATE_TAG = 'date_de_publication';
export const DOI_TAG = 'doi';
export const ARXIV_TAG = 'arxiv';

/** What an import brings: the node's fields, its BibTeX entry if any, its identifiers (as given), its PDF if any. */
export interface PublicationInput {
  fields: BibFields;
  entry: BibEntry | null;
  doi?: string;
  /** Without its version: the article, whichever version its PDF is. */
  arxiv?: string;
  pdf?: FileRef;
}

/** What makes a duplicate, compared: DOIs and arXiv identifiers without case, keys as written, titles normalised. */
interface Marks { doi: string | null; arxiv: string | null; key: string | null; titleYear: string | null }
function titleYear(title: string, year: string | null): string | null {
  if (year === null) return null;
  const t = normalizedTitle(title);
  return t === '' ? null : `${t}|${year}`;
}

/** A node's marks, from its tags: a `doi` that is arXiv's own counts as its arXiv identifier. */
function marksOf(n: NodeRec): Marks {
  let doi: string | null = null, arxiv: string | null = null, key: string | null = null, year: string | null = null;
  for (const t of n.tags) {
    if (t.value === undefined) continue;
    const v = String(t.value);
    if (t.key === DOI_TAG) {
      const d = cleanDoi(v);
      const own = d === null ? null : /^10\.48550\/arxiv\.(.+)$/i.exec(d);
      if (own) arxiv ??= cleanArxiv(own[1]);
      else doi ??= d;
    } else if (t.key === ARXIV_TAG) arxiv ??= cleanArxiv(v);
    else if (t.key === CITE_KEY_TAG && key === null) key = v.trim() || null;
    else if (t.key === DATE_TAG && year === null) year = yearIn(v);
  }
  return { doi: doi?.toLowerCase() ?? null, arxiv: arxiv?.toLowerCase() ?? null, key, titleYear: titleYear(n.title, year) };
}

/** An import's marks: its identifiers, its entry's own key when it is kept (safeCiteKey), its title and year. */
function marksOfInput(p: PublicationInput, key: string | null): Marks {
  return {
    doi: p.doi === undefined ? null : (cleanDoi(p.doi) ?? p.doi).toLowerCase(),
    arxiv: p.arxiv === undefined ? null : (cleanArxiv(p.arxiv) ?? p.arxiv).toLowerCase(),
    key,
    titleYear: titleYear(p.fields.title, p.fields.year),
  };
}

const REASONS: Record<keyof Marks, string> = { doi: 'même DOI', arxiv: 'même identifiant arXiv', key: 'même clé BibTeX', titleYear: 'même titre et même année' };
const shown = (title: string) => (title === '' ? 'Sans titre' : title);

/**
 * The publications of a base, by what makes a duplicate (D7), built once from the state: the nodes outside the trash.
 * `keys`: every `clé_bibtex`, the trash's too, which a key made for a new node avoids (citeKey). Task 6 adds the entries
 * of a .bib to it as they are planned (`add`), so that one file's duplicates are found too.
 */
export class PublicationIndex {
  private readonly by: Record<keyof Marks, Map<string, string>> = { doi: new Map(), arxiv: new Map(), key: new Map(), titleYear: new Map() };
  readonly keys = new Set<string>();

  static of(s: State): PublicationIndex {
    const index = new PublicationIndex();
    for (const n of s.nodes.values()) {
      for (const t of n.tags) if (t.key === CITE_KEY_TAG && t.value !== undefined && String(t.value).trim() !== '') index.keys.add(String(t.value).trim());
      if (n.trashedAt === undefined) index.mark(marksOf(n), shown(n.title));
    }
    return index;
  }

  private mark(m: Marks, title: string): void {
    for (const k of Object.keys(this.by) as (keyof Marks)[]) if (m[k] !== null && !this.by[k].has(m[k]!)) this.by[k].set(m[k]!, title);
  }

  /** Why these marks are a publication already there, in French, naming it; null when they are none's. */
  duplicate(m: Marks): string | null {
    for (const k of Object.keys(this.by) as (keyof Marks)[]) {
      const title = m[k] === null ? undefined : this.by[k].get(m[k]!);
      if (title !== undefined) return `Déjà dans la base (${REASONS[k]}) : « ${title} ».`;
    }
    return null;
  }

  /** A publication planned (task 6: the next entries of the same file see it). */
  add(plan: PlannedPublication): void {
    this.mark(plan.marks, shown(plan.title));
    if (plan.key !== null) this.keys.add(plan.key);
  }
}

/** A publication ready to be made: its node's title and tags, its key and its .bib, what makes it a duplicate. */
export interface PlannedPublication {
  title: string;
  tags: TagValue[];
  key: string | null;
  /** Its entry as a file of its own, « <key>.bib », written by storeText before the action. */
  bib: { name: string; text: string } | null;
  marks: Marks;
}

/**
 * The plan of an import (D7), or why it is refused (a duplicate, the node there named): the key is the entry's if
 * safeCiteKey takes it and no node holds it, otherwise its first author and year (citeKey); at most `maxAuthors` tags
 * `auteur` (publicationMaxAuthors), the .bib keeping them all; a node without a title takes its key. An import without
 * an entry (a PDF without identifier, D8) has no key nor .bib.
 */
export function planPublication(index: PublicationIndex, p: PublicationInput, maxAuthors: number): PlannedPublication | { refused: string } {
  const own = p.entry !== null && p.entry.key !== '' && safeCiteKey(p.entry.key) ? p.entry.key : null;
  const refused = index.duplicate(marksOfInput(p, own));
  if (refused) return { refused };
  const key = p.entry === null ? null : citeKey(p.entry, index.keys);
  const tags: TagValue[] = p.fields.authors.slice(0, Math.max(0, maxAuthors)).map((a) => ({ key: AUTHOR_TAG, value: a }));
  if (p.fields.year !== null) tags.push({ key: DATE_TAG, value: p.fields.year });
  if (key !== null) tags.push({ key: CITE_KEY_TAG, value: key });
  if (p.doi !== undefined) tags.push({ key: DOI_TAG, value: p.doi });
  if (p.arxiv !== undefined) tags.push({ key: ARXIV_TAG, value: p.arxiv });
  return {
    title: p.fields.title.trim() || key || 'Sans titre',
    tags,
    key,
    bib: key !== null && p.entry !== null ? { name: `${key}.bib`, text: bibtexEntry(p.entry, key) } : null,
    marks: marksOfInput(p, key),
  };
}

/**
 * The import as one action (one Ctrl+Z): the node of `plan` put down at `at` with `files` (already in the store), at the
 * step readable at this zoom, entering the group whose envelope receives it (newNodeBuild). Refused when it is computed
 * if the publication is in the base by then (another import meanwhile), the node there named.
 */
export function publicationBuild(
  plan: PlannedPublication, files: FileRef[], scene: PlanScene, at: Vec2, zoom: number, p: RenderParams, index?: SceneIndex,
): (s: State) => Action {
  const make = newNodeBuild(scene, { title: plan.title, tags: plan.tags, files }, at, zoom, p, `Importer « ${plan.title} »`, index);
  return (st) => {
    const refused = PublicationIndex.of(st).duplicate(plan.marks);
    if (refused) throw new CommandError(refused);
    return make(st);
  };
}

/** The import's input from the main process's answer: the CSL's fields (read only by cslToFields), the BibTeX's first entry. */
export function publicationOf(r: Extract<PublicationResult, { ok: true }>, dropped: FileRef | null): PublicationInput | { failed: string } {
  const csl = cslToFields(r.csl);
  if (csl === null) return { failed: 'Réponse inattendue du serveur de DOI.' };
  const entry = typeof r.bibtex === 'string' ? parseBibtex(r.bibtex).entries[0] : undefined;
  if (entry === undefined) return { failed: 'Le BibTeX reçu est illisible : la publication n’est pas importée.' };
  const bib = bibFields(entry), ids = bibIdentifiers(entry);
  const own = 'doi' in r.id ? { doi: r.id.doi } : { arxiv: cleanArxiv(r.id.arxiv) ?? r.id.arxiv };
  const pdf = dropped ?? r.pdf;
  return {
    fields: { title: csl.title || bib.title, authors: csl.authors.length > 0 ? csl.authors : bib.authors, year: csl.year ?? bib.year },
    entry, ...ids, ...own, ...(pdf ? { pdf } : {}),
  };
}

/** What the import dialog needs (PublicationDialog, GraphView): the IPC, the state, the node put down. */
export interface ImportDeps {
  state(): State;
  /** publicationFetch: `pdf` false when a PDF was dropped, which the node keeps (D8: arXiv's is not downloaded again). */
  fetch(text: string, options: { pdf: boolean }): Promise<PublicationResult>;
  storeText(name: string, text: string): Promise<FileRef>;
  /** The node of `plan` put down where the dialog was opened, through the session (publicationBuild): its result. */
  put(plan: PlannedPublication, files: FileRef[]): Promise<Result>;
  /** publicationMaxAuthors. */
  maxAuthors(): number;
  /** Whether the dialog is still open: a closed one drops what comes back (the controller's ruling). */
  open(): boolean;
  /** Where the causes the user is not shown go (the console). */
  log?(what: string, e: unknown): void;
}

/**
 * What came of an import: `done` (the dialog closes; `notice`, what to notify besides); `failed` (said in the dialog,
 * which stays open: the user may correct the identifier); `notified` (a notification, the dialog closes: a duplicate,
 * an action refused); `dropped` (the dialog was closed meanwhile: nothing is said).
 */
export type ImportOutcome =
  | { kind: 'done'; title: string; notice: string | null }
  | { kind: 'failed'; message: string }
  | { kind: 'notified'; message: string }
  | { kind: 'dropped' };

const marksOfId = (id: PublicationId): Marks => ({
  doi: 'doi' in id ? id.doi.toLowerCase() : null, arxiv: 'arxiv' in id ? (cleanArxiv(id.arxiv) ?? id.arxiv).toLowerCase() : null, key: null, titleYear: null,
});

/** The node put down, its result said as an outcome. */
async function putDown(plan: PlannedPublication, files: FileRef[], deps: ImportDeps, notice: string | null): Promise<ImportOutcome> {
  const r = await deps.put(plan, files);
  return r.ok ? { kind: 'done', title: plan.title, notice } : { kind: 'notified', message: r.message };
}

/**
 * An import by identifier (D5, D7), the user having pressed « Importer »: `text` read by parseIdentifier (else refused
 * without the network); a publication already there by that DOI or arXiv identifier, refused before the network too;
 * then the main process asked (the only step that reaches it), its answer read, the duplicates looked for again (key,
 * title and year), the .bib stored, and the node put down, `dropped` among its files (arXiv's PDF then not asked for).
 * The dialog closed at any step, what comes back is dropped. Every failure is said in French: the main process's own
 * messages, or, for a rejection of the IPC (an answer Electron could not clone) or of the store, a message of ours,
 * the cause to `log`.
 */
export async function importByIdentifier(text: string, dropped: FileRef | null, deps: ImportDeps): Promise<ImportOutcome> {
  const id = parseIdentifier(text);
  if (id === null) return { kind: 'failed', message: 'Identifiant non reconnu.' };
  const known = PublicationIndex.of(deps.state()).duplicate(marksOfId(id));
  if (known) return { kind: 'notified', message: known };
  let r: PublicationResult;
  try {
    r = await deps.fetch(text, { pdf: dropped === null });
  } catch (e) {
    deps.log?.('Import de la publication :', e);
    return deps.open() ? { kind: 'failed', message: 'L’import de la publication a échoué : le processus principal n’a pas répondu.' } : { kind: 'dropped' };
  }
  if (!deps.open()) return { kind: 'dropped' };
  if (!r.ok) return { kind: 'failed', message: r.message };
  const input = publicationOf(r, dropped);
  if ('failed' in input) return { kind: 'failed', message: input.failed };
  const plan = planPublication(PublicationIndex.of(deps.state()), input, deps.maxAuthors());
  if ('refused' in plan) return { kind: 'notified', message: plan.refused };
  let bib: FileRef | null = null;
  if (plan.bib) {
    try {
      bib = await deps.storeText(plan.bib.name, plan.bib.text);
    } catch (e) {
      deps.log?.(`Enregistrement de « ${plan.bib.name} » :`, e);
      return deps.open() ? { kind: 'failed', message: 'Le fichier .bib de la publication n’a pas pu être enregistré dans la base.' } : { kind: 'dropped' };
    }
    if (!deps.open()) return { kind: 'dropped' };
  }
  const files = [...(input.pdf ? [input.pdf] : []), ...(bib ? [bib] : [])];
  const notice = dropped === null && r.pdfMessage ? `Publication importée sans son PDF : ${r.pdfMessage}` : null;
  return putDown(plan, files, deps, notice);
}

/**
 * A PDF dropped without an identifier (D8): a node of `title` (its metadata's, or its file's name), the PDF attached,
 * without the network; the user completes it.
 */
export async function createFromPdf(pdf: FileRef, title: string, deps: ImportDeps): Promise<ImportOutcome> {
  const plan = planPublication(PublicationIndex.of(deps.state()), { fields: { title: title.trim(), authors: [], year: null }, entry: null, pdf }, deps.maxAuthors());
  if ('refused' in plan) return { kind: 'notified', message: plan.refused };
  return putDown(plan, [pdf], deps, null);
}
