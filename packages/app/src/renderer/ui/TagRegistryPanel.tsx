import { PROTECTED_TAG_KEYS, type State, type TagKeyDef } from '@cirrus/core';
import { useEffect, useMemo, useRef, useState } from 'react';
import { type Build, deleteTagKeyBuild, formSaveBuild, renameTagKeyBuild } from '../actions.ts';
import {
  addValue, type Draft, draftOf, filterRows, formUpdate, inferDefinition, moveValue, newDraft, type RegistryRow, registryEscapeCloses, registryRows,
  removeValue, renameValue, rowCount, sameDraft, SCOPE_LABELS, setRank, setType, sortValues, TYPE_LABELS,
} from '../tagRegistry.ts';
import { AskDialog, type Question } from './Dialogs.tsx';

const TYPES = Object.keys(TYPE_LABELS) as Draft['type'][];
const SCOPES = Object.keys(SCOPE_LABELS) as Draft['scope'][];

/**
 * What an Escape is left to while it is on screen: the floating panels (the loose ones close on the Escape nothing took,
 * and run first), a connection's pop-up, the graph's menu, the search, the import dialog, a title being typed, a full screen.
 */
const REGISTRY_ESCAPE_YIELDS_TO = '.panels .panel, .popup, .context-menu, .search-box, .publication-dialog, .title-editor, .full-screen';

/** What the panel shows: the list (null), the form of a key, or the form of a key to create. */
type View = null | 'new' | { key: string };

/** Where a key stands, in a line: « énumération ordonnée · nœud · 3 objets », « non déclarée · 1 objet ». */
function rowLine(r: RegistryRow): string {
  const own = r.def ? `${TYPE_LABELS[r.def.type]} · ${SCOPE_LABELS[r.def.scope]}` : 'non déclarée';
  return `${own} · ${rowCount(r)}`;
}

/**
 * One key's form (plan 6a, D4): its type, its scope, one value or several, required or not, its default, and an
 * enumeration's values — name and rank, added, removed, moved, renamed. `def` is the registry's definition now (null: the
 * key is only carried, or is being created). The draft is the form's own: a definition changed elsewhere meanwhile — an
 * undo, a sync — replaces it if nothing was typed (`touched`), else says so (`stale`), and « Enregistrer » then replaces
 * it (formUpdate decides). A key
 * Cirrus reads shows its shape and lets only « Obligatoire » and the default change. Saving, renaming and removing go
 * through `onEdit`, which tells a refusal in a toast and resolves with whether it was written.
 */
