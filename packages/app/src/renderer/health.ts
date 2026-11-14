import {
  connectionName, connectionOfRow, connId, connKind, connRow, connRowCount, connTags, connTitle, connTrashed, type Id, KNOWLEDGE, memberOfAt, memberOfCount, type NodeRec,
  nodeRow, type Op, type State, type TagKeyDef,
} from '@cirrus/core';
import { intrudersByGroup, type PlanScene, plansShowing, type RenderParams } from '@cirrus/view';
import { conflictOriginal } from './files/merge.ts';
import type { LatexRegistry, Origin } from './latex/registry.ts';
import { destination } from './navigation.ts';
import { type NoPlanPick, pickWithoutPlan } from './search/pick.ts';
import type { RevealTarget } from './ui/graph/reveal.ts';

// The graph's health (plan 6b, D8; spec 20), without its panel: the rows of each section, pure, so that the rules are
// tested apart; the panel (ui/HealthPanel.tsx) only draws them, and jumps.

/** The panel's sections, in their order. */
export type HealthSection = 'broken' | 'doubles' | 'conflicts' | 'tags' | 'orphans' | 'unseen' | 'intruders' | 'skipped';

/** Each section's heading, in the panel's order. */
export const HEALTH_SECTIONS: readonly { section: HealthSection; title: string }[] = [
  { section: 'broken', title: 'Références cassées' },
  { section: 'doubles', title: 'Labels et clés BibTeX en double' },
  { section: 'conflicts', title: 'Conflits de .tex' },
  { section: 'tags', title: 'Tags obligatoires non renseignés' },
  { section: 'orphans', title: 'Nœuds orphelins' },
  { section: 'unseen', title: 'Jamais revus' },
  { section: 'intruders', title: 'Intrus dans une enveloppe' },
  { section: 'skipped', title: 'Plans ignorés lors d’une répercussion' },
];

/**
 * A line of the panel: the object it is about (`kind`, `id`), its title — a node's, « Sans titre » for none; a
 * connection's own, '' when it has none, which rowTitle names for the rows shown —, what is wrong (`detail`), and a key
 * unique in its section (in its group for section 4): the object's identifier where it is listed once. `plan`: the plan the row is about (an intruder's, a plan skipped), where its jump goes;
 * `file`: a conflict copy's name, which its line compares with its original; `group`: the required key a row of section
 * 4 lacks, under which the panel lists it.
 */
export interface HealthRow {
  section: HealthSection; kind: 'node' | 'connection'; id: Id; title: string; detail: string; key: string; plan?: Id; file?: string; group?: string;
}

/** Why a repercussion left a plan alone (spec 10): a third group there, a loop, an Escape, or the user gone elsewhere. */
export type SkipReason = 'third' | 'loop' | 'escape' | 'interrupted';
/** A plan a repercussion skipped for the node `node`. */
export interface SkippedPlan { node: Id; plan: Id; why: SkipReason }
const WHY: Record<SkipReason, string> = { third: 'troisième groupe', loop: 'boucle', escape: 'Échap', interrupted: 'répercussion interrompue' };

/** The plans skipped kept for the session (D8): they are not deduced from the state. */
export const SKIPPED_MAX = 200;

/**
 * The journal of the plans skipped during the repercussions of this session (D8), the latest first, SKIPPED_MAX at most:
 * in memory only. `list` is the same array until something is added (useSyncExternalStore's snapshot).
 */
export class SkippedPlans {
  private entries: readonly SkippedPlan[] = [];
  private readonly listeners = new Set<() => void>();
  add(entries: readonly SkippedPlan[]): void {
    if (entries.length === 0) return;
    this.entries = [...entries, ...this.entries].slice(0, SKIPPED_MAX);
    for (const f of this.listeners) f();
  }
  list(): readonly SkippedPlan[] {
    return this.entries;
  }
  subscribe(f: () => void): () => void {
    this.listeners.add(f);
    return () => { this.listeners.delete(f); };
  }
}

/** The window's journal: the graph's repercussions write in it, the panel reads it. */
export const skippedPlans = new SkippedPlans();

