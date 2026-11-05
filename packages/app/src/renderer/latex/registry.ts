import { CITE_KEY_TAG, connId, connRelation, connTitle, connTrashed, type Id, LABEL_TAG, type NodeRec, relationRows, type State } from '@cirrus/core';
import { fileKind } from '../files/kind.ts';
import { scanTex, type TexScan } from './scan.ts';

/** A source that compiles (plan 4b, D7): a node's summary, a connection's relation, a node's .tex. */
export type Origin = { kind: 'summary'; node: Id } | { kind: 'relation'; connection: Id } | { kind: 'file'; node: Id; name: string };
/** Where a label is defined: a source, or a node's title, by its tag `label` (D7). */
export type DefOrigin = Origin | { kind: 'title'; node: Id };

/** A source's slot in the compile IPC (CompileRequest.slot): one per source. */
export function slotOf(o: Origin): string {
  return o.kind === 'summary' ? `summary:${o.node}` : o.kind === 'relation' ? `relation:${o.connection}` : `file:${o.node}:${o.name}`;
}

/** title: the node's, or the connection's for a relation (`node` then null); line: 0 for a tag `label`. */
export interface LabelDef { label: string; origin: DefOrigin; line: number; title: string; node: Id | null }

/** The tags a short citation reads (spec 5.4). */
const AUTHOR_TAG = 'auteur', DATE_TAG = 'date_de_publication';

/** A title shown for a definition or a citation: an untitled node or connection reads as its pop-up says. */
const shown = (title: string) => (title === '' ? 'Sans titre' : title);

/**
 * A publication's short citation (D7), as \cite shows it: « Li, 2008 », « Li et Vitányi, 2008 », « Li et al., 2008 » from
 * three authors. The names are the last word of each tag `auteur`, in their order; the year, the first four digits in a
 * row of `date_de_publication`. Without an author, the node's title; without a year, nothing after the names.
 */