function KeyForm(props: {
  state: State; name: string | null; def: TagKeyDef | null; row: RegistryRow | null;
  onEdit(build: Build): Promise<boolean>; ask(q: Question): void; onBack(): void; onOpen(key: string): void;
}) {
  const { def, row } = props;
  const creating = props.name === null;
  const locked = props.name !== null && PROTECTED_TAG_KEYS.has(props.name);
  // The first draft: the definition, what the objects say for a key they carry, or an empty one. Made once.
  const [base, setBase] = useState<TagKeyDef | null>(def);
  const [draft, setDraft] = useState<Draft>(() => (def ? draftOf(def) : props.name === null ? newDraft() : draftOf(inferDefinition(props.state, props.name))));
  const [stale, setStale] = useState(false);
  /** Something was typed in the form: not the same as differing from `base`, which a key only carried has none to differ from. */
  const [touched, setTouched] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const dirty = base ? !sameDraft(draft, draftOf(base)) : true;
  /** The form's own edits (a blur that sorts the values is not one). */
  const update = (edit: (d: Draft) => Draft) => { setTouched(true); setDraft(edit); };
  const adopt = (taken: TagKeyDef) => { setBase(taken); setDraft(draftOf(taken)); setStale(false); setTouched(false); };

  // The definition changed (by this form's save, an undo, a sync, a declaration elsewhere): formUpdate says what the form does.
  const seen = def ? JSON.stringify(def) : '';
  useEffect(() => {
    const todo = formUpdate({ base, def, draft, touched });
    if (todo.do === 'adopt') adopt(def!);
    else if (todo.do === 'infer') { setBase(null); setDraft(draftOf(inferDefinition(props.state, props.name!))); setTouched(false); }
    else if (todo.do === 'unbase') setBase(null);
    else if (todo.do === 'stale') setStale(true);
  }, [seen]);

  const change = (patch: Partial<Draft>) => update((d) => ({ ...d, ...patch }));
  const save = () => {
    const mine = draft;
    void props.onEdit(formSaveBuild(mine, creating)).then((ok) => { if (ok && creating) props.onOpen(mine.key.trim()); });
  };
  const rename = () => {
    const to = (renaming ?? '').trim();
    if (to === props.name) { setRenaming(null); return; }
    void props.onEdit(renameTagKeyBuild(props.name!, to)).then((ok) => { if (ok) props.onOpen(to); });
  };
  const remove = () => {
    const n = row?.count ?? 0;
    props.ask({
      text: `Retirer « ${props.name} » du registre ?`,
      detail: n === 0 ? 'Aucun objet ne la porte.' : `Ses tags restent sur les objets qui la portent (${rowCount(row!)}) : elle devient « non déclarée ».`,
      choices: [{ value: 'remove', label: 'Retirer du registre' }],
      answer: (v) => { if (v === 'remove') void props.onEdit(deleteTagKeyBuild(props.name!)); },
    });
  };

  const stopEscape = (e: React.KeyboardEvent, give: () => void) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    give();
  };
  const last = draft.values.length - 1;
  return (
    <div className="key-form" data-key={props.name ?? ''}>
      <button className="back" onClick={props.onBack}>‹ Tous les tags</button>
      {creating
        ? <input type="text" className="name-field" autoFocus placeholder="Nom du tag" aria-label="Nom du tag" value={draft.key} onChange={(e) => change({ key: e.target.value })} />
        : <h3 className="key-title">{props.name}</h3>}
      {!creating && row && <p className="meta">{rowLine(row)}</p>}
      {locked && <p className="note">Cirrus se sert de cette clé.</p>}
      {stale && (
        <p className="note warn">
          Cette définition a changé ailleurs depuis que le formulaire est ouvert.{' '}
          {def && <button className="link" onClick={() => adopt(def)}>Reprendre la définition actuelle</button>}
        </p>
      )}
      <label className="field">
        <span>Type</span>
        <select value={draft.type} disabled={locked} onChange={(e) => update((d) => setType(d, e.target.value as Draft['type']))}>
          {TYPES.map((t) => <option key={t} value={t}>{TYPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label className="field">
        <span>Portée</span>
        <select value={draft.scope} disabled={locked} onChange={(e) => change({ scope: e.target.value as Draft['scope'] })}>
          {SCOPES.map((t) => <option key={t} value={t}>{SCOPE_LABELS[t]}</option>)}
        </select>
      </label>
      <label className="check"><input type="checkbox" checked={draft.multi} disabled={locked} onChange={(e) => change({ multi: e.target.checked })} /> Plusieurs valeurs</label>
      <label className="check"><input type="checkbox" checked={draft.required} onChange={(e) => change({ required: e.target.checked })} /> Obligatoire</label>
      {draft.type !== 'word' && (
        <label className="field">
          <span>Valeur par défaut</span>
          {draft.type === 'enum'
            ? (
              <select value={draft.defaultValue} onChange={(e) => change({ defaultValue: e.target.value })}>
                <option value="">(aucune)</option>
                {draft.values.filter((v) => v.name !== '').map((v) => <option key={v.id} value={v.name}>{v.name}</option>)}
              </select>
            )
            : <input type="text" value={draft.defaultValue} spellCheck={false} onChange={(e) => change({ defaultValue: e.target.value })} />}
        </label>
      )}
      {draft.type === 'enum' && (
        <>
          <h4>Valeurs, par rang</h4>
          <ul className="values">
            {draft.values.map((v, i) => (
              <li key={v.id}>
                <input
                  type="text" className="value-name" aria-label="Nom de la valeur" value={v.name} spellCheck={false} autoFocus={v.was === null && v.name === ''}
                  onChange={(e) => update((d) => renameValue(d, v.id, e.target.value))}
                />
                <input
                  type="text" className="value-rank" aria-label={`Rang de « ${v.name} »`} inputMode="decimal" value={v.rank}
                  onChange={(e) => update((d) => setRank(d, v.id, e.target.value))} onBlur={() => setDraft(sortValues)}
                />
                <button className="move" title="Monter" aria-label={`Monter « ${v.name} »`} disabled={i === 0} onClick={() => update((d) => moveValue(d, v.id, -1))}>↑</button>
                <button className="move" title="Descendre" aria-label={`Descendre « ${v.name} »`} disabled={i === last} onClick={() => update((d) => moveValue(d, v.id, 1))}>↓</button>
                <button className="remove" title="Retirer cette valeur" aria-label={`Retirer « ${v.name} »`} onClick={() => update((d) => removeValue(d, v.id))}>×</button>
              </li>
            ))}
          </ul>
          <button className="add" onClick={() => update(addValue)}>+ Ajouter une valeur</button>
        </>
      )}
      {renaming !== null
        ? (
          <div className="rename">
            <input
              type="text" autoFocus value={renaming} aria-label="Nouveau nom du tag" spellCheck={false} onChange={(e) => setRenaming(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); rename(); } else stopEscape(e, () => setRenaming(null)); }}
            />
            <button className="act primary" onClick={rename}>Renommer</button>
            <button className="act cancel" onClick={() => setRenaming(null)}>Annuler</button>
            {!def && <p className="meta">Renomme-la en une clé déclarée pour la ranger sous sa définition.</p>}
          </div>
        )
        : (
          <div className="actions">
            {creating && <button className="act primary" onClick={save}>Créer</button>}
            {!creating && def && <button className="act primary" disabled={!dirty} onClick={save}>Enregistrer</button>}
            {!creating && !def && <button className="act primary" onClick={save}>Déclarer</button>}
            {!creating && !locked && (
              <button className="act" disabled={def !== null && dirty} title={def !== null && dirty ? 'Enregistre d’abord les changements.' : undefined} onClick={() => setRenaming(props.name!)}>
                Renommer…
              </button>
            )}
            {!creating && !locked && def && <button className="act" onClick={remove}>Supprimer</button>}
          </div>
        )}
    </div>
  );
}

