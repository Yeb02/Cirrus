import type { Action, Id, State } from '@cirrus/core';
import { buildScene, type RenderParams, updateScene } from '@cirrus/view';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  HEALTH_SECTIONS, type HealthRow, type HealthSection, IntruderBook, latexRows, type RowList, rowTitle, type SceneSource, skippedPlans, stateHealth,
  type TagGroup, unseenNote,
} from '../health.ts';
import type { LatexRegistry } from '../latex/registry.ts';
import { destination } from '../navigation.ts';
import { inputProbe, runIdleSlices } from '../search/idle.ts';
import type { SceneTools } from './GraphView.tsx';
import { usePanelEscape } from './panelEscape.ts';

/** The intruders' envelopes are read in idle moments as the search index is built (App's SEARCH_IDLE). */
const IDLE: IdleRequestOptions = { timeout: 200 };
const NO_ROWS: readonly HealthRow[] = [];
const subscribeSkipped = (f: () => void) => skippedPlans.subscribe(f);
const skippedNow = () => skippedPlans.list();

/** Where a row's object is, as its line says it: the row's plan, else where a jump would go; in none, so. */
function placeOf(s: State, row: HealthRow, here: Id, tabs: readonly Id[]): string {
  const plan = row.plan ?? destination(s, row.kind, row.id, here, tabs);
  if (plan === null) return s.nodes.get(row.id)?.anchor !== undefined ? 'annotation, dans aucun plan' : 'dans aucun plan';
  return `plan « ${s.plans.get(plan)?.name ?? '?'} »`;
}

/** What every line needs besides itself. */
interface Ctx { state: State; here: Id; tabs: readonly Id[]; step: number; onJump(row: HealthRow): void }

/** A line: the object's title, over what is wrong and where it is; a click jumps to it. */
function Row({ row, ctx }: { row: HealthRow; ctx: Ctx }) {
  // The place is the row's plan when it has one (an intruder, a plan skipped): its detail names it already.
  const where = row.plan === undefined ? ` · ${placeOf(ctx.state, row, ctx.here, ctx.tabs)}` : '';
  return (
    <li className="item" data-id={row.id} data-kind={row.kind}>
      <button className="row" onClick={() => ctx.onJump(row)} title={row.file !== undefined ? 'Comparer la copie avec son original' : 'Y aller'}>
        <span className="title">{rowTitle(ctx.state, row)}</span>
        <span className="meta">{row.detail}{where}</span>
      </button>
    </li>
  );
}

/** The first `step` rows of a list (healthRowsShown, followed when it changes), then « N de plus » while some are left: only those are made. */
function Rows({ rows, ctx }: { rows: RowList; ctx: Ctx }) {
  const [pages, setPages] = useState(1);
  const shown = pages * ctx.step, left = rows.length - shown;
  return (
    <>
      <ul className="items">{rows.slice(0, shown).map((r) => <Row key={r.key} row={r} ctx={ctx} />)}</ul>
      {left > 0 && (
        <button className="more" onClick={() => setPages((n) => n + 1)}>
          {`Afficher ${Math.min(left, ctx.step)} de plus (${left} restant${left > 1 ? 's' : ''})`}
        </button>
      )}
    </>
  );
}

/** A required key unfolded: its rows made now, and again at each change of the state while it stays open. */
function TagRows({ group, ctx }: { group: TagGroup; ctx: Ctx }) {
  const rows = useMemo(() => group.rows(), [group]);
  return <Rows rows={rows} ctx={ctx} />;
}

