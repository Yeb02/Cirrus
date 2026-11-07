import {
  type BibProblem, bibFields, bibIdentifiers, bibShort, combine, CommandError, createNode, type FileRef, type Id, include, parseBibtex, repeatedKeyMessage,
  safeCiteKey, type State, type Vec2,
} from '@cirrus/core';
import { bibBlock, type PlanScene, type RenderParams, type SceneIndex } from '@cirrus/view';
import { type Build, groupAt, readableStep } from '../actions.ts';
import { decodeText } from '../files/decode.ts';
import { messageOf } from '../session.ts';
import { type PlannedPublication, planPublication, PublicationIndex, type PublicationInput } from './build.ts';

/**
 * A whole .bib imported (plan 4c, D9, task 6): dropped on the graph's background, or chosen by « Importer un fichier
 * .bib… » — the main process reads it, within BIB_MAX_BYTES —, decoded as the previews decode a text, read by
 * parseBibtex (BIB_MAX_CHARS), its entries planned as publications (D7) against the base and against the entries above
 * them in the file, without the network. They follow the cursor as a compact block (bibBlock), their .bib stored
 * meanwhile, and a click puts them all down in one action, « Importer <n> publications »; the notification says what
 * was put down, the duplicates set aside (the node there named) and the problems, by their line.
 */

const fr = (n: number) => n.toLocaleString('fr-FR');
const plural = (n: number, one: string, many: string) => `${fr(n)} ${n === 1 ? one : many}`;

/** A .bib's bytes as text (decodeText: UTF-8, UTF-16 with its BOM, else Windows-1252), or why not, in French. */
export function bibText(f: { name: string; bytes: Uint8Array }): { text: string } | { refused: string } {
  const d = decodeText(f.bytes);
  return 'binary' in d ? { refused: `« ${bibShort(f.name)} » n’est pas un fichier texte : rien n’est importé.` } : { text: d.text };
}

/**
 * A .bib planned (D9): the publications to make, in the file's order, each with its entry's line; the entries set
 * aside as duplicates (`why`: the publication there named, in the base or above in the file); the parser's problems,
 * `omitted` those it does not list, `stopped` why it stopped short (parseBibtex).
 */
export interface PlannedBib {
  name: string;
  items: { plan: PlannedPublication; line: number }[];
  duplicates: { line: number; title: string; why: string }[];
  problems: BibProblem[];
  omitted: number;
  stopped: BibProblem | null;
}

/**
 * The publications of `text` (D7, D9), planned one after the other against the base `s` and the file's entries above:
 * each one planned is added to the index (PublicationIndex.add), so that one file's duplicates follow the base's rule —
 * by its own key, without case, never the one made for it; two entries of unsafe keys (addresses) are compared by their
 * identifiers, title and year — their first authors aside — only (the controller's ruling; final review, R2). Every own
 * safe key of the file, DBLP's included (final review, R1), is reserved first, taken by no key made, never a mark: an
 * entry keeps its own, and a \cite of it already written still means it (the controller's ruling of the review, M3).
 * An entry set aside as a duplicate whose key repeats one above is said once,
 * as the duplicate (review M2). At most `maxAuthors` tags `auteur` each (publicationMaxAuthors).
 */
export function planBib(s: State, name: string, text: string, maxAuthors: number): PlannedBib {
  const read = parseBibtex(text), index = PublicationIndex.of(s);
  for (const e of read.entries) if (e.key !== '' && safeCiteKey(e.key)) index.keys.reserve(e.key);
  const out: PlannedBib = { name, items: [], duplicates: [], problems: read.problems, omitted: read.omitted, stopped: read.stopped };
  /** The parser's problems of a repeated key, of the entries set aside as duplicates: said once, as the duplicate. */
  const twice = new Set<string>();
  for (const e of read.entries) {
    const input: PublicationInput = { fields: bibFields(e), entry: e, ...bibIdentifiers(e) };
    const plan = planPublication(index, input, maxAuthors);
    if ('refused' in plan) {
      out.duplicates.push({ line: e.line, title: input.fields.title || e.key || 'Sans titre', why: plan.refused });
      if (e.repeats !== undefined) twice.add(`${e.line}|${repeatedKeyMessage(e)}`);
      continue;
    }
    out.items.push({ plan, line: e.line });
    index.add(plan, e.line);
  }
  if (twice.size > 0) {
    // Those the parser did not list were counted: one fewer each, and its line that counts them gone with the last.
    const counted = read.omitted > 0 ? read.problems[read.problems.length - 1 - (read.stopped ? 1 : 0)] : null;
    const kept = out.problems.filter((p) => !twice.delete(`${p.line}|${p.message}`));
    out.omitted = Math.max(0, out.omitted - twice.size);
    out.problems = out.omitted === 0 && counted !== null ? kept.filter((p) => p !== counted) : kept;
  }
  return out;
}

/** What the notification says when the entries' .bib could not be stored: the store's reason too (review M6). */
export function bibStoreFailure(err: unknown): string {
  const why = messageOf(err).replace(/[.\s]+$/, '');
  return `Les fichiers .bib des publications n’ont pas pu être enregistrés dans la base : ${why}. Rien n’est importé.`;
}