/**
 * The « Registre des tags » panel (plan 6a, D4, spec 5.4), a side panel like the settings', opened from the graph's
 * background menu: the keys the registry declares, then those objects carry with no definition (« non déclarée »), each
 * with how many objects carry it, the trash included; a filter; a key's form to create, change, rename and remove it, and
 * to edit an enumeration's values. Every change is an action of the session (`onEdit`), undone by Ctrl+Z; the panel follows
 * the state (`rev` counts its changes, an undo or a sync included), so the list and the counts are always its own.
 * Escape closes it, wherever the focus is — a button clicked is gone, and the focus with it —, unless something nearer took
 * it: a field that gives something up (the rename), a question, a menu, the search, a gesture of the graph, a floating
 * panel, which close first (REGISTRY_ESCAPE_YIELDS_TO).
 */
export function TagRegistryPanel(props: { state: State; rev: number; onEdit(build: Build): Promise<boolean>; onClose(): void }) {
  const closing = useRef(props.onClose);
  closing.current = props.onClose;
  /** Whether something that has the Escape first was on screen when the key arrived. */
  const yielding = useRef(false);
  useEffect(() => {
    // Capturing, before any handler of the key: a floating panel closes on its own Escape and may be gone from the page by the time the
    // listener below runs (React flushes its state first), when one key would close both.
    const arrived = (e: KeyboardEvent) => { yielding.current = e.key === 'Escape' && document.querySelector(REGISTRY_ESCAPE_YIELDS_TO) !== null; };
    // Bubbling, after the graph's own Escape (a gesture, a menu, the pop-up of a connection) and the fields': one that took it prevented its default.
    const key = (e: KeyboardEvent) => { if (registryEscapeCloses(e, yielding.current)) closing.current(); };
    window.addEventListener('keydown', arrived, true);
    window.addEventListener('keydown', key);
    return () => { window.removeEventListener('keydown', arrived, true); window.removeEventListener('keydown', key); };
  }, []);
  // The filter has the focus as the panel opens, not each time the list comes back (an undo that empties the form): a field
  // owns Ctrl+Z, and the next one would undo its text, not the edit before.
  const fresh = useRef(true);
  useEffect(() => { fresh.current = false; }, []);
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<View>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  // One pass over the keys per change of the state, not per keystroke of the filter.
  const rows = useMemo(() => registryRows(props.state), [props.state, props.rev]);
  const shown = useMemo(() => filterRows(rows, filter), [rows, filter]);
  const name = view !== null && view !== 'new' ? view.key : null;
  const row = name === null ? null : rows.find((r) => r.key === name) ?? null;
  // A key that is neither declared nor carried any more (its creation undone): the list.
  const form = view === 'new' || row !== null;
  const open = (key: string) => { setFilter(''); setView({ key }); };
  return (
    <aside className="registry" aria-label="Registre des tags">
      <header>
        <h2>Registre des tags</h2>
        <button className="close" aria-label="Fermer le registre" onClick={props.onClose}>×</button>
      </header>
      {form
        ? (
          <KeyForm
            key={name ?? '\0new'} state={props.state} name={name} def={name === null ? null : props.state.tagKeys.get(name) ?? null} row={row}
            onEdit={props.onEdit} ask={setQuestion} onBack={() => setView(null)} onOpen={open}
          />
        )
        : (
          <>
            <button className="act new" onClick={() => setView('new')}>+ Nouveau tag</button>
            <input
              type="search" className="search" autoFocus={fresh.current} placeholder="Filtrer les tags" aria-label="Filtrer les tags" value={filter}
              onChange={(e) => setFilter(e.target.value)}
            />
            {shown.length === 0
              ? <p className="none">{rows.length === 0 ? 'Aucun tag n’est déclaré ni porté.' : 'Aucun tag ne correspond.'}</p>
              : (
                <ul className="keys">
                  {shown.map((r) => (
                    <li key={r.key}>
                      <button className={r.def ? 'key' : 'key undeclared'} data-key={r.key} onClick={() => open(r.key)}>
                        <span className="name">{r.key}</span>
                        <span className="meta">{rowLine(r)}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}
          </>
        )}
      {question && <AskDialog q={question} onClose={() => setQuestion(null)} />}
    </aside>
  );
}