export function shortCitation(n: NodeRec): string {
  const names: string[] = [];
  let year = '';
  for (const t of n.tags) {
    if (t.value === undefined) continue;
    if (t.key === AUTHOR_TAG) {
      const last = String(t.value).trim().split(/\s+/).at(-1)!;
      if (last !== '') names.push(last);
    } else if (t.key === DATE_TAG && year === '') year = /\d{4}/.exec(String(t.value))?.[0] ?? '';
  }
  const who = names.length === 0 ? shown(n.title) : names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} et ${names[1]}` : `${names[0]} et al.`;
  return year === '' ? who : `${who}, ${year}`;
}

/** A source as the registry analysed it. */
interface Source { origin: Origin; text: string; scan: TexScan }
/** A definition and where it sorts: by identifier (node or connection), then title, summary, files in the node's order, then offset. */
interface Placed { def: LabelDef; id: Id; rank: number; at: number }

const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const placedOrder = (a: Placed, b: Placed) => compare(a.id, b.id) || a.rank - b.rank || a.at - b.at;

/**
 * The base's labels and citation keys (plan 4b, D7, D8), derived from the state and the .tex texts. Its sources, for
 * the nodes and connections outside the trash: the summaries and relations that are not empty, the .tex whose text is
 * in `texts` (by hash), and the tags `label` of the titles; its keys, the tags `clé_bibtex`. Every definition counts: a
 * label defined twice, in one source or in two, of any sort, has two definitions (a duplicate, shown in red). Built
 * again whole when the state or the texts change, the sources whose origin and text did not change keep their
 * analysis (`previous`): only what changed is read again. What it gives is what it read at its build: the state,
 * changed in place since, is not read again.
 */
export class LatexRegistry {
  private readonly sources = new Map<string, Source>();
  private readonly defs = new Map<string, LabelDef[]>();
  private readonly keys = new Map<string, Id[]>();
  /** The records of the nodes holding a key, as they were at the build (their short citation). */
  private readonly cited = new Map<Id, NodeRec>();
  private all: LabelDef[] | null = null;
  private citations: { key: string; node: Id; text: string }[] | null = null;
  private readonly analyse: (text: string) => TexScan;

  private constructor(analyse: (text: string) => TexScan) {
    this.analyse = analyse;
  }

  /** `analyse`: how a source is read, scanTex (a test counts its calls). */
  static build(s: State, texts: ReadonlyMap<string, string>, previous?: LatexRegistry, analyse: (text: string) => TexScan = scanTex): LatexRegistry {
    const r = new LatexRegistry(analyse), placed = new Map<string, Placed[]>();
    const define = (p: Placed) => {
      const list = placed.get(p.def.label);
      if (list) list.push(p);
      else placed.set(p.def.label, [p]);
    };
    const source = (fresh: Origin, text: string, title: string, node: Id | null, id: Id, rank: number) => {
      const slot = slotOf(fresh), old = previous?.sources.get(slot);
      // The same slot is the same origin: its object is kept too.
      const kept = old !== undefined && old.text === text;
      const src: Source = kept ? old : { origin: old?.origin ?? fresh, text, scan: analyse(text) };
      r.sources.set(slot, src);
      for (const m of src.scan.labels) define({ def: { label: m.name, origin: src.origin, line: m.line, title, node }, id, rank, at: m.from });
    };
    for (const n of s.nodes.values()) {
      if (n.trashedAt !== undefined) continue;
      const title = shown(n.title);
      for (const t of n.tags) {
        if (t.value === undefined || (t.key !== LABEL_TAG && t.key !== CITE_KEY_TAG)) continue;
        const name = String(t.value).trim();
        if (name === '') continue;
        if (t.key === LABEL_TAG) define({ def: { label: name, origin: { kind: 'title', node: n.id }, line: 0, title, node: n.id }, id: n.id, rank: 0, at: 0 });
        else {
          const nodes = r.keys.get(name);
          if (!nodes) r.keys.set(name, [n.id]);
          else if (!nodes.includes(n.id)) nodes.push(n.id);
          r.cited.set(n.id, n);
        }
      }
      if (n.summary !== '') source({ kind: 'summary', node: n.id }, n.summary, title, n.id, n.id, 1);
      n.files.forEach((f, k) => {
        const text = fileKind(f.name) === 'tex' ? texts.get(f.hash) : undefined;
        if (text) source({ kind: 'file', node: n.id, name: f.name }, text, title, n.id, n.id, 2 + k);
      });
    }
    for (const row of relationRows(s)) {
      if (connTrashed(s, row)) continue;
      const id = connId(s, row);
      source({ kind: 'relation', connection: id }, connRelation(s, row), shown(connTitle(s, row)), null, id, 0);
    }
    for (const [label, list] of placed) r.defs.set(label, (list.length > 1 ? list.sort(placedOrder) : list).map((p) => p.def));
    for (const nodes of r.keys.values()) nodes.sort(compare);
    return r;
  }

  /** The definitions of `label`, by identifier: none when it is broken, several when it is doubled. */
  definitions(label: string): LabelDef[] {
    return this.defs.get(label) ?? [];
  }

  /** Every definition, by label (each label's in the order of definitions). */
  labels(): LabelDef[] {
    return (this.all ??= [...this.defs.keys()].sort(compare).flatMap((label) => this.defs.get(label)!));
  }

  /** The nodes holding the citation key `key`, by identifier. */
  citeNodes(key: string): Id[] {
    return this.keys.get(key) ?? [];
  }

  /** Every key with each node holding it and its short citation, by key then node. */
  citeKeys(): { key: string; node: Id; text: string }[] {
    return (this.citations ??= [...this.keys.keys()].sort(compare).flatMap((key) =>
      this.keys.get(key)!.map((node) => ({ key, node, text: shortCitation(this.cited.get(node)!) }))));
  }

  /** The analysis of `text` as the source `origin`: the registry's own when that is the text it read for it, else a new one. */
  scanOf(origin: Origin, text: string): TexScan {
    const src = this.sources.get(slotOf(origin));
    return src !== undefined && src.text === text ? src.scan : this.analyse(text);
  }
}
