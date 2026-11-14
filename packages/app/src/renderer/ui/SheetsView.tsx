import type { Id, SheetRec, State } from '@cirrus/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ageOf } from '../agenda.ts';
import { typedFields } from '../quit.ts';
import { sheetsByDate } from '../sheets.ts';

/** The ages are read again each minute, their finest step (« il y a 5 min »): not a setting, the unit of what they say. */
const AGE_TICK_MS = 60_000;

/**
 * A sheet: its text, editable in place, and its age. What is typed is saved after a pause of `pauseMs` and when the field
 * loses the focus (`onSave`, with the key of this typing: the saves of one typing are one undo step); in the field,
 * Ctrl+Z belongs to the text (spec 6.4). The field follows the sheet's text from elsewhere (an undo, a sync) while
 * nothing typed waits; what is typed waiting is saved before the window closes (typedFields) or the tab is left.
 */
function SheetItem(props: {
  sheet: SheetRec; now: number; pauseMs: number; focus: number;
  onSave(sheet: SheetRec, text: string, typing: string): Promise<boolean>; onToNode(id: Id): void; onDelete(id: Id): void;
}) {
  const { sheet } = props;
  const [text, setText] = useState(sheet.text);
  /** The text the base has, as this field last knew it: what is typed differs from it until saved. */
  const known = useRef(sheet.text);
  const typed = useRef(text);
  typed.current = text;
  const timer = useRef(0);
  /** This field's typings: each focus begins one, whose saves are one undo step. */
  const typing = useRef(0);
  const field = useRef<HTMLTextAreaElement>(null);
  const latest = useRef(props);
  latest.current = props;
  // From elsewhere: taken while nothing typed waits.
  useEffect(() => {
    if (typed.current === known.current) setText(sheet.text);
    known.current = sheet.text;
  }, [sheet.text]);
  const save = (): Promise<void> => {
    window.clearTimeout(timer.current);
    const t = typed.current;
    if (t === known.current) return Promise.resolve();
    known.current = t;
    return latest.current.onSave(latest.current.sheet, t, `feuillet:${sheet.id}:${typing.current}`).then((ok) => {
      // Refused (too long, gone): what is typed stays in the field, to be saved again.
      if (!ok && known.current === t) known.current = latest.current.sheet.text;
    });
  };
  const saveRef = useRef(save);
  saveRef.current = save;
  // What is typed waiting is saved before the window closes, and when the field goes (the tab left, the sheet gone).
  useEffect(() => typedFields.hold(() => saveRef.current()), []);
  useEffect(() => () => { void saveRef.current(); }, []);
  // Asked for the focus (Ctrl+Maj+N): the caret at the end.
  useEffect(() => {
    if (props.focus === 0) return;
    const f = field.current;
    if (!f) return;
    f.focus();
    f.setSelectionRange(f.value.length, f.value.length);
    f.scrollIntoView({ block: 'nearest' });
  }, [props.focus]);
  return (
    <li className="sheet" data-id={sheet.id}>
      <textarea
        ref={field} className="sheet-text" rows={Math.min(12, Math.max(3, text.split('\n').length + 1))}
        placeholder="Une idée, une note…" aria-label="Texte du feuillet" value={text} spellCheck
        onFocus={() => { typing.current++; }}
        onChange={(e) => {
          setText(e.target.value);
          window.clearTimeout(timer.current);
          timer.current = window.setTimeout(() => void saveRef.current(), latest.current.pauseMs);
        }}
        onBlur={() => void save()}
      />
      <div className="meta">
        <span className="age" title={new Date(sheet.createdAt).toLocaleString('fr-FR')}>{ageOf(sheet.createdAt, props.now)}</span>
        <span className="spacer" />
        <button className="act to-node" title="Le poser dans le dernier plan montré, d’un clic" onClick={() => { void save().then(() => props.onToNode(sheet.id)); }}>
          En faire un nœud
        </button>
        <button className="act delete" onClick={() => props.onDelete(sheet.id)}>Supprimer</button>
      </div>
    </li>
  );
}

/**
 * The sheets' tab (plan 6b, D6; spec 17): free texts, the most recent first, each editable in place with its age.
 * Nothing goes by itself: a sheet goes by its « Supprimer », or made a node (« En faire un nœud »: `onToNode`, the graph
 * places it). `focus`: the sheet to give the focus to (Ctrl+Maj+N made it), once listed; `asked` counts those asks.
 */
export function SheetsView(props: {
  state: State; rev: number; pauseMs: number; focus: { sheet: Id; asked: number } | null;
  onSave(sheet: SheetRec, text: string, typing: string): Promise<boolean>; onToNode(id: Id): void; onDelete(id: Id): void; onNew(): void;
}) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => setTick((n) => n + 1), AGE_TICK_MS);
    return () => window.clearInterval(t);
  }, []);
  // The time the ages are read at: each minute, and at each change of the state.
  const now = useMemo(() => Date.now(), [tick, props.rev]);
  const sheets = sheetsByDate(props.state);
  return (
    <section className="page-view sheets" aria-label="Feuillets">
      <header>
        <h2>Feuillets</h2>
        <button className="act new" title="Ctrl+Maj+N" onClick={props.onNew}>Nouveau feuillet</button>
      </header>
      {sheets.length === 0
        ? <p className="none">Aucun feuillet. Ctrl+Maj+N en crée un, d’où que vous soyez.</p>
        : (
          <ul className="sheet-list">
            {sheets.map((sh) => (
              <SheetItem
                key={sh.id} sheet={sh} now={now} pauseMs={props.pauseMs} focus={props.focus?.sheet === sh.id ? props.focus.asked : 0}
                onSave={props.onSave} onToNode={props.onToNode} onDelete={props.onDelete}
              />
            ))}
          </ul>
        )}
    </section>
  );
}
