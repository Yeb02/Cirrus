import { type Id, type State } from '@cirrus/core';
import type { PlanScene, RenderParams } from '@cirrus/view';
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { HEALTH_SECTIONS, type HealthRow, healthRows, type HealthSection, IntruderScan, rowTitle, skippedPlans, unseenNote } from '../health.ts';
import type { LatexRegistry } from '../latex/registry.ts';
import { destination } from '../navigation.ts';
import { inputProbe, runIdleSlices } from '../search/idle.ts';
import { usePanelEscape } from './panelEscape.ts';

/** The intruders' scan asks for idle moments as the search index's build does (App's SEARCH_IDLE). */
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

/** A line: the object's title, over what is wrong and where it is; a click jumps to it. */
function Row({ row, state, here, tabs, onJump }: { row: HealthRow; state: State; here: Id; tabs: readonly Id[]; onJump(row: HealthRow): void }) {
  // The place is the row's plan when it has one (an intruder, a plan skipped): its detail names it already.
  const where = row.plan === undefined ? ` · ${placeOf(state, row, here, tabs)}` : '';
  return (
    <li className="item" data-id={row.id} data-kind={row.kind}>
      <button className="row" onClick={() => onJump(row)} title={row.file !== undefined ? 'Comparer la copie avec son original' : 'Y aller'}>
        <span className="title">{rowTitle(state, row)}</span>
        <span className="meta">{row.detail}{where}</span>
      </button>
    </li>
  );
}

/** The first `shown` rows of a list, then « N de plus » while some are left. */
function Rows(props: { rows: readonly HealthRow[]; step: number; state: State; here: Id; tabs: readonly Id[]; onJump(row: HealthRow): void }) {
  const [shown, setShown] = useState(props.step);
  const left = props.rows.length - shown;
  return (
    <>
      <ul className="items">
        {props.rows.slice(0, shown).map((r) => <Row key={r.key} row={r} state={props.state} here={props.here} tabs={props.tabs} onJump={props.onJump} />)}
      </ul>
      {left > 0 && (
        <button className="more" onClick={() => setShown((n) => n + props.step)}>
          {`Afficher ${Math.min(left, props.step)} de plus (${left} restant${left > 1 ? 's' : ''})`}
        </button>
      )}
    </>
  );
}

/** Section 4's rows under their key, a line each, with its count: unfolded, its objects. */
function TagGroups(props: { rows: readonly HealthRow[]; step: number; state: State; here: Id; tabs: readonly Id[]; onJump(row: HealthRow): void }) {
  const groups = useMemo(() => {
    const by = new Map<string, HealthRow[]>();
    for (const r of props.rows) {
      const list = by.get(r.group!);
      if (list) list.push(r);
      else by.set(r.group!, [r]);
    }
    return [...by];
  }, [props.rows]);
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const toggle = (key: string) => setOpen((o) => { const n = new Set(o); if (n.has(key)) n.delete(key); else n.add(key); return n; });
  return (
    <ul className="groups">
      {groups.map(([key, rows]) => (
        <li key={key} className="group" data-key={key}>
          <button className="fold" aria-expanded={open.has(key)} onClick={() => toggle(key)}>
            {`${open.has(key) ? '▾' : '▸'} « ${key} » — ${rows.length} objet${rows.length > 1 ? 's' : ''}`}
          </button>
          {open.has(key) && <Rows rows={rows} step={props.step} state={props.state} here={props.here} tabs={props.tabs} onJump={props.onJump} />}
        </li>
      ))}
    </ul>
  );
}

/**
 * The « Santé du graphe » panel (plan 6b, D8; spec 20), a side panel like the trash's, opened from the graph's background
 * menu: eight sections in their order, each foldable with its count, each line jumping to its object (`onJump`: App's,
 * which brings the graph back, frames it, or opens a pop-up or a comparison). Sections 1 to 6 and 8 are computed again at
 * each change of the state while it is open (healthRows); the consultations of every PC are read once, as it opens
 * (`window.cirrus.consultationsSeen`); the intruders (section 7) by slices of searchBuildSliceMs in the idle moments,
 * again after each change — the last ones found stay listed meanwhile. A section lists healthRowsShown lines at first.
 * Escape closes it as it closes the trash (usePanelEscape).
 */
