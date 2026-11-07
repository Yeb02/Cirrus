import {
  type Action, type BibEntry, type BibFields, bibFields, bibFileName, bibIdentifiers, bibShort, bibtexEntry, CITE_KEY_TAG, CiteKeys, citeKey, cleanArxiv, cleanDoi,
  CommandError, familyName, type FileRef, type NodeRec, normalizedTitle, parseBibtex, safeCiteKey, type State, type TagValue, type Vec2, yearIn,
} from '@cirrus/core';
import type { PlanScene, RenderParams, SceneIndex } from '@cirrus/view';
import { cslToFields } from '../../main/publications/csl.ts';
import type { PublicationResult } from '../../main/publications/fetch.ts';
import { parseIdentifier, type PublicationId } from '../../main/publications/identifier.ts';
import { newNodeBuild } from '../actions.ts';
import { messageOf, type Result } from '../session.ts';

/**
 * A publication's node (plan 4c, D7), from an import: by its identifier (the main process's answer, publicationFetch),
 * from a PDF dropped without one (D8), from a .bib's entry (task 6). Its title, a tag `auteur` per author (« Prénom
 * Nom »), `date_de_publication`, `clé_bibtex`, `doi` or `arxiv`; its folder holds its PDF and its entry, « <key>.bib »
 * (bibFileName). A publication already in the base is not made again: by its DOI, its arXiv identifier, its entry's
 * key, or its title and year unless their first authors differ (the controller's ruling; final review, R2), the
 * notification naming the node there.
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

/** A publication's identifiers, as compared: its DOIs and its arXiv identifiers (without version), in lower case. */
interface Ids { dois: string[]; arxivs: string[] }
/**
 * What makes a duplicate (D7 and the controller's rulings): its identifiers, its keys as written, its title normalised
 * with its year; `author`, its first author's family name (familyName), which may contradict a match by title and year.
 */
interface Marks extends Ids { keys: string[]; titleYear: string | null; author: string | null }
function titleYear(title: string, year: string | null): string | null {
  if (year === null) return null;
  const t = normalizedTitle(title);
  return t === '' ? null : `${t}|${year}`;
}

/**
 * The identifier a tag's value or an import gives, read as parseIdentifier reads what the user types — a link to a
 * DOI's resolver or to an arXiv page included, arXiv's own DOI being its arXiv identifier —, else as a .bib writes it;
 * a DOI without the punctuation that ends a sentence (cleanDoi: a DOI that differs is a veto, re-review N2).
 */
function readId(v: string): PublicationId | null {
  let id = parseIdentifier(v);
  if (id === null) {
    const doi = cleanDoi(v), arxiv = doi === null ? cleanArxiv(v) : null;
    id = doi !== null ? { doi } : arxiv !== null ? { arxiv } : null;
  }
  if (id === null || !('doi' in id)) return id;
  const doi = cleanDoi(id.doi) ?? id.doi;
  return parseIdentifier(`doi:${doi}`) ?? { doi };
}
/** `v`'s identifier added to `ids`, as compared, whichever tag holds it (review M3). */
function addId(ids: Ids, v: string): void {
  const id = readId(v);
  if (id === null) return;
  const [list, value] = 'doi' in id ? [ids.dois, id.doi] : [ids.arxivs, cleanArxiv(id.arxiv) ?? id.arxiv];
  if (!list.includes(value.toLowerCase())) list.push(value.toLowerCase());
}

/**
 * A node's marks, from its tags: every value of `doi` and `arxiv` (review M3), every `clé_bibtex`; its first tag
 * `auteur`, « Prénom Nom », for its family name, read only when a year makes a title-and-year mark.
 */
function marksOf(n: NodeRec): Marks {
  const m: Marks = { dois: [], arxivs: [], keys: [], titleYear: null, author: null };
  let year: string | null = null, first: string | null = null;
  for (const t of n.tags) {
    if (t.value === undefined) continue;
    const v = String(t.value);
    if (t.key === DOI_TAG || t.key === ARXIV_TAG) addId(m, v);
    else if (t.key === CITE_KEY_TAG && v.trim() !== '') m.keys.push(v.trim());
    else if (t.key === DATE_TAG && year === null) year = yearIn(v);
    else if (t.key === AUTHOR_TAG && first === null) first = v;
  }
  m.titleYear = titleYear(n.title, year);
  if (m.titleYear !== null && first !== null) m.author = familyName(first);
  return m;
}