/** What a drop's repercussions (repercussion(), one per node moved) left alone: a third group's plans, then the loops'. */
export function skippedOf(reps: readonly { node: Id; r: { third: readonly Id[]; loops: readonly Id[] } }[]): SkippedPlan[] {
  return reps.flatMap(({ node, r }) => [
    ...r.third.map((plan): SkippedPlan => ({ node, plan, why: 'third' })), ...r.loops.map((plan): SkippedPlan => ({ node, plan, why: 'loop' })),
  ]);
}

const DAY_MS = 86_400_000;

/** When the object `id` was made, read in its uuidv7 (48 bits of milliseconds first); NaN for another identifier. */
export function createdAt(id: Id): number {
  if (id.length !== 36 || id[14] !== '7') return Number.NaN;
  return Number.parseInt(id.slice(0, 8) + id.slice(9, 13), 16);
}

/** What section 6 says above its rows, if anything: the consultations unread (`seen` null), or not recorded on this PC. */
export function unseenNote(seen: ReadonlyMap<Id, number> | null, record: RenderParams['consultationsRecord']): string | null {
  if (seen === null) return 'Les consultations n’ont pas pu être lues : cette section reste vide.';
  return record === 'yes' ? null : 'L’enregistrement des consultations est éteint sur ce PC : ce que vous y consultez n’est pas compté.';
}

const shown = (title: string) => (title === '' ? 'Sans titre' : title);
const alive = (n: NodeRec | undefined): n is NodeRec => n !== undefined && n.trashedAt === undefined;
const liveConnection = (s: State, id: Id) => { const r = connRow(s, id); return r >= 0 && !connTrashed(s, r); };
const where = (o: Origin | { kind: 'title' }) =>
  (o.kind === 'summary' ? 'le résumé' : o.kind === 'relation' ? 'la relation' : o.kind === 'file' ? `« ${o.name} »` : 'le tag label');
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** A row's title as the panel shows it: a connection without one is named as the trash names it (connectionName). */
export function rowTitle(s: State, row: HealthRow): string {
  if (row.kind !== 'connection' || row.title !== '') return row.title;
  const r = connRow(s, row.id);
  return r < 0 ? 'Sans titre' : connectionName(s, connectionOfRow(s, r));
}

/**
 * Section 1: the sources citing a label that nothing defines, or a key that no live node holds — one row per source, the
 * names it cites so in their order, the labels first. The sources are the registry's: those it could read.
 */
function brokenRows(s: State, registry: LatexRegistry, out: HealthRow[]): void {
  const { labels, keys } = registry.citedNames();
  const bySource = new Map<string, { origin: Origin; names: string[] }>();
  const add = (o: Origin, name: string) => {
    const slot = o.kind === 'summary' ? `s:${o.node}` : o.kind === 'relation' ? `r:${o.connection}` : `f:${o.node}:${o.name}`;
    const e = bySource.get(slot);
    if (e) e.names.push(name);
    else bySource.set(slot, { origin: o, names: [name] });
  };
  for (const [name, list] of labels) if (registry.definitions(name).length === 0) for (const o of list) add(o, `\\ref{${name}}`);
  for (const [name, list] of keys) if (registry.citeNodes(name).length === 0) for (const o of list) add(o, `\\cite{${name}}`);
  // The nodes' sources first, by identifier, then the relations'.
  const idOf = (o: Origin) => (o.kind === 'relation' ? o.connection : o.node);
  const sources = [...bySource].sort(([a, x], [b, y]) => (x.origin.kind === 'relation' ? 1 : 0) - (y.origin.kind === 'relation' ? 1 : 0) || compare(idOf(x.origin), idOf(y.origin)) || compare(a, b));
  for (const [slot, { origin, names }] of sources) {
    const detail = `${names.join(', ')}, dans ${where(origin)}`;
    if (origin.kind === 'relation') {
      if (!liveConnection(s, origin.connection)) continue;
      out.push({ section: 'broken', kind: 'connection', id: origin.connection, title: connTitle(s, connRow(s, origin.connection)), detail, key: `broken:${slot}` });
    } else {
      const n = s.nodes.get(origin.node);
      if (alive(n)) out.push({ section: 'broken', kind: 'node', id: n.id, title: shown(n.title), detail, key: `broken:${slot}` });
    }
  }
}