export function HealthPanel(props: {
  state: State; rev: number; registry: LatexRegistry | null; params: RenderParams; here: Id; tabs: readonly Id[];
  sceneOf(plan: Id): PlanScene | null; onJump(row: HealthRow): void; onClose(): void;
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
  const rows = useMemo(
    () => healthRows(state, registry, seen ?? null, skipped, Date.now(), params),
    [state, rev, registry, seen, skipped, params.healthUnseenDays],
  );

  // Section 7, by slices in the idle moments, for this state; started again after each change.
  const sceneOf = useRef(props.sceneOf);
  sceneOf.current = props.sceneOf;
  const sliceMs = useRef(params.searchBuildSliceMs);
  sliceMs.current = params.searchBuildSliceMs;
  const [intruders, setIntruders] = useState<{ rows: readonly HealthRow[]; rev: number } | null>(null);
  useEffect(() => {
    const scan = new IntruderScan(state, [...state.plans.keys()], (plan) => sceneOf.current(plan));
    const pending = inputProbe();
    let handle = 0;
    const slice = (idle: IdleDeadline) => {
      let done = false;
      runIdleSlices(idle, sliceMs.current, (end) => (done = scan.step(end - performance.now())), pending);
      if (done) setIntruders({ rows: scan.rows(), rev });
      else handle = requestIdleCallback(slice, IDLE);
    };
    handle = requestIdleCallback(slice, IDLE);
    return () => cancelIdleCallback(handle);
  }, [state, rev]);

  const bySection = useMemo(() => {
    const m = new Map<HealthSection, HealthRow[]>(HEALTH_SECTIONS.map((x) => [x.section, []]));
    for (const r of rows) m.get(r.section)!.push(r);
    return m;
  }, [rows]);
  const [folded, setFolded] = useState<ReadonlySet<HealthSection>>(new Set());
  const toggle = (section: HealthSection) => setFolded((f) => { const n = new Set(f); if (n.has(section)) n.delete(section); else n.add(section); return n; });
  const latest = useRef(props);
  latest.current = props;
  const jump = (row: HealthRow) => latest.current.onJump(row);
  const step = params.healthRowsShown;

  return (
    <aside className="health" aria-label="Santé du graphe">
      <header>
        <h2>Santé du graphe</h2>
        <button className="close" aria-label="Fermer la santé du graphe" onClick={props.onClose}>×</button>
      </header>
      {HEALTH_SECTIONS.map(({ section, title }) => {
        const list: readonly HealthRow[] = section === 'intruders' ? intruders?.rows ?? NO_ROWS : bySection.get(section)!;
        // Still computed: sections 1 and 2 before the first LaTeX registry, 6 while the consultations are read, 7 before its first scan.
        const computing = ((section === 'broken' || section === 'doubles') && registry === null) || (section === 'unseen' && seen === undefined)
          || (section === 'intruders' && intruders === null);
        const stale = section === 'intruders' && intruders !== null && intruders.rev !== rev;
        const note = section === 'unseen' && seen !== undefined ? unseenNote(seen, params.consultationsRecord) : null;
        const open = !folded.has(section);
        return (
          <section key={section} className="health-section" data-section={section}>
            <button className="fold" aria-expanded={open} onClick={() => toggle(section)}>
              <span className="name">{`${open ? '▾' : '▸'} ${title}`}</span>
              <span className="count">{computing ? '…' : list.length}</span>
            </button>
            {open && (
              <>
                {note !== null && <p className="note">{note}</p>}
                {computing || stale ? <p className="none">Calcul en cours…</p> : null}
                {!computing && list.length === 0 && note === null && <p className="none">Rien à signaler.</p>}
                {!computing && list.length > 0 && (section === 'tags'
                  ? <TagGroups rows={list} step={step} state={state} here={props.here} tabs={props.tabs} onJump={jump} />
                  : <Rows rows={list} step={step} state={state} here={props.here} tabs={props.tabs} onJump={jump} />)}
              </>
            )}
          </section>
        );
      })}
    </aside>
  );
}