/**
 * An import's marks: its identifiers, its entry's own key (the file's or the server's, whether it is kept or not; one
 * made by citeKey is only taken, never a mark: the controller's ruling of task 6), its title and year, its first
 * author's family name — read from its « Prénom Nom », as its node's first tag `auteur` will hold it.
 */
function marksOfInput(p: PublicationInput, key: string | null): Marks {
  const at = titleYear(p.fields.title, p.fields.year), first = p.fields.authors[0];
  const m: Marks = { dois: [], arxivs: [], keys: key === null ? [] : [key], titleYear: at, author: at !== null && first !== undefined ? familyName(first) : null };
  if (p.doi !== undefined) addId(m, p.doi);
  if (p.arxiv !== undefined) addId(m, p.arxiv);
  return m;
}

const shown = (title: string) => (title === '' ? 'Sans titre' : title);
/**
 * A publication there, or an entry of the same file above (task 6): its title, its line in the file if it is one, and
 * its identifiers, which may contradict a match by key or by title and year; its first author's family name, which may
 * contradict a match by title and year (final review, R2).
 */
interface Holder extends Ids { title: string; line?: number; author: string | null }
/** Why an import is a duplicate, the publication there named (its title cut, bibShort: it may come from a file). */
const already = (why: string, h: Holder) => (h.line === undefined
  ? `Déjà dans la base (${why}) : « ${bibShort(h.title)} ».`
  : `Déjà plus haut dans le fichier, ligne ${h.line} (${why}) : « ${bibShort(h.title)} ».`);

/**
 * The publications of a base, by what makes a duplicate (D7), built once from the state: the nodes outside the trash.
 * `keys`: every `clé_bibtex`, the trash's too, which a key made for a new node avoids (citeKey). Task 6 adds the entries
 * of a .bib to it as they are planned (`add`), so that one file's duplicates are found too, named by their line.
 */
export class PublicationIndex {
  private readonly doi = new Map<string, Holder>();
  private readonly arxiv = new Map<string, Holder>();
  private readonly key = new Map<string, Holder[]>();
  private readonly titleYear = new Map<string, Holder[]>();
  readonly keys = new CiteKeys();

  static of(s: State): PublicationIndex {
    const index = new PublicationIndex();
    for (const n of s.nodes.values()) {
      for (const t of n.tags) if (t.key === CITE_KEY_TAG && t.value !== undefined && String(t.value).trim() !== '') index.keys.add(String(t.value).trim());
      if (n.trashedAt === undefined) index.mark(marksOf(n), shown(n.title));
    }
    return index;
  }

  private mark(m: Marks, title: string, line?: number): void {
    const holder: Holder = { title, dois: m.dois, arxivs: m.arxivs, author: m.author, ...(line !== undefined ? { line } : {}) };
    for (const d of m.dois) if (!this.doi.has(d)) this.doi.set(d, holder);
    for (const a of m.arxivs) if (!this.arxiv.has(a)) this.arxiv.set(a, holder);
    const hold = (map: Map<string, Holder[]>, v: string) => {
      const list = map.get(v);
      if (list) list.push(holder);
      else map.set(v, [holder]);
    };
    // Keys without case, as BibTeX compares them (review of task 6, M1).
    for (const k of m.keys) hold(this.key, k.toLowerCase());
    if (m.titleYear !== null) hold(this.titleYear, m.titleYear);
  }