/** Section 4: a line per required key, with its count; unfolded, its objects. */
function TagGroups({ groups, ctx }: { groups: readonly TagGroup[]; ctx: Ctx }) {
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <ul className="groups">
      {groups.filter((g) => g.count > 0).map((g) => (
        <li key={g.key} className="group" data-key={g.key}>
          <button className="fold" aria-expanded={open.has(g.key)} onClick={() => toggle(g.key)}>
            {`${open.has(g.key) ? '▾' : '▸'} « ${g.key} » — ${g.count} objet${g.count > 1 ? 's' : ''}`}
          </button>
          {open.has(g.key) && <TagRows group={g} ctx={ctx} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * The « Santé du graphe » panel (plan 6b, D8; spec 20), a side panel like the trash's, opened from the graph's background
 * menu: eight sections in their order, each foldable with its count, each line jumping to its object (`onJump`: App's,
 * which brings the graph back, frames it, or opens a pop-up or a comparison). Sections 1 and 2 follow the LaTeX registry
 * (latexRows, when it is built again); 3 to 6 and 8 each change of the state (stateHealth), their long lists made only for
 * the lines shown (healthRowsShown at first). The consultations of every PC are read once, as it opens
 * (`window.cirrus.consultationsSeen`). The intruders (section 7) are an IntruderBook kept while the panel is open: after
 * an action, only the plans whose scene changed are read again, by slices of searchBuildSliceMs in the idle moments; a
 * scene the graph does not keep is built by the book, one plan per idle moment, and updated by each action's operations
 * (`action`). Escape closes it as it closes the trash (usePanelEscape).
 */
export function HealthPanel(props: {
  state: State; rev: number; action: Action | null; registry: LatexRegistry | null; params: RenderParams; here: Id; tabs: readonly Id[];
  scenes(): SceneTools | null; onJump(row: HealthRow): void; onClose(): void;
}) {
  usePanelEscape(props.onClose);
  const { state, rev, registry, params } = props;
  /** The last consultation of each subject, every PC (D7): undefined while read, null when it could not be. */
  const [seen, setSeen] = useState<ReadonlyMap<Id, number> | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    window.cirrus.consultationsSeen().then(
      (pairs) => { if (live) setSeen(new Map(pairs)); },
      (e: unknown) => { console.error('Lecture des consultations :', e); if (live) setSeen(null); },
    );
    return () => { live = false; };
  }, []);
  const skipped = useSyncExternalStore(subscribeSkipped, skippedNow);
  // Sections 1 and 2 when the registry is built again; the others at each change of the state.
  const latex = useMemo(() => (registry ? latexRows(state, registry) : null), [registry]);
  const base = useMemo(() => stateHealth(state, seen ?? null, skipped, Date.now(), params), [state, rev, seen, skipped, params.healthUnseenDays]);

  // Section 7: the book follows each revision; its work is done in the idle moments, a build alone in its own.
  const latest = useRef(props);
  latest.current = props;
  const book = useRef<IntruderBook | null>(null);
  book.current ??= new IntruderBook();
  const [intruders, setIntruders] = useState<{ rows: readonly HealthRow[]; done: boolean; started: boolean; version: number } | null>(null);
  /** Asked again when the graph had no engine yet. */
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const b = book.current!, tools = latest.current.scenes();
    if (!tools) {
      const handle = requestIdleCallback(() => setRetry((n) => n + 1), IDLE);
      return () => cancelIdleCallback(handle);
    }
    const src: SceneSource = {
      key: tools.key, cached: tools.cached,
      build: (plan) => buildScene(state, plan, tools.measure, latest.current.params),
      update: (scene, ops) => updateScene(scene, state, ops, tools.measure, latest.current.params).scene,
    };
    b.follow(state, rev, latest.current.action?.ops ?? null, src);
    const pending = inputProbe();
    const publish = () => setIntruders((last) => (last?.version === b.version ? last : { rows: b.rows(), done: b.done(), started: b.started(), version: b.version }));
    let handle = 0;
    const schedule = () => {
      const work = b.next();
      // A build waits for a true idle moment (no timeout): it is not sliced.
      if (work !== null) handle = work === 'build' ? requestIdleCallback(tick) : requestIdleCallback(tick, IDLE);
    };
    const tick = (idle: IdleDeadline) => {
      const work = b.next();
      if (work === 'build') { if (!idle.didTimeout) b.build(); }
      else if (work === 'scan') runIdleSlices(idle, latest.current.params.searchBuildSliceMs, (end) => b.step(end - performance.now()), pending);
      publish();
      schedule();
    };
    publish();
    schedule();
    return () => cancelIdleCallback(handle);
  }, [state, rev, retry]);

  const [folded, setFolded] = useState<ReadonlySet<HealthSection>>(new Set());
  const toggle = (section: HealthSection) => setFolded((f) => { const n = new Set(f); if (n.has(section)) n.delete(section); else n.add(section); return n; });
  const ctx: Ctx = { state, here: props.here, tabs: props.tabs, step: params.healthRowsShown, onJump: (row) => latest.current.onJump(row) };
  const lists: Record<Exclude<HealthSection, 'tags'>, RowList> = {
    broken: latex?.filter((r) => r.section === 'broken') ?? NO_ROWS,
    doubles: latex?.filter((r) => r.section === 'doubles') ?? NO_ROWS,
    conflicts: base.conflicts, orphans: base.orphans, unseen: base.unseen, intruders: intruders?.rows ?? NO_ROWS, skipped: base.skipped,
  };

  return (
    <aside className="health" aria-label="Santé du graphe">
      <header>
        <h2>Santé du graphe</h2>
        <button className="close" aria-label="Fermer la santé du graphe" onClick={props.onClose}>×</button>
      </header>
      {HEALTH_SECTIONS.map(({ section, title }) => {
        const count = section === 'tags' ? base.tags.reduce((n, g) => n + g.count, 0) : lists[section].length;
        // Still computed: sections 1 and 2 before the first LaTeX registry, 6 while the consultations are read, 7 before its first plan read.
        const computing = ((section === 'broken' || section === 'doubles') && latex === null) || (section === 'unseen' && seen === undefined)
          || (section === 'intruders' && !intruders?.started);
        const stale = section === 'intruders' && intruders !== null && !intruders.done;
        const note = section === 'unseen' && seen !== undefined ? unseenNote(seen, params.consultationsRecord) : null;
        const open = !folded.has(section);
        return (
          <section key={section} className="health-section" data-section={section}>
            <button className="fold" aria-expanded={open} onClick={() => toggle(section)}>
              <span className="name">{`${open ? '▾' : '▸'} ${title}`}</span>
              <span className="count">{computing ? '…' : count}</span>
            </button>
            {open && (
              <>
                {note !== null && <p className="note">{note}</p>}
                {computing || stale ? <p className="none">Calcul en cours…</p> : null}
                {!computing && !stale && count === 0 && note === null && <p className="none">Rien à signaler.</p>}
                {!computing && count > 0 && (section === 'tags' ? <TagGroups groups={base.tags} ctx={ctx} /> : <Rows rows={lists[section]} ctx={ctx} />)}
              </>
            )}
          </section>
        );
      })}
    </aside>
  );
}