/** Section 2: each definition of a label defined more than once, then each node of a key that several hold. */
function doubleRows(s: State, registry: LatexRegistry, out: HealthRow[]): void {
  const defs = registry.labels();
  for (let i = 0, j = 0; i < defs.length; i = j) {
    for (j = i + 1; j < defs.length && defs[j].label === defs[i].label; j++);
    if (j - i < 2) continue;
    for (let k = i; k < j; k++) {
      const d = defs[k], o = d.origin, detail = `label « ${d.label} », ${j - i} définitions, dans ${where(o)}`, key = `doubles:label:${d.label}:${k - i}`;
      if (o.kind === 'relation') {
        if (liveConnection(s, o.connection)) out.push({ section: 'doubles', kind: 'connection', id: o.connection, title: connTitle(s, connRow(s, o.connection)), detail, key });
      } else if (alive(s.nodes.get(o.node))) out.push({ section: 'doubles', kind: 'node', id: o.node, title: d.title, detail, key });
    }
  }
  const held = registry.citeKeys();
  for (let i = 0, j = 0; i < held.length; i = j) {
    for (j = i + 1; j < held.length && held[j].key === held[i].key; j++);
    if (j - i < 2) continue;
    for (let k = i; k < j; k++) {
      const n = s.nodes.get(held[k].node);
      if (alive(n)) out.push({ section: 'doubles', kind: 'node', id: n.id, title: shown(n.title), detail: `clé BibTeX « ${held[k].key} », sur ${j - i} nœuds`, key: `doubles:key:${held[k].key}:${n.id}` });
    }
  }
}

/** Whether `tags` hold the key `key` (a loop: this runs for every object of the base). */
function carries(tags: readonly { key: string }[], key: string): boolean {
  for (let i = 0; i < tags.length; i++) if (tags[i].key === key) return true;
  return false;
}

/** Rows made only when shown: their number, and the rows of a slice (an array is one). */
export interface RowList { readonly length: number; slice(from?: number, to?: number): HealthRow[] }

/** A required key of section 4: how many live objects of its scope lack it, and their rows, made when asked (unfolded). */
export interface TagGroup { key: string; count: number; rows(): HealthRow[] }

/** Nodes listed by identifier, each row made for the slice shown: a section may hold the whole base. */
class NodeRows implements RowList {
  private readonly s: State;
  private readonly ids: Id[];
  private readonly make: (n: NodeRec) => HealthRow;
  constructor(s: State, ids: Id[], make: (n: NodeRec) => HealthRow) {
    this.s = s;
    this.ids = ids;
    this.make = make;
  }
  get length(): number {
    return this.ids.length;
  }
  slice(from = 0, to = this.ids.length): HealthRow[] {
    return this.ids.slice(from, to).flatMap((id) => { const n = this.s.nodes.get(id); return n ? [this.make(n)] : []; });
  }
}

/**
 * The live objects of the scope of `def` (annotations and connections other than knowledge ones aside) that do not carry
 * its key — default or not (spec 5.4) —: counted, and given to `emit` if any.
 */
function lacking(s: State, def: TagKeyDef, emit?: (row: HealthRow) => void): number {
  const key = def.key, detail = `sans « ${key} »`;
  let count = 0;
  if (def.scope !== 'connection') {
    for (const n of s.nodes.values()) {
      if (n.trashedAt !== undefined || n.anchor !== undefined || carries(n.tags, key)) continue;
      count++;
      emit?.({ section: 'tags', kind: 'node', id: n.id, title: shown(n.title), detail, key: n.id, group: key });
    }
  }
  if (def.scope !== 'node') {
    for (let r = 0, end = connRowCount(s); r < end; r++) {
      if (connKind(s, r) !== KNOWLEDGE || connTrashed(s, r) || carries(connTags(s, r), key)) continue;
      count++;
      if (emit) { const id = connId(s, r); emit({ section: 'tags', kind: 'connection', id, title: connTitle(s, r), detail, key: id, group: key }); }
    }
  }
  return count;
}

/** Section 4: each required key by name, counted; its rows made by a pass of their own when asked. */
function tagGroups(s: State): TagGroup[] {
  return [...s.tagKeys.values()].filter((d) => d.required).sort((a, b) => compare(a.key, b.key)).map((def) => ({
    key: def.key, count: lacking(s, def), rows: () => { const out: HealthRow[] = []; lacking(s, def, (r) => out.push(r)); return out; },
  }));
}