  /**
   * Why these marks are a publication already there, in French, naming it; null when they are none's. The same DOI or
   * arXiv identifier, then the same key (without case, review of task 6, M1), then the same title and year; but a key,
   * or a title and year, is another publication's when the identifiers contradict it — both sides have a DOI and they
   * differ, or both an arXiv identifier and they differ (the controller's ruling of the review, I2, M2). A DOI and an
   * arXiv identifier do not. A title and year is another publication's too when both sides have a first author and
   * their family names differ (final review, R2: two chapters « Introduction » of 2020, of Smith and of Doe).
   */
  duplicate(m: Marks): string | null {
    for (const d of m.dois) {
      const h = this.doi.get(d);
      if (h !== undefined) return already('même DOI', h);
    }
    for (const a of m.arxivs) {
      const h = this.arxiv.get(a);
      if (h !== undefined) return already('même identifiant arXiv', h);
    }
    const differ = (mine: string[], theirs: string[]) => mine.length > 0 && theirs.length > 0 && !theirs.some((x) => mine.includes(x));
    const agrees = (h: Holder) => !differ(m.dois, h.dois) && !differ(m.arxivs, h.arxivs);
    for (const k of m.keys) {
      const h = this.key.get(k.toLowerCase())?.find(agrees);
      if (h) return already('même clé BibTeX', h);
    }
    const sameWork = (h: Holder) => agrees(h) && (m.author === null || h.author === null || m.author === h.author);
    const h = m.titleYear === null ? undefined : this.titleYear.get(m.titleYear)?.find(sameWork);
    return h ? already('même titre et même année', h) : null;
  }

  /**
   * A publication planned from the entry of `line` of a .bib (task 6): the next entries of the same file see it, by
   * its marks — its own key, never the one made (the controller's ruling) —, and its key, made or not, is taken.
   */
  add(plan: PlannedPublication, line: number): void {
    this.mark(plan.marks, shown(plan.title), line);
    if (plan.key !== null) this.keys.add(plan.key);
  }
}

/**
 * A publication ready to be made: its node's title and tags, its key and its .bib, what makes it a duplicate (`marks`:
 * its entry's own key, not the one made for it).
 */
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
 * safeCiteKey takes it — BibTeX and LaTeX read it, DBLP's kept (final review, R1) — and no node holds it (one holding
 * it with a contradicting identifier is no duplicate, and the key is then made: He_2016 taken gives he2016), otherwise
 * its first author and year (citeKey); its .bib is written under that key, in a file named by bibFileName
 * (DBLP_conf_nips_….bib); at most `maxAuthors` tags `auteur` (publicationMaxAuthors), the .bib keeping them all; a node
 * without a title takes its key. An import without an entry (a PDF without identifier, D8) has no key nor .bib.
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
    bib: key !== null && p.entry !== null ? { name: bibFileName(key), text: bibtexEntry(p.entry, key) } : null,
    marks: marksOfInput(p, own),
  };
}

/**
 * The import as one action (one Ctrl+Z): the node of `plan` put down at `at` with `files` (already in the store), at the
 * step readable at this zoom, entering the group whose envelope receives it (newNodeBuild). Refused when it is computed
 * if the publication is in the base by then (another import meanwhile), the node there named — by its marks, so its
 * entry's own key, never the one made for it (the controller's ruling of task 6).
 */
export function publicationBuild(
  plan: PlannedPublication, files: FileRef[], scene: PlanScene, at: Vec2, zoom: number, p: RenderParams, index?: SceneIndex,
): (s: State) => Action {
  const make = newNodeBuild(scene, { title: plan.title, tags: plan.tags, files }, at, zoom, p, `Importer « ${plan.title} »`, index);
  return (st) => {
    const now = PublicationIndex.of(st), refused = now.duplicate(plan.marks);
    if (refused) throw new CommandError(refused);
    // Its key taken meanwhile (without case), by a node of another identity: refused, as a .bib's import is — its .bib,
    // already stored under that key, cannot take another one here (review of task 6, M7).
    if (plan.key !== null && now.keys.has(plan.key)) throw new CommandError(`La clé « ${plan.key} » a été prise entre-temps. Rien n’est importé : recommence l’import.`);
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

/** The marks of an identifier typed, before the network: the identifier alone. */
function marksOfId(id: PublicationId): Marks {
  const m: Marks = { dois: [], arxivs: [], keys: [], titleYear: null, author: null };
  addId(m, 'doi' in id ? `doi:${id.doi}` : `arXiv:${id.arxiv}`);
  return m;
}

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
 * the cause to `log` — the store's own reason said after ours (review of task 6, M6).
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
      // The store's reason, in French as the main process says it (review of task 6, M6).
      return deps.open() ? { kind: 'failed', message: `Le fichier .bib de la publication n’a pas pu être enregistré dans la base : ${messageOf(e)}` } : { kind: 'dropped' };
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