/**
 * What the notification of an import says (D9, the controller's ruling): the publications put down (`placed`), or why
 * none was; why the reading stopped short, if it did; the duplicates set aside, each with the publication there; the
 * problems, by their line. Each list names `lines` at most (bibNoticeLines), then counts the others: legible with 2 000
 * duplicates or 200 problems. Every name taken from the file is cut (bibShort).
 */
export function bibNotice(b: PlannedBib, placed: number, lines: number): string {
  const name = bibShort(b.name), out: string[] = [];
  const found = b.items.length + b.duplicates.length;
  // The problems the parser lists, without the one that counts the others nor the stop.
  const listed = b.problems.slice(0, b.problems.length - (b.omitted > 0 ? 1 : 0) - (b.stopped ? 1 : 0));
  const problems = listed.length + b.omitted;
  if (placed > 0) out.push(`${plural(placed, 'publication importée', 'publications importées')} de « ${name} ».`);
  else if (found > 0) out.push(`Aucune publication importée de « ${name} » : aucune entrée nouvelle.`);
  else if (problems > 0 || b.stopped) out.push(`Aucune publication importée de « ${name} » : il ne contient aucune entrée lisible.`);
  else return `« ${name} » ne contient aucune entrée BibTeX : rien n’est importé.`;
  if (b.stopped) out.push(b.stopped.message);
  const list = (shown: string[], total: number) => {
    out.push(...shown);
    if (total > shown.length) out.push(`– et ${plural(total - shown.length, 'autre', 'autres')}.`);
  };
  if (b.duplicates.length > 0) {
    out.push(`${plural(b.duplicates.length, 'doublon écarté', 'doublons écartés')} :`);
    list(b.duplicates.slice(0, lines).map((d) => `– ligne ${d.line}, « ${bibShort(d.title)} » : ${d.why.charAt(0).toLowerCase()}${d.why.slice(1)}`), b.duplicates.length);
  }
  if (problems > 0) {
    out.push(`${plural(problems, 'problème', 'problèmes')} de lecture :`);
    list(listed.slice(0, lines).map((p) => `– ligne ${p.line} : ${p.message}`), problems);
  }
  return out.join('\n');
}

/** The entries' .bib sent to the main process per call (storeTexts): progress is told between two (a fixed bound of the IPC's messages). */
export const BIB_STORE_BATCH = 100;

/**
 * The planned entries' .bib stored (`store`: the IPC storeTexts) by batches of BIB_STORE_BATCH, in order, `progress`
 * told the count stored after each; null once `stopped` (Escape: what is stored stays, the store never erases). A
 * rejection of the store rejects.
 */
export async function storeBibs(
  texts: readonly { name: string; text: string }[], store: (batch: { name: string; text: string }[]) => Promise<FileRef[]>,
  progress: (done: number) => void, stopped: () => boolean,
): Promise<FileRef[] | null> {
  const refs: FileRef[] = [];
  for (let i = 0; i < texts.length; i += BIB_STORE_BATCH) {
    if (stopped()) return null;
    const batch = texts.slice(i, i + BIB_STORE_BATCH), got = await store(batch);
    if (!Array.isArray(got) || got.length !== batch.length) throw new Error('Réponse inattendue du magasin.');
    refs.push(...got);
    progress(refs.length);
  }
  return stopped() ? null : refs;
}

/**
 * The import as one action (D9; spec 6.4: one Ctrl+Z): a node per planned publication with its .bib (`file`, already
 * in the store), put down in the block under `at` (bibBlock: its centre there, at the step readable at this zoom,
 * `lines` each title's lines), all of them entering the group whose envelope is under `at`, as a paste's nodes do.
 * Checked again when it is computed: a publication entered meanwhile, or a key taken, refuses it whole, nothing made.
 */
export function bibImportBuild(
  items: readonly { plan: PlannedPublication; file: FileRef }[], scene: PlanScene, at: Vec2, zoom: number, p: RenderParams,
  lines?: ArrayLike<number>, index?: SceneIndex,
): Build {
  const n = items.length;
  if (n === 0) return null;
  const k = readableStep(zoom, p), offsets = bibBlock(n, k, p, lines);
  const group = groupAt(scene, at, zoom, p, index), plan = scene.plan.id;
  const label = n === 1 ? 'Importer une publication' : `Importer ${fr(n)} publications`;
  return (st) => {
    const now = PublicationIndex.of(st);
    for (const { plan: pl } of items) {
      const refused = now.duplicate(pl.marks);
      if (refused) throw new CommandError(`${refused} Rien n’est importé : recommence l’import du fichier.`);
      if (pl.key !== null && now.keys.has(pl.key)) throw new CommandError(`La clé « ${pl.key} » a été prise entre-temps. Rien n’est importé : recommence l’import du fichier.`);
    }
    const made: Id[] = [];
    return combine(st, label, [
      ...items.map(({ plan: pl, file }, i) => (x: State) => {
        const a = createNode(x, { plan, title: pl.title, x: at.x + offsets[i].x, y: at.y + offsets[i].y, k, tags: pl.tags, files: [file] });
        made.push((a.ops[0] as { after: { id: Id } }).after.id);
        return a;
      }),
      ...(group === null ? [] : items.map((_, i) => (x: State) => include(x, plan, made[i], group))),
    ]);
  };
}