/** Sections 3 to 6 and 8, as the panel reads them (D8): the long ones (4, 5, 6) made for what is shown. */
export interface StateHealth { conflicts: HealthRow[]; tags: TagGroup[]; orphans: RowList; unseen: RowList; skipped: HealthRow[] }

/**
 * Sections 3 to 6 and 8 (D8), computed again at each action while the panel is open: one pass over the nodes — the
 * conflict copies of a .tex whose original is there; the live nodes, annotations aside, member of no live knowledge
 * connection; those made more than healthUnseenDays ago that no PC looked at (none when the consultations could not be
 * read: `seen` null) —, then a pass per required key (over the connections only for a key of their scope), counting.
 */
export function stateHealth(s: State, seen: ReadonlyMap<Id, number> | null, skipped: readonly SkippedPlan[], now: number, p: RenderParams): StateHealth {
  const conflicts: HealthRow[] = [], orphans: Id[] = [], unseen: Id[] = [];
  const limit = now - p.healthUnseenDays * DAY_MS;
  for (const n of s.nodes.values()) {
    if (!alive(n)) continue;
    for (const f of n.files) {
      if (!/\(conflit du /i.test(f.name)) continue;
      const original = conflictOriginal(n.files, f);
      if (original) conflicts.push({ section: 'conflicts', kind: 'node', id: n.id, title: shown(n.title), detail: `« ${f.name} », copie de « ${original.name} »`, key: `conflicts:${n.id}:${f.name}`, file: f.name });
    }
    if (n.anchor !== undefined) continue;
    const row = nodeRow(s, n.id);
    let linked = false;
    for (let i = 0, count = memberOfCount(s, row); i < count && !linked; i++) {
      const c = memberOfAt(s, row, i);
      linked = connKind(s, c) === KNOWLEDGE && !connTrashed(s, c);
    }
    if (!linked) orphans.push(n.id);
    if (seen !== null && createdAt(n.id) < limit && !seen.has(n.id)) unseen.push(n.id);
  }
  const days = (id: Id) => Math.floor((now - createdAt(id)) / DAY_MS);
  return {
    conflicts,
    tags: tagGroups(s),
    orphans: new NodeRows(s, orphans, (n) => ({ section: 'orphans', kind: 'node', id: n.id, title: shown(n.title), detail: 'aucune connexion de connaissance', key: n.id })),
    unseen: new NodeRows(s, unseen, (n) => {
      const d = days(n.id);
      return { section: 'unseen', kind: 'node', id: n.id, title: shown(n.title), detail: `créé il y a ${d} jour${d > 1 ? 's' : ''}`, key: n.id };
    }),
    skipped: skippedRows(s, skipped),
  };
}

/** Section 8: the journal's plans skipped, the latest first; one whose node or plan is gone since is left out. */
function skippedRows(s: State, skipped: readonly SkippedPlan[]): HealthRow[] {
  const out: HealthRow[] = [];
  skipped.forEach((e, i) => {
    const n = s.nodes.get(e.node), plan = s.plans.get(e.plan);
    if (!alive(n) || !plan) return;
    out.push({ section: 'skipped', kind: 'node', id: n.id, title: shown(n.title), detail: `plan « ${plan.name} » : ${WHY[e.why]}`, key: `skipped:${skipped.length - i}`, plan: plan.id });
  });
  return out;
}

/** Sections 1 and 2 (D8), from the LaTeX registry: computed again when it is built again. */
export function latexRows(s: State, registry: LatexRegistry): HealthRow[] {
  const out: HealthRow[] = [];
  brokenRows(s, registry, out);
  doubleRows(s, registry, out);
  return out;
}

/** `rows` added at the end of `out`, one by one: a spread of a whole base's rows would pass the engine's limit on arguments. */
function append(out: HealthRow[], rows: readonly HealthRow[]): void {
  for (const r of rows) out.push(r);
}

/**
 * Every row of sections 1 to 6 and 8, made, in the panel's order (D8): latexRows, then stateHealth's rows all made — what
 * the panel never needs whole. `registry`: null while none is built (sections 1 and 2 then empty).
 */
export function healthRows(
  s: State, registry: LatexRegistry | null, seen: ReadonlyMap<Id, number> | null, skipped: readonly SkippedPlan[], now: number, p: RenderParams,
): HealthRow[] {
  const out = registry ? latexRows(s, registry) : [];
  const h = stateHealth(s, seen, skipped, now, p);
  append(out, h.conflicts);
  for (const g of h.tags) append(out, g.rows());
  append(out, h.orphans.slice());
  append(out, h.unseen.slice());
  append(out, h.skipped);
  return out;
}

/** What a click on a row does (D8): the comparison of a conflict copy; a jump; or, in no plan, a pop-up or a notice. */
export type HealthJump = { compare: { node: Id; original: string; copy: string } } | { reveal: RevealTarget } | NoPlanPick;

/** What a conflict's row tells once its copy, or its original, is gone. */
export const CONFLICT_GONE = 'Cette copie de conflit n’est plus là.';

/**
 * What a click on `row` does (D8): a conflict's opens the comparison of its copy with its original, found again by name
 * (gone, said); another jumps to its object — in the row's plan while that plan still shows it (an intruder, a plan
 * skipped), else where any jump goes (destination: this plan `here`, the lobby, the tabs…); in no plan, an annotation's
 * pop-up opens, and an object gone says so (pickWithoutPlan).
 */
export function healthJump(s: State, row: HealthRow, here: Id, tabs: readonly Id[]): HealthJump {
  if (row.file !== undefined) {
    const n = s.nodes.get(row.id), copy = alive(n) ? n.files.find((f) => f.name === row.file) : undefined;
    const original = copy && conflictOriginal(n!.files, copy);
    return original ? { compare: { node: row.id, original: original.name, copy: copy.name } } : { say: CONFLICT_GONE };
  }
  const shows = (plan: Id) => s.plans.has(plan) && plansShowing(s, row.kind, row.id).includes(plan);
  const plan = row.plan !== undefined && shows(row.plan) ? row.plan : destination(s, row.kind, row.id, here, tabs);
  return plan === null ? pickWithoutPlan(s, row) : { reveal: { plan, id: row.id, kind: row.kind } };
}

/**
 * Where the intruders' scan takes its plans' scenes (D8): the graph's own scene of a plan, current, while it keeps one
 * (`cached`, served as it is); else one the scan builds (`build`) and keeps up to date by each action (`update`,
 * updateScene's) — made with the parameters `key` (sceneParamsKey): another key makes them again.
 */
export interface SceneSource {
  key: string;
  cached(plan: Id): PlanScene | undefined;
  build(plan: Id): PlanScene;
  update(scene: PlanScene, ops: readonly Op[]): PlanScene;
}

/** A plan of the scan: its scene (null: to build), whether the scan owns it, its intruders' rows as last found, and whether they are current. */
interface Book { scene: PlanScene | null; own: boolean; rows: HealthRow[] | null; fresh: boolean }

/**
 * Section 7 (D8), kept while the panel is open: each plan's intruders (spec 10: an item an envelope covers without being
 * its member), with the deepest such group; a phantom is left out (its node is elsewhere). `follow` brings it to each
 * revision of the state: a plan is read again only when its scene is another object — the graph's, by identity; its own,
 * updated by the action's operations (updateScene gives the same object back for a plan the action does not touch). A
 * scene of its own is built again only after renders gathered (a revision skipped: no operations to follow), a change
 * of `key`, or the graph letting the plan's scene go. The work is done by the panel in idle moments: `build` one plan's
 * scene, alone in its moment (never in a slice); `step`, envelopes one at a time (intrudersByGroup).
 */
export class IntruderBook {
  /** The plans' scans begun since it was made: what the measures and the tests count. */
  scans = 0;
  /** Counts the changes of what `rows`, `done` and `started` say: the panel draws again only then. */
  version = 0;
  private readonly plans = new Map<Id, Book>();
  private order: Id[] = [];
  private rev = Number.NaN;
  private key = '';
  private src: SceneSource | null = null;
  private scanning: { plan: Id; scene: PlanScene; steps: Generator<undefined, Map<number, number>, undefined> } | null = null;

  /** The state at revision `rev`; `ops`, the operations of the action that made it from the last one followed, if known. */
  follow(s: State, rev: number, ops: readonly Op[] | null, src: SceneSource): void {
    this.src = src;
    if (src.key !== this.key) {
      this.plans.clear();
      this.key = src.key;
    } else if (rev !== this.rev) {
      const next = ops !== null && rev === this.rev + 1;
      for (const [plan, b] of this.plans) {
        if (!s.plans.has(plan)) { this.plans.delete(plan); continue; }
        if (!b.own || b.scene === null) continue;
        const scene = next ? src.update(b.scene, ops!) : null;
        if (scene !== b.scene) { b.scene = scene; b.fresh = false; }
      }
    }
    this.rev = rev;
    this.order = [...s.plans.keys()];
    for (const plan of this.order) {
      const cached = src.cached(plan), b = this.plans.get(plan);
      if (!b) this.plans.set(plan, { scene: cached ?? null, own: cached === undefined, rows: null, fresh: false });
      else if (cached !== undefined) {
        if (b.scene !== cached) { b.scene = cached; b.own = false; b.fresh = false; }
      } else if (!b.own) {
        // The graph let it go: its last scene goes on without the graph's updates, which may have shared its parts.
        b.scene = null;
        b.own = true;
        b.fresh = false;
      }
    }
    if (this.scanning && this.plans.get(this.scanning.plan)?.scene !== this.scanning.scene) this.scanning = null;
    this.version++;
  }

  /** What is left: envelopes to read in the scenes at hand first, then a plan's scene to build, or nothing. */
  next(): 'build' | 'scan' | null {
    if (this.scanning) return 'scan';
    let build = false;
    for (const plan of this.order) {
      const b = this.plans.get(plan)!;
      if (b.fresh) continue;
      if (b.scene !== null) return 'scan';
      build = true;
    }
    return build ? 'build' : null;
  }

  /** The scene of the first plan that needs one, built: a step of its own. */
  build(): void {
    for (const plan of this.order) {
      const b = this.plans.get(plan)!;
      if (b.fresh || b.scene !== null) continue;
      b.scene = this.src!.build(plan);
      return;
    }
  }

  /** Envelopes read, one at least, then others while `budgetMs` lasts, plan after plan; whether no scan is left. */
  step(budgetMs: number): boolean {
    const end = performance.now() + budgetMs;
    do {
      if (!this.scanning) {
        const plan = this.order.find((q) => { const b = this.plans.get(q)!; return !b.fresh && b.scene !== null; });
        if (plan === undefined) return true;
        const scene = this.plans.get(plan)!.scene!;
        this.scanning = { plan, scene, steps: intrudersByGroup(scene) };
        this.scans++;
      }
      const r = this.scanning.steps.next();
      if (r.done) {
        const b = this.plans.get(this.scanning.plan)!;
        b.rows = found(this.scanning.plan, this.scanning.scene, r.value);
        b.fresh = true;
        this.scanning = null;
        this.version++;
      }
    } while (performance.now() < end);
    return this.next() !== 'scan';
  }

  /** Every plan's intruders as last found, in the plans' order. */
  rows(): HealthRow[] {
    return this.order.flatMap((plan) => this.plans.get(plan)?.rows ?? []);
  }

  /** Whether every plan's intruders are current. */
  done(): boolean {
    return this.order.every((plan) => this.plans.get(plan)!.fresh);
  }

  /** Whether some plan's intruders were found already. */
  started(): boolean {
    return this.order.some((plan) => this.plans.get(plan)!.rows !== null);
  }
}

/** A plan's intruders as rows, by item. */
function found(plan: Id, scene: PlanScene, map: Map<number, number>): HealthRow[] {
  const out: HealthRow[] = [];
  for (const [i, g] of [...map].sort((a, b) => a[0] - b[0])) {
    const it = scene.items[i];
    if (it.kind === 'phantom') continue;
    out.push({
      section: 'intruders', kind: 'node', id: it.node, title: shown(it.title), detail: `dans l’enveloppe de « ${shown(scene.items[g].title)} »`,
      key: `${plan}:${it.id}`, plan,
    });
  }
  return out;
}
